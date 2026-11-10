// مساعد كراسة الشروط والمواصفات — خادم Node.js (بدون مكتبات خارجية، Node 18+)
// Serves dist/ and proxies AI requests to the Claude API.
//   /            -> dist/project-manager.html   (مدير المشروع)
//   /contracts   -> dist/contract-manager.html  (مدير العقود)
//   /vendor/*    -> dist/vendor/*
//   POST /api/claude  {messages:[{role,content}], tier}  ->  {text, stop_reason}
// Config via environment or server/node/.env (see .env.example).
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import url from "node:url";
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist");
try { for (const line of fs.readFileSync(path.join(HERE, ".env"), "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch {}
const { ANTHROPIC_API_KEY, ACCESS_CODE, MODEL = "claude-sonnet-5-5", PORT = "8080", RATE_PER_MIN = "20", ANTHROPIC_BASE_URL = "https://api.anthropic.com" } = process.env;

const SEC = { "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "cache-control": "no-store" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png" };
const send = (res, status, body, headers = {}) => { res.writeHead(status, { ...SEC, ...headers }); res.end(body); };
const json = (res, status, o) => send(res, status, JSON.stringify(o), { "content-type": "application/json; charset=utf-8" });

const hits = new Map(); // naive per-IP rate limit
function limited(ip) { const now = Date.now(); const a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > Number(RATE_PER_MIN); }

async function readBody(req, max = 600000) { let size = 0; const chunks = []; for await (const c of req) { size += c.length; if (size > max) throw new Error("too_large"); chunks.push(c); } return Buffer.concat(chunks).toString("utf8"); }

async function api(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  if (!ACCESS_CODE || req.headers["x-access-code"] !== ACCESS_CODE) return json(res, 401, { error: "unauthorized" });
  if (!ANTHROPIC_API_KEY) return json(res, 500, { error: "server_not_configured" });
  if (limited(req.socket.remoteAddress || "")) return json(res, 429, { error: "rate_limited" });
  let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.message === "too_large" ? 413 : 400, { error: e.message === "too_large" ? "too_large" : "bad_request" }); }
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-20);
  if (!messages.length || messages[0].role !== "user" || messages[messages.length - 1].role !== "user") return json(res, 400, { error: "bad_request" });
  try {
    const r = await fetch(ANTHROPIC_BASE_URL.replace(/\/$/,"") + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 12000, messages })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json(res, (r.status === 429 || r.status === 529) ? 429 : 502, { error: (j.error && j.error.type) || "upstream_error" });
    return json(res, 200, { text: (j.content || []).filter(c => c.type === "text").map(c => c.text).join(""), stop_reason: j.stop_reason });
  } catch { return json(res, 502, { error: "upstream_error" }); }
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api/claude") return api(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "");
  const file = p === "/" || p === "/index.html" ? "project-manager.html" : p === "/contracts" ? "contract-manager.html" : p.startsWith("/vendor/") ? p.slice(1) : null;
  if (!file) return send(res, 404, "Not found");
  const full = path.resolve(DIST, file);
  if (!full.startsWith(DIST + path.sep)) return send(res, 403, "");
  fs.readFile(full, (err, buf) => err ? send(res, 404, "Not found") : send(res, 200, buf, { "content-type": TYPES[path.extname(full)] || "application/octet-stream" }));
}).listen(Number(PORT), () => console.log(`kurrasa listening on :${PORT}  (model ${MODEL}${ANTHROPIC_API_KEY ? "" : ", AI disabled: no ANTHROPIC_API_KEY"})`));
