// §22 簡約化 / scene-first 驗收(CDP headless)。
//   A 版位:3D 場景佔比、疊層佔比、狀態列/chip/gizmo 各就各位
//   B 控制面板:三個分頁切得動、單螢幕裝得下、§19 參數面板永遠在 DOM
//   C 收合:面板收成 36px rail,場景變寬,canvas 跟著 resize
//   D 紅線:verify_recording_shots / record_demo_video 依賴的每個選擇器與
//     hook 逐一 probe;[data-camera] 剛好 6 顆、[data-command] 4 顆
//   E 錄影模式:新 chrome 全部藏掉、面板 0px、canvas 滿版
//   F 風格:CSS 原始碼裡沒有 blur / glow / 過大圓角,字級只剩一組 token
//   G 1920x1080 與 1440x900 全頁截圖、零 console error
// 用法:node mujoco/verify_minimal_shell.mjs   (先確認 serve.py 起在 8124)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_shots");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9384);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-minimal-shell";
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
async function realClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}
async function clickSelector(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!point) return false;
  await realClick(point.x, point.y);
  await sleep(220);
  return true;
}
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, name), Buffer.from(s.data, "base64"));
  return join(OUT_DIR, name);
}

// --------------------------------------------------------------- probes
const LAYOUT = `(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y),
      w: Math.round(b.width), h: Math.round(b.height) };
  };
  const viewport = document.querySelector('.viewport').getBoundingClientRect();
  const area = viewport.width * viewport.height;
  const overlays = [...document.querySelector('.viewport').children]
    .filter((el) => el.id !== 'scene' && getComputedStyle(el).display !== 'none')
    .map((el) => {
      const b = el.getBoundingClientRect();
      return { sel: '.' + String(el.className).split(' ')[0],
        pct: Number(((b.width * b.height) / area * 100).toFixed(2)) };
    });
  return {
    scene: r('#scene'), topbar: r('.topbar'), strip: r('.status-strip'),
    metrics: r('.metrics-panel'), gizmo: r('.viewport-gizmo'),
    menus: r('.viewport-menus'), hint: r('.viewport-hint'),
    legend: r('.scene-legend'), panel: r('.control-panel'),
    scenePctOfWindow: Number((area / (innerWidth * innerHeight) * 100).toFixed(2)),
    overlays, overlayPct: Number(overlays.reduce((s, o) => s + o.pct, 0).toFixed(2)),
  };
})()`;

// verify_recording_shots.mjs / record_demo_video.mjs / verify_kbot_post_tuner.mjs
// 實際用到的每一個選擇器與 hook。
const RED_LINES = `(() => {
  const sel = (s) => Boolean(document.querySelector(s));
  const ids = ['modelStatus','vehicleCount','pedestrianCount','crossingCount',
    'throughputCount','collisionCount','carCount','scooterCount','motorcycleCount',
    'busCount','bicycleCount','sidewalkPedestrianCount','autoMode','downstreamBlocked',
    'motionEffects','highPerformance','trafficDensity','hookTurn','recordingMode',
    'pacingPreset','hookWaitCount','hookWaitChip','boardingCount','kbotPostLabel',
    'kbotPostPreview','kbotPostSegmented','kbotPostTarget','kbotPostS','kbotPostT',
    'kbotPostY','kbotPostVerdict','kbotPostCopy','kbotPostReset','kbotPostExport',
    'pacingSegmented','densitySegmented','durationRoosevelt','durationPedestrian',
    'durationLane90','durationRooseveltValue','durationPedestrianValue',
    'durationLane90Value','trafficModeLabel','busLaneCount','spawnAdjustNote',
    'reseedButton','paramGroups','paramSearch','paramSummary','paramDirtyCount',
    'paramRespawn','paramCopyCode','paramExportJson','paramImportInput','paramResetAll',
    'paramExport','sourceList','ruleSetLabel','seedLabel','phaseSignal','phaseLabel',
    'phaseDescription','phaseCountdown','commandDecision','decisionState',
    'requestedCommand','requestedGesture','activeGesture','candidatePhase',
    'decisionReason','safetyLocks','modeBadge','spawnSummary','fatalError',
    'projectionToggle','focusSelected','cameraSelectionLabel','cameraNotice',
    'viewCube','viewCubeStage','viewMenuButton','viewMenu','layersMenuButton',
    'layersMenu','layerList'];
  const missingIds = ids.filter((id) => !document.getElementById(id));
  const classes = ['.topbar','.camera-toolbar','.scene-legend','.control-panel',
    '.metrics-panel','.legal-boundary','.model-status','.fatal-error',
    '.camera-tools','.viewport-hint','.viewport-gizmo','.viewport-menus',
    '.param-console','.spawn-summary','.status-strip'];
  const missingClasses = classes.filter((c) => !sel(c));
  const hooks = ['__params','__setParam','__paramMeta','__paramCode','__setCamera',
    '__cameraState','__pickAt','__focusObject','__frameSelected','__setCameraMode',
    '__setCameraPreset','__setCameraProjection','__cameraInsideBlocker',
    '__projectPoint','__layerState','__setLayer','__viewCubeState',
    '__cubeFaceDirection','__applyViewCubeFace','__viewportMenuState',
    '__setNodeVisibility','__signalStates','__trafficDirectorDebug',
    '__panelState','__setPanelTab','__setPanelCollapsed'];
  const missingHooks = hooks.filter((h) => typeof window[h] === 'undefined');
  return {
    missingIds, missingClasses, missingHooks,
    cameras: [...document.querySelectorAll('[data-camera]')].map((b) => b.dataset.camera),
    commands: document.querySelectorAll('[data-command]').length,
    statusDot: Boolean(document.querySelector('#modelStatus .status-dot')),
    setCameraSync: (() => {
      const before = window.__cameraState().position.slice();
      const ok = window.__setCamera([10, 5, 0], [0, 1, 0]);
      const after = window.__cameraState().position.slice();
      return { returned: ok, moved: JSON.stringify(before) !== JSON.stringify(after) };
    })(),
  };
})()`;

