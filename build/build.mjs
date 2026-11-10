// Build: src/*.html  ->  dist/*.html (+ vendor) and server/cloudflare/worker.js
// Usage:  node build/build.mjs            (dist uses local /vendor copies — works on an offline/intranet server)
//         node build/build.mjs --cdn      (dist loads libraries from public CDNs)
import fs from "node:fs"; import path from "node:path"; import url from "node:url";
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const useCdn = process.argv.includes("--cdn");
const CDN = {
  docx:  ["https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js", "vendor/docx-8.5.0.umd.js"],
  jszip: ["https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", "vendor/jszip-3.10.2.min.js"],
};
const API = "/api/claude";   // endpoint of the AI proxy (server/node or server/cloudflare)

function wrap(src, { local, mode }) {
  // hoist leading <title>/<meta>/<link> tags into <head>
  const headTags = [];
  let body = src.replace(/^\s*(<title>[\s\S]*?<\/title>|<meta [^>]*>|<link [^>]*>)\s*/gm, (m, tag) => { headTags.push(tag); return ""; });
  body = body.replace(/^\s*<script>window\.KURRASA_MODE="contracts";<\/script>\s*/m, "");
  if (local) for (const [cdn, loc] of Object.values(CDN)) body = body.split(cdn).join(loc);
  const cfg = `<script>window.KURRASA_API=${JSON.stringify(API)};${mode ? `window.KURRASA_MODE=${JSON.stringify(mode)};` : ""}</script>`;
  return `<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${headTags.join("\n")}\n${cfg}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
const pm = fs.readFileSync(path.join(ROOT, "src/project-manager.html"), "utf8");
const cm = fs.readFileSync(path.join(ROOT, "src/contract-manager.html"), "utf8");
const dist = path.join(ROOT, "dist"); fs.mkdirSync(path.join(dist, "vendor"), { recursive: true });
fs.writeFileSync(path.join(dist, "project-manager.html"), wrap(pm, { local: !useCdn }));
fs.writeFileSync(path.join(dist, "contract-manager.html"), wrap(cm, { local: !useCdn, mode: "contracts" }));
for (const f of fs.readdirSync(path.join(ROOT, "vendor"))) fs.copyFileSync(path.join(ROOT, "vendor", f), path.join(dist, "vendor", f));

// Cloudflare Worker (single file, libraries from CDN)
const tpl = fs.readFileSync(path.join(ROOT, "server/cloudflare/worker.template.js"), "utf8");
const worker = tpl.replace("__HTML_PM__", JSON.stringify(wrap(pm, { local: false })))
                  .replace("__HTML_CM__", JSON.stringify(wrap(cm, { local: false, mode: "contracts" })));
fs.writeFileSync(path.join(ROOT, "server/cloudflare/worker.js"), worker);
console.log("built: dist/project-manager.html, dist/contract-manager.html, dist/vendor/*, server/cloudflare/worker.js", useCdn ? "(CDN)" : "(local vendor)");
