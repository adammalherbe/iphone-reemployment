// iPhone Reemployment — give your old iPhone a new job as a live dashboard
// and control panel for your Mac.
// Run:  node server.mjs   (Node 18+, macOS, no npm install needed)
// https://github.com/adammalherbe/iphone-reemployment

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// ───────────────────────── SETTINGS ─────────────────────────
const PORT = Number(process.env.PORT) || 4242;

// Weather for the clock tile. Change to your city: https://www.latlong.net
const WEATHER = { lat: 37.33, lon: -122.01 }; // Cupertino

// The counter tile (middle right). Tap it on the phone to type a new number.
// Use it for anything you track: users, sales, followers, days until launch…
const COUNTER = { label: "Counter", icon: "chart-line", sub: "tap to update" };

// ───────────────────────── BUTTONS (bottom row) ─────────────────────────
// Icons: https://tabler.io/icons (name without "ti-")
const BUTTONS = [
  { id: "claude",     label: "Claude",     icon: "sparkles",      cmd: `open -a Claude || open https://claude.ai` },
  { id: "x",          label: "X",          icon: "brand-x",       cmd: `open https://x.com` },
  { id: "chrome",     label: "Chrome",     icon: "brand-chrome",  cmd: `open -a "Google Chrome"` },
  { id: "terminal",   label: "Terminal",   icon: "terminal-2",    cmd: `open -a Terminal` },
  { id: "cloudflare", label: "Cloudflare", icon: "cloud",         cmd: `open https://dash.cloudflare.com` },
  { id: "lock",       label: "Lock Mac",   icon: "lock",          cmd: `pmset displaysleepnow` },
];

// ───────────────────────── helpers ─────────────────────────
const sh = (cmd, timeout = 5000) =>
  new Promise((res) => exec(cmd, { timeout, shell: "/bin/zsh", maxBuffer: 1 << 20 }, (err, out) => res(err ? null : String(out).trim())));
// Pass the script straight to osascript (no shell), so multi-line scripts keep their line breaks.
// Errors are printed once per kind so you can see what's wrong in Terminal.
const seenErr = new Set();
const osa = (script, timeout = 5000) =>
  new Promise((res) => execFile("osascript", ["-e", script], { timeout, maxBuffer: 1 << 20 }, (err, out, stderr) => {
    if (err) {
      const msg = String(stderr || err.message).trim().split("\n")[0];
      const key = script.slice(0, 40) + msg;
      if (!seenErr.has(key)) { seenErr.add(key); console.log("  [osascript] " + msg); }
      return res(null);
    }
    res(String(out).trim());
  }));
const isRunning = async (proc) => (await sh(`pgrep -x ${JSON.stringify(proc)}`)) !== null;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tokenFile = path.join(DIR, ".token");
let TOKEN;
try { TOKEN = fs.readFileSync(tokenFile, "utf8").trim(); }
catch { TOKEN = crypto.randomBytes(6).toString("hex"); fs.writeFileSync(tokenFile, TOKEN); }

const counterFile = path.join(DIR, "counter.json");
const iconDir = path.join(DIR, "icons");
fs.mkdirSync(iconDir, { recursive: true });

// ───────────────────────── live state ─────────────────────────
const state = {
  cpu: 0, ramUsed: 0, ramTotal: os.totalmem(), battery: null, charging: false,
  volume: 50, muted: false,
  media: null, weather: null, apps: [],
  counter: readJson(counterFile, { total: null, updated: null }),
  host: os.hostname().replace(/\.local$/, ""),
};
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }

let lastCpu = os.cpus();
function sampleCpu() {
  const now = os.cpus(); let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = c.times, b = lastCpu[i].times;
    total += (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
    idle += a.idle - b.idle;
  });
  lastCpu = now;
  state.cpu = total ? Math.round(100 * (1 - idle / total)) : 0;
}

