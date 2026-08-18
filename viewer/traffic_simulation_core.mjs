export const REQUIRED_VEHICLE_TYPES = Object.freeze([
  "car",
  "scooter",
  "motorcycle",
  "bus",
  "bicycle",
]);

export let WEB_TRAFFIC_BUDGET = Object.freeze({
  mainVehicleMin: 16,
  mainVehicleMax: 20,
  sideVehicleCount: 2,
  totalVehicleMax: 22,
  pedestrianMin: 6,
  pedestrianMax: 10,
});

// 車速範圍(公尺/秒)。原本是 spawn 處的字面值 5.5+rand*2.4 / 3.8+rand*0.8,
// 為了讓「所有參數都能調」抽成具名可調常數(§19)。
export let MAIN_SPEED_RANGE = Object.freeze({ min: 5.5, max: 7.9 });
export let SIDE_SPEED_RANGE = Object.freeze({ min: 3.8, max: 4.6 });
// 行人步速倍率:乘在 rules JSON 的 pedestrian_walk_speed_mps 上。
export let PEDESTRIAN_SPEED_SCALE = 1;

export const OFFICIAL_GESTURE_TO_PHASE = Object.freeze({
  ALL_STOP: "all_stop",
  STOP_FRONT_BACK_GO_LEFT_RIGHT: "roosevelt_flow",
  GO_FROM_LEFT: "lane90_release",
});

export const PEDESTRIAN_WALK_COMMAND = Object.freeze({
  phaseId: "pedestrian_crossing",
  kbotGesture: "ALL_STOP",
  officialGestureRequest: false,
});

const PHASE_TO_ACTIVE_GESTURE = Object.freeze({
  all_stop: "ALL_STOP",
  clearance: "ALL_STOP",
  pedestrian_crossing: "ALL_STOP",
  roosevelt_flow: "STOP_FRONT_BACK_GO_LEFT_RIGHT",
  lane90_release: "GO_FROM_LEFT",
});


