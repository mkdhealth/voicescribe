/*
 * Stenoji backend — thin proxy to AssemblyAI + Supabase auth & usage limits.
 * Zero dependencies (plain Node 18+). API keys live ONLY here (env vars),
 * never in the browser.
 *
 * Required env vars:
 *   ASSEMBLYAI_API_KEY   — transcription
 *   SUPABASE_URL         — e.g. https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY    — Supabase "anon public" (or "publishable") key
 *   SUPABASE_SERVICE_KEY — Supabase "service_role" (or "secret") key
 * Optional:
 *   GEMINI_API_KEY       — powers the Polish feature
 *   GEMINI_MODEL         — default gemini-2.5-flash
 *   FREE_MINUTES         — free transcription minutes per user per month (default 60)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FREE_MINUTES = parseInt(process.env.FREE_MINUTES || "60", 10);
const AAI = "https://api.assemblyai.com/v2";

const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;
const MAX_UPLOAD = 500 * 1024 * 1024; // 500 MB

for (const [name, val] of [
  ["ASSEMBLYAI_API_KEY", AAI_KEY],
  ["SUPABASE_URL", SUPABASE_URL],
  ["SUPABASE_ANON_KEY", SUPABASE_ANON_KEY],
  ["SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY],
]) {
  if (!val) {
    console.error("Missing " + name + " environment variable.");
    process.exit(1);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyJsonResponse(res, r) {
  let data;
  try {
    data = await r.json();
  } catch (e) {
    data = { error: "Upstream returned non-JSON (HTTP " + r.status + ")" };
  }
  sendJson(res, r.status, data);
}

/* ---------------- Supabase: auth ---------------- */
// Validates the user's access token by asking Supabase who they are.
// Results are cached for 5 minutes so polling doesn't hammer Supabase.
const tokenCache = new Map(); // token -> { user, ts }
const TOKEN_TTL = 5 * 60 * 1000;

async function getUser(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  const hit = tokenCache.get(token);
  if (hit && Date.now() - hit.ts < TOKEN_TTL) return hit.user;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.id) return null;
    const user = { id: u.id, email: u.email || "" };
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(token, { user, ts: Date.now() });
    return user;
  } catch (e) {
    return null;
  }
}

function unauthorized(res) {
  sendJson(res, 401, { error: "Please sign in to use Stenoji." });
}

