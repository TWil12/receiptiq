// ReceiptIQ — /api/provision-free.js
// Provisions a free-tier API key when someone signs up without Stripe.
// Rate-limited to 1 key per email address.
//
// Also exports a session-info handler (put in /api/session-info.js separately).

import { createHash, randomBytes } from "crypto";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" });

// ─── Supabase helper ──────────────────────────────────────────────────────────

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

// ─── Key helpers ──────────────────────────────────────────────────────────────

function generateRawKey() {
  return `riq_live_${randomBytes(16).toString("hex")}`;
}

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── Email sending (Resend) ───────────────────────────────────────────────────

async function sendKeyEmail(email, rawKey) {
  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{font-family:'Courier New',monospace;background:#f5f0e8;margin:0;padding:40px 20px}
  .card{background:white;max-width:520px;margin:0 auto;padding:40px;border:1px solid #d4cfc4;border-radius:4px}
  h1{font-size:1.4rem;color:#2d5a27;margin-bottom:8px}
  p{color:#1a1a14;font-size:0.85rem;line-height:1.7;margin-bottom:16px}
  .key-box{background:#0a0a08;color:#7ec87e;padding:16px 20px;border-radius:3px;font-size:0.88rem;letter-spacing:0.04em;margin:24px 0;word-break:break-all}
  .warn{background:#fff3d6;border-left:3px solid #c8860a;padding:12px 16px;font-size:0.78rem;color:#1a1a14;margin-bottom:20px}
  .btn{display:inline-block;background:#2d5a27;color:white;padding:12px 24px;text-decoration:none;border-radius:2px;font-size:0.78rem;letter-spacing:0.1em;text-transform:uppercase}
  .footer{margin-top:32px;font-size:0.68rem;color:#aaa}
</style></head>
<body><div class="card">
  <h1>Your ReceiptIQ API Key</h1>
  <p>You're on the <strong>Starter Plan</strong> — <strong>100 receipts/month, free forever.</strong></p>
  <p><strong>Copy this key now. We will never show it again.</strong></p>
  <div class="key-box">${rawKey}</div>
  <div class="warn">⚠ Never commit this key to git or expose it in client-side code. Contact us immediately if compromised.</div>
  <p>Use it as the <code>x-api-key</code> header:</p>
  <pre style="background:#f5f0e8;padding:12px;font-size:0.76rem;border-radius:2px;overflow:auto">curl -X POST https://api.receiptiq.dev/v1/parse \\
  -H "x-api-key: YOUR_KEY" \\
  -d '{"url":"https://example.com/receipt.jpg"}'</pre>
  <br>
  <a href="${process.env.APP_URL}/docs" class="btn">Read the docs →</a>
  <div class="footer">ReceiptIQ · No images stored · Reply with any questions.</div>
</div></body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from:    "ReceiptIQ <receiptiq>@weanol.resend.app",
      to:      [email],
      subject: "Your ReceiptIQ API Key — Starter Plan",
      html,
    }),
  });

  if (!res.ok) throw new Error(`Email send failed: ${await res.text()}`);
}

// ─── Provision-free handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed." });

  const { email } = req.body || {};

  // Basic email validation
  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Valid email address required." });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    // Check if this email already has a key (prevent duplicate provisioning)
    const existing = await supabase(
      `/customers?email=eq.${encodeURIComponent(normalizedEmail)}&select=id`,
      { method: "GET" }
    );

    if (Array.isArray(existing) && existing.length > 0) {
      // Already signed up — don't reveal this directly (prevents email enumeration)
      // Just return success so they check their email
      return res.status(200).json({ ok: true });
    }

    // Create customer
    const customers = await supabase("/customers", {
      method: "POST",
      body: JSON.stringify({ email: normalizedEmail }),
    });
    const customerId = customers[0].id;

    // Generate and provision key
    const rawKey  = generateRawKey();
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);

    await supabase("/api_keys", {
      method: "POST",
      body: JSON.stringify({
        customer_id:   customerId,
        key_hash:      keyHash,
        key_prefix:    keyPrefix,
        plan:          "free",
        monthly_limit: 100,
        active:        true,
      }),
    });

    // Send email with raw key
    await sendKeyEmail(normalizedEmail, rawKey);

    // rawKey is now discarded — it only lived in this function's memory
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("[receiptiq] Free provision error:", err);
    return res.status(500).json({ error: "Could not provision key. Try again shortly." });
  }
}
