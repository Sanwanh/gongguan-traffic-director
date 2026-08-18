// §22 簡約化前後的「視覺重量」量測(CDP headless)。
//   - 疊層佔 3D 場景面積的百分比(逐一列出 + 合計)
//   - 右側面板收合/展開的 scrollHeight(換算成幾個螢幕高)
//   - 裝飾性 CSS 統計:backdrop-filter / glow 陰影 / 圓角 / 字級種類
//   - 1920x1080 與 1440x900 各截一張全頁圖
// 用法:node mujoco/measure_visual_weight.mjs <label>
//   例:node mujoco/measure_visual_weight.mjs before
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "verify_shots");
const LABEL = process.argv[2] ?? "run";
const PORT = Number(process.env.PORT ?? 8124);
const DEBUG_PORT = Number(process.env.DEBUG_PORT ?? 9382);
const PROFILE_DIR = "/private/tmp/claude-501/-Users-san/chrome-visual-weight";
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];

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
async function shot(name) {
  const s = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, name), Buffer.from(s.data, "base64"));
  return join(OUT_DIR, name);
}

// 疊層面積:所有「絕對定位在 .viewport 之上」的可見元素,取最上層那批
// (不遞迴進子元素,避免重複計算)。
const OVERLAY_PROBE = `(() => {
  const viewport = document.querySelector('.viewport');
  const vr = viewport.getBoundingClientRect();
  const sceneArea = vr.width * vr.height;
  const candidates = [...viewport.children].filter((el) => {
    if (el.id === 'scene') return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  });
  const items = candidates.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      sel: el.className ? '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase(),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left - vr.left), y: Math.round(r.top - vr.top),
      pct: Number(((r.width * r.height) / sceneArea * 100).toFixed(2)),
    };
  }).filter((i) => i.w > 0 && i.h > 0);
  const total = Number(items.reduce((s, i) => s + i.pct, 0).toFixed(2));
  return {
    viewport: { w: Math.round(vr.width), h: Math.round(vr.height) },
    scenePctOfWindow: Number((sceneArea / (innerWidth * innerHeight) * 100).toFixed(2)),
    items: items.sort((a, b) => b.pct - a.pct),
    overlayPctOfScene: total,
  };
})()`;

// 裝飾性 CSS 統計:直接對 CSS 原始檔做文字分析(CSSOM 在 headless 下拿不到
// 完整規則,而且我們要的是「原始碼裡還剩多少裝飾」,文字分析更貼題)。
function analyseCss() {
  const cssPath = join(here, "..", "viewer", "traffic_director.css");
  const raw = readFileSync(cssPath, "utf8");
  // 去掉註解,避免把說明文字算進來。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const all = (re) => [...css.matchAll(re)].map((m) => m[0].trim());

  const backdrop = all(/backdrop-filter\s*:\s*(?!none)[^;]+/g);
  // glow = 無位移的彩色外陰影(0 0 Npx / 0 0 0 Npx),排除 inset。
  const shadows = all(/box-shadow\s*:[^;]+/g);
  const glow = shadows.filter((s) => /:\s*0\s+0\s+(0\s+)?[\d.]+px/.test(s)
    && !/inset/.test(s));
  const radii = all(/border-radius\s*:\s*[\d.]+px/g)
    .map((s) => parseFloat(s.split(":")[1]));
  const bigRadius = radii.filter((v) => v >= 8);
  const fontSizes = {};
  for (const m of css.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
    fontSizes[`${m[1]}px`] = (fontSizes[`${m[1]}px`] ?? 0) + 1;
  }
  const zIndexes = {};
  for (const m of css.matchAll(/z-index\s*:\s*(-?\d+)/g)) {
    zIndexes[m[1]] = (zIndexes[m[1]] ?? 0) + 1;
  }
  const hexes = {};
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    hexes[m[0].toLowerCase()] = (hexes[m[0].toLowerCase()] ?? 0) + 1;
  }
  // :root 之後才算「散落的硬寫色」(token 定義本身不算)。
  const rootEnd = css.indexOf("}", css.indexOf(":root"));
  const body = css.slice(rootEnd);
  const bodyHexes = {};
  for (const m of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    bodyHexes[m[0].toLowerCase()] = (bodyHexes[m[0].toLowerCase()] ?? 0) + 1;
  }
  const varUses = (css.match(/var\(--/g) ?? []).length;
  const tokens = (css.slice(0, rootEnd).match(/--[a-z0-9-]+\s*:/g) ?? []).length;

  return {
    backdropFilterCount: backdrop.length,
    backdropFilter: backdrop,
    glowShadowCount: glow.length,
    glowShadow: glow,
    bigRadiusCount: bigRadius.length,
    maxRadiusPx: radii.length ? Math.max(...radii.filter((v) => v < 900)) : 0,
    fontSizeVariants: Object.keys(fontSizes).length,
    fontSizes,
    zIndexVariants: Object.keys(zIndexes).length,
    zIndexes,
    hardcodedHexOccurrences: Object.values(bodyHexes).reduce((a, b) => a + b, 0),
    hardcodedHexUnique: Object.keys(bodyHexes).length,
    tokenCount: tokens,
    varUsages: varUses,
    animationCount: (css.match(/animation\s*:[^;]+/g) ?? []).length,
  };
}

