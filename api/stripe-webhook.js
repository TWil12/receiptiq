// ReceiptIQ — /api/stripe-webhook.js
// Handles Stripe checkout for prepaid credit packs.
//
// Flow:
//   Customer buys a credit pack → Stripe fires checkout.session.completed
//   → webhook verifies signature → credits added to their api_keys row
//   → confirmation email sent
//
// Stripe setup (Dashboard → Developers → Webhooks → Add endpoint):
//   URL:    https://your-domain.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed   ← only one event needed now
//
// Stripe Products to create (one-time payments, NOT subscriptions):
//   Starter Pack  — $10  — metadata: credits=500
//   Growth Pack   — $25  — metadata: credits=1500   (saves $2.50 vs starter rate)
//   Scale Pack    — $100 — metadata: credits=7000   (saves $40 vs starter rate)
//
// Env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_PRICE_STARTER  — price ID for $10 pack
//   STRIPE_PRICE_GROWTH   — price ID for $25 pack
//   STRIPE_PRICE_SCALE    — price ID for $100 pack
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   RESEND_API_KEY
//   APP_URL

import Stripe from "stripe";
import { createHash, randomBytes } from "crypto";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function supabase(path, options = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey:         process.env.SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer:         "return=representation",
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Key generation ───────────────────────────────────────────────────────────

function generateRawKey() {
  return `riq_live_${randomBytes(16).toString("hex")}`;
}

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

async function isAlreadyProcessed(eventId) {
  try {
    const rows = await supabase(
      `/stripe_events?stripe_event_id=eq.${encodeURIComponent(eventId)}&select=stripe_event_id`,
      { method: "GET" }
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

async function markProcessed(eventId, eventType) {
  await supabase("/stripe_events", {
    method: "POST",
    body: JSON.stringify({ stripe_event_id: eventId, event_type: eventType }),
  });
}

// ─── Customer upsert ──────────────────────────────────────────────────────────

async function upsertCustomer(email, stripeCustomerId) {
  const existing = await supabase(
    `/customers?email=eq.${encodeURIComponent(email)}&select=id`,
    { method: "GET" }
  );
  if (Array.isArray(existing) && existing.length > 0) {
    const id = existing[0].id;
    await supabase(`/customers?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
    }).catch(() => {});
    return id;
  }
  const created = await supabase("/customers", {
    method: "POST",
    body: JSON.stringify({ email, stripe_customer_id: stripeCustomerId }),
  });
  return created[0].id;
}

// ─── Key provisioning (new customers) ────────────────────────────────────────

async function provisionKey(customerId, initialCredits) {
  const rawKey    = generateRawKey();
  const keyHash   = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  await supabase("/api_keys", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      key_hash:    keyHash,
      key_prefix:  keyPrefix,
      credits:     initialCredits,
      active:      true,
    }),
  });

  return rawKey;
}

// ─── Credit top-up (existing customers) ──────────────────────────────────────

async function addCredits(customerId, credits, stripePaymentIntentId, amountCents) {
  const keys = await supabase(
    `/api_keys?customer_id=eq.${customerId}&active=eq.true&select=id,credits`,
    { method: "GET" }
  );
  if (!keys?.length) throw new Error(`No active key for customer ${customerId}`);

  const keyId      = keys[0].id;
  const newBalance = (keys[0].credits || 0) + credits;

  await supabase(`/api_keys?id=eq.${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({ credits: newBalance }),
  });

  // Audit log — unique constraint on stripe_payment_intent_id prevents double-crediting
  await supabase("/credit_purchases", {
    method: "POST",
    body: JSON.stringify({
      api_key_id:               keyId,
      stripe_payment_intent_id: stripePaymentIntentId,
      credits_added:            credits,
      amount_cents:             amountCents,
    }),
  });

  return { keyId, newBalance };
}

// ─── Email: new customer ──────────────────────────────────────────────────────

async function sendNewKeyEmail(email, rawKey, credits, amountCents) {
  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{font-family:'Courier New',monospace;background:#f5f0e8;margin:0;padding:40px 20px}
  .card{background:white;max-width:520px;margin:0 auto;padding:40px;border:1px solid #d4cfc4;border-radius:4px}
  h1{font-size:1.4rem;color:#2d5a27;margin-bottom:8px}
  p{color:#1a1a14;font-size:0.85rem;line-height:1.7;margin-bottom:16px}
  .key-box{background:#0a0a08;color:#7ec87e;padding:16px 20px;border-radius:3px;font-size:0.88rem;letter-spacing:0.04em;margin:24px 0;word-break:break-all}
  .credits{background:#e8f5e3;border-left:3px solid #2d5a27;padding:12px 16px;font-size:0.82rem;margin-bottom:20px}
  .warn{background:#fff3d6;border-left:3px solid #c8860a;padding:12px 16px;font-size:0.78rem;margin-bottom:20px}
  .btn{display:inline-block;background:#2d5a27;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;font-size:0.78rem;letter-spacing:0.1em;text-transform:uppercase}
  .footer{margin-top:32px;font-size:0.68rem;color:#aaa}
</style></head>
<body><div class="card">
  <h1>Your ReceiptIQ API Key</h1>
  <div class="credits">✓ <strong>${credits} credits</strong> loaded · $${(amountCents/100).toFixed(2)} paid · $0.02 per receipt</div>
  <p><strong>Copy this key now — we will never show it again.</strong></p>
  <div class="key-box">${rawKey}</div>
  <div class="warn">⚠ Never commit this key to git or expose it in client-side code. Contact us immediately if compromised.</div>
  <p>Include it as the <code>x-api-key</code> header on every request. Each successful parse deducts 1 credit. Your remaining balance is always in <code>meta.credits_remaining</code> in the response.</p>
  <br>
  <a href="${process.env.APP_URL}/docs" class="btn">Read the docs →</a>
  <div class="footer">ReceiptIQ · No images stored · Reply with any questions.</div>
</div></body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "ReceiptIQ <receiptiq.dev@resend.dev>",
      to:      [email],
      subject: `Your ReceiptIQ API Key — ${credits} credits loaded`,
      html,
    }),
  });
}

// ─── Email: top-up ────────────────────────────────────────────────────────────

async function sendTopUpEmail(email, credits, newBalance, amountCents) {
  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{font-family:'Courier New',monospace;background:#f5f0e8;margin:0;padding:40px 20px}
  .card{background:white;max-width:520px;margin:0 auto;padding:40px;border:1px solid #d4cfc4;border-radius:4px}
  h1{font-size:1.4rem;color:#2d5a27;margin-bottom:8px}
  p{color:#1a1a14;font-size:0.85rem;line-height:1.7;margin-bottom:16px}
  .balance{background:#e8f5e3;border-left:3px solid #2d5a27;padding:16px 20px;font-size:1rem;margin:24px 0}
  .btn{display:inline-block;background:#2d5a27;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;font-size:0.78rem;letter-spacing:0.1em;text-transform:uppercase}
  .footer{margin-top:32px;font-size:0.68rem;color:#aaa}
</style></head>
<body><div class="card">
  <h1>Credits Added</h1>
  <p>Your ReceiptIQ account has been topped up.</p>
  <div class="balance">
    <div>Added: <strong>+${credits} credits</strong> ($${(amountCents/100).toFixed(2)})</div>
    <div style="margin-top:8px">New balance: <strong>${newBalance} credits</strong></div>
  </div>
  <p>Your existing API key works as-is — no changes needed on your end.</p>
  <br>
  <a href="${process.env.APP_URL}/#pricing" class="btn">Buy more credits →</a>
  <div class="footer">ReceiptIQ · No images stored · Reply with any questions.</div>
</div></body></html>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from:    "ReceiptIQ <receiptiq.dev@resend.dev>",
      to:      [email],
      subject: `ReceiptIQ — ${credits} credits added · ${newBalance} total remaining`,
      html,
    }),
  });
}

// ─── Vercel config ────────────────────────────────────────────────────────────

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end",  () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed." });

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch { return res.status(400).json({ error: "Could not read body." }); }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[receiptiq] Invalid webhook signature:", err.message);
    return res.status(400).json({ error: "Invalid signature." });
  }

  if (await isAlreadyProcessed(event.id))
    return res.status(200).json({ received: true, skipped: true });

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price", "customer", "payment_intent"],
      });

      const email            = fullSession.customer_details?.email || fullSession.customer?.email;
      const stripeCustomerId = typeof fullSession.customer === "string" ? fullSession.customer : fullSession.customer?.id;
      const paymentIntentId  = typeof fullSession.payment_intent === "string" ? fullSession.payment_intent : fullSession.payment_intent?.id;
      const amountCents      = fullSession.amount_total || 0;
      const credits          = parseInt(fullSession.line_items?.data?.[0]?.price?.metadata?.credits || "0", 10);

      if (!email)   throw new Error("No customer email in session");
      if (!credits) throw new Error(`No credits in price metadata for session ${session.id}`);

      const existing       = await supabase(`/customers?email=eq.${encodeURIComponent(email)}&select=id`, { method: "GET" });
      const isNewCustomer  = !Array.isArray(existing) || existing.length === 0;
      const customerId     = await upsertCustomer(email, stripeCustomerId);

      if (isNewCustomer) {
        const rawKey = await provisionKey(customerId, credits);
        // Log the purchase against the new key
        const keys = await supabase(`/api_keys?customer_id=eq.${customerId}&active=eq.true&select=id`, { method: "GET" });
        if (keys?.length && paymentIntentId) {
          await supabase("/credit_purchases", {
            method: "POST",
            body: JSON.stringify({ api_key_id: keys[0].id, stripe_payment_intent_id: paymentIntentId, credits_added: credits, amount_cents: amountCents }),
          }).catch(console.error);
        }
        await sendNewKeyEmail(email, rawKey, credits, amountCents);
        console.log(`[receiptiq] New customer ${email} — ${credits} credits provisioned`);
      } else {
        const { newBalance } = await addCredits(customerId, credits, paymentIntentId, amountCents);
        await sendTopUpEmail(email, credits, newBalance, amountCents);
        console.log(`[receiptiq] Topped up ${email} — +${credits} credits → ${newBalance} total`);
      }
    }

    await markProcessed(event.id, event.type);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error(`[receiptiq] Error handling ${event.type}:`, err);
    return res.status(500).json({ error: "Handler failed. Stripe will retry." });
  }
}