function analyseCss() {
  const raw = readFileSync(join(here, "..", "viewer", "traffic_director.css"), "utf8");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const shadows = [...css.matchAll(/box-shadow\s*:[^;]+/g)].map((m) => m[0]);
  const radii = [...css.matchAll(/border-radius\s*:\s*([\d.]+)px/g)]
    .map((m) => parseFloat(m[1]));
  const fontSizes = [...css.matchAll(/font-size\s*:\s*([\d.]+)px/g)].map((m) => m[1]);
  const fontTokens = new Set(
    [...css.matchAll(/font-size\s*:\s*var\((--fs-[a-z]+)\)/g)].map((m) => m[1]),
  );
  return {
    backdropFilter: (css.match(/backdrop-filter\s*:\s*(?!none)/g) ?? []).length,
    glow: shadows.filter((s) => /:\s*0\s+0\s+(0\s+)?[\d.]+px/.test(s) && !/inset/.test(s)).length,
    rawFontSizes: fontSizes,
    fontTokens: [...fontTokens].sort(),
    radiiOver4: radii.filter((v) => v > 4 && v < 900),
    maxShadowBlur: Math.max(0, ...shadows.flatMap(
      (s) => [...s.matchAll(/(\d+)px/g)].map((m) => Number(m[1])),
    )),
  };
}

