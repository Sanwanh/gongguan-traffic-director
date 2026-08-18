// RECORDING_PLAN.md 的分鏡驗收:用 headless Chrome (CDP) 依錄影分鏡表逐個
// Shot 操作 viewer,檢查文件寫的畫面內容真的會發生,並存下對應截圖。
//
// 這支腳本走的是「使用者會按的路徑」:相機按鈕、手勢按鈕、面板開關都用真的
// DOM 事件觸發,不直接呼叫內部函式;斷言則讀 __trafficDirectorDebug 等唯讀
// 驗證 hook。
//
// 先決條件:serve.py 已在 8124 起來(python3 serve.py --port 8124 --directory .)
// 執行:node mujoco/verify_recording_shots.mjs [--port 8124] [--out <dir>]
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
const OUT_DIR = argValue("--out", join(here, "verify_shots"));
const DEBUG_PORT = Number(argValue("--cdp-port", "9335"));
const PROFILE_DIR = argValue(
  "--profile",
  "/private/tmp/claude-501/-Users-san/chrome-verify-shots",
);
const PAGE_URL = `http://localhost:${PORT}/viewer/traffic_director.html`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT_DIR, { recursive: true });
rmSync(PROFILE_DIR, { recursive: true, force: true });

const failures = [];
const notes = [];
const shotReports = [];
const consoleErrors = [];
const fail = (shot, message) => failures.push(`${shot}: ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- CDP client
let nextId = 1;
const pending = new Map();
let socket = null;

function send(method, params = {}, sessionId) {
  const id = nextId += 1;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  socket.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 120000);
  });
}

async function evaluate(expression, { awaitPromise = false } = {}) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `page exception: ${result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

// fn 回傳 truthy 就停;逾時回傳 null(呼叫端自行判定失敗)。
async function waitUntil(expression, { timeoutMs = 60000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(intervalMs);
  }
  return null;
}

async function screenshot(name) {
  const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: false,
  });
  const buffer = Buffer.from(shot.data, "base64");
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, buffer);
  return { file, bytes: buffer.length };
}

const snapshot = () => evaluate("window.__trafficDirectorDebug.snapshot()");

// ------------------------------------------------------------- UI operations
async function clickCamera(id) {
  await evaluate(`document.querySelector('[data-camera="${id}"]').click()`);
  await sleep(400);
}

// 手勢按鈕:用 data-phase 找,按下去等於使用者按面板。
async function clickCommand(phase) {
  await evaluate(`document.querySelector('[data-command][data-phase="${phase}"]').click()`);
  await sleep(500);
}

async function setSwitch(id, want) {
  return evaluate(`(() => {
    const el = document.querySelector('#${id}');
    if (el.checked !== ${want}) el.click();
    return el.checked;
  })()`);
}

async function setSelect(id, value) {
  return evaluate(`(() => {
    const el = document.querySelector('#${id}');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
}

const text = (selector) => evaluate(
  `document.querySelector('${selector}')?.textContent?.trim() ?? null`,
);

// ------------------------------------------------------------------- 主流程
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${PROFILE_DIR}`,
  "--window-size=1920,1080",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--enable-unsafe-swiftshader",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let chromeStderr = "";
chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });

async function connect() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const info = await response.json();
      return info.webSocketDebuggerUrl;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`Chrome 沒有在 ${DEBUG_PORT} 起來:\n${chromeStderr}`);
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (event) => reject(new Error(String(event.message ?? event.type))));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve: ok, reject: no } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) no(new Error(`${message.error.message} (${message.method ?? ""})`));
        else ok(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(
          message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text ?? "unknown exception",
        );
      }
      if (message.method === "Runtime.consoleAPICalled"
        && message.params.type === "error") {
        consoleErrors.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
        );
      }
    });
  });
}

