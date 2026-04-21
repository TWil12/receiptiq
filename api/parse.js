// ReceiptIQ — /api/parse.js
// Production receipt parser — credit-based billing ($0.02/receipt = 1 credit)
//
// Environment variables:
//   ANTHROPIC_API_KEY    — Anthropic API key
//   CLAUDE_MODEL         — e.g. claude-sonnet-4-20250514
//   UPSTASH_REDIS_URL    — Upstash Redis REST URL (abuse protection)
//   UPSTASH_REDIS_TOKEN  — Upstash Redis REST token
//   SUPABASE_URL         — Supabase project URL
//   SUPABASE_SERVICE_KEY — Supabase service role key

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES   = 5 * 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 25_000;
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fd[0-9a-f]{2}:/i,
];

// ─── Clients ──────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function redis(command, ...args) {
  const url = `${process.env.UPSTASH_REDIS_URL}/${command}/${args.map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}` },
  });
  return (await res.json()).result;
}

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

// ─── Key hashing ──────────────────────────────────────────────────────────────

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── API key lookup ───────────────────────────────────────────────────────────

async function validateApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || rawKey.length < 20) return null;
  const hash = hashKey(rawKey);
  const rows = await supabase(
    `/api_keys?key_hash=eq.${encodeURIComponent(hash)}&active=eq.true&select=id,credits`,
    { method: "GET" }
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // Update last_used_at non-blocking
  supabase(`/api_keys?id=eq.${rows[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});

  return rows[0]; // { id, credits }
}

// ─── Credit deduction ─────────────────────────────────────────────────────────
// Returns the updated credits balance, or null if insufficient credits.
// Uses optimistic concurrency: only deducts if credits > 0.

async function deductCredit(keyId, currentCredits) {
  if (currentCredits <= 0) return null;

  const updated = await supabase(
    // WHERE clause ensures we only deduct if credits haven't changed under us
    `/api_keys?id=eq.${keyId}&credits=eq.${currentCredits}&active=eq.true`,
    {
      method: "PATCH",
      body: JSON.stringify({ credits: currentCredits - 1 }),
    }
  );

  // If the update matched 0 rows, another request beat us (race condition)
  // Reload the current balance and check again
  if (!Array.isArray(updated) || updated.length === 0) {
    const fresh = await supabase(
      `/api_keys?id=eq.${keyId}&active=eq.true&select=id,credits`,
      { method: "GET" }
    );
    if (!fresh?.length || fresh[0].credits <= 0) return null;
    // Retry once with fresh balance
    return deductCredit(keyId, fresh[0].credits);
  }

  return updated[0].credits; // remaining balance after deduction
}

// ─── Abuse protection: per-IP burst limit via Redis ──────────────────────────
// Caps at 10 requests per 10 seconds per IP to prevent hammering.
// This is separate from credit limits — protects against DoS even with valid keys.

async function checkBurstLimit(ip) {
  try {
    const key   = `burst:${ip}`;
    const count = await redis("incr", key);
    if (count === 1) await redis("expire", key, 10);
    return count <= 10;
  } catch {
    return true; // fail open if Redis is down
  }
}

// ─── Usage logging ────────────────────────────────────────────────────────────

async function logUsage(keyId, success, errorType = null, durationMs = null) {
  try {
    await supabase("/usage_logs", {
      method: "POST",
      body: JSON.stringify({
        api_key_id:       keyId,
        success,
        error_type:       errorType,
        duration_ms:      durationMs,
        credits_deducted: success ? 1 : 0,
      }),
    });
  } catch {
    console.error("[receiptiq] Failed to write usage log");
  }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateUrl(raw) {
  if (!raw.startsWith("https://")) return "URL must use https://";
  let u;
  try { u = new URL(raw); } catch { return "Invalid URL format"; }
  for (const p of BLOCKED_HOST_PATTERNS) {
    if (p.test(u.hostname)) return "URL resolves to a private address";
  }
  return null;
}

function validateMediaType(mt) {
  return ALLOWED_MEDIA_TYPES.has(mt)
    ? null
    : `Unsupported type. Allowed: ${[...ALLOWED_MEDIA_TYPES].join(", ")}`;
}

// ─── Claude call ──────────────────────────────────────────────────────────────

async function callClaude(imageContent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const resp = await anthropic.messages.create(
      {
        model:      CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            imageContent,
            {
              type: "text",
              text: `Parse this receipt or invoice into structured JSON. Return ONLY valid JSON — no markdown, no explanation, no preamble.

{
  "merchant":    { "name": string, "address": string|null, "phone": string|null, "website": string|null },
  "transaction": { "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "receipt_number": string|null, "payment_method": string|null },
  "items":       [ { "description": string, "quantity": number, "unit_price": number, "total": number } ],
  "totals":      { "subtotal": number|null, "tax": number|null, "tip": number|null, "discount": number|null, "total": number },
  "currency":    string,
  "category":    "restaurant"|"grocery"|"retail"|"travel"|"medical"|"utilities"|"other"
}

Use null for missing/unclear fields. All monetary values must be numbers, not strings.`,
            },
          ],
        }],
      },
      { signal: controller.signal }
    );
    return resp.content[0].text.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const start = Date.now();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed." });

  // 1 · Burst limit (IP-based, Redis)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const burstOk = await checkBurstLimit(ip);
  if (!burstOk)
    return res.status(429).json({ error: "Too many requests. Slow down and try again." });

  // 2 · Auth — hash key and look up in Supabase
  const rawKey = req.headers["x-api-key"];
  if (!rawKey)
    return res.status(401).json({ error: "Missing x-api-key header.", docs: "https://receiptiq.dev/docs" });

  let keyRecord;
  try { keyRecord = await validateApiKey(rawKey); }
  catch (err) {
    console.error("[receiptiq] DB error:", err);
    return res.status(503).json({ error: "Service unavailable. Try again shortly." });
  }
  if (!keyRecord)
    return res.status(401).json({ error: "Invalid or inactive API key." });

  // 3 · Check credits before doing any work
  if (keyRecord.credits <= 0)
    return res.status(402).json({
      error:             "No credits remaining.",
      credits_remaining: 0,
      top_up:            "https://receiptiq.dev/#pricing",
    });

  // 4 · Validate request body
  const { image, url, media_type } = req.body || {};
  if (!image && !url)
    return res.status(400).json({
      error:   "Provide image (base64) or url.",
      example: { url: "https://example.com/receipt.jpg" },
    });

  let imageContent;
  if (url) {
    const err = validateUrl(url);
    if (err) return res.status(400).json({ error: err });
    imageContent = { type: "image", source: { type: "url", url } };
  } else {
    if (typeof image !== "string")
      return res.status(400).json({ error: "image must be a base64 string." });
    if (image.length > MAX_IMAGE_BYTES * 1.37)
      return res.status(413).json({ error: "Image exceeds 5MB limit." });
    const mtErr = validateMediaType(media_type || "image/jpeg");
    if (mtErr) return res.status(400).json({ error: mtErr });
    imageContent = { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image } };
  }

  // 5 · Deduct 1 credit BEFORE calling Claude
  //     If Claude fails we refund — but deducting first prevents race conditions
  //     where someone fires 1000 requests simultaneously on 1 credit.
  let creditsAfter;
  try {
    creditsAfter = await deductCredit(keyRecord.id, keyRecord.credits);
  } catch (err) {
    console.error("[receiptiq] Credit deduction error:", err);
    return res.status(503).json({ error: "Service unavailable. Try again shortly." });
  }

  if (creditsAfter === null)
    return res.status(402).json({
      error:             "No credits remaining.",
      credits_remaining: 0,
      top_up:            "https://receiptiq.dev/#pricing",
    });

  // 6 · Call Claude
  let raw;
  try {
    raw = await callClaude(imageContent);
  } catch (err) {
    // Refund the credit on failure — customer shouldn't pay for our errors
    await supabase(`/api_keys?id=eq.${keyRecord.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credits: creditsAfter + 1 }),
    }).catch(() => {});

    const duration = Date.now() - start;
    if (err.name === "AbortError") {
      await logUsage(keyRecord.id, false, "timeout", duration);
      return res.status(504).json({ error: "Timed out. Try a clearer image." });
    }
    console.error("[receiptiq] Claude error:", err);
    await logUsage(keyRecord.id, false, "claude_error", duration);
    return res.status(502).json({ error: "AI service error. Try again. Credit refunded." });
  }

  // 7 · Parse JSON response
  let parsed;
  try {
    const clean = raw.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    // Refund credit — bad image is debatable, but good for trust
    await supabase(`/api_keys?id=eq.${keyRecord.id}`, {
      method: "PATCH",
      body: JSON.stringify({ credits: creditsAfter + 1 }),
    }).catch(() => {});
    console.error("[receiptiq] JSON parse failed. Raw:", raw);
    await logUsage(keyRecord.id, false, "parse_error", Date.now() - start);
    return res.status(422).json({
      error: "Could not extract data from this image. Try a clearer photo. Credit refunded.",
    });
  }

  // 8 · Log success and respond
  const duration = Date.now() - start;
  await logUsage(keyRecord.id, true, null, duration);

  return res.status(200).json({
    success: true,
    data:    parsed,
    meta: {
      model:              CLAUDE_MODEL,
      processing_time_ms: duration,
      api_version:        "v1",
      credits_remaining:  creditsAfter,
    },
  });
}
