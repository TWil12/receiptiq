// ReceiptIQ — /api/checkout.js
// Creates a Stripe Checkout session for a one-time credit pack purchase.
//
// Usage: GET /api/checkout?pack=starter | growth | scale
//
// Stripe Products to create (Dashboard → Product Catalog → Add Product):
//   All three must be ONE-TIME payments, not subscriptions.
//
//   Pack        Price   Credits   Per-receipt rate
//   ─────────── ─────── ───────── ────────────────
//   Starter     $10     500       $0.020 (standard rate)
//   Growth      $25     1,500     $0.017 (15% cheaper)
//   Scale       $100    7,000     $0.014 (30% cheaper)
//
//   On each Price, add metadata:  credits = 500  (or 1500 / 7000)
//
// Env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_STARTER  — price ID, e.g. price_abc123
//   STRIPE_PRICE_GROWTH   — price ID
//   STRIPE_PRICE_SCALE    — price ID
//   APP_URL               — https://receiptiq.dev

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });

const PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  growth:  process.env.STRIPE_PRICE_GROWTH,
  scale:   process.env.STRIPE_PRICE_SCALE,
};

export default async function handler(req, res) {
  const pack = (req.method === "GET" ? req.query.pack : req.body?.pack) || "starter";

  if (!PRICE_IDS[pack]) {
    return res.status(400).json({
      error: `Unknown pack: ${pack}. Use starter, growth, or scale.`,
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 "payment",   // one-time purchase, not subscription
      payment_method_types: ["card"],
      line_items:           [{ price: PRICE_IDS[pack], quantity: 1 }],
      success_url:          `${process.env.APP_URL}/welcome.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${process.env.APP_URL}/#pricing`,
      allow_promotion_codes: true,
      // Pre-fill email if returning customer comes from their dashboard
      ...(req.query.email ? { customer_email: req.query.email } : {}),
    });

    return res.redirect(303, session.url);

  } catch (err) {
    console.error("[receiptiq] Checkout error:", err);
    return res.status(500).json({ error: "Could not create checkout session. Try again." });
  }
}
