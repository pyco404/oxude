// Records the demo walk on the live site as a video.
//
//   node scripts/record-demo.mjs [base-url]      default https://oxude.xyz
//
// Land on home (latest bluff, live feed) → connect a test wallet → rent Mirage
// → play until a match has a bluff → open its transcript and scroll to the
// bluff line → open the settlement on the Solana explorer. 1280x720, slow and
// paused throughout, with a visible cursor. Nothing is cut: waits for the
// chain and for extra matches stay in, to be trimmed in editing.
//
// The wallet is a test stand-in injected into the page (a fresh ed25519 key
// that signs like Phantom), not the real extension. Output: demo/oxude-demo.mp4.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? "https://oxude.xyz";
const API = BASE.includes("localhost") ? "http://localhost:8787" : BASE.replace("://", "://api.");
const OUT = join(ROOT, "demo");
const SIZE = { width: 1280, height: 720 };
const MAX_PLAYS = 6;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A test wallet that signs like Phantom: a fresh key each run, so each recording rents its own agent.
const nacl = readFileSync(join(ROOT, "node_modules/tweetnacl/nacl-fast.min.js"), "utf8");
const seed = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
const testWallet = `${nacl}
(() => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58 = (b) => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let o = ""; while (n > 0n) { o = A[Number(n % 58n)] + o; n /= 58n; } for (const x of b) { if (x === 0) o = "1" + o; else break; } return o; };
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(${JSON.stringify(seed)}));
  const publicKey = { toBase58: () => b58(kp.publicKey), toString: () => b58(kp.publicKey) };
  window.phantom = { solana: { isPhantom: true, publicKey: null,
    async connect() { this.publicKey = publicKey; return { publicKey }; },
    async disconnect() {},
    async signMessage(m) { return { signature: nacl.sign.detached(m, kp.secretKey), publicKey }; } } };
})();`;

// Recorded video has no pointer; draw one that follows the mouse, with a brief ring on each click.
const cursor = `
(() => {
  const draw = () => {
    if (document.getElementById("__demo_cursor")) return;
    const c = document.createElement("div");
    c.id = "__demo_cursor";
    c.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 16 L18.5 16 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-2px,-2px)" });
    const ring = document.createElement("div");
    Object.assign(ring.style, { position: "fixed", width: "28px", height: "28px", marginLeft: "-14px", marginTop: "-14px", border: "2px solid #ff2d2d", borderRadius: "50%", zIndex: "2147483646", pointerEvents: "none", opacity: "0", transition: "opacity 350ms, transform 350ms" });
    document.documentElement.append(c, ring);
    const at = window.__demo_at || [640, 360];
    c.style.left = at[0] + "px"; c.style.top = at[1] + "px";
    addEventListener("mousemove", (e) => { window.__demo_at = [e.clientX, e.clientY]; c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => {
      ring.style.transition = "none"; ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px";
      ring.style.opacity = "1"; ring.style.transform = "scale(0.6)";
      requestAnimationFrame(() => { ring.style.transition = "opacity 450ms, transform 450ms"; ring.style.opacity = "0"; ring.style.transform = "scale(1.4)"; });
    }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", draw); else draw();
})();`;

rmSync(join(OUT, "raw"), { recursive: true, force: true });
mkdirSync(join(OUT, "raw"), { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: 1,
  recordVideo: { dir: join(OUT, "raw"), size: SIZE },
});
await context.addInitScript(testWallet);
await context.addInitScript(cursor);
const page = await context.newPage();
let mouse = { x: 640, y: 360 };

/** Glide the cursor to an element's centre (or an offset in it), slowly. */
async function glide(locator, { dx = 0.5, dy = 0.5, steps = 40 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("nothing to move to");
  const to = { x: box.x + box.width * dx, y: box.y + box.height * dy };
  await page.mouse.move(to.x, to.y, { steps });
  mouse = to;
  await pause(400);
}

/** Glide to it, pause so the viewer sees what is about to happen, click. */
async function click(locator, before = 900) {
  await glide(locator);
  await pause(before);
  await page.mouse.down();
  await pause(90);
  await page.mouse.up();
  await pause(600);
}

/** Scroll smoothly by wheel, in small notches, so the motion reads on video. */
async function scrollBy(pixels, notch = 60) {
  const n = Math.max(1, Math.round(Math.abs(pixels) / notch));
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, Math.sign(pixels) * notch);
    await pause(45);
  }
  await pause(500);
}

async function settlementOf(matchId) {
  const res = await page.request.get(`${API}/matches/${matchId}`);
  return (await res.json()).settlement;
}

