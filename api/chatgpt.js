// Serverless-Funktion für Vercel: Schutz des OpenAI-Keys + CORS
export default async function handler(req, res) {
  // ----- CORS -----
  const allowed = process.env.ALLOWED_ORIGIN || "*"; // im Live-Betrieb bitte Domain setzen!
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { message, context } = body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' (string) in body." });
    }

    const systemPrompt = [
      "You are a Shopify product advisor. Be concise, friendly, and practical.",
      "Use given context (product title, tags, page type) to tailor advice.",
      "If no product context: ask one clarifying question, then answer.",
      "Avoid making up stock/prices; suggest how to check availability."
    ].join(" ");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify({ message, context: context || null }) }
        ]
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "OpenAI error", detail: errText });
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return res.status(200).json({ ok: true, text });
  } catch (e) {
    return res.status(500).json({ error: "Proxy error", detail: String(e?.message || e) });
  }
}
