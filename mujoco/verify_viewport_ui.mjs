// §21 Viewport 操作 UI 驗收(CDP headless)。
//   1 右上角 ViewCube + 工具 rail、左下角 View / Layers 選單、底部提示都在對的角落
//   2 ViewCube 跟著相機轉(transform 真的變),六個面逐一用真滑鼠點得到、切得動
//   3 rail 四顆(Home / Iso / Focus / Persp-Ortho)逐一點擊有效
//   4 View 選單裡的 6 顆舊 [data-camera] + 2 顆 [data-view] + 5 個模式全部有效
//   5 Layers 六個圖層逐一開關,對應物件真的消失/出現
//   6 錄影模式把新 chrome 全部藏掉;零 console error
// 用法:node mujoco/verify_viewport_ui.mjs   (先確認 serve.py 起在 8124)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_shots");
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9371);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-viewport-ui";
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

// 真滑鼠點擊(不是 el.click()):走完整 hit-test,證明元素真的點得到。
async function realClick(x, y) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, buttons: 0,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}
async function drag(fromX, fromY, dx, dy, { steps = 10 } = {}) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: fromX + (dx * i) / steps, y: fromY + (dy * i) / steps,
      button: "left", buttons: 1,
    });
    await sleep(12);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: fromX + dx, y: fromY + dy, button: "left", buttons: 0, clickCount: 1,
  });
}
// 在元素的 bounding rect 內以 2px 網格掃描,收集所有 elementFromPoint 命中它的
// 點,再取「離最近的非命中點最遠」的那一個。ViewCube 的面是 3D transform 之後
// 互相重疊的四邊形,取 bbox 中心或邊緣點會落在別的面上(或落在命中測試的邊界
// 誤差裡),必須取真正的內部點才點得穩。
async function hitPoint(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const step = 2;
    const cols = Math.max(2, Math.floor(r.width / step));
    const rows = Math.max(2, Math.floor(r.height / step));
    const grid = [];
    for (let iy = 0; iy <= rows; iy += 1) {
      const row = [];
      for (let ix = 0; ix <= cols; ix += 1) {
        const x = r.left + (r.width * ix) / cols;
        const y = r.top + (r.height * iy) / rows;
        const hit = document.elementFromPoint(x, y);
        row.push(hit === el || (hit && el.contains(hit)));
      }
      grid.push(row);
    }
    // 對命中網格做一次「離邊界距離」的暴力最大化(格子最多 ~40x40,夠便宜)。
    let best = null;
    let bestScore = -1;
    for (let iy = 0; iy <= rows; iy += 1) {
      for (let ix = 0; ix <= cols; ix += 1) {
        if (!grid[iy][ix]) continue;
        let radius = 0;
        while (radius < 40) {
          const next = radius + 1;
          let clear = true;
          for (let dy = -next; dy <= next && clear; dy += 1) {
            for (let dx = -next; dx <= next; dx += 1) {
              const gy = iy + dy;
              const gx = ix + dx;
              if (gy < 0 || gy > rows || gx < 0 || gx > cols || !grid[gy][gx]) {
                clear = false;
                break;
              }
            }
          }
          if (!clear) break;
          radius = next;
        }
        if (radius > bestScore) {
          bestScore = radius;
          best = { ix, iy };
        }
      }
    }
    if (!best) return null;
    return {
      x: Math.round(r.left + (r.width * best.ix) / cols),
      y: Math.round(r.top + (r.height * best.iy) / rows),
      margin: bestScore * step,
    };
  })()`);
}
async function openViewMenu(point) {
  const state = await evaluate("window.__viewportMenuState()");
  if (state.viewMenu.open) return;
  await realClick(point.x, point.y);
  await sleep(300);
}
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, name), Buffer.from(s.data, "base64"));
  return join(OUT_DIR, name);
}
const deg = (r) => (r * 180) / Math.PI;

let exitCode = 0;
const shots = [];
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
    "Boolean(window.__viewCubeState && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)",
    { timeoutMs: 180000 },
  );
  if (!ready) throw new Error("viewer 沒有在 180 秒內載入完成");
  await sleep(2500);

  // ------------------------------------------------------------ A 版位/存在
  const layout = await evaluate(`(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height) };
    };
    const scene = r('#scene');
    return { scene, gizmo: r('.viewport-gizmo'), cube: r('#viewCube'),
      rail: r('.gizmo-rail'), menus: r('.viewport-menus'),
      hint: r('.viewport-hint'), metrics: r('.metrics-panel'),
      viewBtn: r('#viewMenuButton'), layersBtn: r('#layersMenuButton') };
  })()`);
  check("A1_gizmo_top_right",
    layout.gizmo && layout.gizmo.x + layout.gizmo.w > layout.scene.w - 40
    && layout.gizmo.y < layout.scene.h * 0.25, layout.gizmo);
  check("A2_cube_is_small",
    layout.cube && layout.cube.w >= 60 && layout.cube.w <= 90, layout.cube);
  check("A3_menus_bottom_left",
    layout.menus && layout.menus.x < 40
    && layout.menus.y + layout.menus.h > layout.scene.h - 60, layout.menus);
  check("A4_hint_bottom_centre",
    layout.hint && Math.abs((layout.hint.x + layout.hint.w / 2) - layout.scene.w / 2) < 60
    && layout.hint.y > layout.scene.h * 0.9, layout.hint);
  check("A5_no_gizmo_metrics_overlap",
    layout.metrics.x + layout.metrics.w < layout.gizmo.x, {
      metrics: layout.metrics, gizmo: layout.gizmo,
    });
  const aria = await evaluate(`(() => {
    const sels = ['#viewCube [data-cube-face="front"]', '#viewCube [data-cube-face="top"]',
      '[data-camera-action="home"]', '[data-camera-action="projection"]',
      '[data-camera-action="focus"]', '.gizmo-rail [data-view="isometric"]',
      '#viewMenuButton', '#layersMenuButton'];
    return sels.map((s) => {
      const el = document.querySelector(s);
      return { sel: s, label: el?.getAttribute('aria-label') ?? null,
        tabbable: el ? el.tabIndex >= 0 : false };
    });
  })()`);
  check("A6_aria_labels", aria.every((a) => a.label && a.tabbable),
    aria.filter((a) => !a.label || !a.tabbable));
  const hintText = await evaluate("document.querySelector('.viewport-hint span').textContent");
  check("A7_hint_matches_scheme_b",
    hintText.includes("拖曳旋轉") && hintText.includes("Shift") && hintText.includes("滾輪"),
    hintText);

  // 鍵盤可達性:focus + Enter 要能操作,且 focus-visible 有外框規則。
  await evaluate("document.querySelector('#viewMenuButton').focus()");
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter",
    code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "char", text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter",
    code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(350);
  const keyboard = await evaluate(`(() => {
    const state = window.__viewportMenuState();
    const focusRule = [...document.styleSheets].some((sheet) => {
      try {
        return [...sheet.cssRules].some((rule) => rule.selectorText
          && rule.selectorText.includes('focus-visible')
          && /outline/.test(rule.cssText));
      } catch { return false; }
    });
    const cubeTab = document.querySelector('[data-cube-face="front"]').tabIndex;
    const layerTab = document.querySelector('#layer-vehicles').tabIndex;
    return { open: state.viewMenu.open, focusRule, cubeTab, layerTab,
      active: document.activeElement.id };
  })()`);
  check("A8_keyboard_and_focus_ring",
    keyboard.open === true && keyboard.focusRule === true
    && keyboard.cubeTab >= 0 && keyboard.layerTab >= 0, keyboard);
  await evaluate("window.__viewportMenuState()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape",
    code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape",
    code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);

  // ------------------------------------------- B ViewCube 跟著相機轉
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(500);
  const cubeA = await evaluate("window.__viewCubeState()");
  const canvas = await evaluate(`(() => {
    const r = document.querySelector('#scene canvas').getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  })()`);
  await drag(canvas.cx, canvas.cy, 260, 0);
  await sleep(700);
  const cubeB = await evaluate("window.__viewCubeState()");
  check("B1_cube_follows_camera",
    cubeA.ready && cubeB.transform !== cubeA.transform
    && cubeB.transform.startsWith("matrix3d"),
    { a: cubeA.transform.slice(0, 46), b: cubeB.transform.slice(0, 46) });
  const facingCount = Object.values(cubeB.faces).filter((f) => !f.back).length;
  check("B2_only_front_faces_hittable",
    facingCount >= 1 && facingCount <= 3, cubeB.faces);

  // --------------------------------- C 六個面逐一用真滑鼠點,朝向要對得上
  const faceReport = {};
  const remaining = new Set(["front", "back", "right", "left", "top"]);
  const seeds = [
    ["front", 170, -80], ["front", -170, -80], ["back", 170, -80],
    ["back", -170, -80], ["right", 170, -80], ["left", -170, -80],
    ["top", 170, 90], ["front", 90, -140], ["back", 90, -140],
    ["right", -90, -140], ["left", 90, -140],
  ];
  for (const [seed, dx, dy] of seeds) {
    if (remaining.size === 0) break;
    await evaluate(`window.__applyViewCubeFace('${seed}')`);
    await sleep(950);
    await drag(canvas.cx, canvas.cy, dx, dy);
    await sleep(650);
    for (const face of [...remaining]) {
      const point = await hitPoint(`#viewCube [data-cube-face="${face}"]`);
      if (!point) continue;
      const expected = await evaluate(`window.__cubeFaceDirection('${face}')`);
      await realClick(point.x, point.y);
      await sleep(1100);
      const state = await evaluate("window.__cameraState()");
      const wantAzimuth = deg(Math.atan2(expected[0], expected[2]));
      const wantPolar = deg(Math.acos(Math.max(-1, Math.min(1, expected[1]))));
      const dAz = face === "top"
        ? 0
        : Math.abs(((state.azimuthDeg - wantAzimuth + 540) % 360) - 180);
      const dPolar = Math.abs(state.polarDeg - Math.min(wantPolar, 84.6));
      faceReport[face] = {
        clickedAt: point, azimuthDeg: Number(state.azimuthDeg.toFixed(2)),
        wantAzimuth: Number(wantAzimuth.toFixed(2)),
        polarDeg: Number(state.polarDeg.toFixed(2)),
        wantPolar: Number(Math.min(wantPolar, 84.6).toFixed(2)),
        mode: state.mode, preset: state.preset,
      };
      check(`C_${face}_real_click`, dAz < 2.5 && dPolar < 2.5, faceReport[face]);
      remaining.delete(face);
      break;
    }
  }
  for (const face of remaining) {
    check(`C_${face}_real_click`, false, "面沒有在任何 seed 下露出來,無法真滑鼠點擊");
  }
  check("C_all_five_faces_clicked", remaining.size === 0,
    { clicked: Object.keys(faceReport) });

  // ------------------------------------------------ D 右上角 rail 四顆
  await evaluate("window.__setCameraPreset('street', { immediate: true })");
  await sleep(500);
  const homePoint = await hitPoint('.gizmo-rail [data-camera-action="home"]');
  await realClick(homePoint.x, homePoint.y);
  await sleep(1200);
  const afterHome = await evaluate("window.__cameraState()");
  check("D1_home", afterHome.preset === "overview" && afterHome.mode === "orbit",
    { point: homePoint, preset: afterHome.preset, mode: afterHome.mode });

  const isoPoint = await hitPoint('.gizmo-rail [data-view="isometric"]');
  await realClick(isoPoint.x, isoPoint.y);
  await sleep(1200);
  const afterIso = await evaluate("window.__cameraState()");
  check("D2_isometric", afterIso.preset === "isometric",
    { point: isoPoint, preset: afterIso.preset, polar: afterIso.polarDeg });

  const projPoint = await hitPoint('[data-camera-action="projection"]');
  await realClick(projPoint.x, projPoint.y);
  await sleep(700);
  const ortho = await evaluate(`({ state: window.__cameraState(),
    text: document.querySelector('#projectionToggle').textContent,
    pressed: document.querySelector('#projectionToggle').getAttribute('aria-pressed') })`);
  await realClick(projPoint.x, projPoint.y);
  await sleep(700);
  const persp = await evaluate(`({ state: window.__cameraState(),
    text: document.querySelector('#projectionToggle').textContent,
    pressed: document.querySelector('#projectionToggle').getAttribute('aria-pressed') })`);
  check("D3_projection_toggle",
    ortho.state.projection === "orthographic" && ortho.text === "Ortho"
    && ortho.pressed === "true" && persp.state.projection === "perspective"
    && persp.text === "Persp" && persp.pressed === "false",
    { ortho: ortho.text, persp: persp.text });

  const focusDisabled = await evaluate(`(() => {
    window.__setCameraPreset('overview', { immediate: true });
    return document.querySelector('#focusSelected').disabled;
  })()`);
  await sleep(500);
  await evaluate(`(() => {
    const r = document.querySelector('#scene canvas').getBoundingClientRect();
    const hit = window.__pickAt(r.left + r.width / 2, r.top + r.height / 2);
    return hit;
  })()`);
  // 用真滑鼠在畫面上點一下 KBot 讓 Focus 解鎖
  await evaluate("window.__setCameraPreset('robot', { immediate: true })");
  await sleep(900);
  await realClick(canvas.cx, canvas.cy);
  await sleep(500);
  const selection = await evaluate(`({ label: document.querySelector('#cameraSelectionLabel').textContent,
    disabled: document.querySelector('#focusSelected').disabled,
    selection: window.__cameraState().selection })`);
  const focusPoint = selection.disabled
    ? null
    : await hitPoint('[data-camera-action="focus"]');
  if (focusPoint) {
    await realClick(focusPoint.x, focusPoint.y);
    await sleep(1300);
  }
  const afterFocus = focusPoint ? await evaluate(`({ state: window.__cameraState(),
    ndc: window.__projectPoint(window.__cameraState().target) })`) : null;
  check("D4_focus_selected",
    focusDisabled === true && selection.disabled === false && afterFocus
    && Math.abs(afterFocus.ndc[0]) < 0.1 && Math.abs(afterFocus.ndc[1]) < 0.1,
    { focusDisabledAtStart: focusDisabled, selection, ndc: afterFocus?.ndc });

  // ---------------------------------------------- E View 選單(真滑鼠)
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(400);
  const viewBtnPoint = await hitPoint("#viewMenuButton");
  await realClick(viewBtnPoint.x, viewBtnPoint.y);
  await sleep(350);
  const menuOpen = await evaluate("window.__viewportMenuState()");
  check("E1_view_menu_opens", menuOpen.viewMenu.open === true
    && menuOpen.viewMenu.expanded === "true", menuOpen);
  shots.push(await shot("v21_view_menu.png"));

  const presetButtons = [
    ['[data-camera="overview"]', "overview"], ['[data-view="isometric"]:not(.gizmo-button)', "isometric"],
    ['[data-camera="street"]', "street"], ['[data-camera="robot"]', "robot"],
    ['[data-view="intersection"]', "intersection"], ['[data-camera="busstop"]', "busstop"],
    ['[data-camera="crosswalk"]', "crosswalk"], ['[data-camera="hook"]', "hook"],
  ];
  const presetReport = {};
  for (const [selector, expected] of presetButtons) {
    await openViewMenu(viewBtnPoint);
    const point = await hitPoint(`#viewMenu ${selector}`);
    if (!point) { check(`E2_${expected}_click`, false, "選單裡點不到"); continue; }
    await realClick(point.x, point.y);
    await sleep(1200);
    const state = await evaluate("window.__cameraState()");
    const active = await evaluate(
      `document.querySelector('#viewMenu ${selector}').classList.contains('is-active')`,
    );
    const closed = (await evaluate("window.__viewportMenuState()")).viewMenu.open === false;
    presetReport[expected] = { preset: state.preset, mode: state.mode, active, closed };
    check(`E2_${expected}_click`,
      state.preset === expected && active === true && closed === true,
      presetReport[expected]);
  }

  const modeReport = {};
  for (const mode of ["orbit", "follow", "fixed", "top", "street"]) {
    await openViewMenu(viewBtnPoint);
    const point = await hitPoint(`#viewMenu [data-camera-mode="${mode}"]`);
    if (!point) { check(`E3_mode_${mode}`, false, "選單裡點不到"); continue; }
    await realClick(point.x, point.y);
    await sleep(1300);
    const state = await evaluate("window.__cameraState()");
    const active = await evaluate(
      `document.querySelector('[data-camera-mode="${mode}"]').classList.contains('is-active')`,
    );
    modeReport[mode] = { mode: state.mode, active,
      polar: Number(state.polarDeg.toFixed(1)) };
    check(`E3_mode_${mode}`, state.mode === mode && active === true, modeReport[mode]);
  }
  await evaluate("window.__setCameraMode('orbit')");
  await sleep(900);

  // ------------------------------------------------- F Layers 選單(真滑鼠)
  const layersBtnPoint = await hitPoint("#layersMenuButton");
  await realClick(layersBtnPoint.x, layersBtnPoint.y);
  await sleep(350);
  const layersOpen = await evaluate("window.__viewportMenuState()");
  check("F1_layers_menu_opens", layersOpen.layersMenu.open === true
    && layersOpen.viewMenu.open === false, layersOpen);
  shots.push(await shot("v21_layers_menu.png"));

  const layerIds = ["vehicles", "pedestrians", "kbot", "signals", "markings", "buildings"];
  const layerReport = {};
  // 標線圖層要先把它自己的開關打開,否則本來就是隱藏的,測不出差異。
  await evaluate(`(() => { const el = document.querySelector('#hookTurn');
    if (!el.checked) el.click(); return el.checked; })()`);
  await sleep(400);
  for (const id of layerIds) {
    const point = await hitPoint(`[data-layer="${id}"]`);
    if (!point) { check(`F2_layer_${id}`, false, "圖層列點不到"); continue; }
    const before = (await evaluate("window.__layerState()"))[id];
    await realClick(point.x, point.y);
    await sleep(500);
    const off = (await evaluate("window.__layerState()"))[id];
    await realClick(point.x, point.y);
    await sleep(500);
    const on = (await evaluate("window.__layerState()"))[id];
    layerReport[id] = { before, off, on };
    check(`F2_layer_${id}`,
      before.enabled === true && before.nodes > 0 && before.visibleNodes > 0
      && off.enabled === false && off.visibleNodes === 0
      && on.enabled === true && on.visibleNodes === before.visibleNodes,
      layerReport[id]);
  }
  await realClick(layersBtnPoint.x, layersBtnPoint.y);
  await sleep(300);
  const closedAll = await evaluate("window.__viewportMenuState()");
  check("F3_menus_close",
    closedAll.viewMenu.open === false && closedAll.layersMenu.open === false, closedAll);

  // ---------------------------------------------- G Escape 與點空白處收起
  await openViewMenu(viewBtnPoint);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape",
    code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape",
    code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  const afterEsc = await evaluate("window.__viewportMenuState()");
  await openViewMenu(viewBtnPoint);
  await realClick(canvas.cx, canvas.cy - 200);
  await sleep(350);
  const afterOutside = await evaluate("window.__viewportMenuState()");
  check("G1_escape_and_outside_close",
    afterEsc.viewMenu.open === false && afterOutside.viewMenu.open === false,
    { afterEsc: afterEsc.viewMenu, afterOutside: afterOutside.viewMenu });

  // ------------------------------------------------- H 舊 API 相容性紅線
  const contract = await evaluate(`({
    cameras: [...document.querySelectorAll('[data-camera]')].map(b => b.dataset.camera),
    commands: [...document.querySelectorAll('[data-command]')].length,
    paramIds: ['#paramGroups', '#paramSearch', '#paramResetAll']
      .every(s => Boolean(document.querySelector(s))),
    hooks: ['__params', '__setParam', '__paramMeta', '__paramCode', '__setCamera',
      '__setNodeVisibility', '__cameraState', '__layerState']
      .every(k => typeof window[k] === 'function'),
    setCameraSync: (() => {
      const ok = window.__setCamera([10, 5, 0], [0, 1, 0]);
      const s = window.__cameraState();
      return ok === true && Math.abs(s.target[1] - 1) < 0.001 && !s.transitioning;
    })(),
  })`);
  check("H1_data_camera_exactly_6", contract.cameras.length === 6, contract.cameras);
  check("H2_data_command_4", contract.commands === 4, contract.commands);
  check("H3_param_panel_intact", contract.paramIds === true && contract.hooks === true,
    contract);
  check("H4_setCamera_still_sync", contract.setCameraSync === true, contract.setCameraSync);

  // ------------------------------------------------------ I 錄影模式隱藏
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (!el.checked) el.click(); return el.checked; })()`);
  await sleep(600);
  const recording = await evaluate(`(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== 'none' : null;
    };
    return { gizmo: vis('.viewport-gizmo'), menus: vis('.viewport-menus'),
      hint: vis('.viewport-hint'), tools: vis('.camera-tools'),
      toolbar: vis('.camera-toolbar') };
  })()`);
  check("I1_recording_hides_all_new_chrome",
    Object.values(recording).every((v) => v === false), recording);
  await evaluate(`(() => { const el = document.querySelector('#recordingMode');
    if (el.checked) el.click(); return el.checked; })()`);
  await sleep(600);

  // ---------------------------------------------------------- Z 收尾截圖
  await evaluate("window.__setCameraPreset('overview', { immediate: true })");
  await sleep(1200);
  shots.push(await shot("v21_default.png"));
  check("Z_no_console_errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));

  writeFileSync(join(OUT_DIR, "v21_viewport_ui_report.json"), JSON.stringify({
    results, layout, faceReport, presetReport, modeReport, layerReport,
    consoleErrors, shots,
  }, null, 2));
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