async function sampleRam() {
  if (process.platform !== "darwin") { state.ramUsed = os.totalmem() - os.freemem(); return; }
  const out = await sh("vm_stat"); if (!out) return;
  const page = Number(out.match(/page size of (\d+)/)?.[1] || 16384);
  const get = (k) => Number(out.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] || 0);
  state.ramUsed = (get("Pages active") + get("Pages wired down") + get("Pages occupied by compressor")) * page;
}

async function sampleBattery() {
  const m = (await sh("pmset -g batt"))?.match(/(\d+)%;\s*([a-zA-Z ]+);/);
  if (m) { state.battery = Number(m[1]); state.charging = !/discharging/i.test(m[2]); }
}

async function sampleAudio() {
  const out = await osa(`set s to get volume settings
return (output volume of s as string) & "|" & (output muted of s as string)`);
  if (!out) return;
  const [vol, muted] = out.split("|");
  state.volume = Number(vol) || 0; state.muted = muted === "true";
}

async function currentPlayer() {
  if (await isRunning("Spotify")) return "Spotify";
  if (await isRunning("Music")) return "Music";
  return null;
}

async function sampleMedia() {
  const app = await currentPlayer();
  if (!app) { state.media = null; return; }
  const art = app === "Spotify" ? `& "|" & (artwork url of current track)` : `& "|"`;
  const dur = app === "Spotify" ? `((duration of current track) / 1000)` : `(duration of current track)`;
  const out = await osa(`tell application "${app}"
if player state is stopped then return ""
return (name of current track) & "|" & (artist of current track) & "|" & (player state as string) & "|" & (player position as string) & "|" & (${dur} as string) ${art}
end tell`);
  if (!out) { state.media = null; return; }
  const [title, artist, st, pos, duration, artwork] = out.split("|");
  const num = (v) => parseFloat(String(v).replace(",", ".")) || 0;
  let cover = artwork || null;
  if (app === "Music") cover = await musicArtwork(title + "|" + artist);
  state.media = { app, title, artist, playing: st === "playing", position: num(pos), duration: num(duration), artwork: cover };
}

// Apple Music keeps covers inside the app, so export the current one to a file
let artKey = null, artUrl = null;
async function musicArtwork(key) {
  if (key === artKey) return artUrl;
  artKey = key; artUrl = null;
  const id = iconId("art:" + key), file = path.join(iconDir, "art-" + id + ".img");
  if (!fs.existsSync(file)) {
    const ok = await osa(`tell application "Music"
if (count of artworks of current track) is 0 then return "none"
set d to raw data of artwork 1 of current track
end tell
set f to open for access (POSIX file ${JSON.stringify(file)}) with write permission
set eof f to 0
write d to f
close access f
return "ok"`, 8000);
    if (ok !== "ok") return null;
  }
  artUrl = "/art/" + id;
  return artUrl;
}

