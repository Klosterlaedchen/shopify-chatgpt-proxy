// ChatGPT-Produktberater: Shopify-Produktsuche (Storefront API) + GPT-Antwort
export default async function handler(req, res) {
  // ===== CORS (mehrere erlaubte Origins unterstützt) =====
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
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { message, context } = body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok:false, error:"Missing 'message' (string) in body." });
    }

    // ===== 1) Shopify Produktsuche über Storefront API =====
    const shopDomain = process.env.SHOPIFY_DOMAIN;                 // z.B. dianas-klosterlaedchen.myshopify.com
    const sfToken    = process.env.SHOPIFY_STOREFRONT_TOKEN;       // in Shopify erzeugt
    let products = [];

    if (shopDomain && sfToken) {
      // simple Keyword-Aufbereitung
      const words = message.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(w => w.length >= 3 && !["und","oder","mit","für","als","ein","eine","der","die","das"].includes(w));
      const uniq = [...new Set(words)].slice(0, 6);

      const queryExpr = uniq.length
        ? uniq.map(w => `(title:*${w}* OR tag:'${w}' OR product_type:'${w}')`).join(" AND ")
        : "available_for_sale:true";

      const gql = `
        query Search($query: String!) {
          products(first: 8, query: $query) {
            edges {
              node {
                id
                title
                handle
                productType
                tags
                description(truncateAt: 140)
                featuredImage { url altText }
                variants(first: 1) {
                  edges {
                    node {
                      availableForSale
                      quantityAvailable
                      price { amount currencyCode }
                    }
                  }
                }
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
        body: JSON.stringify({ query: gql, variables: { query: queryExpr } })
      });

      if (!r.ok) {
        const t = await r.text().catch(()=> "");
        // wir brechen nicht ab – GPT kann notfalls ohne Katalog antworten
        console.error("Shopify Storefront error", r.status, t);
      } else {
        const j = await r.json();
        products = (j.data?.products?.edges || []).map(e => {
          const v = e.node.variants?.edges?.[0]?.node;
          const domainForLinks = shopDomain.replace(".myshopify.com","");
          return {
            title: e.node.title,
            handle: e.node.handle,
            url: `https://${domainForLinks}.store/products/${e.node.handle}`,
            productType: e.node.productType,
            tags: e.node.tags,
            desc: e.node.description || "",
            image: e.node.featuredImage?.url || "",
            available: v?.availableForSale ?? true,
            qty: (typeof v?.quantityAvailable === "number") ? v.quantityAvailable : null,
            price: v?.price?.amount ? `${v.price.amount} ${v.price.currencyCode}` : null
          };
        });
      }
    }

    // ===== 2) GPT-Antwort mit Katalog-Kontext =====
    const systemPrompt = [
      "Du bist ein Produktberater für einen Shopify-Shop. Antworte kurz, klar und freundlich.",
      "Nutze die bereitgestellten Produkte (JSON) strikt für Empfehlungen; erfinde nichts.",
      "Wenn die Liste leer ist, stelle genau 1 Rückfrage zur Präzisierung.",
      "Gib je Empfehlung: Titel, 1 Satz Nutzen, Preis (falls vorhanden) und Link.",
      "Kennzeichne Verfügbarkeit grob: 'Auf Lager' (qty>5 oder available), 'Begrenzt' (1–5), 'Nicht verfügbar' (0/false)."
    ].join(" ");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const catalogSnippet = JSON.stringify(products.slice(0, 8));

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
          { role: "user", content: `Nutzerfrage: ${message}\nKontext: ${JSON.stringify(context||{})}\nKatalog(JSON): ${catalogSnippet}` }
        ]
      })
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(()=> "");
      return res.status(openaiRes.status).json({ ok:false, error:"OpenAI error", details: errText });
    }

    const data = await openaiRes.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || "Entschuldigung, keine Antwort erhalten.";
    return res.status(200).json({ ok:true, text });

  } catch (e) {
    console.error("Proxy error", e);
    return res.status(500).json({ ok:false, error:"Proxy error", details:String(e?.message || e) });
  }
}
