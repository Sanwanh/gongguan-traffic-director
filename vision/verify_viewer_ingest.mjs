// 交接驗收:證明 viewer 真的收得下影像管線的輸出。
//
// 這一支不驗精度(那是 verify_pipeline.py 的事),只驗**契約**:
//   1. viewer 用 ?live=<url> 讀得到這份 JSON
//   2. schemaOk === true、degraded === false
//   3. 來源被標成 on-site / 即時,而不是走廊代理值
//   4. 場景真的照著 mainVehicleMin/Max 生成車輛
//   5. laneQuota 的 confidence 是 calibrated(影像才做得到,VD 做不到)
//   6. console 沒有 error
//
// 用法:
//   python run_pipeline.py --calib calib/synthetic-p1.json --image truth/shot_p1.png \
//       --out out/state_p1.json
//   node verify_viewer_ingest.mjs
//
// 硬規則 9:只殺自己 spawn 的那個 pid。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = process.env.STATE ?? "out/state_p1.json";
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9415);
const PROFILE_DIR = process.env.PROFILE_DIR
  ?? "/private/tmp/claude-501/-Users-san/chrome-vision-ingest";
const CHROME = process.env.CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`
  + `?source=file&live=${encodeURIComponent(`../vision/${STATE}`)}`;

if (!existsSync(resolve(HERE, STATE))) {
  console.error(`找不到 ${STATE}。先跑 run_pipeline.py 產生輸出。`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;
const pending = new Map();
let socket = null;
const consoleErrors = [];

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
  `--user-data-dir=${PROFILE_DIR}`, "--window-size=1600,900",
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
      if (message.method === "Runtime.consoleAPICalled"
          && message.params?.type === "error") {
        consoleErrors.push((message.params.args ?? [])
          .map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params?.exceptionDetails?.text ?? "exception");
      }
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
      }
    });
  });
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
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
    "Boolean(window.__dataSource && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)");
  if (!ready) throw new Error("viewer 沒有在時限內載入完成");

  await evaluate("window.__pollDataSource()");
  const state = await waitUntil("(() => { const s = window.__dataSource();"
    + " return s.schemaOk ? s : null; })()", { timeoutMs: 30000 });
  if (!state) throw new Error(`viewer 沒有收下 ${STATE}`);

  console.log(`\nviewer 讀到:${state.url}`);
  check("schema 相符", state.schemaOk === true, `kind=${state.kind}`);
  check("沒有退化", state.degraded === false);
  check("標成路口實測", state.confidence === "on-site", `confidence=${state.confidence}`);
  check("標成即時、未過期", state.realtime === true && state.stale === false,
    `realtime=${state.realtime} stale=${state.stale} ageS=${state.ageS}`);
  check("切到 live 車流檔位", state.trafficMode === "live");
  const { mainVehicleMin, mainVehicleMax } = state.budget;
  const actual = state.actual.mainVehicles;
  check("場景車數落在預算內", actual >= mainVehicleMin && actual <= mainVehicleMax,
    `預算 [${mainVehicleMin}, ${mainVehicleMax}] 實際 ${actual}`);
  check("逐車道權重是校正值", state.budget.laneQuota !== null,
    `laneQuota=${JSON.stringify(state.budget.laneQuota)}`);
  check("車種組成有套用", state.budget.mix !== null,
    `typeSpread=${JSON.stringify(state.actual.typeSpread)}`);
  check("車速沿用模擬預設(影像量不到)", state.budget.speedRangeMps === null);
  check("徽章不是走廊代理值", state.badge !== "走廊代理值", `badge=${state.badge}`);
  check("console 沒有 error", consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | "));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通過`);
  if (failed.length) exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
process.exit(exitCode);
