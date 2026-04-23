// ReceiptIQ — /api/parse.js
// Production receipt parser — credit-based billing, RapidAPI integration, and Redis Trial

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";

// ─── Vercel Environment Safety Check ──────────────────────────────────────────
const REQUIRED_ENVS = [
  'ANTHROPIC_API_KEY',
  'UPSTASH_REDIS_URL',
  'UPSTASH_REDIS_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RAPIDAPI_PROXY_SECRET' // Add this to your Vercel settings
];

const missingEnvs = REQUIRED_ENVS.filter(key => !process.env[key]);
if (missingEnvs.length > 0) {
  // We log instead of throw so the function doesn't completely crash on boot,
  // but we will catch it during execution if a required key is hit.
  console.error(`[receiptiq] Critical: Missing env variables: ${missingEnvs.join(', ')}`);
}

// ─── Config ───────────────────────────────────────────────────────────────────
const MAX_IMAGE_BYTES   = 5 * 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 25_000;
const CLAUDE_MODEL      = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
const TRIAL_CREDIT_LIMIT = 10;
const RAPIDAPI_SECRET   = process.env.RAPIDAPI_PROXY_SECRET;

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

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// ─── Core Logic (Abuse, Deduction, AI) ────────────────────────────────────────

async function validateApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string" || rawKey.length < 20) return null;
  const hash = hashKey(rawKey);
  const rows = await supabase(
    `/api_keys?key_hash=eq.${encodeURIComponent(hash)}&active=eq.true&select=id,credits`,
    { method: "GET" }
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  
  supabase(`/api_keys?id=eq.${rows[0].id}`, {
    method: "PATCH",
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
  return rows[0];
}

async function deductCredit(keyId, currentCredits) {
  if (currentCredits <= 0) return null;
  const updated = await supabase(
    `/api_keys?id=eq.${keyId}&credits=eq.${currentCredits}&active=eq.true`,
    { method: "PATCH", body: JSON.stringify({ credits: currentCredits - 1 }) }
  );
  if (!Array.isArray(updated) || updated.length === 0) {
    const fresh = await supabase(`/api_keys?id=eq.${keyId}&active=eq.true&select=id,credits`, { method: "GET" });
    if (!fresh?.length || fresh[0].credits <= 0) return null;
    return deductCredit(keyId, fresh[0].credits);
  }
  return updated[0].credits;
}

async function checkBurstLimit(ip) {
  try {
    const key   = `burst:${ip}`;
    const count = await redis("incr", key);
    if (count === 1) await redis("expire", key, 10);
    return count <= 10;
  } catch { return true; }
}

async function logUsage(keyId, success, errorType = null, durationMs = null) {
  try {
    await supabase("/usage_logs", {
      method: "POST",
      body: JSON.stringify({ api_key_id: keyId, success, error_type: errorType, duration_ms: durationMs, credits_deducted: success ? 1 : 0 }),
    });
  } catch { console.error("[receiptiq] Failed to write usage log"); }
}

function validateUrl(raw) {
  if (!raw.startsWith("https://")) return "URL must use https://";
  let u;
  try { u = new URL(raw); } catch { return "Invalid URL format"; }
  for (const p of BLOCKED_HOST_PATTERNS) {
    if (p.test(u.hostname)) return "URL resolves to a private address";
  }
  return null;
}
function validateMediaType(mt) { return ALLOWED_MEDIA_TYPES.has(mt) ? null : `Unsupported type.`; }

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
            { type: "text", text: `Parse this receipt or invoice into structured JSON. Return ONLY valid JSON — no markdown, no explanation, no preamble.

{
  "merchant":    { "name": string, "address": string|null, "phone": string|null, "website": string|null },
  "transaction": { "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "receipt_number": string|null, "payment_method": string|null },
  "items":       [ { "description": string, "quantity": number, "unit_price": number, "total": number } ],
  "totals":      { "subtotal": number|null, "tax": number|null, "tip": number|null, "discount": number|null, "total": number },
  "currency":    string,
  "category":    "restaurant"|"grocery"|"retail"|"travel"|"medical"|"utilities"|"other"
}

Use null for missing/unclear fields. All monetary values must be numbers, not strings.` }
          ],
        }],
      },
      { signal: controller.signal }
    );
    return resp.content[0].text.trim();
  } finally { clearTimeout(timer); }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const start = Date.now();

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-rapidapi-proxy-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  const burstOk = await checkBurstLimit(ip);
  if (!burstOk) return res.status(429).json({ error: "Too many requests. Slow down." });

  // 1 · Gatekeeper: Determine Authorization Context
  const rawKey = req.headers["x-api-key"];
  const isRapidAPI = req.headers["x-rapidapi-proxy-secret"] === RAPIDAPI_SECRET;
  const isTrialRequest = req.query.trial === "true" || (!rawKey && !isRapidAPI);

  let keyRecord;

  if (isRapidAPI) {
    keyRecord = { id: 'rapidapi-provider', credits: 999999, tier: 'rapidapi' };
  } else if (isTrialRequest) {
    const trialKey = `trial:${ip}`;
    const usedToday = await redis("get", trialKey) || 0;
    
    if (parseInt(usedToday) >= TRIAL_CREDIT_LIMIT) {
      return res.status(402).json({ 
        error: `Trial limit reached (${TRIAL_CREDIT_LIMIT}/month).`, 
        upgrade: "https://receiptiq.dev/#pricing" 
      });
    }
    keyRecord = { id: `trial-${ip}`, credits: TRIAL_CREDIT_LIMIT - usedToday, tier: 'trial', redisKey: trialKey };
  } else {
    try { keyRecord = await validateApiKey(rawKey); }
    catch (err) { return res.status(503).json({ error: "Service unavailable." }); }
  }

  if (!keyRecord) return res.status(401).json({ error: "Invalid or inactive API key.", docs: "https://receiptiq.dev/docs" });
  if (keyRecord.credits <= 0) return res.status(402).json({ error: "No credits remaining.", top_up: "https://receiptiq.dev/#pricing" });

  // 2 · Validate Request Body
  const { image, url, media_type } = req.body || {};
  if (!image && !url) return res.status(400).json({ error: "Provide image (base64) or url." });

  let imageContent;
  if (url) {
    imageContent = { type: "image", source: { type: "url", url } };
  } else {
    if (typeof image !== "string") return res.status(400).json({ error: "image must be a base64 string." });
    imageContent = { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image } };
  }

  // 3 · Deduct Credit
  let creditsAfter;
  if (keyRecord.tier === 'trial') {
    await redis("incr", keyRecord.redisKey);
    if (keyRecord.credits === TRIAL_CREDIT_LIMIT) await redis("expire", keyRecord.redisKey, 2592000); // 30 days
    creditsAfter = keyRecord.credits - 1;
  } else if (keyRecord.tier === 'rapidapi') {
    creditsAfter = 999999;
  } else {
    try { creditsAfter = await deductCredit(keyRecord.id, keyRecord.credits); }
    catch (err) { return res.status(503).json({ error: "Service unavailable." }); }
    if (creditsAfter === null) return res.status(402).json({ error: "No credits remaining." });
  }

  // 4 · Call Claude
  let raw;
  try {
    raw = await callClaude(imageContent);
  } catch (err) {
    if (keyRecord.tier !== 'trial' && keyRecord.tier !== 'rapidapi') {
      await supabase(`/api_keys?id=eq.${keyRecord.id}`, { method: "PATCH", body: JSON.stringify({ credits: creditsAfter + 1 }) }).catch(() => {});
    }
    return res.status(502).json({ error: "AI service error. Try again." });
  }

  // 5 · Parse and Return
  let parsed;
  try {
    const clean = raw.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    return res.status(422).json({ error: "Could not extract data from this image." });
  }
// Before the final return
const duration = Date.now() - start;
if (keyRecord.tier !== 'trial' && keyRecord.tier !== 'rapidapi') {
  await logUsage(keyRecord.id, true, null, duration);
}
  return res.status(200).json({
    success: true,
    data: parsed,
    meta: {
      model: CLAUDE_MODEL,
      tier: keyRecord.tier,
      credits_remaining: creditsAfter,
    },
  });
}
