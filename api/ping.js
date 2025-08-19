// /api/ping.js — prüft Storefront-API (Domain, Token, Version)
export default async function handler(req, res) {
  // CORS für schnellen Browser-Test
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url = new URL(req.url, "http://x");
    // Optional: Domain live überschreiben: /api/ping?domain=abc.myshopify.com
    const override = url.searchParams.get("domain");

    const { SHOPIFY_DOMAIN, SHOPIFY_STOREFRONT_TOKEN } = process.env;
    const domain = (override || SHOPIFY_DOMAIN || "").trim();
    if (!domain) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_DOMAIN" });
    if (!SHOPIFY_STOREFRONT_TOKEN) return res.status(500).json({ ok: false, error: "Missing SHOPIFY_STOREFRONT_TOKEN" });

    // Nimm ruhig die aktuelle Version
    const endpoint = `https://${domain}/api/2024-07/graphql.json`;
    const query = `query { shop { name primaryDomain { url } } }`;

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    return res.status(r.status).json({
      ok: r.ok,
      status: r.status,
      endpoint,
      domain,
      body,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
