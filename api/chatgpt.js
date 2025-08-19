// ChatGPT-Produktberater – Dynamische Shopify-Suche + GPT-Empfehlung
// - Sucht live im Storefront-Index nach den Begriffen aus der Nutzerfrage
// - Nutzt Titel, Tags, Produkttyp, Vendor (Hersteller) für die Suche
// - Liefert Verfügbarkeit (availableForSale / quantityAvailable) & Preis
// - Gibt bei Erfolg immer { ok: true, text } zurück

export default async function handler(req, res) {
  // ===== CORS (mehrere erlaubte Origins erlaubt) =====
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
    // ===== Body prüfen =====
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { message, context } = body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Missing 'message' (string) in body." });
    }

    // ===== Shopify Settings =====
    const shopDomain = process.env.SHOPIFY_DOMAIN;             // z.B. dianas-klosterlaedchen.myshopify.com
    const sfToken     = process.env.SHOPIFY_STOREFRONT_TOKEN;   // Storefront Access Token
    let products = [];

    if (shopDomain && sfToken) {
      // ---------- Schlüsselwörter aus der Nutzerfrage ----------
      const words = message.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(w =>
          w.length >= 2 && // kurze Begriffe wie "tee" zulassen
          !["und","oder","mit","für","als","ein","eine","der","die","das","den","des","von","im","in","am"].includes(w)
        );

      // Wenn der Nutzer nur sehr wenig sagt, geben wir wenigstens etwas Allgemeines an Shopify
      const baseQuery = words.length ? words.join(" ") : "available_for_sale:true";

      // Gemeinsames GraphQL (wir variieren nur die Query-Variable)
      const gql = `
        query Search($query: String!) {
          products(first: 50, query: $query) {
            edges {
              node {
                id
                title
                handle
                vendor
                productType
                tags
                description(truncateAt: 200)
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

      const endpoint = `https://${shopDomain}/api/2024-07/graphql.json`;
      const headers = {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": sfToken,
      };

      // ---------- 1) Volltext: Wörter einfach hintereinander ----------
      // (Shopify durchsucht u. a. Titel, Produkttyp, Vendor, Tags)
      let queryExpr = baseQuery;
      let r = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: gql, variables: { query: queryExpr } })
      });
      let j = r.ok ? await r.json() : null;
      let edges = j?.data?.products?.edges || [];

      // ---------- 2) Feld-OR (exaktere Suche), wenn noch keine Treffer ----------
      if (!edges.length && words.length) {
        // OR über Felder title / tag / product_type / vendor
        const fieldOr = words
          .map(w => `(title:'${escapeSingle(w)}' OR tag:'${escapeSingle(w)}' OR product_type:'${escapeSingle(w)}' OR vendor:'${escapeSingle(w)}')`)
          .join(" OR ");
        queryExpr = fieldOr;

        r = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: gql, variables: { query: queryExpr } })
        });
        j = r.ok ? await r.json() : null;
        edges = j?.data?.products?.edges || [];
      }

      // ---------- 3) Letzter Fallback: breite Suche auf verfügbare Artikel ----------
      if (!edges.length) {
        queryExpr = "available_for_sale:true";
        r = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ query: gql, variables: { query: queryExpr } })
        });
        j = r.ok ? await r.json() : null;
        edges = j?.data?.products?.edges || [];
      }

      // ---------- Produkt-Mapping ----------
      const frontendBase =
        (process.env.FRONTEND_BASE_URL || "").replace(/\/$/, "") ||
        allowList.find(o => /^https?:\/\/[^ ]+/.test(o)) ||
        `https://${shopDomain}`;

      products = edges.map(e => {
        const n = e.node;
        const v = n.variants?.edges?.[0]?.node;
        const url = n.onlineStoreUrl || `${frontendBase}/products/${n.handle}`;
        return {
          title: n.title,
          desc: n.description || "",
          tags: n.tags,
          productType: n.productType,
          vendor: n.vendor,
          url,
          image: n.featuredImage?.url || "",
          available: (v?.availableForSale ?? n.availableForSale) ?? true,
          qty: (typeof v?.quantityAvailable === "number") ? v.quantityAvailable : null,
          price: v?.price?.amount ? `${v.price.amount} ${v.price.currencyCode}` : null
        };
      });

      // Nur sinnvolle Menge an GPT geben
      if (products.length > 60) products = products.slice(0, 60);
    }

    // ===== GPT-Antwort (aus Produkten filtern & empfehlen) =====
    const systemPrompt = [
      "Du bist ein Produktberater für einen Shopify-Shop. Antworte kurz, klar und freundlich.",
      "Du bekommst Produktdaten als JSON. Wähle 3–5 passende Empfehlungen aus (keine Erfindungen).",
      "Gib je Empfehlung: Titel, 1 Satz Nutzen, Preis (falls vorhanden) und klickbaren Link.",
      "Verfügbarkeit: '✅ Auf Lager' (qty>5 oder available true), '⚠️ Begrenzt' (1–5), '❌ Nicht verfügbar' (0/false).",
      "Wenn die Liste leer ist, stelle genau 1 gezielte Rückfrage zur Präzisierung.",
    ].join(" ");

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const compact = products.map(p => ({
      title: p.title,
      desc: p.desc,
      tags: p.tags,
      productType: p.productType,
      vendor: p.vendor,
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
          { role: "user", content: `Nutzerfrage: ${message}\nKontext: ${JSON.stringify(context || {})}\nGefundene Produkte(JSON): ${JSON.stringify(compact)}` }
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

// Einfache Escaping-Hilfe für einzelne Quotes im Shopify-Query
function escapeSingle(s) {
  return String(s).replace(/'/g, "\\'");
}
