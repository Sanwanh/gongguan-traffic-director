// §26「交通指揮機器人」總開關的 CDP 驗收。
//
// 關掉之後必須:機器人從場景消失、安全閘門不再受他影響、相位照跑、
// 相機不會卡在 follow、崗位微調 UI 收起來、零 console error;
// 再打開必須完全回來(含 localStorage 記憶)。
//
// 用法:node mujoco/verify_kbot_disable.mjs [--port 8124]
// 先決條件:serve.py 已在該 port 起著。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const PORT = Number(argValue("--port", "8124"));
const DEBUG_PORT = Number(argValue("--cdp-port", "9382"));
const OUT_DIR = argValue("--out", join(here, "verify_kbot_disable"));
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-kbot-disable";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// §19 參數總數基準。加了 kbot.enabled 與 5 個走路手感參數 → 94 + 6 = 100。
const PARAM_COUNT = 100;

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
const results = [];
const check = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}`,
    ok ? "" : `\n      ${JSON.stringify(detail)?.slice(0, 500)}`);
};

let nextId = 1;
const pending = new Map();
let socket = null;
function rawSend(method, params = {}, sessionId) {
  const id = (nextId += 1);
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 180000);
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
async function waitUntil(expression, { timeoutMs = 120000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await evaluate(expression);
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--window-size=1600,900",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let chromeStderr = "";
chrome.stderr.on("data", (c) => { chromeStderr += c.toString(); });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await sleep(300); }
  }
  throw new Error(`Chrome 沒有在 ${DEBUG_PORT} 起來:\n${chromeStderr}`);
}
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(String(e.message ?? e.type))));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: no } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) no(new Error(msg.error.message)); else ok(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  });
}

const report = { port: PORT, generatedAt: new Date().toISOString() };
let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  send = (m, p = {}) => (m.startsWith("Target.") || m.startsWith("Browser.")
    ? rawSend(m, p) : rawSend(m, p, sessionId));
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(`(() => {
    const dot = document.querySelector('#modelStatus .status-dot');
    return Boolean(window.__trafficDirectorDebug) && dot
      && !dot.classList.contains('is-loading') && !dot.classList.contains('is-error');
  })()`);
  check("A1_viewer_ready", Boolean(ready));
  await waitUntil("window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true");

  // ---------------------------------------------------------- A 基準紅線
  const base = await evaluate(`(() => ({
    dataCamera: document.querySelectorAll('[data-camera]').length,
    dataCommand: document.querySelectorAll('[data-command]').length,
    paramCount: Object.keys(window.__params()).length,
    paramRows: document.querySelectorAll('#paramGroups .param-row').length,
    hasToggle: Boolean(document.querySelector('#kbotEnabled')),
    toggleChecked: document.querySelector('#kbotEnabled')?.checked,
    enabled: window.__kbotEnabled(),
    param: window.__params()['kbot.enabled'],
    station: window.__trafficDirectorDebug.snapshot().kbotMotion.station,
    layerKbot: window.__layerState().kbot,
  }))()`);
  report.base = base;
  check("A2_red_lines", base.dataCamera === 6 && base.dataCommand === 4, base);
  check("A3_param_count", base.paramCount === PARAM_COUNT
    && base.paramRows === PARAM_COUNT, base);
  check("A4_toggle_present_and_on", base.hasToggle && base.toggleChecked === true
    && base.enabled === true && base.param === 1, base);

  // ---------------------------------------------------------- B 關掉
  // 走真的 DOM 事件(使用者路徑),不直接呼叫內部函式。
  await evaluate(`document.querySelector('#kbotEnabled').click()`);
  await sleep(1200);
  const off = await evaluate(`(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    return {
      enabled: window.__kbotEnabled(),
      param: window.__params()['kbot.enabled'],
      holderVisible: window.__layerState().kbot.visibleNodes,
      robotOnRoadway: s.kbotMotion.robotOnRoadway,
      station: s.kbotMotion.station,
      motionKeys: Object.keys(s.kbotMotion).length,
      holderPosition: s.kbotMotion.holderPosition,
      pedestrianConflictHook: typeof s.pedestrianConflict,
      chip: !document.querySelector('#kbotDisabledChip').hidden,
      postGroupHidden: document.querySelector('#kbotPostGroup').hidden,
      bodyClass: document.body.classList.contains('is-no-controller'),
      stationLabel: document.querySelector('#kbotPostLabel').textContent.trim(),
      safety: document.querySelector('#safetyLocks').textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  report.off = off;
  check("B1_disabled", off.enabled === false && off.param === 0, off);
  check("B2_invisible", off.holderVisible === 0, off);
  check("B3_not_on_roadway", off.robotOnRoadway === false, off);
  check("B4_station_label", off.station === "已停用"
    && off.stationLabel === "已停用", off);
  check("B5_snapshot_contract", off.holderPosition !== null
    && off.motionKeys >= 16, off);
  check("B6_ui_state", off.chip === true && off.postGroupHidden === true
    && off.bodyClass === true, off);
  check("B7_safety_notice", off.safety.includes("純號誌模式"), off.safety);

  // ---------------------------------------------------------- C 相機降級
  await evaluate(`document.querySelector('[data-camera="robot"]').click()`);
  await sleep(1500);
  const cam = await evaluate(`(() => ({
    ...window.__cameraState(),
    buttons: document.querySelectorAll('[data-camera]').length,
    modeButtons: document.querySelectorAll('[data-camera-mode]').length,
  }))()`);
  report.camera = cam;
  check("C1_camera_falls_back", cam.mode !== "follow", cam);
  check("C2_camera_buttons_intact", cam.buttons === 6 && cam.modeButtons >= 1, cam);
  const camMode = await evaluate(`(() => { window.__setCameraMode('follow');
    return window.__cameraState().mode; })()`);
  check("C3_setCameraMode_follow_falls_back", camMode !== "follow", camMode);

  // ------------------------------------------------- D 模擬與相位照常跑
  const before = await evaluate(`(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    return { throughput: Number(document.querySelector('#throughputCount').textContent),
      phase: s.phase, vehicles: s.vehicles.length };
  })()`);
  const seen = new Set();
  const phaseLog = [];
  const startedAt = Date.now();
  // 車輛「真的在動」的獨立證據:通過數要等車跑到場景邊界才 +1,
  // 相位巡一輪不見得有車出界,所以另外量「這一秒有位移的車輛比例」。
  await evaluate(`window.__vehSnap = () => Object.fromEntries(
    // __vehicleStates() 匯出的欄位是 lane_t 不是 t。寫成 v.t 會讓
    // Math.hypot(Δs, undefined) = NaN、NaN > 0.05 恆為 false,
    // 這條「車輛真的在動」的證據就永遠不會觸發(§27 抓到)。
    window.__vehicleStates().map((v) => [v.id, [v.s, v.lane_t]]));
    window.__vehPrev = window.__vehSnap(); true;`);
  const deadline = Date.now() + 95000;
  while (Date.now() < deadline) {
    const s = await evaluate(`(() => { const x = window.__trafficDirectorDebug.snapshot();
      const now = window.__vehSnap();
      const prev = window.__vehPrev || now;
      const ids = Object.keys(now).filter((k) => prev[k]);
      const movedN = ids.filter((k) => Math.hypot(now[k][0] - prev[k][0],
        now[k][1] - prev[k][1]) > 0.05).length;
      window.__vehPrev = now;
      return { phase: x.phase,
        throughput: Number(document.querySelector('#throughputCount').textContent),
        movedVehicles: ids.length ? movedN / ids.length : 0,
        collisions: x.collisions, onRoad: x.kbotMotion.robotOnRoadway }; })()`);
    seen.add(s.phase);
    phaseLog.push(s);
    // 至少觀察 45 秒:通過數要等車輛跑到場景邊界才會 +1,太早跳出會誤判。
    if (Date.now() - startedAt > 45000
      && seen.has("roosevelt_flow") && seen.has("lane90_release")
      && seen.has("pedestrian_crossing")) break;
    await sleep(1000);
  }
  const last = phaseLog.at(-1);
  report.phases = [...seen];
  report.lastSample = last;
  check("D1_phases_cycle", seen.has("roosevelt_flow") && seen.has("lane90_release"),
    [...seen]);
  check("D2_traffic_moves",
    last.throughput > before.throughput || last.movedVehicles >= 0.8,
    { before: before.throughput, after: last.throughput,
      movedFraction: last.movedVehicles });
  check("D3_never_on_roadway", phaseLog.every((s) => s.onRoad === false));
  check("D4_no_collisions", last.collisions === 0, last.collisions);

  // ---------------------------------------------------------- E 再打開
  await evaluate(`document.querySelector('#kbotEnabled').click()`);
  await sleep(2500);
  const on = await evaluate(`(() => {
    const s = window.__trafficDirectorDebug.snapshot();
    return {
      enabled: window.__kbotEnabled(),
      visibleNodes: window.__layerState().kbot.visibleNodes,
      station: s.kbotMotion.station,
      chip: !document.querySelector('#kbotDisabledChip').hidden,
      postGroupHidden: document.querySelector('#kbotPostGroup').hidden,
      bodyClass: document.body.classList.contains('is-no-controller'),
    };
  })()`);
  report.on = on;
  check("E1_re_enabled", on.enabled === true && on.visibleNodes === 1, on);
  check("E2_station_back", on.station !== "已停用", on);
  check("E3_ui_back", on.chip === false && on.postGroupHidden === false
    && on.bodyClass === false, on);
  const camBack = await evaluate(`(() => { window.__setCameraMode('follow');
    return window.__cameraState().mode; })()`);
  check("E4_follow_available_again", camBack === "follow", camBack);

  // -------------------------------------------------- F localStorage 記憶
  await evaluate(`window.__setKbotEnabled(false)`);
  await sleep(400);
  const stored = await evaluate(
    "JSON.parse(localStorage.getItem('gongguan.params.v1') || '{}')['kbot.enabled']",
  );
  check("F1_persisted", stored === 0, stored);
  await send("Page.navigate", { url: PAGE_URL });
  await waitUntil(`(() => {
    const dot = document.querySelector('#modelStatus .status-dot');
    return Boolean(window.__trafficDirectorDebug) && dot
      && !dot.classList.contains('is-loading') && !dot.classList.contains('is-error');
  })()`);
  await sleep(1500);
  const reloaded = await evaluate(`(() => ({
    enabled: window.__kbotEnabled(),
    checked: document.querySelector('#kbotEnabled').checked,
    visibleNodes: window.__layerState().kbot.visibleNodes,
    robotOnRoadway: window.__trafficDirectorDebug.snapshot().kbotMotion.robotOnRoadway,
    statusLoading: document.querySelector('#modelStatus .status-dot').className,
  }))()`);
  report.reloaded = reloaded;
  check("F2_restored_after_reload", reloaded.enabled === false
    && reloaded.checked === false && reloaded.visibleNodes === 0
    && reloaded.robotOnRoadway === false, reloaded);
  check("F3_model_status_ready_even_when_disabled",
    !reloaded.statusLoading.includes("is-loading")
    && !reloaded.statusLoading.includes("is-error"), reloaded.statusLoading);
  // 還原成預設,不要把停用狀態留在 profile 裡
  await evaluate("window.__setKbotEnabled(true)");

  check("G1_no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));
  report.results = results;
  report.consoleErrors = consoleErrors;
  writeFileSync(join(OUT_DIR, "verify_kbot_disable_report.json"),
    `${JSON.stringify(report, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  if (failed.length > 0) exitCode = 1;
} catch (error) {
  exitCode = 1;
  console.error("FAILED:", error.message);
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
  setTimeout(() => { try { chrome.kill("SIGKILL"); } catch { /* ignore */ } }, 1500).unref?.();
}
process.exitCode = exitCode;
