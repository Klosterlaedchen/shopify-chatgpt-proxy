// ChatGPT-Produktberater – Variante B:
// Hole bis zu 50 Produkte (ohne Query) aus Shopify und lass GPT filtern & empfehlen.

export default async function handler(req, res) {
  // ===== CORS (mehrere erlaubte Origins) =====
  const originHeader = req.headers.origin || "";
  const allowList = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "*")
    .split(",").map(s => s.trim()).filter(Boolean);

  let allowOrigin = "*";
  if (allowList.includes("*")) allowOrigin = "*";
  else if (allowList.includes(originHeader)) allowOrigin = originHeader;
  else if (allowList.length) allowOrigin = allowList[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method Not Allowed" });

  try {
    // ===== Request-Body prüfen =====
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { message, context } = body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'message' (string) in body." });
    }

    // ===== 1) Bis zu 50 Produkte aus Shopify holen (ohne Such-Query) =====
    const shopDomain = process.env.SHOPIFY_DOMAIN;            // z.B. dianas-klosterlaedchen.myshopify.com
    const sfToken     = process.env.SHOPIFY_STOREFRONT_TOKEN;  // Storefront-Access-Token
    let products = [];

    if (shopDomain && sfToken) {
      // GraphQL: hole die ersten 50 Produkte (Standard-Sortierung im Shop)
      const gql = `
        query GetProducts {
          products(first: 50) {
            edges {
              node {
                id
                title
                handle
                productType
                tags
                description(truncateAt: 240)
                featuredImage { url altText }
                availableForSale
                variants(first: 1) {
                  edges {
                    node {
                      availableForSale
                      quantityAvailable
                      price { amount currencyCode }
                    }
                  }
                }
                onlineStoreUrl
              }
            }
          }
        }
      `;

      const r = await fetch(`https://${shopDomain}/api/2024-07/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": sfToken,
        },
        body: JSON.stringify({ query: gql })
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        console.error("Shopify Storefront error", r.status, t);
      } else {
        const j = await r.json();

        // Basis-URL für Produktlinks ermitteln:
        // 1) explizit per FRONTEND_BASE_URL (optional)
        // 2) sonst aus ALLOWED_ORIGINS die .store-Domain oder die erste Domain
        // 3) Fallback: myshopify.com-Domain
        const frontendBase =
          (process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "") ||
          allowList.find(o => /\.store/.test(o)) ||
          allowList[0] ||
          `https://${shopDomain}`;

        const edges = j?.data?.products?.edges || [];
        products = edges.map(e => {
          const n = e.node;
          const v = n.variants?.edges?.[0]?.node;
          const urlCandidate = (n.onlineStoreUrl || `${frontendBase.replace(/\/$/, "")}/products/${n.handle}`);
          return {
            title: n.title,
            handle: n.handle,
            url: urlCandidate,
            productType: n.productType,
            tags: n.tags,
            desc: n.description || "",
            image: n.featuredImage?.url || "",
            // Verfügbarkeit/Bestand:
            available: (v?.availableForSale ?? n.availableForSale) ?? true,
            qty: (typeof v?.quantityAvailable === "number") ? v.quantityAvailable : null,
            price: v?.price?.amount ? `${v.price.amount} ${v.price.currencyCode}` : null
          };
        });
      }
    }

    // ===== 2) GPT-Antwort: Produkte filtern + empfehlen =====
    const systemPrompt = [
      "Du bist ein Produktberater für einen Shopify-Shop. Antworte kurz, klar und freundlich.",
      "Du erhältst eine Liste von Shop-Produkten als JSON. Wähle 3–5 passende Empfehlungen aus.",
      "Wähle nur Artikel, die thematisch zur Nutzerfrage passen.",
      "Verfügbarkeit: '✅ Auf Lager' (qty>5 oder available true), '⚠️ Begrenzt' (1–5), '❌ Nicht verfügbar' (0/false).",
      "Gib je Empfehlung: Titel, 1 Satz Nutzen, Preis (falls vorhanden) und klickbaren Link.",
      "Wenn keine Produkttreffer sinnvoll sind, stelle genau 1 kurze Rückfrage zur Präzisierung."
    ].join(" ");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    // Trimme Felder minimal, damit der Kontext kompakt bleibt:
    const compact = products.slice(0, 50).map(p => ({
      title: p.title,
      desc: p.desc,
      tags: p.tags,
      productType: p.productType,
      url: p.url,
      available: p.available,
      qty: p.qty,
      price: p.price
    }));

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
          { role: "user", content: `Nutzerfrage: ${message}\nKontext: ${JSON.stringify(context || {})}\nProdukte(JSON, max 50): ${JSON.stringify(compact)}` }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      return res.status(openaiRes.status).json({ ok: false, error: "OpenAI error", details: errText });
    }

    const data = await openaiRes.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "Entschuldigung, keine Antwort erhalten.";
    return res.status(200).json({ ok: true, text });

  } catch (e) {
    console.error("Proxy error", e);
    return res.status(500).json({ ok: false, error: "Proxy error", details: String(e?.message || e) });
  }
}
