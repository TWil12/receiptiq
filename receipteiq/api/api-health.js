// ReceiptIQ — /api/health.js
// Liveness + dependency health check endpoint.
//
// GET /api/health
//   → 200 { status: "ok", ... }      — all systems healthy
//   → 207 { status: "degraded", ... } — some deps down but core may work
//   → 503 { status: "down", ... }     — critical dep(s) down
//
// Use this URL with any uptime monitor (UptimeRobot, Betterstack, etc.)
// Consider password-protecting detailed output in production by checking
// a secret query param so competitors can't probe your stack.
//
// Example monitor config:
//   URL:              https://api.receiptiq.dev/api/health
//   Method:           GET
//   Expected status:  200
//   Alert if:         status != 200 for 2 consecutive checks
//   Check interval:   60 seconds

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Runs a check and always resolves (never throws) — returns a result object
async function probe(name, isCritical, fn) {
  const start = Date.now();
  try {
    await fn();
    return { name, status: "ok", latency_ms: Date.now() - start, critical: isCritical };
  } catch (err) {
    return {
      name,
      status:     "error",
      error:      err.message,
      latency_ms: Date.now() - start,
      critical:   isCritical,
    };
  }
}

// ─── Individual dependency checks ─────────────────────────────────────────────

async function checkSupabase() {
  // Lightweight: just hit the REST root — no table query needed
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
    headers: {
      apikey:       process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function checkRedis() {
  // PING command — Upstash returns { result: "PONG" }
  const res = await fetch(`${process.env.UPSTASH_REDIS_URL}/ping`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.result !== "PONG") throw new Error(`Unexpected response: ${JSON.stringify(json)}`);
}

async function checkAnthropic() {
  // We don't want to actually call the AI — just verify the API key is set
  // and the models endpoint is reachable (no tokens consumed)
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY env var not set");

  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key":       process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function checkEnvVars() {
  const required = [
    "ANTHROPIC_API_KEY",
    "UPSTASH_REDIS_URL",
    "UPSTASH_REDIS_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "APP_URL",
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) throw new Error(`Missing env vars: ${missing.join(", ")}`);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed." });

  const overallStart = Date.now();

  // Run all checks in parallel
  const [envCheck, supabaseCheck, redisCheck, anthropicCheck] = await Promise.all([
    probe("env_vars",   true,  checkEnvVars),
    probe("supabase",   true,  checkSupabase),
    probe("redis",      true,  checkRedis),
    probe("anthropic",  true,  checkAnthropic),
  ]);

  const checks = [envCheck, supabaseCheck, redisCheck, anthropicCheck];

  const anyError     = checks.some(c => c.status === "error");
  const anyCritical  = checks.some(c => c.status === "error" && c.critical);

  const overallStatus = anyCritical ? "down" : anyError ? "degraded" : "ok";
  const httpStatus    = anyCritical ? 503 : anyError ? 207 : 200;

  // Strip error details unless a secret token is provided
  // Prevents competitors/bots from learning about your stack
  const showDetails = req.query.token === process.env.HEALTH_TOKEN;

  const safeChecks = checks.map(c => ({
    name:       c.name,
    status:     c.status,
    latency_ms: c.latency_ms,
    // Only expose error text to authenticated callers
    ...(showDetails && c.error ? { error: c.error } : {}),
  }));

  return res.status(httpStatus).json({
    status:           overallStatus,
    total_latency_ms: Date.now() - overallStart,
    timestamp:        new Date().toISOString(),
    version:          "v1",
    model:            process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
    checks:           safeChecks,
  });
}