let exitCode = 0;
const shots = [];
const report = {};
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
    "Boolean(window.__panelState && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)",
    { timeoutMs: 180000 },
  );
  if (!ready) throw new Error("viewer 沒有在 180 秒內載入完成");
  await sleep(2500);

  // ------------------------------------------------------------ A 版位
  const layout = await evaluate(LAYOUT);
  report.layout = layout;
  check("A1_scene_is_the_star",
    layout.scenePctOfWindow >= 82, { scenePctOfWindow: layout.scenePctOfWindow });
  check("A2_overlays_are_light",
    layout.overlayPct <= 5, { overlayPct: layout.overlayPct, overlays: layout.overlays });
  check("A3_topbar_is_a_chip",
    layout.topbar.w <= 260 && layout.topbar.h <= 32, layout.topbar);
  check("A4_status_strip_at_bottom",
    layout.strip && layout.strip.h <= 28
    && layout.strip.y + layout.strip.h >= layout.scene.h - 1, layout.strip);
  check("A5_metrics_in_strip_not_top_left",
    layout.metrics.y > layout.scene.h * 0.9
    && layout.metrics.x + layout.metrics.w < layout.gizmo.x, {
      metrics: layout.metrics, gizmo: layout.gizmo,
    });
  check("A6_gizmo_top_right",
    layout.gizmo.x + layout.gizmo.w > layout.scene.w - 40
    && layout.gizmo.y < layout.scene.h * 0.25, layout.gizmo);
  check("A7_menus_bottom_left",
    layout.menus.x < 40 && layout.menus.y + layout.menus.h > layout.scene.h - 60,
    layout.menus);
  check("A8_hint_bottom_centre",
    Math.abs((layout.hint.x + layout.hint.w / 2) - layout.scene.w / 2) < 60
    && layout.hint.y > layout.scene.h * 0.9, layout.hint);
  check("A9_panel_narrower", layout.panel.w === 320, layout.panel);

  // -------------------------------------------------------- B 面板分頁
  const tabReport = [];
  for (const tab of ["command", "sim", "params"]) {
    const clicked = await clickSelector(`[data-panel-tab="${tab}"]`);
    await sleep(260);
    const state = await evaluate("window.__panelState()");
    const paramsAlive = await evaluate(`(() => ({
      groups: Boolean(document.querySelector('#paramGroups')),
      rows: document.querySelectorAll('#paramGroups .param-row').length,
      search: Boolean(document.querySelector('#paramSearch')),
      resetAll: Boolean(document.querySelector('#paramResetAll')),
      paramCount: Object.keys(window.__params()).length,
    }))()`);
    tabReport.push({ tab, clicked, state, paramsAlive });
    check(`B_tab_${tab}_activates`,
      clicked && state.tab === tab
      && state.panes.find((p) => p.id.toLowerCase().endsWith(tab)).active,
      { tab: state.tab, panes: state.panes.map((p) => `${p.id}:${p.display}`) });
    check(`B_tab_${tab}_keeps_param_console`,
      paramsAlive.groups && paramsAlive.search && paramsAlive.resetAll
      && paramsAlive.rows === 94 && paramsAlive.paramCount === 94, paramsAlive);
  }
  report.tabs = tabReport;

  // 指揮分頁應該單螢幕裝得下(不用捲)
  await clickSelector('[data-panel-tab="command"]');
  await sleep(300);
  const commandFit = await evaluate("window.__panelState()");
  report.commandFit = commandFit;
  check("B4_command_tab_fits_one_screen",
    commandFit.scrollHeight <= commandFit.clientHeight + 4, commandFit);

  // 參數分頁仍然可捲、內容完整
  await clickSelector('[data-panel-tab="params"]');
  await sleep(300);
  const paramsTab = await evaluate("window.__panelState()");
  check("B5_params_tab_scrollable_and_full",
    paramsTab.scrollHeight > paramsTab.clientHeight, paramsTab);
  shots.push(await shot("v22_tab_params.png"));
  await clickSelector('[data-panel-tab="sim"]');
  await sleep(300);
  shots.push(await shot("v22_tab_sim.png"));
  await clickSelector('[data-panel-tab="command"]');
  await sleep(300);

  // --------------------------------------------------------- C 收合
  const beforeCollapse = await evaluate(
    "document.querySelector('#scene canvas').getBoundingClientRect().width",
  );
  await clickSelector("#panelCollapse");
  await sleep(700);
  const collapsed = await evaluate(`(() => {
    const panel = document.querySelector('.control-panel').getBoundingClientRect();
    return {
      state: window.__panelState(),
      panelWidth: Math.round(panel.width),
      canvasWidth: Math.round(
        document.querySelector('#scene canvas').getBoundingClientRect().width),
      paramGroupsStillInDom: Boolean(document.querySelector('#paramGroups')),
    };
  })()`);
  report.collapsed = { beforeCollapse, ...collapsed };
  check("C1_collapse_shrinks_panel",
    collapsed.state.collapsed && collapsed.panelWidth === 36, collapsed);
  check("C2_collapse_widens_canvas",
    collapsed.canvasWidth > beforeCollapse + 200,
    { before: beforeCollapse, after: collapsed.canvasWidth });
  check("C3_collapse_keeps_param_dom", collapsed.paramGroupsStillInDom, collapsed);
  shots.push(await shot("v22_collapsed.png"));
  await clickSelector("#panelCollapse");
  await sleep(700);
  const expanded = await evaluate("window.__panelState()");
  check("C4_expand_restores", expanded.collapsed === false, expanded);

  // ------------------------------------------------------- D 紅線 probe
  const red = await evaluate(RED_LINES);
  report.redLines = red;
  check("D1_all_ids_present", red.missingIds.length === 0, red.missingIds);
  check("D2_all_classes_present", red.missingClasses.length === 0, red.missingClasses);
  check("D3_all_hooks_present", red.missingHooks.length === 0, red.missingHooks);
  check("D4_data_camera_exactly_six",
    red.cameras.length === 6
    && ["overview", "street", "robot", "crosswalk", "hook", "busstop"]
      .every((c) => red.cameras.includes(c)), red.cameras);
  check("D5_data_command_four", red.commands === 4, red.commands);
  check("D6_status_dot_selector", red.statusDot, red.statusDot);
  check("D7_setCamera_sync_contract",
    red.setCameraSync.returned === true && red.setCameraSync.moved, red.setCameraSync);

  // 六顆 data-camera 逐一 click 仍然有效(驗收腳本用的是 el.click())
  const cameraClicks = await evaluate(`(async () => {
    const out = [];
    for (const id of ['overview','street','robot','crosswalk','hook','busstop']) {
      const el = document.querySelector('[data-camera="' + id + '"]');
      el.click();
      await new Promise((r) => setTimeout(r, 120));
      out.push({ id, active: el.classList.contains('is-active'),
        preset: window.__cameraState().preset });
    }
    return out;
  })()`);
  report.cameraClicks = cameraClicks;
  check("D8_data_camera_click_still_works",
    cameraClicks.every((c) => c.active), cameraClicks);

  // 四顆 data-command 也還能點
  const commandClicks = await evaluate(`(() => {
    const els = [...document.querySelectorAll('[data-command]')];
    return els.map((el) => ({ phase: el.dataset.phase, disabled: el.disabled === true }));
  })()`);
  check("D9_commands_enabled",
    commandClicks.length === 4 && commandClicks.every((c) => !c.disabled), commandClicks);

  // §18 崗位微調的隱藏鏡像 select 仍可驅動
  const postTuner = await evaluate(`(() => {
    const seg = document.querySelector('#kbotPostSegmented button[data-post="lane90"]');
    seg.click();
    return { active: seg.classList.contains('is-active'),
      target: document.querySelector('#kbotPostTarget').value };
  })()`);
  check("D10_kbot_post_tuner_still_drivable",
    postTuner.active && postTuner.target === "lane90", postTuner);
  await evaluate(`document.querySelector('#kbotPostSegmented button[data-post="stand"]').click()`);

  // ---------------------------------------------------- E 錄影模式
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (!el.checked) el.click(); return el.checked; })()`);
  await sleep(800);
  const recording = await evaluate(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== 'none' : null;
    };
    return {
      bodyClass: document.body.classList.contains('is-recording'),
      panelWidth: Math.round(
        document.querySelector('.control-panel').getBoundingClientRect().width),
      canvasWidth: Math.round(
        document.querySelector('#scene canvas').getBoundingClientRect().width),
      chrome: { gizmo: vis('.viewport-gizmo'), menus: vis('.viewport-menus'),
        hint: vis('.viewport-hint'), tools: vis('.camera-tools'),
        toolbar: vis('.camera-toolbar'), strip: vis('.status-strip'),
        legend: vis('.scene-legend'), panel: vis('.control-panel') },
    };
  })()`);
  report.recording = recording;
  check("E1_recording_hides_panel",
    recording.bodyClass && recording.panelWidth <= 1, recording);
  check("E2_recording_canvas_fullwidth", recording.canvasWidth >= 1900,
    recording.canvasWidth);
  check("E3_recording_hides_all_chrome",
    Object.values(recording.chrome).every((v) => v === false), recording.chrome);
  shots.push(await shot("v22_recording.png"));
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (el.checked) el.click(); return el.checked; })()`);
  await sleep(800);

  // 收合 + 錄影同時開啟時,錄影必須贏(滿版)
  await evaluate("window.__setPanelCollapsed(true)");
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (!el.checked) el.click(); })()`);
  await sleep(700);
  const bothOn = await evaluate(`Math.round(
    document.querySelector('#scene canvas').getBoundingClientRect().width)`);
  check("E4_recording_beats_collapse", bothOn >= 1900, bothOn);
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (el.checked) el.click(); })()`);
  await evaluate("window.__setPanelCollapsed(false)");
  await sleep(700);

  // ------------------------------------------------------- F 風格紅線
  const css = analyseCss();
  report.css = css;
  check("F1_no_backdrop_filter", css.backdropFilter === 0, css.backdropFilter);
  check("F2_no_glow_shadows", css.glow === 0, css.glow);
  check("F3_no_raw_font_sizes", css.rawFontSizes.length === 0, css.rawFontSizes);
  check("F4_font_scale_is_one_set",
    css.fontTokens.length <= 6 && css.fontTokens.length >= 3, css.fontTokens);
  check("F5_no_oversized_radius", css.radiiOver4.length === 0, css.radiiOver4);
  check("F6_shadows_are_restrained", css.maxShadowBlur <= 12, css.maxShadowBlur);

  // --------------------------------------------------------- G 截圖
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(1500);
  shots.push(await shot("v22_final_1920.png"));
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1500);
  const layout1440 = await evaluate(LAYOUT);
  report.layout1440 = layout1440;
  check("G1_1440_scene_still_dominant",
    layout1440.scenePctOfWindow >= 76 && layout1440.overlayPct <= 7, {
      scenePctOfWindow: layout1440.scenePctOfWindow, overlayPct: layout1440.overlayPct,
    });
  shots.push(await shot("v22_final_1440.png"));

  check("G2_no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));

  report.results = results;
  report.consoleErrors = consoleErrors;
  report.shots = shots;
  writeFileSync(join(OUT_DIR, "v22_minimal_shell_report.json"),
    JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
console.log(`screenshots: ${shots.join(" ")}`);
process.exit(failures > 0 ? 1 : exitCode);
