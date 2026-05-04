// api/order.js — Vercel Serverless Function
const https = require("https");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────
const SHOPIFY_STORE   = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const FB_PIXEL_ID     = "1526974165452583";
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

// ─── Hash helper (Facebook requires SHA256 for PII) ───────────────────────
const hash = (value) =>
  crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");

// ─── Main Handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const { name, phone, city, address, qty, variantId, packDetails, totalPrice, sourceUrl } = req.body;

  // ── Validate ──────────────────────────────────────────────────────────
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
      phone,
      shipping_address: {
        first_name:   name.split(" ")[0] || name,
        last_name:    name.split(" ").slice(1).join(" ") || ".",
        phone,
        address1:     address,
        city,
        province:     "",
        zip:          "",
        country:      "Morocco",
        country_code: "MA",
      },
      billing_address: {
        first_name:   name.split(" ")[0] || name,
        last_name:    name.split(" ").slice(1).join(" ") || ".",
        phone,
        address1:     address,
        city,
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
  let orderId, orderNumber, orderValue;
  try {
    const shopifyOrder = await shopifyPost(`/admin/api/2024-04/orders.json`, orderPayload);
    orderId     = shopifyOrder.order?.id;
    orderNumber = shopifyOrder.order?.order_number;
    orderValue  = shopifyOrder.order?.total_price || totalPrice || "0.00";
  } catch (err) {
    console.error("[Shopify Error]", err.message, err.body || "");
    return res.status(502).json({ error: "Failed to create Shopify order", detail: err.message });
  }

  // ── Fire Facebook Purchase event (server-side) ────────────────────────
  try {
    let cleanPhone = phone.replace(/[\s\-().]/g, "");
    if (!cleanPhone.startsWith("+")) cleanPhone = "+212" + cleanPhone.replace(/^0/, "");

    const eventPayload = {
      test_event_code: "TEST996",   // ⚠️ REMOVE THIS LINE BEFORE GOING LIVE
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(Date.now() / 1000),
          event_id:   `order_${orderId}`,
          action_source: "website",
          event_source_url: sourceUrl || "https://haloframe.shop",
          user_data: {
            ph:      [hash(cleanPhone)],
            fn:      [hash(name.split(" ")[0] || name)],
            ln:      [hash(name.split(" ").slice(1).join(" ") || name)],
            ct:      [hash(city)],
            country: [hash("ma")],
          },
          custom_data: {
            currency:     "MAD",
            value:        parseFloat(orderValue),
            content_ids:  [String(variantId)],
            content_type: "product",
            order_id:     String(orderId),
          },
        },
      ],
    };

    await fbPost(`/v19.0/${FB_PIXEL_ID}/events`, eventPayload);
    console.log(`[FB Event] Purchase fired for order ${orderNumber}`);
  } catch (fbErr) {
    console.error("[FB Event Error]", fbErr.message);
  }

  return res.status(200).json({ success: true, orderId, orderNumber });
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
    request.setTimeout(9000, () => request.destroy(new Error("Shopify request timed out")));
    request.write(data);
    request.end();
  });
}

// ─── Facebook Conversions API Helper ──────────────────────────────────────
function fbPost(path, body) {
  return new Promise((resolve, reject) => {
    const data     = JSON.stringify(body);
    const fullPath = `${path}?access_token=${FB_ACCESS_TOKEN}`;
    const options  = {
      hostname: "graph.facebook.com",
      path:     fullPath,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const request = https.request(options, (response) => {
      let raw = "";
      response.on("data", (chunk) => (raw += chunk));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (response.statusCode >= 400) {
            const err = new Error(`FB API ${response.statusCode}`);
            err.body  = JSON.stringify(parsed.error || parsed);
            return reject(err);
          }
          resolve(parsed);
        } catch {
          reject(new Error("Invalid JSON from Facebook"));
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(9000, () => request.destroy(new Error("FB request timed out")));
    request.write(data);
    request.end();
  });
}