let ok = false;
try {
  // 1. Land on home: the latest bluff, then the live feed.
  log("home");
  // Not "networkidle": the feed polls every 10s, so the network never goes quiet.
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 90000 });
  const bluffCard = page.locator("section", { hasText: "Latest bluff" }).first();
  await bluffCard.waitFor({ timeout: 60000 });
  await page.mouse.move(mouse.x, mouse.y);
  await pause(3000);
  await glide(bluffCard.locator("p").first(), { dx: 0.15 });
  await pause(3500);
  const feed = page.locator("section", { hasText: "Live matches" }).first();
  await glide(feed.locator("li").first(), { dx: 0.3 });
  await pause(1500);
  await scrollBy(420);
  await pause(3000);
  await scrollBy(-420);
  await pause(1500);

  // 2. Connect the test wallet from the sidebar.
  log("connect wallet");
  const walletButton = page.locator("#site-nav .mt-auto button[aria-haspopup]");
  await click(walletButton);
  await pause(1800);
  await click(page.locator("#site-nav [role=menu] button", { hasText: /^Phantom$/ }));
  await page.locator("#site-nav .mt-auto button[aria-haspopup]", { hasText: /…/ }).waitFor({ timeout: 45000 });
  await pause(2500);

  // 3. Rent Mirage.
  log("rent Mirage");
  const mirage = page.locator("li button", { hasText: /^Mirage/ }).first();
  await mirage.waitFor({ timeout: 30000 });
  await click(mirage);
  await pause(2500);
  await click(page.getByRole("button", { name: "Rent Mirage" }));
  await page.getByText("private rating").waitFor({ timeout: 45000 });
  await pause(3000);

  // 4. Play until a match has a bluff in it.
  let matchId = null;
  let previous = null;
  const openLink = () => page.locator("section", { hasText: "Transcript" }).last().getByRole("link", { name: "open" });
  for (let play = 1; play <= MAX_PLAYS && !matchId; play++) {
    log(`play ${play}`);
    const button = page.getByRole("button", { name: "Play a match" });
    await button.waitFor({ timeout: 30000 });
    await click(button);
    // Wait for this match's transcript, not the last one's.
    await page.waitForFunction(
      (prev) => {
        const a = [...document.querySelectorAll("section a")].find((x) => x.textContent.trim() === "open");
        return a && a.getAttribute("href") !== prev;
      },
      previous,
      { timeout: 45000 },
    );
    const id = (await openLink().getAttribute("href"))?.split("/m/")[1] ?? null;
    previous = `/m/${id}`;
    const transcript = page.locator("section", { hasText: "Transcript" }).last();
    await pause(2500);
    const text = await transcript.locator("pre").innerText();
    if (/A bluff that worked|The bluff was called/.test(text)) matchId = id;
    else {
      log("  no bluff in that one; playing again");
      await pause(2000);
    }
  }
  if (!matchId) throw new Error(`no bluff in ${MAX_PLAYS} matches`);
  log("match", matchId);

  // 5. Open the transcript and scroll to the bluff line.
  const transcript = page.locator("section", { hasText: "Transcript" }).last();
  await click(transcript.getByRole("link", { name: "open" }));
  await page.waitForURL(`**/m/${matchId}`, { waitUntil: "commit", timeout: 90000 });
  await page.locator("pre span").first().waitFor({ timeout: 90000 });
  await pause(3000);
  // A bluff that worked is the point of the game; a called bluff only if the match had no other.
  const worked = page.locator("pre span", { hasText: "A bluff that worked" });
  const bluffLine = (await worked.count()) > 0 ? worked.first() : page.locator("pre span", { hasText: "The bluff was called" }).first();
  const box = await bluffLine.boundingBox();
  if (box && box.y > SIZE.height * 0.55) await scrollBy(box.y - SIZE.height * 0.45);
  await glide(bluffLine, { dx: 0.05 });
  await pause(5000);

  // 6. Wait for the settlement to land on chain, then open it on the explorer, in this same tab.
  log("waiting for settlement");
  let settlement = await settlementOf(matchId);
  const deadline = Date.now() + 180000;
  while (settlement && settlement.status !== "confirmed" && Date.now() < deadline) {
    await pause(3000);
    settlement = await settlementOf(matchId);
  }
  if (!settlement) throw new Error("level match: nothing settled, so no explorer link");
  if (settlement.status !== "confirmed") throw new Error("settlement did not confirm within 3 minutes");
  await page.reload({ waitUntil: "load", timeout: 90000 });
  await page.getByRole("link", { name: "view transaction" }).waitFor({ timeout: 60000 });
  await page.mouse.move(mouse.x, mouse.y);
  await pause(1500);
  const view = page.getByRole("link", { name: "view transaction" });
  await glide(view);
  await pause(2500);
  await view.evaluate((a) => a.removeAttribute("target"));
  await click(view, 400);
  // The explorer is heavy and slow to finish loading; wait for the transaction itself, not the page.
  await page.waitForURL(/explorer\.solana\.com/, { waitUntil: "domcontentloaded", timeout: 60000 });
  const status = page.getByText(/^(Success|Finalized|Confirmed)$/).first();
  await status.waitFor({ timeout: 90000 }).catch(() => log("  explorer status not found; recording the page as it is"));
  await pause(4000);
  await glide(status).catch(() => {});
  await pause(6000);
  log("done");
  ok = true;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  const raw = await video.path();
  // A failed run never overwrites a good recording.
  const name = ok ? "oxude-demo" : "oxude-demo.failed";
  const webm = join(OUT, `${name}.webm`);
  renameSync(raw, webm);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", join(OUT, `${name}.mp4`)]);
  rmSync(join(OUT, "raw"), { recursive: true, force: true });
  log("wrote", join(OUT, `${name}.mp4`));
}