// Open apps (the ones with a window/dock icon)
const SKIP_APPS = new Set(["com.apple.finder"]); // Finder is always open — remove to show it
const appPaths = new Map();
async function sampleApps() {
  // lsappinfo is built into macOS and needs no permissions
  const [out, order, front] = await Promise.all([sh("lsappinfo list", 5000), sh("lsappinfo visibleProcessList", 5000), sh("lsappinfo front", 5000)]);
  if (!out) { logOnce("apps", "  [apps] lsappinfo returned nothing"); return; }
  const apps = [];
  for (const block of out.split(/\n(?=\s*\d+\) ")/)) {
    const name = block.match(/^\s*\d+\) "([^"]+)"/)?.[1];
    const id = block.match(/bundleID="([^"]+)"/)?.[1];
    const appPathStr = block.match(/bundle path="([^"]+)"/)?.[1];
    const type = block.match(/type="([^"]+)"/)?.[1];
    const asn = block.match(/ASN:(0x[0-9a-f]+-0x[0-9a-f]+)/i)?.[1]?.toLowerCase();
    if (!name || !id || type !== "Foreground" || SKIP_APPS.has(id)) continue;
    if (appPathStr) appPaths.set(id, appPathStr);
    apps.push({ name, id, asn, icon: iconId(id) });
  }
  // most recently used first (visibleProcessList is front-to-back)
  const rank = (order || "").toLowerCase().match(/0x[0-9a-f]+-0x[0-9a-f]+/g) || [];
  const pos = (a) => { const i = rank.indexOf(a.asn); return i < 0 ? 999 : i; };
  apps.sort((a, b) => pos(a) - pos(b));
  const frontAsn = (front || "").toLowerCase().match(/0x[0-9a-f]+-0x[0-9a-f]+/)?.[0];
  for (const a of apps) a.front = a.asn === frontAsn;
  if (!apps.length) logOnce("apps0", "  [apps] no foreground apps found in lsappinfo output");
  state.apps = apps.slice(0, 14);
  for (const a of state.apps) ensureIcon(a.id);
}
const logged = new Set();
function logOnce(k, msg) { if (!logged.has(k)) { logged.add(k); console.log(msg); } }

const iconJobs = new Map();
const iconId = (k) => crypto.createHash("md5").update(k).digest("hex").slice(0, 10);
async function appPath(bundleId) {
  if (appPaths.has(bundleId)) return appPaths.get(bundleId);
  const found = (await sh(`mdfind "kMDItemCFBundleIdentifier == '${bundleId.replace(/'/g, "")}'" | grep -m1 '\\.app$'`)) || null;
  appPaths.set(bundleId, found);
  return found;
}
function ensureIcon(bundleId) {
  const id = iconId(bundleId), out = path.join(iconDir, id + ".png");
  if (fs.existsSync(out) || iconJobs.has(id)) return;
  iconJobs.set(id, (async () => {
    const appPathStr = await appPath(bundleId);
    if (!appPathStr) return;
    let name = await sh(`defaults read ${q(appPathStr + "/Contents/Info")} CFBundleIconFile`);
    if (!name) return;
    if (!name.endsWith(".icns")) name += ".icns";
    await sh(`sips -s format png --resampleHeightWidthMax 96 ${q(appPathStr + "/Contents/Resources/" + name)} --out ${q(out)}`, 10000);
  })());
}

async function sampleWeather() {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${WEATHER.lat}&longitude=${WEATHER.lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
    const j = await r.json();
    state.weather = { temp: Math.round(j.current.temperature_2m), code: j.current.weather_code,
      hi: Math.round(j.daily.temperature_2m_max[0]), lo: Math.round(j.daily.temperature_2m_min[0]) };
  } catch {}
}

// ───────────────────────── actions ─────────────────────────
async function media(verb) {
  const app = await currentPlayer() || "Spotify";
  const cmd = { playpause: "playpause", next: "next track", prev: "previous track" }[verb];
  if (!cmd) return false;
  await osa(`tell application "${app}" to ${cmd}`);
  await sleep(250); await sampleMedia(); broadcast();
  return true;
}

