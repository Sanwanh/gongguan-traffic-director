// 校正用的「地面對應點目錄」:把場景裡每一條白漆的四個角落的模擬座標 (s, t)
// 抓出來,寫成 calib/marks_catalog.json。
//
// 為什麼要有這個:校正時使用者只在影像上「點」,地面座標**一律從場景取真值**,
// 不用手打。手打一個數字打錯 1.2 公尺,整張 H 就歪掉,而且 4 點時查不出來。
//
// 用法:node dump_marks.mjs           (需要 serve.py 起在 8124)
// 產出:calib/marks_catalog.json      (小檔,可以進版控;之後校正就不必再開 viewer)
//
// 硬規則 9:只殺自己 spawn 的那個 pid。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, process.env.OUT ?? "calib/marks_catalog.json");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9414);
const PROFILE_DIR = process.env.PROFILE_DIR
  ?? "/private/tmp/claude-501/-Users-san/chrome-vision-marks";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = process.env.CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const PATTERNS = [
  { pattern: "MainCrosswalk_Straight.*Stripe", band: "straight-crosswalk",
    labelZhTw: "主行穿線(直行)白漆" },
  { pattern: "MainCrosswalk_Staggered.*Stripe", band: "staggered-crosswalk",
    labelZhTw: "錯位行穿線白漆" },
  { pattern: "StopBar", band: "stop-bar", labelZhTw: "停止線" },
  { pattern: "LaneArrow", band: "lane-arrow", labelZhTw: "車道方向箭頭" },
];

mkdirSync(dirname(OUT), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const pending = new Map();
let socket = null;
function rawSend(method, params = {}, sessionId) {
  const id = (nextId += 1);
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve_, reject) => {
    pending.set(id, { resolve: resolve_, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }
    }, 120000);
  });
}
let send = rawSend;
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`page exception: ${result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text}`);
  }
  return result.result?.value;
}
async function waitUntil(expression, { timeoutMs = 150000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`, "--window-size=1280,800",
  "--disable-background-timer-throttling", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  throw new Error(`Chrome 沒起來:\n${chromeStderr}`);
}
function openSocket(url) {
  return new Promise((resolve_, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve_(ws));
    ws.addEventListener("error", (event) => reject(new Error(String(event.message ?? event.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
      }
    });
  });
}

let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const base = send;
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? base(method, params) : base(method, params, sessionId)
  );
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: PAGE_URL });
  const ready = await waitUntil(
    "Boolean(window.__paintedNodeBounds && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)");
  if (!ready) throw new Error("viewer 沒有在時限內載入完成");

  const marks = await evaluate(`(() => {
    const specs = ${JSON.stringify(PATTERNS)};
    const seen = new Set();
    const out = [];
    for (const spec of specs) {
      for (const b of window.__paintedNodeBounds(spec.pattern)) {
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        out.push({ name: b.name, band: spec.band, labelZhTw: spec.labelZhTw,
          sMin: b.sMin, sMax: b.sMax, tMin: b.tMin, tMax: b.tMax,
          corners: [
            { corner: "sMin,tMin", s: b.sMin, t: b.tMin },
            { corner: "sMax,tMin", s: b.sMax, t: b.tMin },
            { corner: "sMax,tMax", s: b.sMax, t: b.tMax },
            { corner: "sMin,tMax", s: b.sMin, t: b.tMax },
          ] });
      }
    }
    return out;
  })()`);

  const bands = {};
  for (const mark of marks) bands[mark.band] = (bands[mark.band] ?? 0) + 1;
  writeFileSync(OUT, JSON.stringify({
    schema: "gongguan.vision.marks.v1",
    generatedAt: new Date().toISOString(),
    source: "viewer window.__paintedNodeBounds (gongguan_v54_environment.glb)",
    note: "模擬座標 (s, t),單位公尺。校正時地面座標一律取這裡的值,不要手打。",
    bands,
    marks,
  }, null, 2) + "\n");
  console.log(`marks=${marks.length} bands=${JSON.stringify(bands)}`);
  console.log(`OUT=${OUT}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
process.exit(exitCode);
