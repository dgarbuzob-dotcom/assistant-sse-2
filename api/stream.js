export default async function handler(req, res) {
  // --- CORS ---
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") return res.status(405).end("Use POST");

  // читаем JSON-тело
  const body = await readJson(req);
  const prompt = body?.prompt;
  const incomingThreadId = body?.thread_id || null;
  if (!prompt) return res.status(400).end("Missing 'prompt'");

  // SSE-заголовки
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

    if (!runResp.ok || !runResp.body) {
      const txt = await runResp.text();
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
        } catch (_) { /* пропускаем нечитаемое */ }
      }
    };

    // читаем поток (и WebStream, и Node Readable)
    if (typeof runResp.body.getReader === "function") {
      // Web Streams
      const reader = runResp.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        handleChunkText(decoder.decode(value, { stream: true }));
      }
    } else {
      // Node Readable
      runResp.body.setEncoding?.("utf8");
      await new Promise((resolve) => {
        runResp.body.on("data", (chunk) => handleChunkText(String(chunk)));
        runResp.body.on("end", resolve);
        runResp.body.on("error", (e) => { sse({ type: "error", error: String(e) }); resolve(); });
      });
    }

    res.end();
  } catch (e) {
    sse({ type: "error", error: String(e) });
    res.end();
  }
}

async function readJson(req) {
  try {
    if (req.body) {
      if (typeof req.body === "string") return JSON.parse(req.body);
      return req.body;
    }
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(raw);
  } catch {
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