// ───────────────────────── server ─────────────────────────
const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(data);
}
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const authed = url.searchParams.get("t") === TOKEN;
  const p = url.pathname;

  if (p === "/pair") {
    const ra = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(pairPage());
  }
  if (p === "/") {
    if (!authed) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("Open the link printed in Terminal (it has the ?t= token)."); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(path.join(DIR, "index.html"), "utf8"));
  }
  if (!authed) { res.writeHead(401); return res.end(); }

  if (p === "/config") return json(res, 200, { buttons: BUTTONS.map(({ cmd, ...b }) => b), counter: COUNTER });

  if (p === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    clients.add(res); req.on("close", () => clients.delete(res));
    return;
  }
  if (p.startsWith("/art/")) {
    const f = path.join(iconDir, "art-" + p.slice(5).replace(/[^a-f0-9]/g, "") + ".img");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const buf = fs.readFileSync(f);
    const type = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    res.writeHead(200, { "content-type": type, "cache-control": "max-age=86400" });
    return res.end(buf);
  }
  if (p.startsWith("/icon/")) {
    const f = path.join(iconDir, p.slice(6).replace(/[^a-f0-9]/g, "") + ".png");
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
    return res.end(fs.readFileSync(f));
  }
  if (req.method !== "POST") { res.writeHead(404); return res.end(); }

  if (p.startsWith("/action/")) {
    const b = BUTTONS.find((x) => x.id === p.slice(8));
    if (!b) return json(res, 404, { ok: false });
    return json(res, 200, { ok: (await sh(b.cmd, 15000)) !== null });
  }
  if (p.startsWith("/media/")) return json(res, 200, { ok: await media(p.slice(7)) });
  if (p.startsWith("/volume/")) {
    const v = Math.max(0, Math.min(100, Number(p.slice(8)) || 0));
    await osa(`set volume output volume ${v}`);
    if (state.muted && v > 0) await osa("set volume output muted false");
    await sampleAudio(); broadcast();
    return json(res, 200, { ok: true });
  }
  if (p === "/switch") {
    const target = state.apps.find((a) => a.id === url.searchParams.get("app"));
    if (!target) return json(res, 404, { ok: false });
    return json(res, 200, { ok: (await sh(`open -b ${q(target.id)}`)) !== null });
  }
  if (p === "/counter") {
    const total = Number(String(await body(req)).replace(/[^\d]/g, ""));
    if (!total) return json(res, 400, { ok: false });
    state.counter = { total, updated: new Date().toISOString() };
    fs.writeFileSync(counterFile, JSON.stringify(state.counter));
    broadcast(); return json(res, 200, { ok: true });
  }
  res.writeHead(404); res.end();
});

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254"))
    .map((i) => `http://${i.address}:${PORT}/?t=${TOKEN}`);
}
function pairPage() {
  const url = lanUrls()[0] || "";
  return `<!doctype html><meta charset="utf-8"><title>iPhone Reemployment · Pair your phone</title>
<style>body{font-family:-apple-system,system-ui;background:#0b0b12;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
#qr{background:#fff;padding:18px;border-radius:20px;display:inline-block;margin:24px 0}code{color:#bbb;font-size:14px}</style>
<div><h1>Scan with your old iPhone</h1><p>Make sure it's on the same Wi-Fi as this Mac.</p><div id="qr"></div><br><code>${url}</code>
<p style="color:#888">Then Share → Add to Home Screen.</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById("qr"), { text: ${JSON.stringify(url)}, width: 260, height: 260 });</script>`;
}

// ───────────────────────── loops ─────────────────────────
async function tick() {
  sampleCpu();
  await Promise.all([sampleRam(), sampleAudio(), sampleMedia()]);
  broadcast();
}
setInterval(tick, 2000);
setInterval(async () => { await sampleApps(); broadcast(); }, 4000);
setInterval(sampleBattery, 30000);
setInterval(sampleWeather, 10 * 60000);
sampleBattery(); sampleWeather(); sampleApps(); tick();

const firstRun = !fs.existsSync(path.join(DIR, ".paired"));
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.log(`\n  Port ${PORT} is already in use. Is the deck already running in another window?\n`);
  else console.log(e);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n  iPhone Reemployment is running. Your old iPhone is back at work.\n");
  for (const u of lanUrls()) console.log(`  Open on your phone:  ${u}`);
  console.log(`\n  Or scan a QR code:    http://localhost:${PORT}/pair  (open this on the Mac)`);
  console.log("  Then on the phone:    Share → Add to Home Screen\n");
  console.log("  Stop with Ctrl + C\n");
  if (firstRun) { fs.writeFileSync(path.join(DIR, ".paired"), ""); exec(`open http://localhost:${PORT}/pair`); }
});
