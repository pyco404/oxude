// Screenshots a URL at a real mobile viewport via the DevTools protocol.
// Usage: node scripts/shoot.mjs <url> <out.png> [width] [height] [fullPage]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, width = "390", height = "844", full = "true"] = process.argv.slice(2);
const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "shoot-"));
const chrome = spawn("/usr/bin/google-chrome", [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  await wait(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) { chrome.kill(); throw new Error("chrome did not start"); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: true,
});
await send("Page.navigate", { url });
await wait(3500);
const { result } = await send("Runtime.evaluate", {
  expression: "JSON.stringify({inner: innerWidth, scroll: document.documentElement.scrollWidth, height: document.body.scrollHeight})",
  returnByValue: true,
});
const metrics = JSON.parse(result.value);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full === "true" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`${out} — viewport ${metrics.inner}px, document ${metrics.scroll}px, page height ${metrics.height}px` +
  (metrics.scroll > metrics.inner ? "  ← HORIZONTAL OVERFLOW" : "  (no horizontal overflow)"));
ws.close();
chrome.kill();
