// api/order.js — Vercel Serverless Function
const https = require("https");

// ─── Config (Matches your Vercel Dashboard exactly) ───────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_DOMAIN;       // e.g. "1tymmh-7c.myshopify.com"
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API access token (shpat_...)

// ─── Main Handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, city, address, qty, variantId, packDetails } = req.body;

  // ── Validate required fields ──────────────────────────────────────────
  const missing = [];
  if (!name)      missing.push("name");
  if (!phone)     missing.push("phone");
  if (!city)      missing.push("city");
  if (!address)   missing.push("address");
  if (!variantId) missing.push("variantId");
  if (missing.length) {
    return res.status(400).json({ error: "Missing fields", fields: missing });
  }

  // ── Build Shopify order payload ───────────────────────────────────────
  const orderPayload = {
    order: {
      financial_status: "pending",
      fulfillment_status: null,
      send_receipt: false,
      send_fulfillment_receipt: false,
      
      // FIX: Providing phone here instead of a nested customer object 
      // allows Shopify to link existing customers automatically.
      phone: phone,

      shipping_address: {
        first_name:   name.split(" ")[0] || name,
        last_name:    name.split(" ").slice(1).join(" ") || ".",
        phone:        phone,
        address1:     address,
        city:         city,
        province:     "",
        zip:          "",
        country:      "Morocco",
        country_code: "MA",
      },

      billing_address: {
        first_name:   name.split(" ")[0] || name,
        last_name:    name.split(" ").slice(1).join(" ") || ".",
        phone:        phone,
        address1:     address,
        city:         city,
        country:      "Morocco",
        country_code: "MA",
      },

      line_items: [
        {
          variant_id: variantId,
          quantity:   parseInt(qty, 10) || 1,
        },
      ],

      note: packDetails
        ? `COD Order — Items: ${packDetails}`
        : `COD Order — Qty: ${qty}`,

      tags: "COD, Halo-Frame",
    },
  };

  // ── Create Shopify order ──────────────────────────────────────────────
  try {
    const shopifyOrder = await shopifyPost(
      `/admin/api/2024-04/orders.json`,
      orderPayload
    );
    
    const orderId     = shopifyOrder.order?.id;
    const orderNumber = shopifyOrder.order?.order_number;

    return res.status(200).json({ success: true, orderId, orderNumber });
    
  } catch (err) {
    console.error("[Shopify Error]", err.message, err.body || "");
    return res.status(502).json({ error: "Failed to create Shopify order", detail: err.message });
  }
};

// ─── Shopify Admin API Helper ──────────────────────────────────────────────
function shopifyPost(path, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const options = {
      hostname: SHOPIFY_STORE,
      path,
      method:   "POST",
      headers: {
        "Content-Type":           "application/json",
        "Content-Length":         Buffer.byteLength(data),
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      },
    };

    const request = https.request(options, (response) => {
      let raw = "";
      response.on("data", (chunk) => (raw += chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (response.statusCode >= 400) {
            const err = new Error(`Shopify ${response.statusCode}`);
            err.body  = JSON.stringify(parsed.errors || parsed);
            return reject(err);
          }
          resolve(parsed);
        } catch {
          reject(new Error("Invalid JSON from Shopify"));
        }
      });
    });

    request.on("error", reject);
    request.setTimeout(9000, () => {
      request.destroy(new Error("Shopify request timed out"));
    });
    request.write(data);
    request.end();
  });
}
