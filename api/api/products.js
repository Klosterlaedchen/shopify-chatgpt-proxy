// /api/products.js – schlanke Produktsuche über Shopify Storefront API
export default async function handler(req, res) {
  const { SHOPIFY_STOREFRONT_TOKEN, SHOPIFY_DOMAIN } = process.env;

  // CORS (einfach): alles erlauben für schnellen Test
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const url = new URL(req.url, "http://x");
    const q = (url.searchParams.get("query") || "").trim();
    if (!q) {
      return res.status(400).json({ ok: false, error: "Missing ?query=term" });
    }

    const endpoint = `https://${SHOPIFY_DOMAIN}/api/2024-04/graphql.json`;
    const gql = `
      query SearchProducts($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
              handle
              availableForSale
              totalInventory
              onlineStoreUrl
              images(first: 1) { edges { node { url altText } } }
            }
          }
        }
      }
    `;
    const body = JSON.stringify({
      query: gql,
      variables: { query: q, first: 10 },
    });

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body,
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: "Shopify error",
        status: r.status,
        details: data,
      });
    }

    const items =
      data?.data?.products?.edges?.map(({ node }) => ({
        id: node.id,
        title: node.title,
        url:
          node.onlineStoreUrl ||
          `https://${SHOPIFY_DOMAIN.replace(".myshopify.com", "")}.store/products/${node.handle}`,
        inStock: node.availableForSale,
        totalInventory: node.totalInventory,
        image: node.images?.edges?.[0]?.node?.url || null,
      })) ?? [];

    return res.status(200).json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error("products endpoint error", err);
    return res.status(500).json({ ok: false, error: err.message || "Internal Error" });
  }
}
