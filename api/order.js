// api/order.js — Vercel Serverless Function
// Deploy to Vercel. Set env vars in Vercel dashboard (never hardcode secrets).

const https = require("https");

// ─── Config (set these in Vercel → Settings → Environment Variables) ───────
const SHOPIFY_STORE   = process.env.SHOPIFY_STORE;    // e.g. "my-store.myshopify.com"
const SHOPIFY_TOKEN   = process.env.SHOPIFY_TOKEN;    // Admin API access token
const ULTRAMSG_INSTANCE = process.env.SHOPIFY_API_SECRET; // e.g. "instance12345"
const ULTRAMSG_TOKEN  = process.env.SHOPIFY_SHOP_NAME;

// ─── Main Handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS — allow requests from your Shopify storefront
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

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
  // FIX: Use `address1` (not `address`). Add country/country_code so
  // Shopify saves the full shipping address instead of silently dropping it.
  const orderPayload = {
    order: {
      financial_status: "pending",
      fulfillment_status: null,
      send_receipt: false,
      send_fulfillment_receipt: false,

      // Customer block — splits name into first/last automatically
      customer: {
        first_name: name.split(" ")[0] || name,
        last_name:  name.split(" ").slice(1).join(" ") || ".",
        phone:      phone,
      },

      // Shipping address — FIX: address1 + country_code are REQUIRED
      shipping_address: {
        first_name:   name.split(" ")[0] || name,
        last_name:    name.split(" ").slice(1).join(" ") || ".",
        phone:        phone,
        address1:     address,   // ← was "address", must be "address1"
        city:         city,
        province:     "",
        zip:          "",
        country:      "Morocco",
        country_code: "MA",      // ← required for Shopify to save the address
      },

      // Billing = same as shipping (required to avoid order warnings)
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

      // Store pack details in order note so you see it in Shopify admin
      note: packDetails
        ? `COD Order — Items: ${packDetails}`
        : `COD Order — Qty: ${qty}`,

      tags: "COD, Halo-Frame",
    },
  };

  // ── Create Shopify order ──────────────────────────────────────────────
  let shopifyOrder;
  try {
    shopifyOrder = await shopifyPost(
      `/admin/api/2024-04/orders.json`,
      orderPayload
    );
  } catch (err) {
    console.error("[Shopify Error]", err.message, err.body || "");
    return res.status(502).json({ error: "Failed to create Shopify order", detail: err.message });
  }

  const orderId     = shopifyOrder.order?.id;
  const orderNumber = shopifyOrder.order?.order_number;

  // ── Respond immediately so the customer isn't waiting ────────────────
  res.status(200).json({ success: true, orderId, orderNumber });

  // ── Send WhatsApp after 15 min (non-blocking, fire and forget) ────────
  // Vercel functions time out at 10s on hobby plan — use a background
  // approach: schedule via setTimeout only on paid plans, or use a free
  // cron service like cron-job.org to hit /api/notify separately.
  // For now: send immediately (customers prefer quick confirmation).
  if (ULTRAMSG_INSTANCE && ULTRAMSG_TOKEN) {
    try {
      await sendWhatsApp(phone, name, orderNumber, qty, city, packDetails);
    } catch (err) {
      console.error("[WhatsApp Error]", err.message);
      // Non-fatal — order is already created
    }
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
        "Content-Type":                 "application/json",
        "Content-Length":               Buffer.byteLength(data),
        "X-Shopify-Access-Token":       SHOPIFY_TOKEN,
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
    request.setTimeout(9000, () => {           // 9s — safely under Vercel 10s limit
      request.destroy(new Error("Shopify request timed out"));
    });
    request.write(data);
    request.end();
  });
}

// ─── UltraMsg WhatsApp Helper ──────────────────────────────────────────────
function sendWhatsApp(phone, name, orderNumber, qty, city, packDetails) {
  const message = [
    `🛍️ *New HALO FRAME Order #${orderNumber}*`,
    ``,
    `👤 *Customer:* ${name}`,
    `📞 *Phone:* ${phone}`,
    `📍 *City:* ${city}`,
    `📦 *Qty:* ${qty}`,
    packDetails ? `🎯 *Items:* ${packDetails}` : "",
    ``,
    `💰 *Payment:* Cash on Delivery`,
    `✅ Status: Pending confirmation`,
  ].filter(Boolean).join("\n");

  const body = new URLSearchParams({
    token: ULTRAMSG_TOKEN,
    to:    phone,
    body:  message,
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.ultramsg.com",
      path:     `/${ULTRAMSG_INSTANCE}/messages/chat`,
      method:   "POST",
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