/* ---------------- Supabase: usage metering ---------------- */
async function sbRest(pathAndQuery, options) {
  const opts = options || {};
  const headers = Object.assign(
    {
      apikey: SUPABASE_SERVICE_KEY,
      authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      "content-type": "application/json",
    },
    opts.headers || {}
  );
  return fetch(SUPABASE_URL + "/rest/v1/" + pathAndQuery, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function usedSecondsThisMonth(userId) {
  const r = await sbRest(
    "usage_events?select=seconds&user_id=eq." + userId +
    "&created_at=gte." + encodeURIComponent(monthStartIso())
  );
  if (!r.ok) throw new Error("Usage lookup failed (HTTP " + r.status + ")");
  const rows = await r.json();
  return rows.reduce((sum, row) => sum + (row.seconds || 0), 0);
}

// Returns null if the user still has minutes, otherwise a friendly error string.
async function limitExceededMessage(userId) {
  const used = await usedSecondsThisMonth(userId);
  if (used < FREE_MINUTES * 60) return null;
  return (
    "You've used all " + FREE_MINUTES + " free minutes for this month. " +
    "Your minutes reset on the 1st. Paid plans are coming soon!"
  );
}

async function registerTranscript(userId, transcriptId) {
  try {
    await sbRest("usage_events?on_conflict=transcript_id", {
      method: "POST",
      headers: { Prefer: "return=minimal,resolution=ignore-duplicates" },
      body: { user_id: userId, transcript_id: transcriptId, kind: "batch", seconds: 0 },
    });
  } catch (e) {
    console.error("Failed to register transcript " + transcriptId + ": " + e.message);
  }
}

// Bill a completed transcript exactly once: only updates the row if seconds is still 0.
async function billTranscript(userId, transcriptId, seconds) {
  if (!seconds || seconds <= 0) return;
  try {
    await sbRest(
      "usage_events?transcript_id=eq." + encodeURIComponent(transcriptId) +
      "&user_id=eq." + userId + "&seconds=eq.0",
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: { seconds: Math.round(seconds) },
      }
    );
  } catch (e) {
    console.error("Failed to bill transcript " + transcriptId + ": " + e.message);
  }
}

/* ---------------- HTTP server ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---------- Public config for the frontend ----------
    if (p === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, {
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_ANON_KEY,
        freeMinutes: FREE_MINUTES,
      });
    }

    // ---------- Everything under /api requires sign-in ----------
    let user = null;
    if (p.startsWith("/api/")) {
      user = await getUser(req);
      if (!user) return unauthorized(res);
    }

    if (p === "/api/me" && req.method === "GET") {
      const used = await usedSecondsThisMonth(user.id);
      return sendJson(res, 200, {
        email: user.email,
        usedSeconds: used,
        limitSeconds: FREE_MINUTES * 60,
      });
    }

    if (p === "/api/upload" && req.method === "POST") {
      const limitMsg = await limitExceededMessage(user.id);
      if (limitMsg) return sendJson(res, 402, { error: limitMsg });
      const body = await readBody(req, MAX_UPLOAD);
      const r = await fetch(AAI + "/upload", {
        method: "POST",
        headers: { authorization: AAI_KEY },
        body,
      });
      return proxyJsonResponse(res, r);
    }

    if (p === "/api/transcript" && req.method === "POST") {
      const limitMsg = await limitExceededMessage(user.id);
      if (limitMsg) return sendJson(res, 402, { error: limitMsg });
      const raw = await readBody(req, 1024 * 1024);
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); }
      catch (e) { return sendJson(res, 400, { error: "Invalid JSON" }); }
      const ALLOWED = [
        "audio_url", "speech_models", "speaker_labels", "speakers_expected", "summarization",
        "summary_model", "summary_type", "language_detection", "language_detection_options",
      ];
      const body = {};
      for (const k of ALLOWED) if (k in parsed) body[k] = parsed[k];
      const r = await fetch(AAI + "/transcript", {
        method: "POST",
        headers: { authorization: AAI_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let data;
      try { data = await r.json(); }
      catch (e) { data = { error: "Upstream returned non-JSON (HTTP " + r.status + ")" }; }
      if (r.ok && data.id) await registerTranscript(user.id, data.id);
      return sendJson(res, r.status, data);
    }

    const pollMatch = p.match(/^\/api\/transcript\/([\w-]+)$/);
    if (pollMatch && req.method === "GET") {
      const r = await fetch(AAI + "/transcript/" + pollMatch[1], {
        headers: { authorization: AAI_KEY },
      });
      let data;
      try { data = await r.json(); }
      catch (e) { data = { error: "Upstream returned non-JSON (HTTP " + r.status + ")" }; }
      if (r.ok && data.status === "completed" && data.audio_duration) {
        await billTranscript(user.id, data.id, data.audio_duration);
      }
      return sendJson(res, r.status, data);
    }

    if (p === "/api/polish" && req.method === "POST") {
      const raw = await readBody(req, 2 * 1024 * 1024);
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); }
      catch (e) { return sendJson(res, 400, { error: "Invalid JSON" }); }
      const text = String(parsed.text || "").slice(0, 250000);
      if (!text.trim()) return sendJson(res, 400, { error: "No text provided" });
      if (!GEMINI_KEY) {
        return sendJson(res, 501, {
          error: "Polish isn't configured yet — add a GEMINI_API_KEY environment variable (free key from aistudio.google.com).",
        });
      }
      const prompt =
        "The following is a raw speech transcript. Rewrite it with proper punctuation, " +
        "capitalization, and sensible paragraph breaks. Keep the SAME language as the " +
        "original (do not translate). Do not add, remove, summarize, or reword any content. " +
        "If lines start with [timestamps] or speaker names, keep those prefixes exactly as they are. " +
        "Return ONLY the corrected transcript with no preamble or explanation.\n\nTRANSCRIPT:\n" + text;
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1 },
          }),
        }
      );
      let data;
      try { data = await r.json(); }
      catch (e) { data = { error: { message: "Upstream returned non-JSON (HTTP " + r.status + ")" } }; }
      if (!r.ok) {
        const msg = (data.error && data.error.message) || "Polish failed (HTTP " + r.status + ")";
        return sendJson(res, r.status, { error: msg });
      }
      let out = "";
      try { out = data.candidates[0].content.parts.map((pt) => pt.text || "").join(""); }
      catch (e) { return sendJson(res, 502, { error: "Unexpected response from Gemini." }); }
      return sendJson(res, 200, { response: out.trim() });
    }

    if (p === "/api/streaming-token" && req.method === "GET") {
      const limitMsg = await limitExceededMessage(user.id);
      if (limitMsg) return sendJson(res, 402, { error: limitMsg });
      const r = await fetch(
        "https://streaming.assemblyai.com/v3/token?expires_in_seconds=3600",
        { headers: { authorization: AAI_KEY } }
      );
      return proxyJsonResponse(res, r);
    }

    // ---------- Static files ----------
    if (req.method === "GET") {
      let file = p === "/" ? "/index.html" : p;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
        return fs.createReadStream(full).pipe(res);
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    sendJson(res, 502, { error: "Proxy error: " + e.message });
  }
});

server.listen(PORT, () => {
  console.log("Stenoji running on http://localhost:" + PORT);
});
