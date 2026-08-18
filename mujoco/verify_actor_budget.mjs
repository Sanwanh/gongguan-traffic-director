// §17 擬物化預算驗收:尖峰車流 + 高效能渲染下量 draw call / FPS / 每型別
// mesh 與三角形,檢查行人步態不打滑、reducedMotion 會凍在 Idle,並存下
// 鳥瞰 / 街道 / 公車站三張圖與六張特寫供人工看。
//
// 先決條件:serve.py 已在 8124 起來(python3 serve.py --port 8124 --directory .)
// 執行:node mujoco/verify_actor_budget.mjs [--port 8124] [--tag v6]
//        [--out mujoco/verify_shots] [--no-closeups]
//
// 紅線(§15 效能稽核 + §17d 實測基準,Apple M4 / 1920×1080 / pixelRatio 1):
//   尖峰 63 個 actor 時 drawCalls 中位數 ≤ 2900、measuredFps 中位數 ≥ 40、
//   console error 0、行人 strideRatio == 1.000。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const PORT = Number(argValue("--port", "8124"));
const OUT_DIR = argValue(
  "--out",
  new URL("verify_shots", import.meta.url).pathname,
);
const TAG = argValue("--tag", "v6");
const CLOSEUPS = argv.includes("--no-closeups") ? false : true;
const DEBUG_PORT = Number(argValue("--cdp-port", "9353"));
const PROFILE_DIR = `/private/tmp/claude-501/-Users-san/chrome-verify-${TAG}`;
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    }, 120000);
  });
}
let send = rawSend;

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
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

async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const buffer = Buffer.from(shot.data, "base64");
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, buffer);
  return { file, bytes: buffer.length };
}

