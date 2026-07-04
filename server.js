/*
 * VoiceScribe backend — thin proxy to AssemblyAI.
 * Zero dependencies (plain Node 18+). The API key lives ONLY here (env var),
 * never in the browser.
 *
 * Run:  ASSEMBLYAI_API_KEY=your_key node server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const AAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY; // optional — powers the Polish feature
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AAI = "https://api.assemblyai.com/v2";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD = 500 * 1024 * 1024; // 500 MB

if (!AAI_KEY) {
  console.error("Missing ASSEMBLYAI_API_KEY environment variable.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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

const ALLOWED_TRANSCRIPT_FIELDS = [
  "audio_url", "speech_models", "speaker_labels", "speakers_expected", "summarization",
  "summary_model", "summary_type", "language_detection", "language_detection_options",
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // ---------- API ----------
    if (p === "/api/upload" && req.method === "POST") {
      const body = await readBody(req, MAX_UPLOAD);
      const r = await fetch(AAI + "/upload", {
        method: "POST",
        headers: { authorization: AAI_KEY },
        body,
      });
      return proxyJsonResponse(res, r);
    }

    if (p === "/api/transcript" && req.method === "POST") {
      const raw = await readBody(req, 1024 * 1024);
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); }
      catch (e) { return sendJson(res, 400, { error: "Invalid JSON" }); }
      const body = {};
      for (const k of ALLOWED_TRANSCRIPT_FIELDS) if (k in parsed) body[k] = parsed[k];
      const r = await fetch(AAI + "/transcript", {
        method: "POST",
        headers: { authorization: AAI_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return proxyJsonResponse(res, r);
    }

    const pollMatch = p.match(/^\/api\/transcript\/([\w-]+)$/);
    if (pollMatch && req.method === "GET") {
      const r = await fetch(AAI + "/transcript/" + pollMatch[1], {
        headers: { authorization: AAI_KEY },
      });
      return proxyJsonResponse(res, r);
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

server.listen(PORT, () => console.log("VoiceScribe running on http://localhost:" + PORT));
