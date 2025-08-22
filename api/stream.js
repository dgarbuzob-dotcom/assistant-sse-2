export default async function handler(req, res) {
  // --- CORS ---
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).end("Use POST or GET");

  // читаем JSON-тело (если есть) + параллельно разбираем query
  const body = req.method === "POST" ? await readJson(req) : {};
  const url = new URL(req.url, `https://${req.headers.host}`);
  const promptFromQuery = url.searchParams.get("prompt");
  const threadIdFromQuery = url.searchParams.get("thread_id");

  console.log("STREAM body:", body);
  console.log("STREAM query:", Object.fromEntries(url.searchParams.entries()));

  const prompt = body?.prompt ?? promptFromQuery ?? null;
  const incomingThreadId = body?.thread_id ?? threadIdFromQuery ?? null;

  if (!prompt) return res.status(400).end("Missing 'prompt'");

  // SSE заголовки
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sse = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // 1) создаём/берём тред
    let threadId = incomingThreadId;
    if (!threadId) {
      const t = await openai("https://api.openai.com/v1/threads", {
        method: "POST",
        body: JSON.stringify({})
      });
      threadId = t.id;
      sse({ type: "thread.created", thread_id: threadId });
    }

    // 2) добавляем сообщение пользователя
    await openai(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: prompt })
    });

    // 3) запускаем run со stream:true
    console.log("RUN:start", { threadId, assistant: process.env.ASSISTANT_ID });
    const runResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID, stream: true })
    });
    console.log("RUN:resp", runResp.status, runResp.statusText);

    if (!runResp.ok || !runResp.body) {
      const txt = await runResp.text().catch(() => "");
      console.error("RUN:error_body", txt);
      sse({ type: "error", error: `OpenAI ${runResp.status}: ${txt}` });
      return res.end();
    }

    let full = "";

    const handleChunkText = (chunkText) => {
      for (const line of chunkText.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "response.output_text.delta") {
            const delta = evt.delta || "";
            full += delta;
            sse({ type: "delta", text: delta });
          }
          if (evt.type === "response.completed") {
            sse({ type: "done", thread_id: threadId, text: full });
          }
          if (evt.type === "error") {
            sse({ type: "error", error: evt.error?.message || "Unknown error" });
          }
        } catch {}
      }
    };

    // читаем поток (и WebStream, и Node Readable)
    if (typeof runResp.body.getReader === "function") {
      const reader = runResp.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleChunkText(decoder.decode(value, { stream: true }));
      }
    } else {
      runResp.body.setEncoding?.("utf8");
      await new Promise((resolve) => {
        runResp.body.on("data", (chunk) => handleChunkText(String(chunk)));
        runResp.body.on("end", resolve);
        runResp.body.on("error", (e) => { sse({ type: "error", error: String(e) }); resolve(); });
      });
    }

    res.end();
  } catch (e) {
    console.error("STREAM:error", e);
    sse({ type: "error", error: String(e) });
    res.end();
  }
}

async function readJson(req) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("readJson error", e);
    return {};
  }
}

async function openai(url, init) {
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
      ...(init?.headers || {})
    }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : {};
}
