// اختبار شامل: الخادم + صفحة مدير المشروع + الذكاء الاصطناعي (عبر خادم وهمي) + صفحة مدير العقود + إصدار الكراسة
// Usage: npm run build && npm test     (needs: npm i -D playwright && npx playwright install chromium)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import url from "node:url"; import { spawn } from "node:child_process";
import { chromium } from "playwright";
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), ".."); const OUT = path.join(ROOT, "tests/out"); fs.mkdirSync(OUT, { recursive: true });
let ok = true; const check = (c, m) => { console.log((c ? "✓ " : "✗ ") + m); if (!c) ok = false; };

// 1) mock Claude API
const mock = http.createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; const body = JSON.parse(b); const last = body.messages.at(-1).content;
  const text = last.includes("مهمتك الآن فهم مشروعه")
    ? JSON.stringify({ summary: "تريد خدمات استشارية للحوكمة.", assumptions: [], type_guess: "general", type_why: "[N58]", ctype_guess: "consult", questions: [] })
    : "إجابة اختبارية [N22]";
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" })); }).listen(18901);

// 2) app server
const srv = spawn(process.execPath, [path.join(ROOT, "server/node/server.mjs")], { env: { ...process.env, PORT: "18900", ACCESS_CODE: "test-code", ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:18901" }, stdio: "inherit" });
await new Promise(r => setTimeout(r, 800));
const B = "http://127.0.0.1:18900";
try {
  check((await fetch(B + "/api/claude", { method: "POST", body: "{}" })).status === 401, "الخادم يرفض الطلب بدون رمز الدخول");
  const browser = await chromium.launch(); const ctx = await browser.newContext({ acceptDownloads: true }); const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(e.message));
  await p.goto(B + "/"); await p.waitForTimeout(500);
  // AI through proxy
  await p.fill("#f_brief", "نبي شركة استشارية تقيّم وضعنا وتسوي دليل حوكمة وسياسات لمدة سنة كاملة في الرياض");
  await p.click("#btnUnderstand"); await p.waitForSelector("#codeIn"); await p.fill("#codeIn", "test-code"); await p.click("[data-cok]"); await p.waitForTimeout(1200);
  check((await p.textContent("#work")).includes("تريد خدمات استشارية للحوكمة"), "المساعد الذكي يعمل عبر الخادم");
  // sample + export
  await p.click('.steps [data-go="type"]'); await p.click('[data-set="type"][data-val="general"]'); await p.click("#btnSample"); await p.waitForTimeout(300);
  const pmB64 = await p.evaluate(async () => { const blob = await window.docx.Packer.toBlob(window.__buildDocx()); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; buf.forEach(b => s += String.fromCharCode(b)); return btoa(s); });
  const pmFile = path.join(OUT, "pm.docx"); fs.writeFileSync(pmFile, Buffer.from(pmB64, "base64")); check(fs.statSync(pmFile).size > 5000, "تصدير ملف مدير المشروع");
  // contract manager
  await p.goto(B + "/contracts"); await p.waitForTimeout(500);
  check(await p.evaluate(() => !document.getElementById("cm").hidden), "صفحة مدير العقود مستقلة");
  await p.setInputFiles("#pmFile", pmFile); await p.waitForTimeout(800);
  const n = await p.$$eval('[data-ck^="qty."]', e => e.length); for (let i = 0; i < n; i++) await p.fill(`#ck_qty_${i}`, String(i + 1));
  check(n > 0, `قراءة ${n} بند من ملف مدير المشروع`);
  const bkB64 = await p.evaluate(async () => { const blob = await window.__buildBooklet(); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; buf.forEach(b => s += String.fromCharCode(b)); return btoa(s); });
  const bk = path.join(OUT, "booklet.docx"); fs.writeFileSync(bk, Buffer.from(bkB64, "base64")); check(fs.statSync(bk).size > 20000, "إصدار الكراسة النهائية");
  check(!errs.length, "لا أخطاء في الصفحات" + (errs.length ? ": " + errs.join(" | ") : ""));
  await browser.close();
} finally { srv.kill(); mock.close(); }
console.log(ok ? "\nكل الاختبارات نجحت" : "\nفشلت بعض الاختبارات"); process.exit(ok ? 0 : 1);
