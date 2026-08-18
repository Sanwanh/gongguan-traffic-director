// §20 相機系統驗收(CDP headless)。
//   1 六個以上預設視角逐一切換,取樣中間幀確認過渡是漸進的
//   2 picking 打得中 KBot / 車輛 / 行人 / 號誌 / 公車站 / 路口
//   3 focus 後目標落在畫面中心附近
//   4 zoom 到最近時相機不在任何建物包圍盒內
//   5 Follow 模式下手動 orbit 會退出 Follow
//   6 window.__setCamera 仍是同步瞬移(錄影腳本契約)
// 用法:node mujoco/verify_camera_system.mjs   (先確認 serve.py 起在 8124)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_camera");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9366);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-camera";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];
const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail ?? "")}`);
}

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
async function waitUntil(expression, { timeoutMs = 120000, intervalMs = 300 } = {}) {
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
  `--user-data-dir=${PROFILE_DIR}`, "--window-size=1920,1080",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check", "about:blank",
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
  throw new Error(`Chrome 沒起來:\n${chromeStderr}`);
}
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(String(e.message ?? e.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(message.error.message));
        else ok(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text ?? "unknown");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
      }
    });
  });
}

// 合成滑鼠拖曳(CDP Input 事件,走真正的 pointer 事件路徑)。
async function drag(fromX, fromY, dx, dy, { button = "left", modifiers = 0, steps = 12 } = {}) {
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 4;
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: fromX, y: fromY, button, buttons, clickCount: 1, modifiers,
  });
  for (let i = 1; i <= steps; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: fromX + (dx * i) / steps, y: fromY + (dy * i) / steps,
      button, buttons, modifiers,
    });
    await sleep(12);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: fromX + dx, y: fromY + dy, button, buttons, clickCount: 1, modifiers,
  });
}
async function wheel(x, y, deltaY, times = 1) {
  for (let i = 0; i < times; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: 0, deltaY,
    });
    await sleep(20);
  }
}

let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const base = send;
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? base(method, params)
      : base(method, params, sessionId)
  );
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(
    "Boolean(window.__cameraState && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)",
    { timeoutMs: 150000 },
  );
  if (!ready) throw new Error("viewer 沒有在 150 秒內載入完成");
  await waitUntil("window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true",
    { timeoutMs: 90000 });
  await sleep(1500);

  // ---------------------------------------------------------------- A hooks
  const hooks = await evaluate(`({
    cameraState: typeof window.__cameraState,
    pickAt: typeof window.__pickAt,
    focusObject: typeof window.__focusObject,
    setCameraMode: typeof window.__setCameraMode,
    setCamera: typeof window.__setCamera,
    cams: [...document.querySelectorAll('[data-camera]')].map(b => b.dataset.camera),
  })`);
  check("A1_hooks_present", Object.values(hooks).slice(0, 5)
    .every((t) => t === "function"), hooks);
  check("A2_data_camera_exactly_6", hooks.cams.length === 6, hooks.cams);
  const blockerCount = (await evaluate("window.__cameraState().blockers"));
  check("A3_blockers_built", blockerCount > 0, { blockerCount });

  // ------------------------------------------------- B 預設視角平滑過渡取樣
  const presets = ["overview", "isometric", "street", "robot", "intersection", "busstop",
    "crosswalk", "hook", "topdown", "fixedpost"];
  const transitionReport = [];
  // 先回到 overview 當起點
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(300);
  for (const preset of presets) {
    if (preset === "overview") continue;
    await evaluate("window.__setCameraPreset('overview', { immediate: true })");
    await sleep(250);
    const start = await evaluate("window.__cameraState()");
    await evaluate(`window.__setCameraPreset(${JSON.stringify(preset)})`);
    const samples = [];
    for (let i = 0; i < 8; i += 1) {
      await sleep(70);
      samples.push(await evaluate("window.__cameraState()"));
    }
    await sleep(900);
    const end = await evaluate("window.__cameraState()");
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const total = dist(start.position, end.position);
    const mids = samples.filter((s) => s.transitioning);
    const distinct = new Set(samples.map((s) => s.position.join(","))).size;
    const startedAtEnd = samples.length > 0
      && dist(samples[0].position, end.position) < 0.01;
    transitionReport.push({
      preset, total: Number(total.toFixed(2)), midFrames: mids.length,
      distinctSamples: distinct, endMode: end.mode,
      finalTransitioning: end.transitioning,
    });
    check(`B_${preset}_gradual`,
      total < 1 || (mids.length >= 2 && distinct >= 3 && !startedAtEnd),
      transitionReport.at(-1));
    check(`B_${preset}_settled`, end.transitioning === false, {
      transitioning: end.transitioning, mode: end.mode,
    });
    check(`B_${preset}_no_building_clip`,
      (await evaluate("window.__cameraInsideBlocker()")) === false, preset);
  }

  // ------------------------------------------------ C data-camera 六顆仍有效
  for (const id of ["overview", "street", "robot", "crosswalk", "hook", "busstop"]) {
    await evaluate(`document.querySelector('[data-camera="${id}"]').click()`);
    await sleep(1000);
    const state = await evaluate("window.__cameraState()");
    const active = await evaluate(
      `document.querySelector('[data-camera="${id}"]').classList.contains('is-active')`,
    );
    check(`C_${id}_click_works`, state.preset === id && active === true,
      { preset: state.preset, active, mode: state.mode });
  }

  // ------------------------------------------------- D __setCamera 同步瞬移
  await evaluate("document.querySelector('[data-camera=\"robot\"]').click()");
  await sleep(1200);
  const immediate = await evaluate(`(() => {
    const ok = window.__setCamera([10, 5, 0], [0, 1, 0]);
    const s = window.__cameraState();
    return { ok, position: s.position, target: s.target, mode: s.mode,
      transitioning: s.transitioning };
  })()`);
  check("D1_setCamera_sync", immediate.ok === true
    && Math.abs(immediate.target[1] - 1) < 0.001
    && immediate.transitioning === false, immediate);
  await sleep(1600);
  const afterDrift = await evaluate("window.__cameraState()");
  const drift = Math.hypot(
    afterDrift.target[0] - immediate.target[0],
    afterDrift.target[1] - immediate.target[1],
    afterDrift.target[2] - immediate.target[2],
  );
  check("D2_setCamera_no_follow_drift", drift < 0.05,
    { drift: Number(drift.toFixed(4)), mode: afterDrift.mode });

  // ------------------------------------------------------------- E picking
  await evaluate("window.__setCameraPreset('robot', { immediate: true })");
  await sleep(600);
  const kbotPick = await evaluate(`(() => {
    const rect = document.querySelector('#scene canvas').getBoundingClientRect();
    const hits = [];
    for (let dy = -60; dy <= 60; dy += 20) {
      for (let dx = -40; dx <= 40; dx += 20) {
        const hit = window.__pickAt(rect.left + rect.width / 2 + dx,
          rect.top + rect.height / 2 + dy);
        if (hit) hits.push(hit.id);
      }
    }
    return hits;
  })()`);
  check("E1_pick_kbot", kbotPick.includes("kbot"),
    { hits: kbotPick.length, kbot: kbotPick.filter((id) => id === "kbot").length,
      sample: [...new Set(kbotPick)] });

  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(600);
  const sweep = await evaluate(`(() => {
    const rect = document.querySelector('#scene canvas').getBoundingClientRect();
    const kinds = {};
    for (let y = 0.2; y <= 0.85; y += 0.05) {
      for (let x = 0.15; x <= 0.9; x += 0.03) {
        const hit = window.__pickAt(rect.left + rect.width * x, rect.top + rect.height * y);
        if (hit) kinds[hit.kind] = (kinds[hit.kind] ?? 0) + 1;
      }
    }
    return kinds;
  })()`);
  check("E2_pick_kinds", Object.keys(sweep).length >= 2, sweep);
  const staticPicks = await evaluate(`({
    intersection: window.__focusObject('intersection'),
    busstopSe: window.__focusObject('busstop:se'),
    hook: window.__focusObject('hook'),
  })`);
  check("E3_static_focus_ids", Object.values(staticPicks).every(Boolean), staticPicks);

  const signalId = await evaluate(`(() => {
    const s = window.__signalStates().find(x => x.visible ?? true);
    return s ? s.head : null;
  })()`);
  const signalFocus = signalId
    ? await evaluate(`window.__focusObject('signal:${signalId}')`)
    : null;
  check("E4_signal_focus", Boolean(signalFocus), { signalId });

  // ---------------------------------------------- F focus 後目標是否置中
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(400);
  const focusCentre = await evaluate(`(() => {
    window.__focusObject('kbot', { immediate: true });
    const s = window.__cameraState();
    return { ndc: window.__projectPoint(s.target), distance: s.distance };
  })()`);
  check("F1_focus_kbot_centred",
    Math.abs(focusCentre.ndc[0]) < 0.08 && Math.abs(focusCentre.ndc[1]) < 0.08,
    focusCentre);
  check("F2_focus_kbot_distance",
    focusCentre.distance >= 4 && focusCentre.distance <= 20, focusCentre);

  const focusAnimated = await evaluate(`(() => {
    window.__setCameraPreset('overview', { immediate: true });
    window.__focusObject('busstop:se');
    return window.__cameraState().transitioning;
  })()`);
  check("F3_focus_is_animated", focusAnimated === true, { focusAnimated });
  await sleep(1200);

  // --------------------------------------------------------- G zoom 不穿模
  await evaluate("window.__setCameraPreset('street', { immediate: true })");
  await sleep(500);
  const canvasRect = await evaluate(`(() => {
    const r = document.querySelector('#scene canvas').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await wheel(canvasRect.x, canvasRect.y, -120, 60);
  await sleep(900);
  const zoomState = await evaluate(`({
    state: window.__cameraState(), inside: window.__cameraInsideBlocker(),
  })`);
  check("G1_zoom_no_clip", zoomState.inside === false, zoomState.state.distance);
  check("G2_zoom_above_ground", zoomState.state.position[1] >= 0.85,
    zoomState.state.position);
  check("G3_zoom_min_distance", zoomState.state.distance >= 4.9,
    zoomState.state.distance);

  // -------------------------------------------- H pan 穩定(target 不飛天)
  await evaluate("window.__setCameraPreset('street', { immediate: true })");
  await sleep(500);
  for (let i = 0; i < 4; i += 1) {
    await drag(canvasRect.x, canvasRect.y - 150, 0, 300, { button: "right" });
    await sleep(120);
  }
  await sleep(500);
  const panState = await evaluate("window.__cameraState()");
  check("H1_pan_target_bounded",
    panState.target[1] >= 0.3 && panState.target[1] <= 14.1, panState.target);

  // ---------------------------------------- I Follow 被手動 orbit 打斷即退出
  await evaluate("document.querySelector('[data-camera=\"robot\"]').click()");
  await sleep(1300);
  const beforeTakeover = await evaluate("window.__cameraState()");
  await drag(canvasRect.x, canvasRect.y, 180, 0, { button: "left" });
  await sleep(400);
  const afterTakeover = await evaluate(`({
    state: window.__cameraState(),
    notice: document.querySelector('#cameraNotice').hidden === false
      ? document.querySelector('#cameraNotice').textContent : null,
    followActive: document.querySelector('[data-camera-mode="follow"]')
      .classList.contains('is-active'),
  })`);
  check("I1_follow_mode_entered", beforeTakeover.mode === "follow", beforeTakeover.mode);
  check("I2_follow_exits_on_orbit", afterTakeover.state.mode === "orbit"
    && afterTakeover.followActive === false,
    { mode: afterTakeover.state.mode, notice: afterTakeover.notice });
  check("I3_follow_exit_notice", Boolean(afterTakeover.notice), afterTakeover.notice);

  // ------------------------------- J Follow 距離不漂移(offset-follow 驗證)
  await evaluate("window.__setCameraMode('follow')");
  await sleep(1400);
  const follow0 = await evaluate("window.__cameraState()");
  await sleep(3000);
  const follow1 = await evaluate("window.__cameraState()");
  check("J1_follow_distance_stable",
    Math.abs(follow1.distance - follow0.distance) < 1.2,
    { d0: follow0.distance, d1: follow1.distance });

  // ---------------------------------------------------- K 模式與投影切換
  const modeReport = {};
  for (const mode of ["orbit", "follow", "fixed", "top", "street"]) {
    await evaluate(`window.__setCameraMode(${JSON.stringify(mode)})`);
    await sleep(1100);
    const state = await evaluate("window.__cameraState()");
    modeReport[mode] = { mode: state.mode, polar: state.polarDeg,
      inside: await evaluate("window.__cameraInsideBlocker()") };
  }
  check("K1_all_modes", Object.entries(modeReport)
    .every(([k, v]) => v.mode === k && v.inside === false), modeReport);
  check("K2_top_is_topdown", modeReport.top.polar < 12, modeReport.top);
  check("K3_street_is_low", modeReport.street.polar > 45, modeReport.street);

  await evaluate("window.__setCameraMode('orbit')");
  await sleep(1100);
  const beforeOrtho = await evaluate("window.__cameraState()");
  await evaluate("window.__setCameraProjection('orthographic')");
  await sleep(400);
  const orthoState = await evaluate("window.__cameraState()");
  await send("Page.captureScreenshot", { format: "png" }).then((s) => {
    writeFileSync(join(OUT_DIR, "ortho.png"), Buffer.from(s.data, "base64"));
  });
  await evaluate("window.__setCameraProjection('perspective')");
  await sleep(400);
  const backState = await evaluate("window.__cameraState()");
  check("K4_ortho_toggle", orthoState.projection === "orthographic"
    && backState.projection === "perspective",
    { ortho: orthoState.projection, back: backState.projection });
  check("K5_ortho_roundtrip_framing",
    Math.abs(backState.distance - beforeOrtho.distance) < 6,
    { before: beforeOrtho.distance, after: backState.distance });

  // ------------------------------------------------------- L 錄影模式隱藏
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (!el.checked) el.click(); return el.checked; })()`);
  await sleep(500);
  const recordingHidden = await evaluate(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return getComputedStyle(el).display !== 'none';
    };
    return { tools: vis('.camera-tools'), hint: vis('.viewport-hint'),
      toolbar: vis('.camera-toolbar') };
  })()`);
  check("L1_recording_hides_new_chrome",
    recordingHidden.tools === false && recordingHidden.hint === false,
    recordingHidden);
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (el.checked) el.click(); return el.checked; })()`);

  check("Z_no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "final.png"), Buffer.from(shot.data, "base64"));
  writeFileSync(join(OUT_DIR, "report.json"),
    JSON.stringify({ results, transitionReport, modeReport, consoleErrors }, null, 2));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures > 0 ? 1 : exitCode);