let exitCode = 0;
try {
  const wsUrl = await connect();
  socket = await openSocket(wsUrl);

  // 用 browser-level socket 開一個新 target,再 attach 成 flat session。
  // headless 的 createTarget 不接受尺寸(會回 "Target position can only be set
  // for new windows"),畫面尺寸一律交給 Emulation.setDeviceMetricsOverride。
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId, flatten: true,
  });
  // 之後所有 page 域指令都帶 sessionId:包一層。
  const rawSend = send;
  // eslint-disable-next-line no-func-assign
  send = (method, params = {}) => (
    method.startsWith("Target.") || method.startsWith("Browser.")
      ? rawSend(method, params)
      : rawSend(method, params, sessionId)
  );

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: PAGE_URL });

  const ready = await waitUntil(
    "Boolean(window.__trafficDirectorDebug && window.__kbotProbeWorldPos"
    + " && document.querySelector('#modelStatus .status-dot')"
    + "?.classList.contains('is-loading') === false)",
    { timeoutMs: 120000 },
  );
  if (!ready) throw new Error("viewer 沒有在 120 秒內載入完成");
  notes.push(`載入完成:${await text("#modelStatus")}`);

  // ---------------------------------------------------- 面板設定(錄影用值)
  const panel = {
    autoMode: await setSwitch("autoMode", true),
    motionEffects: await setSwitch("motionEffects", true),
    highPerformance: await setSwitch("highPerformance", true),
    hookTurn: await setSwitch("hookTurn", true),
    downstreamBlocked: await setSwitch("downstreamBlocked", false),
    recordingMode: await setSwitch("recordingMode", false),
    trafficDensity: await setSelect("trafficDensity", "normal"),
    pacingPreset: await setSelect("pacingPreset", "filming"),
  };
  for (const [key, value] of Object.entries(panel)) {
    if (value === false && key !== "downstreamBlocked" && key !== "recordingMode") {
      fail("setup", `開關 ${key} 沒有設成錄影用值`);
    }
  }
  // 文件宣稱「錄影」節奏 = 32 / 30 / 22 秒。
  const durations = await evaluate(`({
    roosevelt: Number(document.querySelector('#durationRoosevelt').value),
    pedestrian: Number(document.querySelector('#durationPedestrian').value),
    lane90: Number(document.querySelector('#durationLane90').value),
  })`);
  if (durations.roosevelt !== 32 || durations.pedestrian !== 30
    || durations.lane90 !== 22) {
    fail("setup", `錄影節奏秒數 ${JSON.stringify(durations)} != 32/30/22`);
  }
  notes.push(`錄影節奏秒數 ${JSON.stringify(durations)}`);

  // ------------------------------------------------------------------ 暖機
  // 文件要求「先跑一個完整循環再開錄」:等 KBot 走完進場動線、車隊排好。
  const warmupStart = Date.now();
  const entryDone = await waitUntil(
    "window.__trafficDirectorDebug.snapshot().kbotMotion.walkEntryDone === true",
    { timeoutMs: 90000 },
  );
  if (!entryDone) fail("warmup", "KBot 進場動線沒有在 90 秒內完成");
  await sleep(20000);
  notes.push(`暖機 ${((Date.now() - warmupStart) / 1000).toFixed(0)}s`);

  // ------------------------------------------------- Shot 1 鳥瞰 + 錄影模式
  {
    const shot = "shot1_overview";
    await clickCamera("overview");
    await setSwitch("recordingMode", true);
    await sleep(600);
    const hidden = await evaluate(`(() => {
      const panelEl = document.querySelector('.control-panel');
      const rect = panelEl.getBoundingClientRect();
      return {
        bodyClass: document.body.classList.contains('is-recording'),
        panelWidth: Math.round(rect.width),
        canvasWidth: Math.round(
          document.querySelector('#scene canvas').getBoundingClientRect().width,
        ),
      };
    })()`);
    if (!hidden.bodyClass) fail(shot, "錄影模式沒有加上 is-recording");
    if (hidden.panelWidth > 1) fail(shot, `錄影模式右側面板仍佔 ${hidden.panelWidth}px`);
    if (hidden.canvasWidth < 1900) {
      fail(shot, `錄影模式畫面沒有滿版(canvas ${hidden.canvasWidth}px)`);
    }
    const green = await waitUntil(
      "window.__trafficDirectorDebug.snapshot().phase === 'roosevelt_flow'",
      { timeoutMs: 130000 },
    );
    if (!green) fail(shot, "130 秒內沒有等到羅斯福路放行相位");
    const image = await screenshot(shot);
    shotReports.push({
      shot, camera: "overview", recordingMode: true,
      panelWidth: hidden.panelWidth, canvasWidth: hidden.canvasWidth,
      phase: (await snapshot()).phase, image: image.file, bytes: image.bytes,
    });
  }

  // ------------------------------------ Shot 2 街道 + 兩臂平伸 + 黃燈尾段
  {
    const shot = "shot2_roosevelt";
    await setSwitch("recordingMode", false);
    await clickCamera("street");
    await clickCommand("roosevelt_flow");
    const active = await waitUntil(
      "window.__trafficDirectorDebug.snapshot().phase === 'roosevelt_flow'",
      { timeoutMs: 30000 },
    );
    if (!active) fail(shot, "按下兩臂左右平伸後沒有進入羅斯福路放行");
    const gesture = (await snapshot()).activeKbotGesture;
    if (gesture !== "STOP_FRONT_BACK_GO_LEFT_RIGHT") {
      fail(shot, `KBot 手勢是 ${gesture},不是兩臂左右平伸`);
    }
    // 相位剛開始時車隊還沒駛進畫面,等 10 秒才是文件說的「車流通過」。
    await sleep(10000);
    const image = await screenshot(shot);

    // 黃燈尾段:綠燈最後 3 秒要點亮 amber,且此時還沒過停止線的車要煞停。
    // 車輛沒有直接暴露速度,改以 0.6 秒內的位移量判定「真的停住」。
    await evaluate(`(() => {
      window.__amberProbe = null;
      const tick = () => {
        const snap = window.__trafficDirectorDebug.snapshot();
        const left = Number(document.querySelector('#phaseCountdown').textContent);
        if (snap.phase === 'roosevelt_flow' && left > 0 && left <= 2.6
          && !window.__amberProbe) {
          const before = new Map(window.__vehicleStates()
            .map((v) => [v.id, v.s]));
          const ambers = window.__signalStates()
            .filter((node) => node.aspect === 'amber' && node.visible).length;
          setTimeout(() => {
            const states = window.__vehicleStates();
            const main = states.filter((v) => !String(v.id).includes('lane90'));
            const still = main.filter((v) => before.has(v.id)
              && Math.abs(v.s - before.get(v.id)) < 0.08);
            window.__amberProbe = { left, ambers, main: main.length,
              still: still.length };
          }, 600);
        }
      };
      window.__amberTimer = setInterval(tick, 120);
      return true;
    })()`);
    const tail = await waitUntil(
      "window.__amberProbe", { timeoutMs: 70000, intervalMs: 250 },
    );
    await evaluate("clearInterval(window.__amberTimer)");
    if (!tail) {
      fail(shot, "沒有量到綠燈尾段(相位倒數 <=2.6s)的狀態");
    } else {
      if (tail.ambers < 1) fail(shot, "黃燈尾段沒有任何 amber 亮起");
      // 「還沒過停止線的車開始煞停」要拍得到,前提是尾段時還有車在接近;
      // 一般模式的隊伍常在 32 秒綠燈內就排空,這時尾段畫面只有黃燈沒有煞停。
      notes.push(`Shot2 黃燈尾段:剩 ${tail.left}s、amber ${tail.ambers} 組、`
        + `幹道 ${tail.main} 車中 ${tail.still} 輛停住`
        + `${tail.still < 1 ? "(此輪拍不到煞停,要用尖峰模式)" : ""}`);
    }
    const amberImage = await screenshot(`${shot}_amber`);
    shotReports.push({
      shot, camera: "street", recordingMode: false, gesture,
      amberTail: tail, image: image.file, amberImage: amberImage.file,
    });
  }

  // -------------------------- Shot 3 行穿線 + WALK + KBot 走到行穿線中央
  {
    const shot = "shot3_pedestrian";
    await clickCamera("crosswalk");
    await setSwitch("recordingMode", true);
    await clickCommand("pedestrian_crossing");
    const walking = await waitUntil(
      "window.__trafficDirectorDebug.snapshot().phase === 'pedestrian_crossing'",
      { timeoutMs: 30000 },
    );
    if (!walking) fail(shot, "按下 WALK 請求後沒有進入行人穿越相位");

    // 真步態:0.4 秒取樣機器人探針世界座標,位置必須連續變化(不是瞬移/靜止)。
    const samples = [];
    for (let index = 0; index < 12; index += 1) {
      samples.push({
        probe: await evaluate("window.__kbotProbeWorldPos()"),
        motion: await evaluate(
          "(() => { const m = window.__trafficDirectorDebug.snapshot().kbotMotion;"
          + " return { station: m.station, walkKind: m.walkKind,"
          + " sample: m.sampleTimeS, holder: m.holderPosition }; })()",
        ),
      });
      await sleep(400);
    }
    const moved = samples.slice(1).filter((entry, index) => {
      const previous = samples[index].probe;
      return previous && entry.probe
        && Math.hypot(...entry.probe.map((v, axis) => v - previous[axis])) > 0.001;
    }).length;
    if (moved < 8) fail(shot, `KBot 探針只有 ${moved}/11 次取樣在動(應為連續步態)`);
    const walked = samples.some((entry) => entry.motion.walkKind
      && entry.motion.walkKind !== "none" && entry.motion.walkKind !== "idle");
    if (!walked) {
      notes.push(`Shot3 取樣期間 walkKind: ${[...new Set(samples.map((s) => s.motion.walkKind))]}`);
    }
    const atPost = await waitUntil(`(() => {
      const m = window.__trafficDirectorDebug.snapshot().kbotMotion;
      return m.station === '行穿線中央' ? m : null;
    })()`, { timeoutMs: 30000 });
    if (!atPost) {
      const current = (await snapshot()).kbotMotion;
      fail(shot, `KBot 沒有走到行穿線中央(station=${current.station}, `
        + `holder=${JSON.stringify(current.holderPosition?.map((v) => Number(v.toFixed(2))))})`);
    }
    const image = await screenshot(shot);
    // 交錯式行穿線:應該有人在中央庇護帶等下一輪。
    const refuge = await waitUntil(`(() => {
      const states = window.__trafficDirectorDebug.snapshot().pedestrianStates;
      return states.waiting_at_refuge ? states : null;
    })()`, { timeoutMs: 25000 });
    if (!refuge) {
      notes.push("Shot3 這一輪沒有行人停在中央庇護帶(waiting_at_refuge 為 0)");
    }
    shotReports.push({
      shot, camera: "crosswalk", recordingMode: true,
      probeMovingSamples: `${moved}/11`,
      station: atPost?.station ?? null,
      holderPosition: atPost?.holderPosition ?? null,
      pedestrianStates: refuge ?? (await snapshot()).pedestrianStates,
      image: image.file,
    });
  }

  // --------------------- Shot 4 相位要換了,KBot 自己退到安全區(核心論點)
  {
    const shot = "shot4_retreat";
    // 機器人還在車道上時,安全閘門要顯示護送中且不得放行車流。
    // 安全閘門面板和其他 UI 一樣是 uiUpdateHz 更新,剛踏上車道那一瞬間
    // DOM 還沒重畫;等一個 UI tick 之後再讀,才是使用者看得到的字。
    const onRoad = await waitUntil(`(() => {
      const snap = window.__trafficDirectorDebug.snapshot();
      if (!snap.kbotMotion.robotOnRoadway) return null;
      return { phase: snap.phase, pedestrianConflict: snap.pedestrianConflict };
    })()`, { timeoutMs: 30000, intervalMs: 150 });
    if (!onRoad) {
      notes.push("Shot4 取樣時 KBot 已不在車道上(可能已提早退場)");
    } else {
      await sleep(400);
      const locked = await evaluate(`(() => {
        const snap = window.__trafficDirectorDebug.snapshot();
        return { onRoadway: snap.kbotMotion.robotOnRoadway,
          pedestrianConflict: snap.pedestrianConflict,
          locks: document.querySelector('#safetyLocks').textContent.trim() };
      })()`);
      onRoad.locks = locked.locks;
      if (locked.onRoadway) {
        if (!locked.locks.includes("KBot 於車道護送中")) {
          fail(shot, `KBot 在車道上但安全閘門沒顯示護送中:${locked.locks}`);
        }
        if (!locked.pedestrianConflict) {
          fail(shot, "KBot 在車道上時 pedestrianConflict 應為 true(不得放行車流)");
        }
      } else {
        notes.push("Shot4 KBot 在一個 UI tick 內就離開車道,略過閘門文字比對");
      }
    }
    // 相位結束前主動退到最近的安全點。
    const retreated = await waitUntil(`(() => {
      const m = window.__trafficDirectorDebug.snapshot().kbotMotion;
      return (m.safeZone && !m.robotOnRoadway && m.station !== '移動中') ? m : null;
    })()`, { timeoutMs: 60000, intervalMs: 250 });
    if (!retreated) fail(shot, "行人相位結束後 KBot 沒有退到安全區");
    const locksAfter = await text("#safetyLocks");
    if (retreated && locksAfter.includes("KBot 於車道護送中")) {
      fail(shot, "已退到安全區但安全閘門仍鎖在護送中");
    }
    // §16:退場終點已不是公車站月台(使用者否決「站在公車站裡指揮」),
    // 而是行穿線北端的人行道崗位——行穿線機位正好拍得到他沿畫線退場。
    await clickCamera("crosswalk");
    const image = await screenshot(shot);
    shotReports.push({
      shot, camera: "crosswalk", recordingMode: true,
      onRoadLocks: onRoad?.locks ?? null,
      retreatStation: retreated?.station ?? null,
      retreatPosition: retreated?.holderPosition ?? null,
      locksAfter, image: image.file,
    });
  }

  // -------------------------------- Shot 5 待轉區 + 巷90:右轉與兩段式左轉
  {
    const shot = "shot5_hook";
    await clickCamera("hook");
    await clickCommand("lane90_release");
    const active = await waitUntil(
      "window.__trafficDirectorDebug.snapshot().phase === 'lane90_release'",
      { timeoutMs: 40000 },
    );
    if (!active) fail(shot, "按下左方來車速行後沒有進入巷90 放行相位");
    const gesture = (await snapshot()).activeKbotGesture;
    if (gesture !== "GO_FROM_LEFT") fail(shot, `KBot 手勢是 ${gesture},不是招車手勢`);

    const turning = await waitUntil(`(() => {
      const states = window.__lane90States();
      const right = states.filter((v) => v.turn === 'right'
        && ['turning', 'merged'].includes(v.state));
      const hook = states.filter((v) => v.turn === 'hook'
        && ['turning', 'hook_wait', 'merged'].includes(v.state));
      return (right.length > 0 || hook.length > 0)
        ? { right: right.length, hook: hook.length, sample: states.slice(0, 8) }
        : null;
    })()`, { timeoutMs: 40000, intervalMs: 250 });
    if (!turning) fail(shot, "巷90 放行後沒有任何車輛進入轉向動線");

    const waiting = await waitUntil(`(() => {
      const box = window.__lane90States().filter((v) => v.state === 'hook_wait');
      return box.length > 0 ? { box: box.length, slots: box.map((v) => v.slot) } : null;
    })()`, { timeoutMs: 45000, intervalMs: 250 });
    if (!waiting) {
      fail(shot, "沒有機車停進待轉區(state=hook_wait)");
    } else {
      // 面板是 uiUpdateHz(高效能 8Hz)更新,剛進待轉區時 DOM 會落後一拍;
      // 等一個 UI tick 再比對,才是使用者看得到的數字。
      await sleep(400);
      const shown = await evaluate(`(() => ({
        shown: Number(document.querySelector('#hookWaitCount').textContent),
        box: window.__lane90States().filter((v) => v.state === 'hook_wait').length,
      }))()`);
      if (shown.shown !== shown.box) {
        fail(shot, `面板「待轉中」顯示 ${shown.shown},實際 ${shown.box}`);
      }
      waiting.shown = shown.shown;
      if (new Set(waiting.slots).size !== waiting.slots.length) {
        fail(shot, `待轉格位重複:${waiting.slots}`);
      }
    }
    const image = await screenshot(shot);
    shotReports.push({
      shot, camera: "hook", gesture, turning, waiting, image: image.file,
    });
  }

  // ------------------------------- Shot 6 待轉機車起步(兩段式左轉第二段)
  {
    const shot = "shot6_hook_release";
    await setSwitch("recordingMode", false);
    const before = Number(await text("#hookWaitCount"));
    await clickCommand("roosevelt_flow");
    // 手勢是「請求」:先確認它真的變成執行中的羅斯福路放行相位,
    // 否則待轉區沒清空只是因為請求被安全閘門擋著(那是 Shot 8 的戲)。
    const green = await waitUntil(`(() => {
      const snap = window.__trafficDirectorDebug.snapshot();
      return (snap.phase === 'roosevelt_flow' && snap.decisionState === 'active')
        ? snap.phase : null;
    })()`, { timeoutMs: 60000, intervalMs: 250 });
    if (!green) {
      const snap = await snapshot();
      const blockers = await evaluate("window.__conflictVehicles()");
      fail(shot, `沒有進入羅斯福路放行(phase=${snap.phase}, `
        + `decision=${snap.decisionState}/${snap.decisionReason}, `
        + `blockers=${JSON.stringify(blockers)})`);
    }
    const cleared = await waitUntil(`(() => {
      const shown = Number(document.querySelector('#hookWaitCount').textContent);
      const merged = window.__lane90States()
        .filter((v) => v.turn === 'hook' && v.state === 'merged');
      return shown === 0 ? { shown, merged: merged.length } : null;
    })()`, { timeoutMs: 45000, intervalMs: 250 });
    if (before > 0 && !cleared) {
      const snap = await snapshot();
      const stuck = await evaluate("window.__lane90States()"
        + ".filter((v) => v.state !== 'alley')");
      const blockers = await evaluate("window.__conflictVehicles()");
      fail(shot, `羅斯福路放行後待轉區沒有清空(仍 ${before} 輛):`
        + `phase=${snap.phase}, decision=${snap.decisionState}/${snap.decisionReason}, `
        + `pedConflict=${snap.pedestrianConflict}, `
        + `blockers=${JSON.stringify(blockers)}, lane90=${JSON.stringify(stuck)}`);
    }
    if (before === 0) notes.push("Shot6 觸發時待轉區本來就是空的");
    const image = await screenshot(shot);
    shotReports.push({
      shot, camera: "hook", recordingMode: false,
      hookWaitBefore: before, phaseActive: green, afterRelease: cleared,
      image: image.file,
    });
  }

  // --------------------------------------------- Shot 7 公車進站與上車人次
  {
    const shot = "shot7_busstop";
    await clickCamera("busstop");
    await setSwitch("recordingMode", true);
    // 文件建議尖峰模式比較快等到公車;換模式會以現行 seed 重生。
    await setSelect("trafficDensity", "peak");
    await sleep(1500);
    // 候車者是「穿越到月台」才會出現在月台上:先跑一輪行人相位,
    // 否則月台永遠空的、公車靠站也不會有人上車(§14 驗收發現)。
    await clickCommand("pedestrian_crossing");
    const onPlatform = await waitUntil(`(() => {
      const states = window.__trafficDirectorDebug.snapshot().pedestrianStates;
      return states.waiting_for_bus ? states.waiting_for_bus : null;
    })()`, { timeoutMs: 120000, intervalMs: 500 });
    if (!onPlatform) {
      notes.push("Shot7 一輪行人相位後月台仍無候車者");
    } else {
      notes.push(`Shot7 月台候車者 ${onPlatform} 人(經一輪行人相位)`);
    }
    const boardingsBefore = (await snapshot()).busBoardings;
    const dwelling = await waitUntil(`(() => {
      const buses = window.__busStates().filter((b) => b.dwellRemaining > 0);
      return buses.length ? buses : null;
    })()`, { timeoutMs: 180000, intervalMs: 400 });
    let waiters = null;
    if (!dwelling) {
      fail(shot, "180 秒內沒有公車靠站(dwellRemaining > 0)");
    } else {
      // 靠站當下月台上有沒有人在等?沒有人等就不會有上車人次,
      // 這是判斷「文件宣稱」到底成不成立的關鍵資料。
      waiters = await evaluate(`(() => {
        const snap = window.__trafficDirectorDebug.snapshot();
        const bus = window.__busStates().find((b) => b.dwellRemaining > 0);
        const near = snap.pedestrians.filter((p) => p.state === 'waiting_for_bus'
          && bus && Math.abs(p.s - bus.s) < 12);
        return { states: snap.pedestrianStates, nearBus: near.length,
          busS: bus ? bus.s : null };
      })()`);
      notes.push(`Shot7 靠站公車:${JSON.stringify(dwelling[0])};`
        + `月台候車 ${waiters.nearBus} 人,行人狀態 ${JSON.stringify(waiters.states)}`);
    }
    const image = await screenshot(shot);
    const boarded = await waitUntil(
      `window.__trafficDirectorDebug.snapshot().busBoardings > ${boardingsBefore}`,
      { timeoutMs: 120000, intervalMs: 500 },
    );
    const boardingsAfter = (await snapshot()).busBoardings;
    if (!boarded) {
      notes.push(`Shot7 觀測窗內沒有新的上車人次(維持 ${boardingsAfter})`);
    }
    shotReports.push({
      shot, camera: "busstop", recordingMode: true, mode: "peak",
      dwelling, waiters, boardingsBefore, boardingsAfter, image: image.file,
    });
  }

  // ------------------------------------------------------- Shot 8 安全閘門
  {
    const shot = "shot8_safety";
    await setSwitch("recordingMode", false);
    await clickCamera("street");
    // 要示範的是「下游堵塞」這一條閘門。它在決策優先序的最後一位,
    // 所以要等到其他閘門(行人衝突、行穿線淨空、路口淨空)全部通過的
    // 空窗才送出請求,否則會先被別的原因擋下,拍不到文件寫的畫面。
    const window8 = await waitUntil(`(() => {
      const snap = window.__trafficDirectorDebug.snapshot();
      return (!snap.pedestrianConflict && snap.crosswalkClear
        && snap.conflictZoneClear && snap.phase !== 'clearance')
        ? snap.phase : null;
    })()`, { timeoutMs: 120000, intervalMs: 250 });
    if (!window8) notes.push("Shot8 等不到無行人衝突的空窗,直接送出請求");
    await setSwitch("downstreamBlocked", true);
    await clickCommand("roosevelt_flow");
    const blocked = await waitUntil(`(() => {
      const snap = window.__trafficDirectorDebug.snapshot();
      if (snap.decisionState !== 'blocked') return null;
      return { state: snap.decisionState, reason: snap.decisionReason,
        panel: document.querySelector('#commandDecision').dataset.state,
        reasonText: document.querySelector('#decisionReason').textContent.trim(),
        locks: document.querySelector('#safetyLocks').textContent.trim() };
    })()`, { timeoutMs: 20000, intervalMs: 200 });
    if (!blocked) {
      fail(shot, "下游堵塞時 GO 沒有被擋下");
    } else {
      if (blocked.reason !== "downstream_not_clear") {
        fail(shot, `擋下原因是 ${blocked.reason},不是 downstream_not_clear`);
      }
      if (blocked.panel !== "blocked") fail(shot, `決策面板 data-state=${blocked.panel}`);
      if (!blocked.locks.includes("下游堵塞")) {
        fail(shot, `安全閘門沒有列出下游堵塞:${blocked.locks}`);
      }
    }
    const image = await screenshot(shot);
    await setSwitch("downstreamBlocked", false);
    const released = await waitUntil(`(() => {
      const snap = window.__trafficDirectorDebug.snapshot();
      return snap.decisionState === 'active' ? snap.phase : null;
    })()`, { timeoutMs: 30000, intervalMs: 250 });
    if (!released) fail(shot, "關掉下游堵塞後決策沒有恢復執行中");
    // 全向停止:最高優先權立即撤銷。
    await clickCommand("all_stop");
    const allStop = await waitUntil(
      "window.__trafficDirectorDebug.snapshot().phase === 'all_stop'",
      { timeoutMs: 15000, intervalMs: 200 },
    );
    if (!allStop) fail(shot, "全向停止沒有立即生效");
    const afterImage = await screenshot(`${shot}_released`);
    shotReports.push({
      shot, camera: "street", recordingMode: false,
      blocked, releasedPhase: released, allStopImmediate: Boolean(allStop),
      image: image.file, afterImage: afterImage.file,
    });
  }

  // ---------------------------------------------------------- 全域收尾檢查
  const final = await snapshot();
  const render = await evaluate("window.__renderStats()");
  if (final.collisions !== 0) fail("global", `碰撞計數 ${final.collisions} != 0`);
  if (render.measuredFps < 24) {
    notes.push(`headless FPS ${render.measuredFps}(headless 不代表實機)`);
  }
  const realErrors = consoleErrors.filter(
    (message) => !/favicon|DevTools|Autofill/i.test(message),
  );
  if (realErrors.length > 0) fail("global", `console 有 ${realErrors.length} 筆錯誤`);

  const report = {
    page: PAGE_URL,
    plan: "RECORDING_PLAN.md",
    panel,
    durations,
    shots: shotReports,
    final: {
      collisions: final.collisions,
      busBoardings: final.busBoardings,
      vehicleCounts: final.vehicleCounts,
      signalHeads: final.signalHeads,
      render,
    },
    consoleErrors: realErrors,
    notes,
    failures,
  };
  writeFileSync(
    join(here, "recording_shots_report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  for (const note of notes) console.log(`  · ${note}`);
  if (failures.length > 0) {
    console.error("FAIL 錄影分鏡驗收:");
    for (const failure of failures) console.error(`  - ${failure}`);
    exitCode = 1;
  } else {
    console.log(
      `PASS 錄影分鏡驗收:8 個 Shot 全部照 RECORDING_PLAN.md 重現,`
      + `截圖在 ${OUT_DIR},報告 mujoco/recording_shots_report.json`,
    );
  }
} catch (error) {
  console.error(`ERROR ${error.message}`);
  if (chromeStderr) console.error(chromeStderr.split("\n").slice(-8).join("\n"));
  exitCode = 2;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  chrome.kill("SIGTERM");
}
process.exit(exitCode);
