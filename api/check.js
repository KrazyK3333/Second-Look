// Vercel serverless function: POST /api/check
// Your API key stays here on the server. Never put it in index.html.

const MODEL = "claude-haiku-5-5"; // fast and cheap; swap to "claude-sonnet-5-5" for tougher calls

const FREE_PER_DAY = 3; // keep in sync with index.html

// Family codes you hand out to paying customers, set in Vercel as:
// FAMILY_CODES=SMITH-4821,GARCIA-1937
const validCodes = () =>
  (process.env.FAMILY_CODES || "").split(",").map(c => c.trim().toUpperCase()).filter(Boolean);

// Free limit is counted on the server in Upstash Redis (free tier), by visitor IP.
// Clearing the browser doesn't reset it. Requires UPSTASH_REDIS_REST_URL and _TOKEN.
const redisReady = () => !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

function freeKey(req) {
  const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  return `free:${ip}:${new Date().toISOString().slice(0, 10)}`;
}

async function redis(commands) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error("Redis error " + r.status);
  return (await r.json()).map(x => x.result);
}

async function usedToday(req) {
  const [n] = await redis([["GET", freeKey(req)]]);
  return Number(n) || 0;
}

async function takeFreeCheck(req) {
  const key = freeKey(req);
  const [n] = await redis([["INCR", key], ["EXPIRE", key, 90000]]);
  return n; // the count including this check
}

async function giveBackFreeCheck(req) {
  try { await redis([["DECR", freeKey(req)]]); } catch {}
}

const PROMPT = (text) => `You are a scam-detection helper for older adults who are not tech-savvy. Analyze the message below that someone received (a text, email, or phone call they described).

Decide one verdict:
- "bad" if it is likely a scam or phishing
- "warn" if it is unclear or has some warning signs
- "safe" if it looks like an ordinary legitimate message

Watch for: urgency or threats, requests for gift cards, wire transfers, crypto, or verification codes, suspicious links or look-alike domains, impersonating family, banks, government, or delivery companies, prizes the person did not enter, requests for secrecy, and payment or login requests.

Write for a grandparent: short, warm, plain words, no jargon, no blame. Never guarantee something is safe.

Respond with ONLY a JSON object, no other text:
{"verdict":"bad"|"warn"|"safe","summary":"one or two plain sentences","reasons":["2 to 4 short reasons"],"next_step":"one clear sentence on what to do now"}

Message:
"""
${text}
"""`;

module.exports = async (req, res) => {
  // GET /api/check -> how many free checks are left today (doesn't use one)
  if (req.method === "GET") {
    const code = String(req.query.code || "").trim().toUpperCase();
    if (code && validCodes().includes(code)) return res.status(200).json({ family: true });
    if (!redisReady()) return res.status(200).json({ remaining: null });
    try {
      return res.status(200).json({ remaining: Math.max(0, FREE_PER_DAY - await usedToday(req)), badCode: !!code });
    } catch {
      return res.status(200).json({ remaining: null });
    }
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST or GET." });
  }

  const message = (req.body && typeof req.body.message === "string") ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "Paste a message first." });
  if (message.length > 4000) return res.status(400).json({ error: "That message is too long. Paste just the main part." });

  const code = typeof req.body.code === "string" ? req.body.code.trim().toUpperCase() : "";
  if (code && !validCodes().includes(code)) {
    return res.status(402).json({ error: "That family code didn't work. Check it and enter it again, or use your free checks.", badCode: true });
  }
  let remaining = null;
  if (!code) {
    // Fail closed: without the database, free checks can't be counted, so they're off.
    if (!redisReady()) {
      return res.status(503).json({ error: "Free checks aren't set up yet. Family Plan members can still enter their code." });
    }
    let count;
    try { count = await takeFreeCheck(req); }
    catch { return res.status(503).json({ error: "The checker is busy. Try again in a moment." }); }
    if (count > FREE_PER_DAY) {
      return res.status(402).json({ error: "That's today's free checks. They come back tomorrow, or get the Family Plan for unlimited checks.", remaining: 0 });
    }
    remaining = FREE_PER_DAY - count;
  }
  // If the AI call fails below, the free check is handed back so people aren't charged for errors.
  const refund = () => { if (!code) giveBackFreeCheck(req); };

  if (!process.env.ANTHROPIC_API_KEY) {
    refund();
    return res.status(500).json({ error: "The checker isn't set up yet (missing API key)." });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: PROMPT(message) }]
      })
    });

    if (!r.ok) refund();
    if (r.status === 429) return res.status(429).json({ error: "Too many checks right now. Wait a minute, then try again." });
    if (!r.ok) {
      console.error("Anthropic API error", r.status, await r.text());
      return res.status(502).json({ error: "The checker had a problem. Try again in a moment." });
    }

    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const json = JSON.parse(text.replace(/```json|```/g, "").trim());

    return res.status(200).json({
      verdict: ["safe", "warn", "bad"].includes(json.verdict) ? json.verdict : "warn",
      summary: String(json.summary || ""),
      reasons: Array.isArray(json.reasons) ? json.reasons.slice(0, 4).map(String) : [],
      next_step: String(json.next_step || ""),
      remaining,
      family: !!code
    });
  } catch (err) {
    console.error(err);
    refund();
    return res.status(500).json({ error: "Something went wrong while checking. Try again in a moment." });
  }
};