export function resolveTrafficCommand({
  requestedPhaseId,
  requestedGesture,
  requestKind = "gesture",
  gestureElapsedS = 0,
  clearanceElapsedS = 0,
  gestureStabilityS = 0.4,
  clearanceMinimumS = 2.0,
  conflictZoneClear = false,
  crosswalkClear = false,
  pedestrianConflict = false,
  downstreamClear = false,
}) {
  const candidatePhaseId = String(requestedPhaseId ?? "");
  const expectedGesture = PHASE_TO_ACTIVE_GESTURE[candidatePhaseId];
  const isWalkSignalRequest = (
    requestKind === "walk_signal"
    && candidatePhaseId === PEDESTRIAN_WALK_COMMAND.phaseId
    && requestedGesture === PEDESTRIAN_WALK_COMMAND.kbotGesture
  );
  const isOfficialGestureRequest = (
    requestKind === "gesture"
    && OFFICIAL_GESTURE_TO_PHASE[requestedGesture] === candidatePhaseId
  );

  const base = {
    candidatePhaseId,
    requestedGesture,
    requestKind,
    officialGestureRequest: isOfficialGestureRequest,
  };

  if (!expectedGesture || (!isWalkSignalRequest && !isOfficialGestureRequest)) {
    return {
      ...base,
      state: "blocked",
      reasonCode: "invalid_command",
      safePhaseId: "all_stop",
      activeGesture: "ALL_STOP",
    };
  }

  if (candidatePhaseId === "all_stop") {
    return {
      ...base,
      state: "active",
      reasonCode: "immediate_all_stop",
      safePhaseId: "all_stop",
      activeGesture: "ALL_STOP",
    };
  }

  if (Number(clearanceElapsedS) + 1e-9 < Number(clearanceMinimumS)) {
    return {
      ...base,
      state: "pending",
      reasonCode: "minimum_clearance",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  if (!crosswalkClear) {
    return {
      ...base,
      state: "blocked",
      reasonCode: "crosswalk_not_clear",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  if (!conflictZoneClear) {
    return {
      ...base,
      state: "blocked",
      reasonCode: "intersection_not_clear",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  if (candidatePhaseId !== "pedestrian_crossing" && pedestrianConflict) {
    return {
      ...base,
      state: "blocked",
      reasonCode: "pedestrian_conflict",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  if (candidatePhaseId !== "pedestrian_crossing" && !downstreamClear) {
    return {
      ...base,
      state: "blocked",
      reasonCode: "downstream_not_clear",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  if (Number(gestureElapsedS) + 1e-9 < Number(gestureStabilityS)) {
    return {
      ...base,
      state: "pending",
      reasonCode: "gesture_stability",
      safePhaseId: "clearance",
      activeGesture: "ALL_STOP",
    };
  }

  return {
    ...base,
    state: "active",
    reasonCode: "command_active",
    safePhaseId: candidatePhaseId,
    activeGesture: expectedGesture,
  };
}

// Lane geometry is calibrated against the painted markings measured in
// gongguan_v54_environment.glb (SPEC_VIEWER_V2 §7, V3 calibration): lane
// centres come from the LaneArrow rows interpolated at s=0, in the corrected
// simulation frame (simulationRoot yaw = 0.75π + atan(-0.02957)). Taiwan
// convention: cars/taxis keep the inner lanes, scooters/bicycles ride
// outside.
export let MAIN_ROOSEVELT_LANES = Object.freeze([
  Object.freeze({
    t: -6.22,
    direction: 1,
    movement: "roosevelt_northwest",
    lanePosition: "inner",
    allowed: Object.freeze(["car", "taxi"]),
  }),
  Object.freeze({
    t: -9.02,
    direction: 1,
    movement: "roosevelt_northwest",
    lanePosition: "middle",
    allowed: Object.freeze(["car", "taxi", "motorcycle"]),
  }),
  Object.freeze({
    t: -11.82,
    direction: 1,
    movement: "roosevelt_northwest",
    lanePosition: "outer",
    allowed: Object.freeze(["car", "taxi", "scooter", "motorcycle", "bicycle"]),
  }),
  Object.freeze({
    t: 7.18,
    direction: -1,
    movement: "roosevelt_southeast",
    lanePosition: "inner",
    allowed: Object.freeze(["car", "taxi"]),
  }),
  Object.freeze({
    t: 9.98,
    direction: -1,
    movement: "roosevelt_southeast",
    lanePosition: "middle",
    allowed: Object.freeze(["car", "taxi", "motorcycle"]),
  }),
  Object.freeze({
    t: 12.78,
    direction: -1,
    movement: "roosevelt_southeast",
    lanePosition: "outer",
    allowed: Object.freeze(["car", "taxi", "scooter", "motorcycle", "bicycle"]),
  }),
]);

export let LANE_WIDTH_M = 2.8;

// Central bus-only lanes, measured from the painted BusLaneBoundary /
// CentralBuswayDivider lines: the busway is straight in the calibrated
// frame (fit residual < 0.05 m), NW between t=-1.71..0.82, SE between
// t=1.73..4.20.
export let BUS_LANES = Object.freeze([
  Object.freeze({
    t: -0.44,
    direction: 1,
    movement: "roosevelt_northwest",
    lanePosition: "bus",
    allowed: Object.freeze(["bus"]),
  }),
  Object.freeze({
    t: 2.97,
    direction: -1,
    movement: "roosevelt_southeast",
    lanePosition: "bus",
    allowed: Object.freeze(["bus"]),
  }),
]);

// The general carriageways bend gently with the real road while the central
// busway stays straight (the painted separation buffer absorbs the
// difference). Offsets are the measured lateral shift of the whole 3-lane
// carriageway relative to its s=0 cross-section, sampled from the LaneArrow
// rows (all three lanes parallel within 0.005 m). Piecewise linear in s,
// clamped beyond the sampled span. Bus lanes and side-access traffic use
// offset 0.
export const ROAD_CURVE_OFFSETS = Object.freeze({
  "1": Object.freeze([
    Object.freeze([-91.4, 0.057]),
    Object.freeze([-54.4, -0.85]),
    Object.freeze([-29.4, -0.364]),
    Object.freeze([30.6, 0.379]),
    Object.freeze([53.6, 0.902]),
    Object.freeze([92.6, 1.696]),
  ]),
  "-1": Object.freeze([
    Object.freeze([-92.7, 0.695]),
    Object.freeze([-55.7, 0.036]),
    Object.freeze([-30.6, -0.62]),
    Object.freeze([29.3, 0.593]),
    Object.freeze([52.3, 0.811]),
    Object.freeze([91.4, 1.18]),
  ]),
});

function curveSamples(direction) {
  return ROAD_CURVE_OFFSETS[String(Math.sign(direction) || 1)]
    ?? ROAD_CURVE_OFFSETS["1"];
}

export function roadCurveOffset(direction, s) {
  const samples = curveSamples(direction);
  const x = Number(s);
  if (x <= samples[0][0]) return samples[0][1];
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const [x0, o0] = samples[index];
    const [x1, o1] = samples[index + 1];
    if (x <= x1) return o0 + (o1 - o0) * (x - x0) / (x1 - x0);
  }
  return samples[samples.length - 1][1];
}

export function roadCurveSlope(direction, s) {
  const samples = curveSamples(direction);
  const x = Number(s);
  if (x <= samples[0][0] || x >= samples[samples.length - 1][0]) return 0;
  for (let index = 0; index + 1 < samples.length; index += 1) {
    const [x0, o0] = samples[index];
    const [x1, o1] = samples[index + 1];
    if (x <= x1) return (o1 - o0) / (x1 - x0);
  }
  return 0;
}

function generalLanesByPosition(direction) {
  const byPosition = {};
  for (const lane of MAIN_ROOSEVELT_LANES) {
    if (lane.direction === direction) byPosition[lane.lanePosition] = lane;
  }
  return byPosition;
}

// Pure, seed-driven lane assignment (SPEC_VIEWER_V2 §4b). Buses always use
// the bus lane for their direction; every other type only gets lanes whose
// `allowed` list contains it. `allowed` is the hard rule: the §4b scooter
// 20% middle preference is overridden by the §4a middle-lane allowed list
// (no scooter), so those picks resolve to the outer lane.
export function laneForVehicle(type, random, direction = null) {
  const dir = direction ?? (random() < 0.5 ? 1 : -1);
  if (type === "bus") {
    return BUS_LANES.find((lane) => lane.direction === dir);
  }
  const lanes = generalLanesByPosition(dir);
  let lane;
  if (type === "bicycle") {
    lane = lanes.outer;
  } else if (type === "scooter") {
    lane = random() < 0.8 ? lanes.outer : lanes.middle;
  } else if (type === "motorcycle") {
    lane = random() < 0.5 ? lanes.outer : lanes.middle;
  } else {
    lane = [lanes.inner, lanes.middle, lanes.outer][
      Math.floor(random() * 3) % 3
    ];
  }
  if (!lane || !lane.allowed.includes(type)) lane = lanes.outer;
  return lane;
}

// Lane 90 (Shuiyuan market side street) is on the POSITIVE-t side of
// Roosevelt: its drivable mouth is x in [-11,-3], curb at t≈16.3, the
// sidewalk crosswalk band at t 18.1..21.9. Side vehicles ride two columns
// down-t (t decreasing) toward the road, wait at SIDE_STOP_T, and merge
// (despawn) once past SIDE_END_T.
export const SIDE_ACCESS_SPAWNS = Object.freeze([
  Object.freeze({ s: -9.5, t: 33 }),
  Object.freeze({ s: -6.0, t: 36.5 }),
]);
export let SIDE_STOP_T = 17.2;
export let SIDE_END_T = 14.5;
// 巷90 縱列排隊間距(兩輪車車長 + 反應餘裕)。
export let SIDE_COLUMN_HEADWAY_M = 5.6;

// ---------------------------------------------------------------------------
// 巷90 出口的合法轉向(SPEC_VIEWER_V2 §13)
//
// 巷90 是單向「駛出」羅斯福路的巷口,出巷後只有兩種合法動線:
//   right — 右轉併入東南向最外側車道(t=12.78,dir=-1)。轉向後與停在
//           s=18.67 停止線的東南向車隊同向且在其下游,不會交織。
//   hook  — 機慢車「兩段式左轉」(道交條例 §99):先直行穿越路口,進入
//           西北向車道旁的機車待轉區停等,待羅斯福路綠燈再起步併入
//           西北向最外側車道(t=-11.82,dir=+1)。
//
// 兩條動線都刻意避開三條實畫行穿線帶:右轉全程 t≥12.78(不在
// stag_neg 的 t 範圍內);待轉直行走 s=-5.6 走廊(stag_neg 的 s 上界是
// -7.54),因此穿越路口時不會壓到任何行穿線。
export let LANE90_RIGHT_LANE_T = 12.78;
export let LANE90_HOOK_LANE_T = -11.82;
// 待轉直行走廊與待轉區的 s 位置受一個硬約束:車身(兩輪車 2.5 m)不得
// 侵入交錯式行穿線負半段(s 上界 -7.54,加 0.8 m 淨空 ⇒ 車尾 s 必須
// > -6.74)。走廊 -4.6、格位最遠 -4.9 ⇒ 車尾最低 -6.15,留 0.59 m。
export let LANE90_HOOK_CORRIDOR_S = -4.6;
export const LANE90_TURNS = Object.freeze(["right", "hook"]);

// 機車待轉區(執行期加畫的標線;實景 GLB 未含此標線)。box 為方框範圍,
// slots 為停等格位,前排(較大 s)先發車——起步方向為 +s。
export let HOOK_BOX = Object.freeze({
  s: -4.05,
  t: LANE90_HOOK_LANE_T,
  halfS: 1.95,
  halfT: 1.4,
  slots: Object.freeze([
    Object.freeze({ s: -3.2, t: -11.1 }),
    Object.freeze({ s: -3.2, t: -12.6 }),
    Object.freeze({ s: -4.9, t: -11.1 }),
    Object.freeze({ s: -4.9, t: -12.6 }),
  ]),
});

// 待轉格的填格順序:一律先填「離巷口最遠的那一排」(t = -12.6),
// 同排再由外而內。騎士是從 t 大的方向沿 s = LANE90_HOOK_CORRIDOR_S 進來,
// 若照 0,1,2,3 順序填,後來的人前往自己的格位時會從已停妥的車身上輾過去
// (實測最近距離 0.12 m);改成遠排優先後,行進路徑與任何已佔用格位的
// 最近距離是 1.50 m,永遠大於 HOOK_PARKED_CLEARANCE_M。
export let HOOK_BOX_FILL_ORDER = Object.freeze([1, 3, 0, 2]);

// 停在待轉格的車不是「前車」:格位彼此只有 1.5–1.7 m,若沿用跟車距離
// (半車長＋半車長＋1.6 m ≈ 4.1 m)當淨空門檻,想進待轉區的騎士會在
// 路口中央被永遠擋住 → turnState 一直是 "turning" → 清空相位等不到路口
// 淨空 → 羅斯福路永遠不會綠 → 待轉區永遠不會釋出。實測死結,見 §14。
// 這個門檻只用來擋「真的會車體重疊」。
export let HOOK_PARKED_CLEARANCE_M = 1.2;

export function hookBoxSlot(index) {
  const slots = HOOK_BOX.slots;
  return slots[Math.max(0, Math.trunc(index)) % slots.length];
}

// 兩輪車才做兩段式左轉;其餘一律右轉(汽車在此巷口亦僅右轉)。
export function lane90TurnFor(type, random) {
  const twoWheeler = ["scooter", "motorcycle", "bicycle"].includes(type);
  if (!twoWheeler) return "right";
  return random() < 0.45 ? "hook" : "right";
}

// 從巷口到併入點的 waypoint 折線(模擬座標 s,t)。最後一點即併入點,
// 之後車輛改以一般車道邏輯行駛。hook 的最後一點是待轉格位。
export function buildLane90TurnPath(turn, columnS, slotIndex = 0) {
  if (turn === "hook") {
    const slot = hookBoxSlot(slotIndex);
    return [
      { s: columnS, t: 15.9 },
      { s: (columnS + LANE90_HOOK_CORRIDOR_S) / 2, t: 14.0 },
      { s: LANE90_HOOK_CORRIDOR_S, t: 12.2 },
      { s: LANE90_HOOK_CORRIDOR_S, t: -8.8 },
      { s: slot.s, t: slot.t },
    ];
  }
  // 右轉:併入東南向最外側車道。併入點必須留在交錯式行穿線正半段
  // (s 下界 -14.80,含 0.8 m 淨空 ⇒ 車尾 s 必須 > -14.0)之外。
  return [
    { s: columnS, t: 15.9 },
    { s: columnS - 0.5, t: 14.4 },
    { s: columnS - 1.4, t: 13.3 },
    { s: columnS - 2.2, t: LANE90_RIGHT_LANE_T },
  ];
}

// 待轉區釋出後的短併入路徑:由格位滑到車道中心線再交還一般車道邏輯。
export function buildHookMergePath(slot) {
  return [{ s: Number(slot.s) + 4.6, t: LANE90_HOOK_LANE_T }];
}

// ---------------------------------------------------------------------------
// 中央公車道停靠(SPEC_VIEWER_V2 §13):公車在月台候車帶中段停靠,
// 車門側朝月台。停靠點取自實測月台範圍(BUS_PLATFORMS)。
export let BUS_DWELL_STOPS = Object.freeze({
  "1": Object.freeze({ s: -36.0, platform: "nw" }),
  "-1": Object.freeze({ s: 21.0, platform: "se" }),
});
export let BUS_DWELL_SECONDS = Object.freeze({ min: 6, max: 12 });
export let BUS_BOARDING_RADIUS_M = 9;
// 走到車門旁多近算上車(公尺)。
export let BUS_BOARD_ARRIVE_M = 0.35;

const VEHICLE_LENGTHS = Object.freeze({
  car: 4.8,
  scooter: 2.3,
  motorcycle: 2.5,
  bus: 10.8,
  bicycle: 2.5,
});

const PEDESTRIAN_SIDEWALK_T = 19.2;
const PEDESTRIAN_CURB_T = 17.5;
const TRANSITION_RUNOUT_M = 8;

// 行人穿越幾何:直行行穿線走廊內縮到 [11.2, 14.6],避開東側中央公車
// 月台(BusStop_1 x≥15.3);交錯式行穿線兩半段取畫線帶內縮範圍,轉折
// 走中央分向島(t 0.82..1.73)作為庇護帶。
// §16 實測修正:28 條 MainCrosswalk_Straight656_Stripe_* 之中,被中央公車
// 月台切短的三條(t 3.45..5.76)只畫到 s≈13.15,原本的 sMax=14.6 會讓行人
// 走出畫線 1.4 m。收斂成「每條條紋都覆蓋」的 s 區間,順帶與 KBot 的行穿線
// 崗位(s=15.0)留出 1.85 m,行人不會穿過指揮者身體。
export let STRAIGHT_CROSS_CORRIDOR = Object.freeze({ sMin: 11.44, sMax: 13.15 });
export let PEDESTRIAN_REFUGE_T = 1.28;
export let STAGGERED_CROSS = Object.freeze({
  posHalfS: Object.freeze({ sMin: -18.6, sMax: -15.4 }),
  negHalfS: Object.freeze({ sMin: -11.3, sMax: -8.1 }),
});

// 中央公車道月台(實測):月台面高 0.15;BusStop_1(東南向)候車帶
// t≈5.2、可站 x∈[17,25](雨棚在 x≥27);入口在直行斑馬線東緣 x≈16.2。
// BusStop_0(西北向)候車帶 t≈-3.5、可站 x∈[-28,-45];入口是交錯式
// 行穿線旁的共享穿越坡道 x≈-15.2(RefugePathTactile)。
export let BUS_PLATFORM_DECK_Y = 0.15;
export let BUS_PLATFORMS = Object.freeze({
  se: Object.freeze({
    row: 5.2, entryS: 16.2,
    waitSMin: 17.2, waitSMax: 24.8,
  }),
  nw: Object.freeze({
    row: -3.4, entryS: -15.2,
    waitSMin: -44, waitSMax: -28,
  }),
});

// ---------------------------------------------------------------------------
// 路緣線模型(實測 CurbPaint_±1_* 內插):兩側路緣的 t 值隨 s 線性平移
// (道路整體斜移),殘差 < 0.1 m。s=-17.5 處 +t 側 15.66、-t 側 -16.67。
export function kerbT(side, s) {
  const shift = 0.0298 * (Number(s) + 17.5);
  return Number(side) > 0 ? 15.66 + shift : -16.67 + shift;
}

// KBot 可以站的安全區(不在任何車道上)。指揮者離開崗位時一定要退到
// 其中之一——使用者需求:「紅綠燈到時候躲到公車站或是兩邊的人行道」。
// 中央分向島的行人庇護帶刻意「不」列入:它只有 0.9 m 寬且夾在兩條
// 公車道之間,行人可暫停、體型較大的機器人不該久站。
export function controllerSafeZone(s, t) {
  const sNum = Number(s);
  const tNum = Number(t);
  if (tNum >= kerbT(1, sNum) + 0.30) return "sidewalk_pos";
  if (tNum <= kerbT(-1, sNum) - 0.30) return "sidewalk_neg";
  if (
    sNum >= BUS_PLATFORMS.se.entryS - 0.6 && sNum <= 66
    && Math.abs(tNum - BUS_PLATFORMS.se.row) <= 1.1
  ) return "platform_se";
  if (
    sNum <= BUS_PLATFORMS.nw.entryS + 0.6 && sNum >= -66
    && Math.abs(tNum - BUS_PLATFORMS.nw.row) <= 1.1
  ) return "platform_nw";
  return null;
}

// 避車處清單(依「離路口近、視野好」排序)。y 為站立面高度 + 0.02。
// §16:公車站月台(platform_se / platform_nw)已從清單移除。它們雖然是
// controllerSafeZone 認定的安全區(真的被逼到那裡不算違規),但實測會讓
// 指揮者每一輪都退進公車停靠格裡「站在公車站裡指揮」,而且被車廂完全遮
// 擋——使用者明確否決。退避一律走人行道轉角。
export let CONTROLLER_REFUGES = Object.freeze([
  Object.freeze({ id: "sidewalk_pos", label: "行穿線頭人行道",
    s: 15.0, t: 17.15, y: 0.24 }),
  Object.freeze({ id: "sidewalk_neg", label: "對側人行道",
    s: 14.0, t: -16.75, y: 0.24 }),
  Object.freeze({ id: "lane90_corner", label: "巷90 巷口人行道",
    s: -0.5, t: 17.00, y: 0.24 }),
]);

// 最近的避車處(以直線距離;同距離時取清單順序較前者)。
export function nearestControllerRefuge(s, t, exclude = null) {
  let best = null;
  let bestDistance = Infinity;
  for (const refuge of CONTROLLER_REFUGES) {
    if (exclude && refuge.id === exclude) continue;
    const distance = Math.hypot(refuge.s - Number(s), refuge.t - Number(t));
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = refuge;
    }
  }
  return best;
}

// 產生一次穿越計畫:35% 直行、30% 交錯式、20% 東南月台候車、15% 西北
// 月台候車。path 為 waypoint 序列;safeLeg=true 的一段走在分向島庇護帶
// 或月台上(不構成車流衝突),refuge=true 的節點在號誌轉紅時可停等下
// 一次 WALK,busStop=true 的節點停留 busWaitS 秒模擬候車;y 為該點地面
// 高(月台 0.15,預設 0)。entryCrossS 是「進入後到達下一個安全點」所
// 需秒數,供尾端進入閘門使用。
export function buildPedestrianCrossing(random, side, speed) {
  const curbT = side * PEDESTRIAN_CURB_T;
  const farT = -side * PEDESTRIAN_CURB_T;
  const roll = random();

  if (roll < 0.35) {
    const curbS = STRAIGHT_CROSS_CORRIDOR.sMin
      + random() * (STRAIGHT_CROSS_CORRIDOR.sMax - STRAIGHT_CROSS_CORRIDOR.sMin);
    return {
      kind: "straight",
      curb: { s: curbS, t: curbT },
      path: [{ s: curbS, t: farT, safeLeg: false, refuge: false }],
      entryCrossS: (2 * PEDESTRIAN_CURB_T) / speed,
    };
  }

  if (roll < 0.65) {
    const nearHalf = side > 0 ? STAGGERED_CROSS.posHalfS : STAGGERED_CROSS.negHalfS;
    const farHalf = side > 0 ? STAGGERED_CROSS.negHalfS : STAGGERED_CROSS.posHalfS;
    const sNear = nearHalf.sMin + random() * (nearHalf.sMax - nearHalf.sMin);
    const sFar = farHalf.sMin + random() * (farHalf.sMax - farHalf.sMin);
    return {
      kind: "staggered",
      curb: { s: sNear, t: curbT },
      path: [
        { s: sNear, t: PEDESTRIAN_REFUGE_T, safeLeg: false, refuge: false },
        { s: sFar, t: PEDESTRIAN_REFUGE_T, safeLeg: true, refuge: true },
        { s: sFar, t: farT, safeLeg: false, refuge: false },
      ],
      entryCrossS: (PEDESTRIAN_CURB_T - PEDESTRIAN_REFUGE_T) / speed + 1,
    };
  }

  if (roll < 0.85) {
    // 東南月台候車:直行斑馬線過到月台列,東行上月台等車,回西端
    // 入口等 WALK 再續行對側。
    const platform = BUS_PLATFORMS.se;
    const curbS = 13.2 + random() * 1.2;
    const waitS = platform.waitSMin
      + random() * (platform.waitSMax - platform.waitSMin);
    return {
      kind: "bus_se",
      platform: "se",
      curb: { s: curbS, t: curbT },
      path: [
        { s: curbS, t: platform.row, safeLeg: false, refuge: false },
        { s: waitS, t: platform.row, safeLeg: true, refuge: false,
          busStop: true, y: BUS_PLATFORM_DECK_Y },
        { s: platform.entryS, t: platform.row, safeLeg: true, refuge: true,
          y: BUS_PLATFORM_DECK_Y },
        { s: curbS, t: platform.row, safeLeg: false, refuge: false },
        { s: curbS, t: farT, safeLeg: false, refuge: false },
      ],
      entryCrossS: (PEDESTRIAN_CURB_T - platform.row * side) / speed + 1,
    };
  }

  // 西北月台候車:交錯式近半段→分向島→共享穿越坡道跨北向公車道上
  // 月台;回程原路,經島上走遠半段到對側。
  const platform = BUS_PLATFORMS.nw;
  const nearHalf = side > 0 ? STAGGERED_CROSS.posHalfS : STAGGERED_CROSS.negHalfS;
  const farHalf = side > 0 ? STAGGERED_CROSS.negHalfS : STAGGERED_CROSS.posHalfS;
  const sNear = nearHalf.sMin + random() * (nearHalf.sMax - nearHalf.sMin);
  const sFar = farHalf.sMin + random() * (farHalf.sMax - farHalf.sMin);
  const waitS = platform.waitSMin
    + random() * (platform.waitSMax - platform.waitSMin);
  return {
    kind: "bus_nw",
    platform: "nw",
    curb: { s: sNear, t: curbT },
    path: [
      { s: sNear, t: PEDESTRIAN_REFUGE_T, safeLeg: false, refuge: false },
      { s: platform.entryS, t: PEDESTRIAN_REFUGE_T, safeLeg: true, refuge: true },
      { s: platform.entryS, t: platform.row, safeLeg: false, refuge: false },
      { s: waitS, t: platform.row - 0.2, safeLeg: true, refuge: false,
        busStop: true, y: BUS_PLATFORM_DECK_Y },
      { s: platform.entryS, t: platform.row, safeLeg: true, refuge: true,
        y: BUS_PLATFORM_DECK_Y },
      { s: platform.entryS, t: PEDESTRIAN_REFUGE_T, safeLeg: false, refuge: false },
      { s: sFar, t: PEDESTRIAN_REFUGE_T, safeLeg: true, refuge: true },
      { s: sFar, t: farT, safeLeg: false, refuge: false },
    ],
    entryCrossS: (PEDESTRIAN_CURB_T - PEDESTRIAN_REFUGE_T) / speed + 1,
  };
}

// Painted crosswalk bands measured from the MainCrosswalk stripe meshes in
// the calibrated frame. "straight" is the wide band southeast of the
// junction; the staggered crossing northwest of it has one half per
// carriageway. t ranges let waiting vehicles whose lane never touches a
// band (e.g. the SE busway vs the negative-t half) pass the clearance
// gates.
export const CROSSWALK_BANDS = Object.freeze([
  Object.freeze({ id: "straight", sMin: 10.59, sMax: 16.30, tMin: -14.27, tMax: 15.06 }),
  Object.freeze({ id: "stag_pos", sMin: -19.25, sMax: -14.80, tMin: -2.3, tMax: 14.16 }),
  Object.freeze({ id: "stag_neg", sMin: -11.88, sMax: -7.54, tMin: -14.95, tMax: -4.83 }),
]);

// Painted stop bars (StopBar_* / BusLaneStopBar_* meshes): each entry is
// the approach-side edge of the bar plus the exit point (far edge of the
// crossing it guards + runout) in travel order for its direction. Vehicles
// stop with their front bumper at `stop`; between `stop` and `exit` they
// count as occupying the transition conflict zone.
export const STOP_SEQUENCES = Object.freeze({
  general: Object.freeze({
    "1": Object.freeze([
      Object.freeze({ stop: -15.26, exit: -7.54 + TRANSITION_RUNOUT_M }),
      Object.freeze({ stop: 8.21, exit: 16.30 + TRANSITION_RUNOUT_M }),
    ]),
    "-1": Object.freeze([
      Object.freeze({ stop: 18.67, exit: 10.59 - TRANSITION_RUNOUT_M }),
      Object.freeze({ stop: -11.56, exit: -19.25 - TRANSITION_RUNOUT_M }),
    ]),
  }),
  bus: Object.freeze({
    "1": Object.freeze([
      Object.freeze({ stop: -20.29, exit: -7.54 + TRANSITION_RUNOUT_M }),
      Object.freeze({ stop: 9.53, exit: 16.30 + TRANSITION_RUNOUT_M }),
    ]),
    "-1": Object.freeze([
      Object.freeze({ stop: 17.61, exit: 10.59 - TRANSITION_RUNOUT_M }),
      Object.freeze({ stop: -7.05, exit: -19.25 - TRANSITION_RUNOUT_M }),
    ]),
  }),
});

function stopSequenceFor(vehicle) {
  const laneClass = vehicle.laneClass === "bus" ? "bus" : "general";
  return STOP_SEQUENCES[laneClass][String(vehicle.direction)] ?? [];
}

// Only the FIRST painted stop bar arrests a vehicle. Once the front bumper
// has committed past it the vehicle is inside the junction box and is let
// through every later bar/crosswalk so it never parks mid-intersection
// (「過了停止線就讓它過去」). Returns the first bar while still upstream of
// it, else null.
export function nextStopLine(vehicle, epsilon = 0.05) {
  const direction = Number(vehicle.direction);
  const frontU = (Number(vehicle.s) + direction * Number(vehicle.length) * 0.5)
    * direction;
  const sequence = stopSequenceFor(vehicle);
  if (sequence.length === 0) return null;
  const first = sequence[0];
  if (frontU > first.stop * direction + Number(epsilon)) return null;
  return first;
}

export function distanceToNextStop(vehicle, epsilon = 0.05) {
  const line = nextStopLine(vehicle, epsilon);
  if (!line) return Infinity;
  const direction = Number(vehicle.direction);
  const frontU = (Number(vehicle.s) + direction * Number(vehicle.length) * 0.5)
    * direction;
  return Math.max(0, line.stop * direction - frontU);
}


export function vehicleClearsCrosswalk(vehicle, margin = 0.8) {
  const halfLength = Number(vehicle.length) * 0.5;
  const sLow = Number(vehicle.s) - halfLength;
  const sHigh = Number(vehicle.s) + halfLength;
  const t = Number(vehicle.t);
  for (const band of CROSSWALK_BANDS) {
    if (Number.isFinite(t)
      && (t < band.tMin - 1.0 || t > band.tMax + 1.0)) continue;
    if (sHigh > band.sMin - Number(margin) + 1e-9
      && sLow < band.sMax + Number(margin) - 1e-9) {
      return false;
    }
  }
  return true;
}


export function vehicleOccupiesTransitionConflict(
  vehicle,
  margin = 0.8,
  epsilon = 0.05,
) {
  const halfLength = Number(vehicle.length) * 0.5;

  if (vehicle.sideAccess) {
    return (
      Number(vehicle.t) < SIDE_STOP_T - Number(epsilon)
      && Number(vehicle.t) > SIDE_END_T - halfLength - Number(epsilon)
    );
  }

  const direction = Number(vehicle.direction);
  const frontU = (Number(vehicle.s) + direction * halfLength) * direction;
  const rearU = (Number(vehicle.s) - direction * halfLength) * direction;
  // Pass-through semantics: a vehicle past the first bar transits the whole
  // junction box, so it occupies the conflict zone until its rear clears the
  // LAST exit (keeps clearance/WALK gates safe for mid-box movers).
  const sequence = stopSequenceFor(vehicle);
  if (sequence.length === 0) return false;
  const first = sequence[0];
  const last = sequence[sequence.length - 1];
  return (
    frontU > first.stop * direction + Number(epsilon)
    && rearU < last.exit * direction
  );
}


export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}


function integerBetween(random, minimum, maximumInclusive) {
  return minimum + Math.floor(random() * (maximumInclusive - minimum + 1));
}


function roundedRandom(random, minimum, maximum, digits = 3) {
  const value = minimum + random() * (maximum - minimum);
  return Number(value.toFixed(digits));
}


function sampleWeightedVehicle(random, mix) {
  const total = Object.values(mix).reduce(
    (sum, probability) => sum + Number(probability),
    0,
  );
  if (!(total > 0)) return "car";
  const pick = random() * total;
  let cumulative = 0;
  for (const [type, probability] of Object.entries(mix)) {
    cumulative += Number(probability);
    if (pick <= cumulative) return type;
  }
  return "car";
}


function shuffleInPlace(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}


function buildVehicleRoster(random, count, mix) {
  const roster = REQUIRED_VEHICLE_TYPES.slice(0, count);
  while (roster.length < count) {
    roster.push(sampleWeightedVehicle(random, mix));
  }
  return shuffleInPlace(roster, random);
}


function vehicleAppearance(random, type) {
  const scaleRanges = {
    car: [0.94, 1.02],
    bus: [0.96, 1.01],
    scooter: [0.92, 1.06],
    motorcycle: [0.94, 1.05],
    bicycle: [0.9, 1.04],
  };
  const [minimumScale, maximumScale] = scaleRanges[type] ?? [0.94, 1.02];
  const bodyColorId = integerBetween(random, 0, 9);
  return {
    bodyColorId,
    colorIndex: bodyColorId,
    bodyVariantId: integerBetween(random, 0, 3),
    riderVariantId: integerBetween(random, 0, 7),
    visualScale: roundedRandom(random, minimumScale, maximumScale),
    reactionDelayS: roundedRandom(random, 0, 0.9),
  };
}


export function visibleVehicleFingerprint(vehicle) {
  return JSON.stringify([
    vehicle.type,
    vehicle.bodyColorId,
    vehicle.bodyVariantId,
    vehicle.riderVariantId,
    vehicle.visualScale,
  ]);
}


export function kbotMotionSample({
  phaseId,
  elapsedS = 0,
  startFrame,
  fps,
  cycleFrames = 24,
  animateGesture = false,
  reducedMotion = false,
  endFrame = null,
  transitionFrames = 12,
}) {
  const framesPerSecond = Number(fps);
  if (!(framesPerSecond > 0)) throw new RangeError("fps must be positive");
  let frame = Number(startFrame);
  const lastFrame = Number(endFrame);
  if (!reducedMotion && Number.isFinite(lastFrame) && lastFrame > frame) {
    // Continuous in-window playback: play the entry transition once, then
    // ping-pong within [startFrame + transition, endFrame]. The triangle
    // wave keeps frame-to-frame deltas bounded (no snap when a modulo loop
    // would wrap from endFrame back to the window start).
    const advance = Math.max(0, Number(elapsedS)) * framesPerSecond;
    const transition = Math.min(
      Math.max(0, Number(transitionFrames)),
      lastFrame - frame,
    );
    if (advance <= transition) {
      frame += advance;
    } else {
      const loopSpan = lastFrame - frame - transition;
      if (loopSpan > 0) {
        const wave = (advance - transition) % (2 * loopSpan);
        frame += transition + (wave <= loopSpan ? wave : 2 * loopSpan - wave);
      } else {
        frame += transition;
      }
    }
  } else if (
    phaseId === "lane90_release"
    && animateGesture
    && !reducedMotion
  ) {
    frame += (
      Math.max(0, Number(elapsedS)) * framesPerSecond
    ) % Math.max(1, Number(cycleFrames));
  }
  return {
    frame,
    // Blender's glTF exporter writes frame 1 at 1 / fps, not at time zero.
    clipTimeS: frame / framesPerSecond,
  };
}


// 依既有位置與側別重擲一次穿越計畫(初生與回收共用)。
export function rollPedestrianCrossing(random, pedestrian, side) {
  const crossing = buildPedestrianCrossing(random, side, pedestrian.speed);
  const exitS = crossing.path[crossing.path.length - 1].s;
  pedestrian.side = side;
  pedestrian.crossing = crossing;
  pedestrian.pathIndex = 0;
  pedestrian.safeZone = false;
  pedestrian.curbS = crossing.curb.s;
  pedestrian.curbT = crossing.curb.t;
  pedestrian.targetSidewalkT = -side * PEDESTRIAN_SIDEWALK_T;
  pedestrian.departureS = exitS
    + pedestrian.travelDirection * (6 + random() * 9);
  pedestrian.waitDelay = 0.35 + random() * 2.2;
  pedestrian.waitElapsed = 0;
  pedestrian.busWaitS = 20 + random() * 28;
  pedestrian.busPlatform = crossing.platform ?? null;
  pedestrian.groundY = 0;
  return pedestrian;
}

function pedestrianPlan(random, index, pedestrianSpeed) {
  const side = index % 2 === 0 ? -1 : 1;
  const travelDirection = random() < 0.5 ? -1 : 1;
  const pedestrian = {
    id: `pedestrian-${index}`,
    state: "sidewalk_approach",
    side,
    s: 0,
    t: side * PEDESTRIAN_SIDEWALK_T,
    travelDirection,
    speed: pedestrianSpeed,
    gaitOffset: random() * Math.PI * 2,
    colorIndex: index,
    heading: travelDirection > 0 ? "s_positive" : "s_negative",
  };
  rollPedestrianCrossing(random, pedestrian, side);
  pedestrian.s = pedestrian.curbS
    - travelDirection * (5 + random() * 8);
  return pedestrian;
}


export let SPAWN_SPAN_M = 136;

// Minimum spawn headway between two same-lane neighbours (SPEC_VIEWER_V2
// §5): (front length + rear length)/2 + max(6, speed*1.2), where speed is
// the follower's desired speed (the follower is who must brake).
export function minimumSpawnHeadway(front, rear) {
  const speed = Number(rear.desiredSpeed) || 0;
  return (Number(front.length) + Number(rear.length)) / 2
    + Math.max(6, speed * 1.2);
}

// Post-spawn assertion helper: returns every same-lane pair closer than the
// minimum spawn headway (empty array = collision-free placement).
export function spawnHeadwayViolations(vehicles) {
  const violations = [];
  const laneGroups = new Map();
  for (const vehicle of vehicles) {
    if (vehicle.sideAccess) continue;
    const laneKey = `${vehicle.movement}:${vehicle.t}`;
    if (!laneGroups.has(laneKey)) laneGroups.set(laneKey, []);
    laneGroups.get(laneKey).push(vehicle);
  }
  for (const [laneKey, group] of laneGroups) {
    const ordered = [...group].sort(
      (a, b) => a.s * a.direction - b.s * b.direction,
    );
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const rear = ordered[index];
      const front = ordered[index + 1];
      const gap = (front.s - rear.s) * front.direction;
      const needed = minimumSpawnHeadway(front, rear);
      if (gap + 1e-6 < needed) {
        violations.push({
          laneKey,
          rearId: rear.id,
          frontId: front.id,
          gap,
          needed,
        });
      }
    }
  }
  return violations;
}

// Deterministic per-lane placement in travel-order coordinates
// (u = s * direction): consecutive vehicles are separated by at least the
// minimum headway, leftover span is spread evenly, and jitter is bounded to
// 45% of that spread so it can never break the minimum gap.
function placeLaneVehicles(group, jitters, jitterScale) {
  const halfSpan = SPAWN_SPAN_M / 2;
  const count = group.length;
  const gaps = [];
  for (let index = 0; index + 1 < count; index += 1) {
    gaps.push(minimumSpawnHeadway(group[index + 1], group[index]));
  }
  const needed = gaps.reduce((sum, gap) => sum + gap, 0);
  const slack = SPAWN_SPAN_M - needed;
  if (slack < 0) return false;
  const extra = slack / count;
  const jitterLimit = Math.min(3, extra * 0.45) * jitterScale;
  let cursor = -halfSpan + extra * 0.5;
  for (let index = 0; index < count; index += 1) {
    const u = cursor + jitters[index] * jitterLimit;
    group[index].s = group[index].direction > 0 ? u : -u;
    if (index + 1 < count) cursor += gaps[index] + extra;
  }
  return true;
}

// Keep-out sweep: no vehicle may spawn committed past a stop bar or on a
// crosswalk band. Vehicles overlapping a stop-bar-to-exit interval are
// pushed back (front to back, preserving headway); anything pushed past the
// rear margin is removed and reported via spawnReductions.
function spawnKeepOutZones(direction, lanePosition) {
  const laneClass = lanePosition === "bus" ? "bus" : "general";
  const sequence = STOP_SEQUENCES[laneClass][String(direction)] ?? [];
  if (sequence.length === 0) return [];
  // Whole junction box (first bar to last exit): matching the pass-through
  // commitment semantics, nobody spawns anywhere inside it.
  return [{
    startU: sequence[0].stop * direction - 0.8,
    endU: sequence[sequence.length - 1].exit * direction,
  }];
}

function applySpawnKeepOut(group, removedIds) {
  if (group.length === 0) return;
  const zones = spawnKeepOutZones(group[0].direction, group[0].lanePosition);
  if (zones.length === 0) return;
  const ordered = [...group].sort(
    (a, b) => a.s * a.direction - b.s * b.direction,
  );
  let frontKept = null;
  let frontKeptU = Infinity;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const vehicle = ordered[index];
    const half = vehicle.length * 0.5;
    let u = vehicle.s * vehicle.direction;
    if (frontKept) {
      u = Math.min(u, frontKeptU - minimumSpawnHeadway(frontKept, vehicle));
    }
    let moved = true;
    while (moved) {
      moved = false;
      for (const zone of zones) {
        if (u + half > zone.startU && u - half < zone.endU) {
          u = zone.startU - half - 0.3;
          moved = true;
        }
      }
    }
    if (u < -SPAWN_SPAN_M / 2 - 24) {
      removedIds.add(vehicle.id);
      continue;
    }
    vehicle.s = u * vehicle.direction;
    frontKept = vehicle;
    frontKeptU = u;
  }
}


export function buildSpawnPlan(
  seed,
  mix,
  pedestrianSpeed = 1.45,
  mode = "normal",
) {
  if (!(Number(pedestrianSpeed) > 0)) {
    throw new RangeError("pedestrianSpeed must be positive");
  }
  const budget = TRAFFIC_DENSITY_MODES[mode] ?? TRAFFIC_DENSITY_MODES.normal;
  const modeId = TRAFFIC_DENSITY_MODES[mode] ? mode : "normal";
  const random = mulberry32(seed);
  const mainCount = integerBetween(
    random,
    budget.mainVehicleMin,
    budget.mainVehicleMax,
  );
  const roster = buildVehicleRoster(random, mainCount, mix);

  const laneGroups = new Map();
  const mainVehicles = roster.map((type, index) => {
    const lane = laneForVehicle(type, random);
    const vehicle = {
      id: `roosevelt-${index}`,
      type,
      route: "roosevelt",
      movement: lane.movement,
      direction: lane.direction,
      s: 0,
      t: lane.t,
      desiredSpeed: MAIN_SPEED_RANGE.min
        + random() * (MAIN_SPEED_RANGE.max - MAIN_SPEED_RANGE.min),
      length: VEHICLE_LENGTHS[type] ?? VEHICLE_LENGTHS.car,
      sideAccess: false,
      lanePosition: lane.lanePosition,
      spawnSlot: "",
      ...vehicleAppearance(random, type),
    };
    const laneKey = `${lane.movement}:${lane.t}`;
    if (!laneGroups.has(laneKey)) laneGroups.set(laneKey, []);
    const group = laneGroups.get(laneKey);
    vehicle.spawnSlot = `${lane.movement}:${lane.t}:${group.length}`;
    group.push(vehicle);
    return vehicle;
  });

  // Collision-free placement (SPEC_VIEWER_V2 §5): up to 3 deterministic
  // rounds with shrinking jitter, then deterministic tail reduction for any
  // lane that still cannot host its vehicles (reported as spawnReductions).
  const removedIds = new Set();
  for (const group of laneGroups.values()) {
    const jitters = group.map(() => random() * 2 - 1);
    let placed = false;
    for (const jitterScale of [1, 0.5, 0]) {
      if (
        placeLaneVehicles(group, jitters, jitterScale)
        && spawnHeadwayViolations(group).length === 0
      ) {
        placed = true;
        break;
      }
    }
    while (!placed && group.length > 0) {
      removedIds.add(group.pop().id);
      placed = group.length === 0 || (
        placeLaneVehicles(group, jitters, 0)
        && spawnHeadwayViolations(group).length === 0
      );
    }
    applySpawnKeepOut(
      group.filter((vehicle) => !removedIds.has(vehicle.id)),
      removedIds,
    );
  }

  const vehicles = mainVehicles.filter(
    (vehicle) => !removedIds.has(vehicle.id),
  );

  // 巷90:每個縱列排一小隊機慢車,依序駛出巷口後右轉或做兩段式左轉。
  const perColumn = Math.max(1, budget.sideVehiclesPerColumn ?? 2);
  let sideIndex = 0;
  for (const [columnIndex, spawn] of SIDE_ACCESS_SPAWNS.entries()) {
    for (let queue = 0; queue < perColumn; queue += 1) {
      const type = ["scooter", "motorcycle", "bicycle"][
        integerBetween(random, 0, 2)
      ];
      const turn = lane90TurnFor(type, random);
      vehicles.push({
        id: `lane90-${sideIndex}`,
        type,
        route: "lane90",
        movement: "lane90_oneway",
        direction: 1,
        s: spawn.s,
        t: spawn.t + queue * SIDE_COLUMN_HEADWAY_M,
        endT: SIDE_END_T,
        recycleT: spawn.t + (perColumn - 0.5) * SIDE_COLUMN_HEADWAY_M,
        columnIndex,
        columnS: spawn.s,
        columnBaseT: spawn.t,
        turn,
        desiredSpeed: SIDE_SPEED_RANGE.min
          + random() * (SIDE_SPEED_RANGE.max - SIDE_SPEED_RANGE.min),
        length: VEHICLE_LENGTHS[type],
        sideAccess: true,
        spawnSlot: `lane90:${columnIndex}:${queue}`,
        ...vehicleAppearance(random, type),
      });
      sideIndex += 1;
    }
  }

  const pedestrianCount = integerBetween(
    random,
    budget.pedestrianMin,
    budget.pedestrianMax,
  );
  const pedestrians = Array.from(
    { length: pedestrianCount },
    (_, index) => pedestrianPlan(random, index, Number(pedestrianSpeed)),
  );

  return {
    seed,
    mode: modeId,
    vehicles,
    pedestrians,
    busLaneCount: BUS_LANES.length,
    spawnReductions: removedIds.size,
  };
}


function moveToward(value, target, distance) {
  if (Math.abs(target - value) <= distance) return target;
  return value + Math.sign(target - value) * distance;
}


function moveTowardWithBudget(value, target, budget) {
  const available = Math.max(0, budget);
  const required = Math.abs(target - value);
  const used = Math.min(required, available);
  return {
    value: moveToward(value, target, used),
    remaining: available - used,
  };
}


export function advancePedestrian(
  pedestrian,
  { delta, walkAllowed, busAtPlatform = false, busDoorS = null },
) {
  const next = { ...pedestrian };
  const distance = Math.max(0, delta) * next.speed;

  if (next.state === "sidewalk_approach") {
    let remaining = distance;
    if (next.s !== next.curbS) {
      const result = moveTowardWithBudget(next.s, next.curbS, remaining);
      next.s = result.value;
      remaining = result.remaining;
      next.heading = next.travelDirection > 0 ? "s_positive" : "s_negative";
    }
    if (next.s === next.curbS && remaining > 0 && next.t !== next.curbT) {
      const result = moveTowardWithBudget(next.t, next.curbT, remaining);
      next.t = result.value;
      next.heading = next.curbT > next.t ? "t_positive" : "t_negative";
    }
    if (next.s === next.curbS && next.t === next.curbT) {
      next.state = "waiting_at_curb";
      next.waitElapsed = 0;
    }
    return next;
  }

  if (next.state === "waiting_at_curb") {
    if (!walkAllowed) {
      next.waitElapsed = 0;
      return next;
    }
    next.waitElapsed += Math.max(0, delta);
    if (next.waitElapsed >= next.waitDelay) {
      next.state = "crossing";
    }
    return next;
  }

  if (next.state === "waiting_at_refuge") {
    // 分向島庇護帶/月台入口:等下一次 WALK 才走下一段。
    next.safeZone = true;
    if (!walkAllowed) {
      next.waitElapsed = 0;
      return next;
    }
    next.waitElapsed += Math.max(0, delta);
    if (next.waitElapsed >= Math.min(next.waitDelay, 1.0)) {
      next.state = "crossing";
    }
    return next;
  }

  if (next.state === "waiting_for_bus") {
    // 月台候車:公車真的停靠在同一月台時上車(boarding);等不到車
    // (busWaitS 逾時)就放棄候車、沿原計畫續行對側。
    next.safeZone = true;
    next.waitElapsed += Math.max(0, delta);
    if (busAtPlatform) {
      next.state = "boarding";
      next.waitElapsed = 0;
      next.boarded = false;
      // 車門座標由呼叫端從實際停靠的公車量出來;量不到才退回原地上車。
      next.boardTarget = Number.isFinite(busDoorS)
        ? { s: busDoorS, t: next.t }
        : null;
      return next;
    }
    if (next.waitElapsed >= next.busWaitS) {
      next.state = "crossing";
      next.waitElapsed = 0;
    }
    return next;
  }

  if (next.state === "boarding") {
    // 上車動線:候車者先沿月台走到車門旁(boardTarget),走到了才算上車
    // (boarded=true)、由呼叫端隱藏並在公車駛離後回收。舊版直接在候車位置
    // 把人藏起來,月台最遠站位離車門 8 m,看起來就是「人憑空消失」。
    next.safeZone = true;
    next.waitElapsed += Math.max(0, delta);
    if (!next.boardTarget) {
      next.boarded = true;
      return next;
    }
    const deltaS = next.boardTarget.s - next.s;
    const deltaT = next.boardTarget.t - next.t;
    const span = Math.hypot(deltaS, deltaT);
    if (span <= BUS_BOARD_ARRIVE_M) {
      next.s = next.boardTarget.s;
      next.t = next.boardTarget.t;
      next.boarded = true;
      return next;
    }
    const step = Math.min(distance, span);
    next.s += (deltaS / span) * step;
    next.t += (deltaT / span) * step;
    next.heading = Math.abs(deltaT) >= Math.abs(deltaS)
      ? (deltaT > 0 ? "t_positive" : "t_negative")
      : (deltaS > 0 ? "s_positive" : "s_negative");
    return next;
  }

  if (next.state === "crossing") {
    // 已進入者沿 waypoint 走完當前危險段;WALK 結束只擋新進入與庇護帶
    // 上的再出發。safeLeg 的一段(島上轉折/月台)不構成車流衝突。
    let remaining = distance;
    while (remaining > 0) {
      const waypoint = next.crossing.path[next.pathIndex];
      next.safeZone = Boolean(waypoint.safeLeg);
      // 地面高朝目標 waypoint 的 y 收斂(月台 0.15,一般 0)。
      const targetY = waypoint.y ?? 0;
      const yStep = Math.max(0, delta) * 0.35;
      next.groundY = Math.abs(targetY - (next.groundY ?? 0)) <= yStep
        ? targetY
        : (next.groundY ?? 0) + Math.sign(targetY - next.groundY) * yStep;
      const deltaS = waypoint.s - next.s;
      const deltaT = waypoint.t - next.t;
      const span = Math.hypot(deltaS, deltaT);
      if (span > 1e-9) {
        next.heading = Math.abs(deltaT) >= Math.abs(deltaS)
          ? (deltaT > 0 ? "t_positive" : "t_negative")
          : (deltaS > 0 ? "s_positive" : "s_negative");
      }
      if (span > remaining) {
        next.s += (deltaS / span) * remaining;
        next.t += (deltaT / span) * remaining;
        remaining = 0;
        break;
      }
      next.s = waypoint.s;
      next.t = waypoint.t;
      remaining -= span;
      if (next.pathIndex + 1 >= next.crossing.path.length) {
        next.state = "sidewalk_departure";
        next.safeZone = false;
        next.groundY = 0;
        break;
      }
      next.pathIndex += 1;
      if (waypoint.busStop) {
        next.state = "waiting_for_bus";
        next.safeZone = true;
        next.waitElapsed = 0;
        break;
      }
      if (waypoint.refuge && !walkAllowed) {
        next.state = "waiting_at_refuge";
        next.safeZone = true;
        next.waitElapsed = 0;
        break;
      }
    }
    return next;
  }

  if (next.state === "sidewalk_departure") {
    let remaining = distance;
    if (next.t !== next.targetSidewalkT) {
      const result = moveTowardWithBudget(
        next.t,
        next.targetSidewalkT,
        remaining,
      );
      next.t = result.value;
      remaining = result.remaining;
      next.heading = next.targetSidewalkT > next.t
        ? "t_positive"
        : "t_negative";
    }
    if (next.t === next.targetSidewalkT && remaining > 0) {
      next.s = moveTowardWithBudget(next.s, next.departureS, remaining).value;
      next.heading = next.travelDirection > 0 ? "s_positive" : "s_negative";
    }
    if (next.t === next.targetSidewalkT && next.s === next.departureS) {
      next.state = "complete";
    }
  }
  return next;
}

export let TRAFFIC_DENSITY_MODES = Object.freeze({
  sparse: Object.freeze({
    label: "稀疏",
    mainVehicleMin: 10,
    mainVehicleMax: 14,
    pedestrianMin: 6,
    pedestrianMax: 10,
    sideVehiclesPerColumn: 2,
  }),
  normal: Object.freeze({
    label: "一般",
    mainVehicleMin: 22,
    mainVehicleMax: 28,
    pedestrianMin: 10,
    pedestrianMax: 16,
    sideVehiclesPerColumn: 3,
  }),
  peak: Object.freeze({
    label: "尖峰",
    mainVehicleMin: 34,
    mainVehicleMax: 42,
    pedestrianMin: 16,
    pedestrianMax: 24,
    sideVehiclesPerColumn: 4,
  }),
});


// ---------------------------------------------------------------------------
// §19 參數登錄表(core 段)
//
// san 的需求:「我想要所有參數都是可以控制設定的,而不是只有某些部分可以設定」。
// 做法是把可調常數從 const 改成 let —— ES module 的匯出是 live binding,所以
// 只要在「定義它的模組」內重新指派,所有 import 端(包括 traffic_director.js
// 與 node 測試)自動看到新值,一個呼叫點都不用改。
//
// 每個項目:
//   id      唯一鍵,也是 JSON / localStorage 的鍵
//   group   UI 分組(見 traffic_params.mjs 的 PARAM_GROUPS)
//   apply   live    = 改了立刻生效
//           respawn = 只影響下次生成,需要按「重新產生」才看得到
//   calib   true 代表這是從 gongguan_v54_environment.glb 實測出來的校準值,
//           改了會偏離實景幾何 —— UI 會標警語並提供「回到實測值」。
// ---------------------------------------------------------------------------

const reNum = (obj, key, value) => Object.freeze({ ...obj, [key]: value });

function laneParam(index, label) {
  return {
    id: `lane.main${index}T`,
    group: "geometry",
    label,
    unit: "m",
    min: -20,
    max: 20,
    step: 0.01,
    apply: "respawn",
    calib: true,
    get: () => MAIN_ROOSEVELT_LANES[index].t,
    set: (v) => {
      const next = MAIN_ROOSEVELT_LANES.map((lane, i) => (
        i === index ? Object.freeze({ ...lane, t: v }) : lane
      ));
      MAIN_ROOSEVELT_LANES = Object.freeze(next);
    },
  };
}

function busLaneParam(index, label) {
  return {
    id: `lane.bus${index}T`,
    group: "geometry",
    label,
    unit: "m",
    min: -12,
    max: 12,
    step: 0.01,
    apply: "respawn",
    calib: true,
    get: () => BUS_LANES[index].t,
    set: (v) => {
      const next = BUS_LANES.map((lane, i) => (
        i === index ? Object.freeze({ ...lane, t: v }) : lane
      ));
      BUS_LANES = Object.freeze(next);
    },
  };
}

function densityParam(mode, key, label, unit, min, max, step) {
  return {
    id: `density.${mode}.${key}`,
    group: "density",
    label,
    unit,
    min,
    max,
    step,
    apply: "respawn",
    get: () => TRAFFIC_DENSITY_MODES[mode][key],
    set: (v) => {
      TRAFFIC_DENSITY_MODES = Object.freeze({
        ...TRAFFIC_DENSITY_MODES,
        [mode]: reNum(TRAFFIC_DENSITY_MODES[mode], key, v),
      });
    },
  };
}

function platformParam(side, key, label, min, max) {
  return {
    id: `platform.${side}.${key}`,
    group: "geometry",
    label,
    unit: "m",
    min,
    max,
    step: 0.01,
    apply: "respawn",
    calib: true,
    get: () => BUS_PLATFORMS[side][key],
    set: (v) => {
      BUS_PLATFORMS = Object.freeze({
        ...BUS_PLATFORMS,
        [side]: reNum(BUS_PLATFORMS[side], key, v),
      });
    },
  };
}

export function coreParamDefs() {
  return [
    // --- 車速 ---
    {
      id: "speed.mainMin", group: "speed", label: "幹道車速下限",
      unit: "m/s", min: 0.5, max: 25, step: 0.1, apply: "respawn",
      get: () => MAIN_SPEED_RANGE.min,
      set: (v) => { MAIN_SPEED_RANGE = reNum(MAIN_SPEED_RANGE, "min", v); },
    },
    {
      id: "speed.mainMax", group: "speed", label: "幹道車速上限",
      unit: "m/s", min: 0.5, max: 25, step: 0.1, apply: "respawn",
      get: () => MAIN_SPEED_RANGE.max,
      set: (v) => { MAIN_SPEED_RANGE = reNum(MAIN_SPEED_RANGE, "max", v); },
    },
    {
      id: "speed.sideMin", group: "speed", label: "巷90 車速下限",
      unit: "m/s", min: 0.5, max: 20, step: 0.1, apply: "respawn",
      get: () => SIDE_SPEED_RANGE.min,
      set: (v) => { SIDE_SPEED_RANGE = reNum(SIDE_SPEED_RANGE, "min", v); },
    },
    {
      id: "speed.sideMax", group: "speed", label: "巷90 車速上限",
      unit: "m/s", min: 0.5, max: 20, step: 0.1, apply: "respawn",
      get: () => SIDE_SPEED_RANGE.max,
      set: (v) => { SIDE_SPEED_RANGE = reNum(SIDE_SPEED_RANGE, "max", v); },
    },
    {
      id: "speed.pedestrianScale", group: "speed", label: "行人步速倍率",
      unit: "×", min: 0.2, max: 3, step: 0.05, apply: "respawn",
      get: () => PEDESTRIAN_SPEED_SCALE,
      set: (v) => { PEDESTRIAN_SPEED_SCALE = v; },
    },

    // --- 車流量 ---
    densityParam("sparse", "mainVehicleMin", "稀疏｜幹道車數下限", "輛", 0, 80, 1),
    densityParam("sparse", "mainVehicleMax", "稀疏｜幹道車數上限", "輛", 0, 80, 1),
    densityParam("sparse", "pedestrianMin", "稀疏｜行人下限", "人", 0, 60, 1),
    densityParam("sparse", "pedestrianMax", "稀疏｜行人上限", "人", 0, 60, 1),
    densityParam("sparse", "sideVehiclesPerColumn", "稀疏｜巷90 每列車數", "輛", 0, 10, 1),
    densityParam("normal", "mainVehicleMin", "一般｜幹道車數下限", "輛", 0, 80, 1),
    densityParam("normal", "mainVehicleMax", "一般｜幹道車數上限", "輛", 0, 80, 1),
    densityParam("normal", "pedestrianMin", "一般｜行人下限", "人", 0, 60, 1),
    densityParam("normal", "pedestrianMax", "一般｜行人上限", "人", 0, 60, 1),
    densityParam("normal", "sideVehiclesPerColumn", "一般｜巷90 每列車數", "輛", 0, 10, 1),
    densityParam("peak", "mainVehicleMin", "尖峰｜幹道車數下限", "輛", 0, 80, 1),
    densityParam("peak", "mainVehicleMax", "尖峰｜幹道車數上限", "輛", 0, 80, 1),
    densityParam("peak", "pedestrianMin", "尖峰｜行人下限", "人", 0, 60, 1),
    densityParam("peak", "pedestrianMax", "尖峰｜行人上限", "人", 0, 60, 1),
    densityParam("peak", "sideVehiclesPerColumn", "尖峰｜巷90 每列車數", "輛", 0, 10, 1),
    {
      id: "density.spawnSpan", group: "density", label: "生成跨距",
      unit: "m", min: 40, max: 300, step: 1, apply: "respawn",
      get: () => SPAWN_SPAN_M,
      set: (v) => { SPAWN_SPAN_M = v; },
    },
    {
      id: "density.sideHeadway", group: "density", label: "巷90 縱列排隊間距",
      unit: "m", min: 2, max: 20, step: 0.1, apply: "respawn",
      get: () => SIDE_COLUMN_HEADWAY_M,
      set: (v) => { SIDE_COLUMN_HEADWAY_M = v; },
    },

    // --- 公車 ---
    {
      id: "bus.dwellMin", group: "bus", label: "靠站停留下限",
      unit: "秒", min: 0, max: 60, step: 0.5, apply: "live",
      get: () => BUS_DWELL_SECONDS.min,
      set: (v) => { BUS_DWELL_SECONDS = reNum(BUS_DWELL_SECONDS, "min", v); },
    },
    {
      id: "bus.dwellMax", group: "bus", label: "靠站停留上限",
      unit: "秒", min: 0, max: 60, step: 0.5, apply: "live",
      get: () => BUS_DWELL_SECONDS.max,
      set: (v) => { BUS_DWELL_SECONDS = reNum(BUS_DWELL_SECONDS, "max", v); },
    },
    {
      id: "bus.boardingRadius", group: "bus", label: "可上車判定半徑",
      unit: "m", min: 1, max: 30, step: 0.5, apply: "live",
      get: () => BUS_BOARDING_RADIUS_M,
      set: (v) => { BUS_BOARDING_RADIUS_M = v; },
    },
    {
      id: "bus.boardArrive", group: "bus", label: "走到車門多近算上車",
      unit: "m", min: 0.05, max: 3, step: 0.05, apply: "live",
      get: () => BUS_BOARD_ARRIVE_M,
      set: (v) => { BUS_BOARD_ARRIVE_M = v; },
    },
    {
      id: "bus.dwellStopNwS", group: "bus", label: "西北向停靠點 s",
      unit: "m", min: -80, max: 0, step: 0.5, apply: "live", calib: true,
      get: () => BUS_DWELL_STOPS["1"].s,
      set: (v) => {
        BUS_DWELL_STOPS = Object.freeze({
          ...BUS_DWELL_STOPS, "1": reNum(BUS_DWELL_STOPS["1"], "s", v),
        });
      },
    },
    {
      id: "bus.dwellStopSeS", group: "bus", label: "東南向停靠點 s",
      unit: "m", min: 0, max: 80, step: 0.5, apply: "live", calib: true,
      get: () => BUS_DWELL_STOPS["-1"].s,
      set: (v) => {
        BUS_DWELL_STOPS = Object.freeze({
          ...BUS_DWELL_STOPS, "-1": reNum(BUS_DWELL_STOPS["-1"], "s", v),
        });
      },
    },

    // --- 待轉區 ---
    {
      id: "hook.parkedClearance", group: "hook", label: "待轉格淨空門檻",
      unit: "m", min: 0.2, max: 6, step: 0.1, apply: "live",
      get: () => HOOK_PARKED_CLEARANCE_M,
      set: (v) => { HOOK_PARKED_CLEARANCE_M = v; },
    },
    {
      id: "hook.boxS", group: "hook", label: "待轉區中心 s",
      unit: "m", min: -20, max: 20, step: 0.05, apply: "live", calib: true,
      get: () => HOOK_BOX.s,
      set: (v) => { HOOK_BOX = reNum(HOOK_BOX, "s", v); },
    },
    {
      id: "hook.boxHalfS", group: "hook", label: "待轉區半長",
      unit: "m", min: 0.5, max: 8, step: 0.05, apply: "live", calib: true,
      get: () => HOOK_BOX.halfS,
      set: (v) => { HOOK_BOX = reNum(HOOK_BOX, "halfS", v); },
    },
    {
      id: "hook.boxHalfT", group: "hook", label: "待轉區半寬",
      unit: "m", min: 0.5, max: 8, step: 0.05, apply: "live", calib: true,
      get: () => HOOK_BOX.halfT,
      set: (v) => { HOOK_BOX = reNum(HOOK_BOX, "halfT", v); },
    },

    // --- 行人幾何 ---
    {
      id: "ped.corridorMin", group: "pedestrian", label: "直行走廊 s 下界",
      unit: "m", min: 0, max: 30, step: 0.01, apply: "respawn", calib: true,
      get: () => STRAIGHT_CROSS_CORRIDOR.sMin,
      set: (v) => {
        STRAIGHT_CROSS_CORRIDOR = reNum(STRAIGHT_CROSS_CORRIDOR, "sMin", v);
      },
    },
    {
      id: "ped.corridorMax", group: "pedestrian", label: "直行走廊 s 上界",
      unit: "m", min: 0, max: 30, step: 0.01, apply: "respawn", calib: true,
      get: () => STRAIGHT_CROSS_CORRIDOR.sMax,
      set: (v) => {
        STRAIGHT_CROSS_CORRIDOR = reNum(STRAIGHT_CROSS_CORRIDOR, "sMax", v);
      },
    },
    {
      id: "ped.refugeT", group: "pedestrian", label: "分向島庇護帶 t",
      unit: "m", min: -6, max: 6, step: 0.01, apply: "respawn", calib: true,
      get: () => PEDESTRIAN_REFUGE_T,
      set: (v) => { PEDESTRIAN_REFUGE_T = v; },
    },
    {
      id: "ped.platformDeckY", group: "pedestrian", label: "月台面高",
      unit: "m", min: 0, max: 1, step: 0.005, apply: "respawn", calib: true,
      get: () => BUS_PLATFORM_DECK_Y,
      set: (v) => { BUS_PLATFORM_DECK_Y = v; },
    },

    // --- 校準幾何 ---
    laneParam(0, "西北向 內側車道 t"),
    laneParam(1, "西北向 中線車道 t"),
    laneParam(2, "西北向 外側車道 t"),
    laneParam(3, "東南向 內側車道 t"),
    laneParam(4, "東南向 中線車道 t"),
    laneParam(5, "東南向 外側車道 t"),
    busLaneParam(0, "西北向 公車專用道 t"),
    busLaneParam(1, "東南向 公車專用道 t"),
    {
      id: "lane.width", group: "geometry", label: "車道寬",
      unit: "m", min: 1.5, max: 6, step: 0.05, apply: "respawn", calib: true,
      get: () => LANE_WIDTH_M,
      set: (v) => { LANE_WIDTH_M = v; },
    },
    {
      id: "lane.sideStopT", group: "geometry", label: "巷90 停止線 t",
      unit: "m", min: 0, max: 30, step: 0.05, apply: "respawn", calib: true,
      get: () => SIDE_STOP_T,
      set: (v) => { SIDE_STOP_T = v; },
    },
    {
      id: "lane.sideEndT", group: "geometry", label: "巷90 匯入終點 t",
      unit: "m", min: 0, max: 30, step: 0.05, apply: "respawn", calib: true,
      get: () => SIDE_END_T,
      set: (v) => { SIDE_END_T = v; },
    },
    {
      id: "lane.hookLaneT", group: "geometry", label: "待轉併入車道 t",
      unit: "m", min: -20, max: 20, step: 0.01, apply: "respawn", calib: true,
      get: () => LANE90_HOOK_LANE_T,
      set: (v) => { LANE90_HOOK_LANE_T = v; },
    },
    {
      id: "lane.rightLaneT", group: "geometry", label: "右轉併入車道 t",
      unit: "m", min: -20, max: 20, step: 0.01, apply: "respawn", calib: true,
      get: () => LANE90_RIGHT_LANE_T,
      set: (v) => { LANE90_RIGHT_LANE_T = v; },
    },
    platformParam("se", "row", "東南月台 候車帶 t", -20, 20),
    platformParam("se", "entryS", "東南月台 入口 s", -80, 80),
    platformParam("se", "waitSMin", "東南月台 候車 s 下界", -80, 80),
    platformParam("se", "waitSMax", "東南月台 候車 s 上界", -80, 80),
    platformParam("nw", "row", "西北月台 候車帶 t", -20, 20),
    platformParam("nw", "entryS", "西北月台 入口 s", -80, 80),
    platformParam("nw", "waitSMin", "西北月台 候車 s 下界", -80, 80),
    platformParam("nw", "waitSMax", "西北月台 候車 s 上界", -80, 80),
  ];
}
