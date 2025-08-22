export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end("Use POST");

  try {
    const body = await readJson(req);
    const prompt = body?.prompt;
    let thread_id = body?.thread_id || null;
    if (!prompt) return res.status(400).json({ error: "Missing 'prompt'" });

    // универсальный вызов OpenAI (Assistants API v2)
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

    // 1) создаём тред при необходимости
    if (!thread_id) {
      const t = await openai("https://api.openai.com/v1/threads", {
        method: "POST",
        body: JSON.stringify({})
      });
      thread_id = t.id;
    }

    // 2) добавляем сообщение
    await openai(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: prompt })
    });

    // 3) запускаем run (без stream)
    const run = await openai(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id: process.env.ASSISTANT_ID })
    });

    // 4) ждём завершения
    let status = run.status;
    const run_id = run.id;
    const started = Date.now();
    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      if (Date.now() - started > 120000) throw new Error("Run timeout");
      await new Promise(r => setTimeout(r, 1200));
      const cur = await openai(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, { method: "GET" });
      status = cur.status;
    }
    if (status !== "completed") {
      return res.status(400).json({ ok:false, thread_id, run_id, status });
    }

    // 5) читаем последний ответ ассистента
    const msgs = await openai(`https://api.openai.com/v1/threads/${thread_id}/messages?limit=5`, { method: "GET" });
    const last = msgs.data?.find(m => m.role === "assistant");
    let text = "";
    if (last?.content?.length) {
      for (const c of last.content) if (c.type === "text") text += c.text?.value || "";
    }
    return res.status(200).json({ ok:true, thread_id, text });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e) });
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