const PANEL_PROBE = `(() => {
  const panel = document.querySelector('.control-panel');
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  const vh = innerHeight;
  // §22 之後真正會捲的是 .panel-scroll;之前是 .control-panel 自己。
  const scroller = document.querySelector('.panel-scroll') ?? panel;
  const measure = () => {
    const opened = [...scroller.querySelectorAll('details')];
    const prior = opened.map((d) => d.open);
    const collapsedScrollH = scroller.scrollHeight;
    opened.forEach((d) => { d.open = true; });
    const expandedScrollH = scroller.scrollHeight;
    opened.forEach((d, i) => { d.open = prior[i]; });
    return { collapsedScrollH, expandedScrollH, detailsCount: opened.length };
  };
  const out = {
    width: Math.round(r.width),
    pctOfWindow: Number((r.width / innerWidth * 100).toFixed(2)),
    clientHeight: scroller.clientHeight,
    totalControls: panel.querySelectorAll('input, select, button').length,
  };
  if (window.__setPanelTab) {
    // 分頁版:逐頁量,因為一次只顯示一組
    const before = window.__panelState().tab;
    out.perTab = {};
    for (const tab of ['command', 'sim', 'params']) {
      window.__setPanelTab(tab);
      const m = measure();
      out.perTab[tab] = {
        collapsedScreens: Number((m.collapsedScrollH / vh).toFixed(2)),
        expandedScreens: Number((m.expandedScrollH / vh).toFixed(2)),
        ...m,
      };
    }
    window.__setPanelTab(before);
    const worstC = Math.max(...Object.values(out.perTab).map((t) => t.collapsedScrollH));
    const worstE = Math.max(...Object.values(out.perTab).map((t) => t.expandedScrollH));
    out.worstCollapsedScrollH = worstC;
    out.worstCollapsedScreens = Number((worstC / vh).toFixed(2));
    out.worstExpandedScrollH = worstE;
    out.worstExpandedScreens = Number((worstE / vh).toFixed(2));
    out.detailsCount = panel.querySelectorAll('details').length;
  } else {
    const m = measure();
    out.worstCollapsedScrollH = m.collapsedScrollH;
    out.worstCollapsedScreens = Number((m.collapsedScrollH / vh).toFixed(2));
    out.worstExpandedScrollH = m.expandedScrollH;
    out.worstExpandedScreens = Number((m.expandedScrollH / vh).toFixed(2));
    out.detailsCount = m.detailsCount;
  }
  return out;
})()`;

let exitCode = 0;
const report = { label: LABEL, at: new Date().toISOString() };
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
    "Boolean(document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-error') === false)",
    { timeoutMs: 180000 },
  );
  if (!ready) throw new Error("viewer 沒有在 180 秒內載入完成");
  await sleep(3000);

  report.at1920 = {
    overlay: await evaluate(OVERLAY_PROBE),
    panel: await evaluate(PANEL_PROBE),
  };
  report.decor = analyseCss();
  shots.push(await shot(`v22_${LABEL}_1920.png`));

  // 1440x900
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1200);
  report.at1440 = {
    overlay: await evaluate(OVERLAY_PROBE),
    panel: await evaluate(PANEL_PROBE),
  };
  shots.push(await shot(`v22_${LABEL}_1440.png`));

  report.consoleErrors = consoleErrors;
  report.shots = shots;
  writeFileSync(
    join(OUT_DIR, `v22_measure_${LABEL}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({
    label: LABEL,
    scene1920: report.at1920.overlay.viewport,
    scenePctOfWindow1920: report.at1920.overlay.scenePctOfWindow,
    overlayPctOfScene1920: report.at1920.overlay.overlayPctOfScene,
    overlayItems1920: report.at1920.overlay.items,
    panel1920: report.at1920.panel,
    scenePctOfWindow1440: report.at1440.overlay.scenePctOfWindow,
    overlayPctOfScene1440: report.at1440.overlay.overlayPctOfScene,
    decor: {
      backdropFilterCount: report.decor.backdropFilterCount,
      glowShadowCount: report.decor.glowShadowCount,
      bigRadiusCount: report.decor.bigRadiusCount,
      fontSizeVariants: report.decor.fontSizeVariants,
      fontSizes: report.decor.fontSizes,
      zIndexVariants: report.decor.zIndexVariants,
      animationCount: report.decor.animationCount,
    },
    consoleErrors,
  }, null, 2));
  console.log(`shots: ${shots.join(" ")}`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
process.exit(exitCode);
