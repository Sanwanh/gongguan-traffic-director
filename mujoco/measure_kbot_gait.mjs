// §26 KBot 步態量測(before/after 用同一支腳本,數字可直接對照)。
//
// 量四件事,全部用 window.__kbotGaitProbe() 的逐幀取樣:
//   A 朝向與腳滑：沿 ±s / ±t 四個方向各走一趟,量「站立腳」在世界座標的
//     側向滑移(垂直於行進方向)與沿軌滑移(平行於行進方向)。
//     側向滑移是「朝向錯了」的直接指標——朝向對了它就會是 0。
//   B 起停：從靜止起步 0.4 s 內身體位移、同期站立腳位移、起停當幀的
//     |Δholder.y|。
//   C 轉身：走一條 90° 折線,量 yaw 目標的單幀最大跳動、轉向期間身體位移。
//   D 擺臂：穩態走路時兩手掌相對本體的前後擺幅,以及左右相關係數
//     (自然走路應該是反相 → 相關係數為負)。
//   E 離地：站立與走路時腳底(三顆 mesh 的世界 AABB min.y)離崗位 y 的高度。
//
// 用法:node mujoco/measure_kbot_gait.mjs [--port 8124] [--tag before]
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
const TAG = argValue("--tag", "after");
const DEBUG_PORT = Number(argValue("--cdp-port", "9377"));
const OUT_DIR = argValue("--out", join(here, "verify_gait"));
const PROFILE_DIR = `/private/tmp/claude-501/-Users-san/chrome-gait-${TAG}`;
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

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
async function waitUntil(expression, { timeoutMs = 90000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

// ------------------------------------------------------------------ 統計
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const round = (v, n = 1) => (v === null || v === undefined ? null : Number(v.toFixed(n)));
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma; const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// ----------------------------------------------------------------- Chrome
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--window-size=1280,720",
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

const report = { tag: TAG, port: PORT, generatedAt: new Date().toISOString() };
let exitCode = 0;
try {
  socket = await openSocket(await connect());
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? rawSend(method, params)
      : rawSend(method, params, sessionId)
  );
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: PAGE_URL });
  const ready = await waitUntil(`(() => {
    const dot = document.querySelector('#modelStatus .status-dot');
    if (!dot) return false;
    return !dot.classList.contains('is-loading') && !dot.classList.contains('is-error');
  })()`, { timeoutMs: 120000 });
  if (!ready) throw new Error("viewer 沒有載入完成");
  await waitUntil("typeof window.__kbotGaitProbe === 'function' && !!window.__kbotGaitProbe()");
  // 進場走完再開始量(否則第一趟會被進場路線蓋掉)
  await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true",
    { timeoutMs: 90000 },
  );

  // 錄影器:掛在 rAF 上,逐幀存 __kbotGaitProbe()
  await evaluate(`window.__gaitRec = { on: false, rows: [] };
    window.__gaitStart = () => {
      window.__gaitRec = { on: true, rows: [] };
      const tick = () => {
        if (!window.__gaitRec.on) return;
        const row = window.__kbotGaitProbe();
        if (row) window.__gaitRec.rows.push(row);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    };
    window.__gaitStop = () => { window.__gaitRec.on = false; return window.__gaitRec.rows; };
    true;`);

  // ------------------------------------------------------- A 四方向直線走
  // 起點都在人行道 y,走 8 m 直線。速度用勤務速度(最容易看出滑腳)。
  const POST_Y = await evaluate("window.__kbotPosts().posts.stand.y");
  const DUTY = await evaluate("window.__params()['kbot.dutySpeed']");
  report.postY = POST_Y;
  report.dutySpeed = DUTY;
  report.posts = await evaluate("window.__kbotPosts().posts");
  // 地面高度:三個崗位與進場路徑中繼點正下方的實景面
  report.ground = await evaluate(`(() => {
    const posts = window.__kbotPosts().posts;
    const out = {};
    for (const [id, p] of Object.entries(posts)) out[id] = window.__groundHeightAt(p.x, p.z);
    out.entry0 = window.__groundHeightAt(-1.0, 18.2);
    out.entry1 = window.__groundHeightAt(4.0, 17.4);
    return out;
  })()`);
  const LEGS = [
    { id: "plus_s", from: { x: 8, z: 17.15 }, to: { x: 16, z: 17.15 } },
    { id: "minus_s", from: { x: 16, z: 17.15 }, to: { x: 8, z: 17.15 } },
    { id: "plus_t", from: { x: 15, z: 9.0 }, to: { x: 15, z: 17.0 } },
    { id: "minus_t", from: { x: 15, z: 17.0 }, to: { x: 15, z: 9.0 } },
  ];
  report.legs = {};
  for (const leg of LEGS) {
    await evaluate(`(() => {
      window.__kbotTeleportProbe({ x: ${leg.from.x}, y: ${POST_Y}, z: ${leg.from.z} });
      window.__kbotWalkProbe([{ x: ${leg.to.x}, y: ${POST_Y}, z: ${leg.to.z} }], ${DUTY});
      return window.__gaitStart();
    })()`);
    const distance = Math.hypot(leg.to.x - leg.from.x, leg.to.z - leg.from.z);
    await sleep(Math.ceil((distance / DUTY) * 1000) + 900);
    const rows = await evaluate("window.__gaitStop()");
    report.legs[leg.id] = analyseLeg(rows, leg);
  }

  // ------------------------------------------------------- C 90° 折線轉身
  await evaluate(`(() => {
    window.__kbotTeleportProbe({ x: 15, y: ${POST_Y}, z: 17.15 });
    window.__kbotWalkProbe([
      { x: 15, y: ${POST_Y}, z: 11.0 },
      { x: 8.0, y: ${POST_Y}, z: 11.0 },
    ], ${DUTY});
    return window.__gaitStart();
  })()`);
  await sleep(Math.ceil(((6.15 + 7.0) / DUTY) * 1000) + 1600);
  report.turn = analyseTurn(await evaluate("window.__gaitStop()"));

  // ------------------------------------------------------- E 站立離地
  // 用 §18 崗位預覽把他釘在 stand 崗位上(勤務狀態機不會把他叫走),
  // 這樣「站立」的量測才是確定性的。
  await evaluate(`(() => { window.__selectKbotPost('stand');
    window.__setKbotPostPreview(true); return true; })()`);
  await sleep(1500);
  await evaluate("window.__gaitStart()");
  await sleep(1500);
  const standRows = await evaluate("window.__gaitStop()");
  // 逐相位量腳底偏移:MuJoCo 烘焙的站姿在不同手勢窗有 PD 追蹤殘差,
  // 腳底相對 holder 原點的高度並不是同一個數字,崗位 y 要取這組的中位。
  const soleByPhase = {};
  for (const phase of ["all_stop", "roosevelt_flow", "pedestrian_crossing",
    "lane90_release"]) {
    await evaluate(
      `document.querySelector('[data-command][data-phase="${phase}"]').click()`,
    );
    await sleep(2500);
    await evaluate("window.__gaitStart()");
    await sleep(900);
    const rows = await evaluate("window.__gaitStop()");
    const usable = rows.filter((r) => r.walkKind === null && r.soleL !== null);
    soleByPhase[phase] = usable.length === 0 ? null : {
      samples: usable.length,
      activePhase: await evaluate("window.__trafficDirectorDebug.snapshot().phase"),
      soleOffsetMm: round(median(
        usable.map((r) => (Math.min(r.soleL, r.soleR) - r.holder[1]) * 1000),
      ), 1),
    };
  }
  report.soleByPhase = soleByPhase;
  await evaluate("window.__setKbotPostPreview(false)");
  const standSole = standRows
    .filter((r) => r.soleL !== null && r.soleR !== null)
    .map((r) => Math.min(r.soleL, r.soleR));
  const standSoleAll = standRows
    .filter((r) => r.soleAllL !== null && r.soleAllR !== null)
    .map((r) => Math.min(r.soleAllL, r.soleAllR));
  const groundY = report.ground?.stand?.y ?? null;
  const standHolderY = median(standRows.map((r) => r.holder[1]));
  report.stand = {
    samples: standRows.length,
    postY: POST_Y,
    groundY,
    holderY: round(standHolderY, 4),
    // 腳底相對 holder 原點的偏移(負 = 腳底在原點下方)。崗位 y 就是
    // 用「地面 y − 這個值」定出來的。
    soleOffsetFromHolderMm: round((median(standSole) - standHolderY) * 1000, 1),
    walkKinds: [...new Set(standRows.map((r) => r.walkKind))],
    soleMinMedian: round(median(standSole), 4),
    soleAllMinMedian: round(median(standSoleAll), 4),
    clearanceAbovePostMm: round((median(standSole) - POST_Y) * 1000, 1),
    clearanceAboveGroundMm: groundY === null
      ? null : round((median(standSole) - groundY) * 1000, 1),
    clearanceAllAboveGroundMm: groundY === null
      ? null : round((median(standSoleAll) - groundY) * 1000, 1),
    facingDeg: round(median(standRows.map((r) => r.facingDeg)), 2),
    footSepDeg: round(median(standRows.map((r) => r.footSepDeg)), 2),
    modelYawDeg: standRows.length ? standRows.at(-1).modelYawDeg : null,
    holderYawDeg: round(median(standRows.map((r) => r.holderYawDeg)), 2),
  };

  report.consoleErrors = consoleErrors;
  writeFileSync(join(OUT_DIR, `${TAG}_gait.json`), `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report);
} catch (error) {
  exitCode = 1;
  console.error("FAILED:", error.message);
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
  setTimeout(() => { try { chrome.kill("SIGKILL"); } catch { /* ignore */ } }, 1500).unref?.();
}
process.exitCode = exitCode;

// --------------------------------------------------------------- 分析函式
function analyseLeg(rows, leg) {
  const moving = rows.filter((r) => r.walkKind === "probe");
  if (moving.length < 10) return { samples: moving.length, error: "沒有取到走路樣本" };
  const dirX = leg.to.x - leg.from.x;
  const dirZ = leg.to.z - leg.from.z;
  const norm = Math.hypot(dirX, dirZ);
  const ux = dirX / norm; const uz = dirZ / norm;      // 行進方向單位向量
  const nx = -uz; const nz = ux;                        // 側向單位向量
  const travelDeg = Math.atan2(dirZ, dirX) * 180 / Math.PI;

  const lateral = []; const along = []; const bodySpeeds = [];
  const facingErr = [];
  for (let i = 1; i < moving.length; i += 1) {
    const a = moving[i - 1]; const b = moving[i];
    const dt = b.tS - a.tS;
    if (!(dt > 0.004 && dt < 0.2)) continue;
    const bodyV = Math.hypot(b.holder[0] - a.holder[0], b.holder[2] - a.holder[2]) / dt;
    bodySpeeds.push(bodyV);
    if (bodyV < 0.15) continue;                        // 起步/煞車段另外算
    if (b.facingDeg !== null) {
      let e = b.facingDeg - travelDeg;
      while (e > 180) e -= 360;
      while (e < -180) e += 360;
      facingErr.push(e);
    }
    // 站立腳 = 兩腳中「世界速度較小」的那隻(貼地的那隻)
    const feet = [["footL", "soleL"], ["footR", "soleR"]].map(([fk]) => {
      if (!a[fk] || !b[fk]) return null;
      const vx = (b[fk][0] - a[fk][0]) / dt;
      const vz = (b[fk][2] - a[fk][2]) / dt;
      return { vx, vz, speed: Math.hypot(vx, vz) };
    }).filter(Boolean);
    if (feet.length < 2) continue;
    const stance = feet[0].speed <= feet[1].speed ? feet[0] : feet[1];
    lateral.push(Math.abs(stance.vx * nx + stance.vz * nz) * 1000);
    along.push(Math.abs(stance.vx * ux + stance.vz * uz) * 1000);
  }
  const bodySpeedMm = median(bodySpeeds) * 1000;
  return {
    samples: moving.length,
    bodySpeedMps: round(median(bodySpeeds), 3),
    modelYawDeg: round(median(moving.map((r) => r.modelYawDeg)), 2),
    holderYawDeg: round(median(moving.map((r) => r.holderYawDeg)), 2),
    clipTimeS: round(median(moving.map((r) => r.clipTimeS)), 3),
    facingDegMedian: round(median(moving.map((r) => r.facingDeg)), 2),
    facingErrDeg: {
      median: round(median(facingErr), 2),
      p90: round(pct(facingErr.map(Math.abs), 0.9), 2),
    },
    stanceLateralSlipMmPerS: {
      p10: round(pct(lateral, 0.1)), median: round(median(lateral)),
      p90: round(pct(lateral, 0.9)), max: round(Math.max(...lateral)),
    },
    stanceAlongSlipMmPerS: {
      p10: round(pct(along, 0.1)), median: round(median(along)),
      p90: round(pct(along, 0.9)),
    },
    plantedFrac: round(
      along.filter((v) => v < 0.15 * bodySpeedMm).length / along.length, 3,
    ),
  };
}

function analyseTurn(rows) {
  const moving = rows.filter((r) => r.walkKind === "probe");
  if (moving.length < 10) return { samples: moving.length, error: "沒有取到走路樣本" };
  let maxYawStepDeg = 0;
  let maxTargetStepDeg = 0;
  for (let i = 1; i < moving.length; i += 1) {
    const wrap = (v) => {
      let x = v; while (x > 180) x -= 360; while (x < -180) x += 360; return x;
    };
    maxYawStepDeg = Math.max(
      maxYawStepDeg, Math.abs(wrap(moving[i].holderYawDeg - moving[i - 1].holderYawDeg)),
    );
    maxTargetStepDeg = Math.max(
      maxTargetStepDeg, Math.abs(wrap(moving[i].yawTargetDeg - moving[i - 1].yawTargetDeg)),
    );
  }
  // 轉向期間:holder yaw 每秒變化 > 12°/s 的連續區段
  let turnS = 0; let turnDist = 0;
  for (let i = 1; i < moving.length; i += 1) {
    const dt = moving[i].tS - moving[i - 1].tS;
    if (!(dt > 0.004 && dt < 0.2)) continue;
    const wrap = (v) => { let x = v; while (x > 180) x -= 360; while (x < -180) x += 360; return x; };
    const rate = Math.abs(wrap(moving[i].holderYawDeg - moving[i - 1].holderYawDeg)) / dt;
    if (rate > 12) {
      turnS += dt;
      turnDist += Math.hypot(
        moving[i].holder[0] - moving[i - 1].holder[0],
        moving[i].holder[2] - moving[i - 1].holder[2],
      );
    }
  }
  // 起步:第一個有速度的樣本後 0.4 s
  const t0 = moving[0].tS;
  const win = moving.filter((r) => r.tS - t0 <= 0.4);
  const startDist = win.length > 1
    ? Math.hypot(
      win.at(-1).holder[0] - win[0].holder[0],
      win.at(-1).holder[2] - win[0].holder[2],
    )
    : null;
  const stanceStart = win.length > 1 && win[0].footL && win.at(-1).footL
    ? Math.min(
      Math.hypot(win.at(-1).footL[0] - win[0].footL[0], win.at(-1).footL[2] - win[0].footL[2]),
      Math.hypot(win.at(-1).footR[0] - win[0].footR[0], win.at(-1).footR[2] - win[0].footR[2]),
    )
    : null;
  // 起停當幀的 |Δholder.y|
  let maxDy = 0;
  for (let i = 1; i < rows.length; i += 1) {
    maxDy = Math.max(maxDy, Math.abs(rows[i].holder[1] - rows[i - 1].holder[1]));
  }
  // 擺臂:穩態(速度 > 0.8 × duty)且沒在轉的樣本
  const hx = []; const hxR = [];
  for (let i = 1; i < moving.length; i += 1) {
    const dt = moving[i].tS - moving[i - 1].tS;
    if (!(dt > 0.004 && dt < 0.2)) continue;
    if (!moving[i].handL || !moving[i].handR) continue;
    hx.push(moving[i].handL[0]);
    hxR.push(moving[i].handR[0]);
  }
  const swingL = hx.length ? (Math.max(...hx) - Math.min(...hx)) * 1000 : null;
  const swingR = hxR.length ? (Math.max(...hxR) - Math.min(...hxR)) * 1000 : null;
  const soles = moving
    .filter((r) => r.soleL !== null && r.soleR !== null)
    .map((r) => Math.min(r.soleL, r.soleR));
  const solesAll = moving
    .filter((r) => r.soleAllL !== null && r.soleAllR !== null)
    .map((r) => Math.min(r.soleAllL, r.soleAllR));
  return {
    samples: moving.length,
    maxYawTargetStepDeg: round(maxTargetStepDeg, 2),
    maxYawStepDeg: round(maxYawStepDeg, 2),
    turnSeconds: round(turnS, 3),
    turnBodyTravelM: round(turnDist, 3),
    startBodyTravel04sM: round(startDist, 3),
    startStanceFootTravel04sM: round(stanceStart, 3),
    maxHolderDyMm: round(maxDy * 1000, 2),
    handSwingForeAftMm: { left: round(swingL), right: round(swingR) },
    handSwingCorrelation: round(correlation(hx, hxR), 3),
    walkSoleAboveBaseMm: {
      min: round((Math.min(...soles) - report.postY) * 1000, 1),
      p10: round((pct(soles, 0.1) - report.postY) * 1000, 1),
      median: round((median(soles) - report.postY) * 1000, 1),
      max: round((Math.max(...soles) - report.postY) * 1000, 1),
    },
    walkSoleAllAboveBaseMm: {
      median: round((median(solesAll) - report.postY) * 1000, 1),
      max: round((Math.max(...solesAll) - report.postY) * 1000, 1),
    },
  };
}

function printSummary(r) {
  const lines = [];
  lines.push(`=== KBot 步態量測 [${r.tag}] port ${r.port} ===`);
  lines.push(`崗位 y = ${r.postY}  勤務速度 = ${r.dutySpeed} m/s`);
  lines.push("");
  lines.push("A 四方向直線走(站立腳滑移,mm/s)");
  lines.push("  方向      朝向誤差°   側向滑移 med/p90   沿軌滑移 med   踩得住比例");
  for (const [id, v] of Object.entries(r.legs ?? {})) {
    if (v.error) { lines.push(`  ${id.padEnd(9)} ${v.error}`); continue; }
    lines.push(`  ${id.padEnd(9)} ${String(v.facingErrDeg.median).padStart(8)}`
      + `   ${String(v.stanceLateralSlipMmPerS.median).padStart(6)}`
      + ` / ${String(v.stanceLateralSlipMmPerS.p90).padStart(6)}`
      + `      ${String(v.stanceAlongSlipMmPerS.median).padStart(6)}`
      + `        ${v.plantedFrac}`);
  }
  lines.push("");
  const t = r.turn ?? {};
  lines.push("B/C/D 起停 · 轉身 · 擺臂");
  lines.push(`  yaw 目標單幀最大跳動 : ${t.maxYawTargetStepDeg}°`);
  lines.push(`  holder yaw 單幀最大   : ${t.maxYawStepDeg}°`);
  lines.push(`  轉向耗時 / 期間位移    : ${t.turnSeconds}s / ${t.turnBodyTravelM} m`);
  lines.push(`  起步 0.4s 身體位移     : ${t.startBodyTravel04sM} m`);
  lines.push(`  起步 0.4s 站立腳位移   : ${t.startStanceFootTravel04sM} m`);
  lines.push(`  起停當幀 |Δholder.y|   : ${t.maxHolderDyMm} mm`);
  lines.push(`  手掌前後擺幅 L/R       : ${t.handSwingForeAftMm?.left} / ${t.handSwingForeAftMm?.right} mm`);
  lines.push(`  兩手相關係數(要為負) : ${t.handSwingCorrelation}`);
  lines.push(`  走路時腳底離基準 min/p10/med/max: ${t.walkSoleAboveBaseMm?.min} / ${t.walkSoleAboveBaseMm?.p10} / ${t.walkSoleAboveBaseMm?.median} / ${t.walkSoleAboveBaseMm?.max} mm`);
  lines.push("");
  lines.push("E 站立與地面");
  lines.push(`  地面 y(stand 崗位下) : ${r.ground?.stand?.y}  (${r.ground?.stand?.node})`);
  lines.push(`  地面 y(crosswalk)     : ${r.ground?.crosswalk?.y}  (${r.ground?.crosswalk?.node})`);
  lines.push(`  地面 y(lane90)        : ${r.ground?.lane90?.y}  (${r.ground?.lane90?.node})`);
  lines.push(`  腳底離崗位 y           : ${r.stand?.clearanceAbovePostMm} mm`);
  lines.push(`  腳底離地面             : ${r.stand?.clearanceAboveGroundMm} mm（含膠囊 ${r.stand?.clearanceAllAboveGroundMm} mm）`);
  lines.push(`  腳底相對 holder 原點   : ${r.stand?.soleOffsetFromHolderMm} mm（holder y=${r.stand?.holderY}, walkKind=${JSON.stringify(r.stand?.walkKinds)}）`);
  lines.push(`  實測正面方位角         : ${r.stand?.facingDeg}°  (holder yaw ${r.stand?.holderYawDeg}°, 建模朝向 ${r.stand?.modelYawDeg}°, 兩腳連線解 ${r.stand?.footSepDeg}°)`);
  lines.push(`  逐相位腳底偏移(mm)   : ${Object.entries(r.soleByPhase ?? {})
    .map(([k, v]) => `${k}=${v?.soleOffsetMm}`).join("  ")}`);
  lines.push(`  console error          : ${r.consoleErrors?.length ?? 0}`);
  console.log(lines.join("\n"));
}