async function setSwitch(id, want) {
  return evaluate(`(() => { const el = document.querySelector('#${id}');
    if (el.checked !== ${want}) el.click(); return el.checked; })()`);
}
async function setSelect(id, value) {
  return evaluate(`(() => { const el = document.querySelector('#${id}');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
}
async function clickCamera(id) {
  await evaluate(`document.querySelector('[data-camera="${id}"]').click()`);
  await sleep(900);
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
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return (await response.json()).webSocketDebuggerUrl;
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
        if (message.error) no(new Error(message.error.message)); else ok(message.result);
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

const report = { tag: TAG, consoleErrors, shots: [] };
let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await rawSend("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rawSend("Target.attachToTarget", { targetId, flatten: true });
  send = (m, p = {}) => (m.startsWith("Target.") || m.startsWith("Browser.")
    ? rawSend(m, p) : rawSend(m, p, sessionId));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(
    "Boolean(window.__trafficDirectorDebug && window.__renderStats"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false)");
  if (!ready) throw new Error("viewer 沒有在 150 秒內載入完成");

  report.gpu = await evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  })()`);
  report.panel = {
    highPerformance: await setSwitch("highPerformance", true),
    motionEffects: await setSwitch("motionEffects", true),
    autoMode: await setSwitch("autoMode", true),
    trafficDensity: await setSelect("trafficDensity", "peak"),
  };
  await sleep(15000);

  if (await evaluate("typeof window.__actorRenderAudit === 'function'")) {
    report.actorAudit = await evaluate("window.__actorRenderAudit()");
  }

  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    await sleep(1100);
    samples.push(await evaluate("window.__renderStats()"));
  }
  const fps = samples.map((s) => s.measuredFps).sort((a, b) => a - b);
  const calls = samples.map((s) => s.drawCalls).sort((a, b) => a - b);
  const tris = samples.map((s) => s.triangles ?? 0).sort((a, b) => a - b);
  report.perf = {
    mode: samples[0].mode,
    fpsMin: fps[0], fpsMedian: fps[Math.floor(fps.length / 2)], fpsMax: fps[fps.length - 1],
    drawCallsMin: calls[0], drawCallsMedian: calls[Math.floor(calls.length / 2)],
    drawCallsMax: calls[calls.length - 1],
    trianglesMedian: tris[Math.floor(tris.length / 2)],
    samples,
  };
  report.vehicleCounts = await evaluate(
    "window.__trafficDirectorDebug.snapshot().vehicleCounts");

  if (await evaluate("typeof window.__pedestrianGait === 'function'")) {
    report.gait = await evaluate(`(() => {
      const list = window.__pedestrianGait();
      const moving = list.filter(p => p.speed > 0.05 && p.walkWeight !== null);
      const ratios = moving.map(p => p.strideRatio).filter(r => r !== null);
      return {
        rig: list[0]?.rig ?? null,
        n: list.length,
        movingN: moving.length,
        strideRatioMin: ratios.length ? Math.min(...ratios) : null,
        strideRatioMax: ratios.length ? Math.max(...ratios) : null,
        walkWeightMin: moving.length ? Math.min(...moving.map(p => p.walkWeight)) : null,
        sample: list.slice(0, 4),
      };
    })()`);
    // 動畫時間軸有在推進 = mixer 真的在跑。
    const t0 = await evaluate("window.__pedestrianGait().map(p => p.walkTime)");
    await sleep(900);
    const t1 = await evaluate("window.__pedestrianGait().map(p => p.walkTime)");
    report.gait.walkTimeAdvanced = t0.filter((v, i) => t1[i] !== v).length;
    report.gait.distinctStartPhases = new Set(t0.map((v) => Math.round(v * 100))).size;
  }

  for (const [camera, name] of [
    ["overview", `${TAG}_actors_overview`],
    ["street", `${TAG}_actors_street`],
    ["busstop", `${TAG}_actors_busstop`],
  ]) {
    await clickCamera(camera);
    await sleep(1500);
    report.shots.push({ camera, ...(await screenshot(name)) });
  }

  if (CLOSEUPS) {
    for (const type of ["car", "bus", "scooter", "motorcycle", "bicycle"]) {
      const picked = await evaluate(`(() => {
        const list = window.__vehicleStates().filter(v => v.type === ${JSON.stringify(type)});
        if (!list.length) return null;
        const v = list[Math.floor(list.length / 2)];
        return { s: v.s, t: v.lane_t };
      })()`);
      if (!picked) continue;
      const d = type === "bus" ? 8 : 4.6;
      await evaluate(`window.__setCamera([${picked.s + d}, ${type === "bus" ? 3.4 : 2.2}, `
        + `${picked.t + d}], [${picked.s}, ${type === "bus" ? 1.6 : 0.9}, ${picked.t}])`);
      await sleep(800);
      report.shots.push({ camera: `closeup-${type}`, ...(await screenshot(`${TAG}_closeup_${type}`)) });
    }
    const ped = await evaluate(`(() => {
      const list = window.__pedestrianStates()
        .filter(p => p.visible && (p.state === 'crossing' || p.state === 'sidewalk_approach'));
      return list.length ? { s: list[0].s, t: list[0].t } : null;
    })()`);
    if (ped) {
      await evaluate(`window.__setCamera([${ped.s + 2.4}, 1.8, ${ped.t + 2.6}], `
        + `[${ped.s}, 0.9, ${ped.t}])`);
      await sleep(700);
      report.shots.push({ camera: "closeup-pedestrian", ...(await screenshot(`${TAG}_closeup_pedestrian`)) });
      // 步態確實在動:同一機位隔 0.35 s 再截一張。
      await sleep(350);
      report.shots.push({ camera: "closeup-pedestrian-2", ...(await screenshot(`${TAG}_closeup_pedestrian_b`)) });
    }
  }

  // reducedMotion(關掉「動作效果」):行人必須凍在 Idle 站姿,不得報錯。
  await setSwitch("motionEffects", false);
  await sleep(1200);
  if (await evaluate("typeof window.__pedestrianGait === 'function'")) {
    const a = await evaluate("window.__pedestrianGait().map(p => p.walkTime)");
    await sleep(900);
    const b = await evaluate("window.__pedestrianGait().map(p => p.walkTime)");
    report.reducedMotion = {
      frozenPedestrians: a.filter((v, i) => b[i] === v).length,
      total: a.length,
      walkWeightMax: Math.max(...(await evaluate(
        "window.__pedestrianGait().map(p => p.walkWeight ?? 0)"))),
    };
  }
  await setSwitch("motionEffects", true);
} catch (error) {
  report.error = String(error?.stack ?? error);
  exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* noop */ }
  chrome.kill("SIGTERM");
}
writeFileSync(join(OUT_DIR, `${TAG}_actor_report.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, perf: { ...report.perf, samples: undefined } }, null, 1));
process.exit(exitCode);
