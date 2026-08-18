import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { createParamRegistry, PARAM_GROUPS } from "./traffic_params.mjs?v=eff94f7a";
import {
  BUS_BOARDING_RADIUS_M,
  coreParamDefs,
  BUS_DWELL_SECONDS,
  BUS_DWELL_STOPS,
  BUS_LANES,
  BUS_PLATFORMS,
  CROSSWALK_BANDS,
  HOOK_BOX,
  HOOK_BOX_FILL_ORDER,
  HOOK_PARKED_CLEARANCE_M,
  LANE90_HOOK_LANE_T,
  LANE90_RIGHT_LANE_T,
  OFFICIAL_GESTURE_TO_PHASE,
  PEDESTRIAN_WALK_COMMAND,
  SIDE_COLUMN_HEADWAY_M,
  SIDE_STOP_T,
  STRAIGHT_CROSS_CORRIDOR,
  TRAFFIC_DENSITY_MODES,
  advancePedestrian,
  buildHookMergePath,
  buildLane90TurnPath,
  buildSpawnPlan,
  controllerSafeZone,
  distanceToNextStop,
  hookBoxSlot,
  kbotMotionSample,
  lane90TurnFor,
  minimumSpawnHeadway,
  mulberry32,
  nearestControllerRefuge,
  nextStopLine,
  resolveTrafficCommand,
  roadCurveOffset,
  roadCurveSlope,
  rollPedestrianCrossing,
  vehicleClearsCrosswalk,
  vehicleOccupiesTransitionConflict,
} from "./traffic_simulation_core.mjs?v=d97942c3";

const RULES_URL = "../traffic_rules/taiwan_traffic_director_rules.json?v=b1a6379f";
const ENVIRONMENT_URL = "models/gongguan_v54_environment.glb?v=685c61c0";
const KBOT_URL = "models/kbot_traffic_director.glb?v=ee079987";
const SIGNAL_ASPECTS_URL = "models/gongguan_v54_signal_aspects.glb?v=d52a3745";
const KBOT_APPEARANCE_PROFILE = "black-high-contrast-v1";
const DRACO_DECODER_URL =
  "./vendor/examples/jsm/libs/draco/gltf/";
let SCENE_LENGTH = 170;
let ROAD_HALF_WIDTH = 17;
let CONFLICT_HALF_LENGTH = 8;
let CROSSWALK_CLEARANCE_MARGIN = 0.8;
let LOW_LOAD_RENDER_PROFILE = Object.freeze({
  targetFps: 30,
  maxPixelRatio: 1.25,
  uiUpdateHz: 4,
  shadows: false,
});
// Dual render profiles (SPEC_VIEWER_V2 §3): 高效能 60 FPS (default) and
// 省電 = the legacy low-load profile. Toggled from the simulation panel.
let RENDER_PROFILES = Object.freeze({
  performance: Object.freeze({
    id: "performance",
    targetFps: 60,
    maxPixelRatio: Math.min(2, devicePixelRatio),
    uiUpdateHz: 8,
    shadows: false,
  }),
  powersave: Object.freeze({ id: "powersave", ...LOW_LOAD_RENDER_PROFILE }),
});
// 亮度(§2b 實測值:Hemi 1.6 / Sun 3.4 / 曝光 1.22)。§19 起改成可調。
let LIGHTING = { exposure: 1.22, hemisphere: 1.6, sun: 3.4 };

// Hard follow-safety floor (SPEC_VIEWER_V2 §5): the bumper-to-bumper gap
// between a leader and its same-lane follower never drops below 2 m.
let FOLLOW_MIN_BUMPER_GAP_M = 2;

const ui = {
  scene: document.querySelector("#scene"),
  fatalError: document.querySelector("#fatalError"),
  modelStatus: document.querySelector("#modelStatus"),
  phaseLabel: document.querySelector("#phaseLabel"),
  phaseDescription: document.querySelector("#phaseDescription"),
  phaseCountdown: document.querySelector("#phaseCountdown"),
  phaseSignal: document.querySelector("#phaseSignal"),
  commandDecision: document.querySelector("#commandDecision"),
  decisionState: document.querySelector("#decisionState"),
  requestedCommand: document.querySelector("#requestedCommand"),
  requestedGesture: document.querySelector("#requestedGesture"),
  activeGesture: document.querySelector("#activeGesture"),
  candidatePhase: document.querySelector("#candidatePhase"),
  decisionReason: document.querySelector("#decisionReason"),
  safetyLocks: document.querySelector("#safetyLocks"),
  modeBadge: document.querySelector("#modeBadge"),
  vehicleCount: document.querySelector("#vehicleCount"),
  pedestrianCount: document.querySelector("#pedestrianCount"),
  crossingCount: document.querySelector("#crossingCount"),
  throughputCount: document.querySelector("#throughputCount"),
  collisionCount: document.querySelector("#collisionCount"),
  carCount: document.querySelector("#carCount"),
  scooterCount: document.querySelector("#scooterCount"),
  motorcycleCount: document.querySelector("#motorcycleCount"),
  busCount: document.querySelector("#busCount"),
  bicycleCount: document.querySelector("#bicycleCount"),
  sidewalkPedestrianCount: document.querySelector("#sidewalkPedestrianCount"),
  autoMode: document.querySelector("#autoMode"),
  downstreamBlocked: document.querySelector("#downstreamBlocked"),
  motionEffects: document.querySelector("#motionEffects"),
  highPerformance: document.querySelector("#highPerformance"),
  trafficDensity: document.querySelector("#trafficDensity"),
  hookTurn: document.querySelector("#hookTurn"),
  recordingMode: document.querySelector("#recordingMode"),
  pacingPreset: document.querySelector("#pacingPreset"),
  hookWaitCount: document.querySelector("#hookWaitCount"),
  hookWaitChip: document.querySelector("#hookWaitChip"),
  boardingCount: document.querySelector("#boardingCount"),
  kbotPostLabel: document.querySelector("#kbotPostLabel"),
  kbotPostPreview: document.querySelector("#kbotPostPreview"),
  kbotPostSegmented: document.querySelector("#kbotPostSegmented"),
  kbotPostTarget: document.querySelector("#kbotPostTarget"),
  kbotPostS: document.querySelector("#kbotPostS"),
  kbotPostT: document.querySelector("#kbotPostT"),
  kbotPostY: document.querySelector("#kbotPostY"),
  kbotPostSValue: document.querySelector("#kbotPostSValue"),
  kbotPostTValue: document.querySelector("#kbotPostTValue"),
  kbotPostYValue: document.querySelector("#kbotPostYValue"),
  kbotPostVerdict: document.querySelector("#kbotPostVerdict"),
  kbotPostCopy: document.querySelector("#kbotPostCopy"),
  kbotPostReset: document.querySelector("#kbotPostReset"),
  kbotPostCopyNote: document.querySelector("#kbotPostCopyNote"),
  kbotPostExport: document.querySelector("#kbotPostExport"),
  pacingSegmented: document.querySelector("#pacingSegmented"),
  densitySegmented: document.querySelector("#densitySegmented"),
  durationRoosevelt: document.querySelector("#durationRoosevelt"),
  durationPedestrian: document.querySelector("#durationPedestrian"),
  durationLane90: document.querySelector("#durationLane90"),
  durationRooseveltValue: document.querySelector("#durationRooseveltValue"),
  durationPedestrianValue: document.querySelector("#durationPedestrianValue"),
  durationLane90Value: document.querySelector("#durationLane90Value"),
  trafficModeLabel: document.querySelector("#trafficModeLabel"),
  busLaneCount: document.querySelector("#busLaneCount"),
  spawnAdjustNote: document.querySelector("#spawnAdjustNote"),
  reseedButton: document.querySelector("#reseedButton"),
  paramGroups: document.querySelector("#paramGroups"),
  paramSearch: document.querySelector("#paramSearch"),
  paramSummary: document.querySelector("#paramSummary"),
  paramDirtyCount: document.querySelector("#paramDirtyCount"),
  paramRespawnNote: document.querySelector("#paramRespawnNote"),
  paramRestoredNote: document.querySelector("#paramRestoredNote"),
  paramRestoredCount: document.querySelector("#paramRestoredCount"),
  paramRespawn: document.querySelector("#paramRespawn"),
  paramCopyCode: document.querySelector("#paramCopyCode"),
  paramExportJson: document.querySelector("#paramExportJson"),
  paramImportInput: document.querySelector("#paramImportInput"),
  paramResetAll: document.querySelector("#paramResetAll"),
  paramExport: document.querySelector("#paramExport"),
  sourceList: document.querySelector("#sourceList"),
  ruleSetLabel: document.querySelector("#ruleSetLabel"),
  seedLabel: document.querySelector("#seedLabel"),
  commandButtons: [...document.querySelectorAll("[data-command]")],
  cameraButtons: [...document.querySelectorAll("[data-camera]")],
  // §20 相機系統(新增的視角/模式/工具都用獨立屬性,不進 data-camera
  // 名稱空間 —— verify_kbot_post_tuner 斷言 data-camera 剛好 6 顆)。
  cameraViewButtons: [...document.querySelectorAll("[data-view]")],
  cameraModeButtons: [...document.querySelectorAll("[data-camera-mode]")],
  cameraActionButtons: [...document.querySelectorAll("[data-camera-action]")],
  projectionToggle: document.querySelector("#projectionToggle"),
  focusSelected: document.querySelector("#focusSelected"),
  cameraSelectionLabel: document.querySelector("#cameraSelectionLabel"),
  cameraNotice: document.querySelector("#cameraNotice"),
  // §21 Viewport 操作 UI:ViewCube、View / Layers 選單。
  viewCube: document.querySelector("#viewCube"),
  viewCubeStage: document.querySelector("#viewCubeStage"),
  viewCubeFaces: [...document.querySelectorAll("[data-cube-face]")],
  viewMenuButton: document.querySelector("#viewMenuButton"),
  viewMenu: document.querySelector("#viewMenu"),
  layersMenuButton: document.querySelector("#layersMenuButton"),
  layersMenu: document.querySelector("#layersMenu"),
  layerList: document.querySelector("#layerList"),
  // §22 控制面板分頁與收合。
  panelTabs: [...document.querySelectorAll("[data-panel-tab]")],
  panelPanes: [...document.querySelectorAll(".panel-pane")],
  panelCollapse: document.querySelector("#panelCollapse"),
  panelScroll: document.querySelector(".panel-scroll"),
};

const runtime = {
  rules: null,
  phases: [],
  currentPhaseId: "all_stop",
  phaseIndex: 0,
  phaseElapsed: 0,
  phaseDuration: 2,
  command: null,
  auto: true,
  phaseSeconds: {},
  downstreamBlocked: false,
  vehicles: [],
  pedestrians: [],
  throughput: 0,
  collisions: 0,
  busBoardings: 0,
  hookTurnEnabled: true,
  seedOffset: 0,
  kbotMixer: null,
  kbotAnimations: [],
  kbotHolder: null,
  kbotAppearance: null,
  kbotProbe: null,
  kbotArms: { left: null, right: null },
  kbotHands: { left: null, right: null },
  kbotPosePhaseId: "all_stop",
  kbotGestureClock: 0,
  kbotSampleTimeS: 0,
  kbotYawTargetRad: 0,
  kbotWalk: {
    targets: null,
    kind: null,
    baseY: 0.30,
    bobPhase: 0,
    clock: 0,
    entryDone: false,
    entryDelayS: 2.5,
  },
  kbotBlend: null,
  // §18 崗位微調(預設完全不作用:preview=false 時所有行為與沒有這組 UI
  // 時一模一樣)。
  kbotPostEditId: "stand",
  kbotPostPreview: false,
  kbotPostInputs: null,
  kbotPostMarkers: null,
  buildingNodes: [],
  signalAspects: null,
  signalAspectNodes: [],
  signalHeadCount: 0,
  simulationRoot: null,
  hookTurnBox: null,
  environment: null,
  environmentReady: false,
  kbotReady: false,
  signalsReady: false,
  // SPEC_VIEWER_V2 §1a: motion is controlled by the「動作效果」switch and is
  // ON by default, regardless of the OS prefers-reduced-motion setting.
  reducedMotion: false,
  renderProfile: RENDER_PROFILES.performance,
  trafficMode: "normal",
  // §22 目前顯示的控制面板分頁(command / sim / params)。
  panelTab: "command",
  renderStats: {
    targetFps: RENDER_PROFILES.performance.targetFps,
    measuredFps: 0,
    renderedFrames: 0,
  },
};

let scene;
let camera;
let renderer;
let controls;
let clock;
let random;
let lastRenderAtMs = 0;
let lastUiUpdateAtMs = 0;
let fpsWindowStartedAtMs = 0;
let fpsWindowFrames = 0;

const materialCache = new Map();
const boxGeometryCache = new Map();
const cylinderGeometryCache = new Map();

function setFatalError(message) {
  ui.fatalError.hidden = false;
  ui.fatalError.textContent = message;
}

function material(color, roughness = 0.7, metalness = 0.0) {
  const key = `${color}:${roughness}:${metalness}`;
  if (!materialCache.has(key)) {
    const value = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    value.userData.sharedRuntimeResource = true;
    materialCache.set(key, value);
  }
  return materialCache.get(key);
}

function box(width, height, depth, color, roughness = 0.7, metalness = 0) {
  const geometryKey = `${width}:${height}:${depth}`;
  if (!boxGeometryCache.has(geometryKey)) {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    geometry.userData.sharedRuntimeResource = true;
    boxGeometryCache.set(geometryKey, geometry);
  }
  const mesh = new THREE.Mesh(
    boxGeometryCache.get(geometryKey),
    material(color, roughness, metalness),
  );
  mesh.castShadow = LOW_LOAD_RENDER_PROFILE.shadows;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(radius, height, color, radialSegments = 12) {
  const geometryKey = `${radius}:${height}:${radialSegments}`;
  if (!cylinderGeometryCache.has(geometryKey)) {
    const geometry = new THREE.CylinderGeometry(
      radius,
      radius,
      height,
      radialSegments,
    );
    geometry.userData.sharedRuntimeResource = true;
    cylinderGeometryCache.set(geometryKey, geometry);
  }
  const mesh = new THREE.Mesh(
    cylinderGeometryCache.get(geometryKey),
    material(color, 0.72),
  );
  mesh.castShadow = LOW_LOAD_RENDER_PROFILE.shadows;
  mesh.receiveShadow = true;
  return mesh;
}

function normalizeLoadedModel(model) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= bounds.min.y;
  model.updateMatrixWorld(true);
}

function makeDracoLoader() {
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_DECODER_URL);
  draco.setDecoderConfig({ type: "wasm" });
  return draco;
}

function refreshModelStatus() {
  if (runtime.environmentReady && runtime.kbotReady && runtime.signalsReady) {
    setModelStatus(
      "ready",
      `V54＋綠色 KBot＋${runtime.signalHeadCount} 組號誌｜${runtime.renderProfile.targetFps} FPS`,
    );
  } else if (runtime.environmentReady && runtime.signalsReady) {
    setModelStatus("loading", "V54 實景與號誌已載入，載入綠色 KBot ORCA");
  } else if (runtime.environmentReady) {
    setModelStatus("loading", "V54 實景已載入，載入實景號誌與綠色 KBot");
  } else {
    setModelStatus("loading", "載入指定 V54 Blender 實景");
  }
}

function loadEnvironment() {
  refreshModelStatus();
  const draco = makeDracoLoader();
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return new Promise((resolve, reject) => {
    loader.load(
      ENVIRONMENT_URL,
      (gltf) => {
        runtime.environment = gltf.scene;
        runtime.environment.name = "Canonical_V54_Environment";
        runtime.environment.traverse((node) => {
          if (node.isMesh) {
            node.castShadow = false;
            node.receiveShadow = true;
          }
        });
        scene.add(runtime.environment);
        // §20:相機防穿模包圍盒 + 公車站 picking 目標(只做一次)。
        buildCameraBlockers();
        buildBusStopPickMeshes();
        runtime.environmentReady = true;
        draco.dispose();
        refreshModelStatus();
        resolve();
      },
      undefined,
      (error) => {
        draco.dispose();
        reject(
          new Error(
            `指定 V54 實景載入失敗；已停止，不顯示替代場景。${error.message ?? error}`,
          ),
        );
      },
    );
  });
}

// KBot 指揮崗位(高度=實測地面+0.02:人行道 0.215、路面 0、月台 0.15):
// stand     平時/羅斯福放行——人行道路緣、行穿線正北端(與 crosswalk
//           崗位同一條 s,退避時沿畫線正北直走,不橫切任何車道);
// crosswalk 行人相位——直行行穿線中線 × +t 半段畫線帶中段,真正站在
//           「斑馬線畫線上」指揮(受 robotInVehiclePath 安全閘門保護)。
//           §16 實測:舊崗位 (15.60, 1.28) 落在 t∈(-1.73, 2.52) 這段
//           「無畫線空白帶」(BRT 中央分向島)正中央,根本不在斑馬線上,
//           而且分向島不是安全區,每一輪都被閘門趕去公車站月台。新座標
//           t=8.33 是 Stripe_20 中心(t∈[8.06,8.60]),該條紋 s 覆蓋
//           [10.78,15.64];s=15.00 則是「t≥6 的每條條紋都覆蓋」的縱向
//           中線(舊值 15.60 有 9/14 條踩不到)。
// lane90    巷90放行——巷口轉角,面向巷口招車。
// 崗位不安全時(車流相位、或相位剩餘時間不足)一律退到最近的避車處
// ——人行道轉角(CONTROLLER_REFUGES;公車站月台已從清單移除)。
// 出廠預設(還原按鈕與「複製設定」的對照基準),永遠凍結。
const KBOT_POSTS_DEFAULT = Object.freeze({
  stand: Object.freeze({
    id: "stand", label: "行穿線旁人行道", x: 15.0, y: 0.24, z: 17.15,
  }),
  crosswalk: Object.freeze({
    id: "crosswalk", label: "行穿線中央", x: 15.00, y: 0.02, z: 8.33,
  }),
  lane90: Object.freeze({
    id: "lane90", label: "巷90 巷口", x: -0.5, y: 0.24, z: 17.00,
  }),
});
const KBOT_POST_IDS = Object.freeze(["stand", "crosswalk", "lane90"]);
// §18「機器人崗位微調」:KBOT_POSTS 由凍結模組常數改成執行期可調。規則是
// 「就地改欄位、永不換物件」——三個 post 物件的識別在整個生命週期固定,
// 所以 `const KBOT_STAND = KBOT_POSTS.stand` 這種別名讀到的永遠是最新值,
// 不會出現「有些地方讀舊常數、有些地方讀新值」。反過來說,純量/陣列衍生
// 值沒辦法就地更新,一律改成函式(kbotCrossS() / kbotEntryPath())。
const KBOT_POSTS = {
  stand: { ...KBOT_POSTS_DEFAULT.stand },
  crosswalk: { ...KBOT_POSTS_DEFAULT.crosswalk },
  lane90: { ...KBOT_POSTS_DEFAULT.lane90 },
};
const KBOT_STAND = KBOT_POSTS.stand;
// 直行行穿線中線:跨越車道一律沿此線南北向移動,絕不斜穿路口。
// (= crosswalk 崗位的 s;跟著崗位走,所以是函式不是常數。)
function kbotCrossS() {
  return KBOT_POSTS.crosswalk.x;
}
// 巷90 巷口中心(招車時的注視點)。崗位可調,注視點不動。
const LANE90_MOUTH = Object.freeze({ x: -7.5, z: 21.0 });
// 進場步行路徑:場景就緒 2.5 秒後,從水源市場走廊沿人行道走到路緣站位
// (讓使用者看得到走路,而非載入期間走完)。末點抄目前的 stand 崗位。
function kbotEntryPath() {
  return [
    { x: -1.0, y: 0.24, z: 18.2 },
    { x: 4.0, y: 0.24, z: 17.4 },
    { x: KBOT_STAND.x, y: KBOT_STAND.y, z: KBOT_STAND.z },
  ];
}
let KBOT_ENTRY_DELAY_S = 2.5;
// 速度與步態同步:烘焙的走路循環 32 幀/週期(1.333 s 兩步),步幅約
// 0.57 m → 設計速度 0.85 m/s。勤務轉移用快走 1.25 m/s,步態播放速率
// 依 speed / 設計速度 等比加快,腳掌才不會在地上打滑。
let KBOT_WALK_DESIGN_SPEED = 0.85;
let KBOT_WALK_SPEED = KBOT_WALK_DESIGN_SPEED;
let KBOT_DUTY_SPEED = 1.35;
// 到崗後至少要站這麼久才值得走過去,否則直接在安全處指揮。
// §16:4.0 → 3.0。巷90 崗位在標準節奏(16 s)下的預算是
// 15.5 m / 1.35 = 11.5 s + dwell,4.0 只剩 0.5 s 餘裕、實測 300 s 內
// 一次都沒走成;3.0 留 1.5 s 餘裕才走得到。
let KBOT_POST_MIN_DWELL_S = 3.0;
// GLB 時間軸 1068–1143 為 MuJoCo 烘焙的原地步行循環(SPEC_MUJOCO.md):
// 前 12 幀是進入過渡,迴圈區 [1079, 1143] 恰為兩個 32 幀週期,取模播放
// 無縫;前進位移由 holder 提供(root motion)。
const KBOT_WALK_CLIP = Object.freeze({ loopStartFrame: 1079, loopSpanFrames: 64 });

// 執行期綠色塗裝(v2:低飽和玉綠殼 + 槍鐵色關節,避免整身螢光綠):
// GLB 的 black-high-contrast-v1 外觀 metadata 驗證照舊,通過後依
// kbot_material_role 逐材質改色(不動材質名稱與 metadata)。
let KBOT_GREEN_TINT = Object.freeze({
  body_black: 0x2e7d52,
  joint_graphite: 0x232e28,
  orca_black: 0x2e7d52,
  orca_graphite: 0x1e5038,
});

function applyKbotGreenTint(model) {
  const painted = new Set();
  model.traverse((node) => {
    if (!node.isMesh) return;
    const color = KBOT_GREEN_TINT[node.userData.kbot_material_role];
    if (color === undefined) return;
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    for (const meshMaterial of materials) {
      if (!meshMaterial || painted.has(meshMaterial)) continue;
      meshMaterial.color.set(color);
      painted.add(meshMaterial);
    }
  });
}

function loadKbot() {
  runtime.kbotHolder = new THREE.Group();
  // §20 picking:holder 才是跟隨迴圈與 focus 用的節點,給它名字與 pick id。
  runtime.kbotHolder.name = "Runtime_KbotHolder";
  runtime.kbotHolder.userData.pickId = "kbot";
  const start = kbotEntryPath()[0];
  runtime.kbotHolder.position.set(start.x, start.y, start.z);
  runtime.kbotWalk.entryDelayS = KBOT_ENTRY_DELAY_S;
  runtime.simulationRoot.add(runtime.kbotHolder);

  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      KBOT_URL,
      (gltf) => {
        const model = gltf.scene;
        const appearance = validateKbotAppearance(model);
        runtime.kbotModel = model;
        applyKbotGreenTint(model);
        model.traverse((node) => {
          if (node.isMesh) {
            node.castShadow = LOW_LOAD_RENDER_PROFILE.shadows;
            node.receiveShadow = true;
            // 兩支前臂節點:id25 = 右前臂(GO_FROM_LEFT 的招車手)、
            // id60 = 左前臂(平伸的攔阻手)。用來驗證手勢方位。
            if (node.name.includes("visual_id25")) {
              runtime.kbotProbe = node;
              runtime.kbotArms.right = node;
            }
            if (node.name.includes("visual_id60")) runtime.kbotArms.left = node;
            // 手掌節點:id26 = 右手、id61 = 左手。前臂 mesh 的原點在手肘
            // 樞紐上,肘部屈伸幾乎不改變它——量「手勢幅度」一定要看手掌。
            if (node.name.includes("visual_id26")) runtime.kbotHands.right = node;
            if (node.name.includes("visual_id61")) runtime.kbotHands.left = node;
          }
        });
        // 防呆:GLB 必須含步行循環視窗(時間軸 ≥ 1143/24 s),否則多半
        // 是瀏覽器抓到舊快取(immutable ?v= 未更新)——機器人會滑行而
        // 非走路。fail-closed。
        const maxClipS = Math.max(
          ...gltf.animations.map((clip) => clip.duration),
        );
        if (maxClipS < 1143 / 24 - 0.01) {
          throw new Error(
            `KBot GLB 缺少步行循環影格(時間軸僅 ${maxClipS.toFixed(2)}s;`
            + "請強制重新整理以更新快取)",
          );
        }
        normalizeLoadedModel(model);
        runtime.kbotHolder.add(model);
        runtime.kbotAnimations = gltf.animations;
        runtime.kbotAppearance = { ...appearance, runtimeTint: "green-v1" };
        if (gltf.animations.length > 0) {
          runtime.kbotMixer = new THREE.AnimationMixer(model);
          for (const clip of gltf.animations) {
            const action = runtime.kbotMixer.clipAction(clip);
            action.play();
          }
        }
        runtime.kbotReady = true;
        refreshModelStatus();
        syncKbotPose();
        resolve();
      },
      undefined,
      (error) => {
        reject(
          new Error(
            `KBot ORCA 載入失敗；已停止，不顯示任何替代模型。${error.message ?? error}`,
          ),
        );
      },
    );
  });
}

function validateKbotAppearance(model) {
  const roleCounts = {
    body_black: 0,
    joint_graphite: 0,
    orca_black: 0,
    orca_graphite: 0,
  };
  const materialNames = new Set();
  let meshCount = 0;
  model.traverse((node) => {
    if (!node.isMesh) return;
    meshCount += 1;
    const role = node.userData.kbot_material_role;
    const profile = node.userData.kbot_appearance_profile;
    if (profile !== KBOT_APPEARANCE_PROFILE || !(role in roleCounts)) {
      throw new Error(`KBot 黑色外觀 metadata 不完整：${node.name}`);
    }
    roleCounts[role] += 1;
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material];
    for (const meshMaterial of materials) {
      if (meshMaterial?.name) materialNames.add(meshMaterial.name);
    }
  });
  const expectedRoles = {
    body_black: 17,
    joint_graphite: 11,
    orca_black: 38,
    orca_graphite: 22,
  };
  const expectedMaterials = new Set([
    "TrafficDirector_KBot_MatteBlackShell",
    "TrafficDirector_KBot_BlackJointMetal",
    "TrafficDirector_KBot_ORCABlack",
    "TrafficDirector_KBot_ORCAGraphite",
  ]);
  const rolesMatch = Object.entries(expectedRoles).every(
    ([role, count]) => roleCounts[role] === count,
  );
  const materialsMatch = (
    materialNames.size === expectedMaterials.size
    && [...expectedMaterials].every((name) => materialNames.has(name))
  );
  if (meshCount !== 88 || !rolesMatch || !materialsMatch) {
    throw new Error(
      `KBot 黑色外觀驗證失敗：mesh=${meshCount}, roles=${JSON.stringify(roleCounts)}, materials=${[...materialNames].join(",")}`,
    );
  }
  return {
    valid: true,
    profile: KBOT_APPEARANCE_PROFILE,
    meshCount,
    roleCounts,
    materialNames: [...materialNames].sort(),
  };
}

function loadSignalAspects() {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      SIGNAL_ASPECTS_URL,
      (gltf) => {
        const nodes = [];
        const headIds = new Set();
        gltf.scene.traverse((node) => {
          const aspect = node.userData.traffic_director_signal_aspect;
          const headId = node.userData.traffic_director_signal_head_id;
          const kind = node.userData.traffic_director_signal_kind;
          const movement = node.userData.traffic_director_signal_movement;
          if (!aspect) return;
          if (!headId || !kind || !movement) {
            throw new Error(`實景號誌 metadata 不完整：${node.name}`);
          }
          node.visible = false;
          nodes.push(node);
          headIds.add(headId);
        });
        const hasWalk = nodes.some(
          (node) => node.userData.traffic_director_signal_aspect === "walk",
        );
        if (nodes.length < 80 || headIds.size !== 13 || !hasWalk) {
          throw new Error(
            `實景號誌資產不完整：aspect=${nodes.length}, head=${headIds.size}`,
          );
        }
        runtime.signalAspects = gltf.scene;
        runtime.signalAspects.name = "Canonical_V54_Live_Signal_Aspects";
        runtime.signalAspectNodes = nodes;
        runtime.signalHeadCount = headIds.size;
        scene.add(runtime.signalAspects);
        runtime.signalsReady = true;
        syncSignalAspects();
        refreshModelStatus();
        resolve();
      },
      undefined,
      (error) => {
        reject(
          new Error(
            `V54 實景號誌載入失敗；控制保持全停。${error.message ?? error}`,
          ),
        );
      },
    );
  });
}

function applyRenderProfile(profileId) {
  runtime.renderProfile = RENDER_PROFILES[profileId]
    ?? RENDER_PROFILES.performance;
  runtime.renderStats.targetFps = runtime.renderProfile.targetFps;
  if (renderer) {
    renderer.setPixelRatio(Math.min(
      devicePixelRatio,
      runtime.renderProfile.maxPixelRatio,
    ));
    renderer.setSize(ui.scene.clientWidth, ui.scene.clientHeight);
  }
  refreshModelStatus();
}

function setModelStatus(mode, text) {
  const dot = ui.modelStatus.querySelector(".status-dot");
  dot.classList.remove("is-loading", "is-error");
  if (mode === "loading") dot.classList.add("is-loading");
  if (mode === "error") dot.classList.add("is-error");
  ui.modelStatus.querySelector("span:last-child").textContent = text;
}

function registerPart(group, mesh, name, castShadow = true) {
  mesh.name = name;
  mesh.userData.actorPart = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  group.userData.visualParts.push(name);
  group.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// §17 車輛/行人擬物化幾何。
//
// 設計前提來自效能稽核:瓶頸是 draw call(實測 1.36 µs/call 共用材質、
// 1.85 µs/call 獨立材質),三角形在這個規模下近乎免費(≤ 0.7 µs/千面)。
// 所以擬物化的做法是「面數放開、零件數收斂」:
//
//   * 每台車的靜態零件在 module 內先依 (type, bodyVariant, riderVariant)
//     合併成最多 4 份 BufferGeometry —— 車身色(逐車換材質)、trim(金屬/
//     塑件/騎士)、glass(玻璃)、lamp(燈),同型同版的車完全共用同一份。
//   * trim / glass / lamp / wheel 一律用頂點色,全域各只有一份材質。
//   * 只有車輪維持獨立 mesh(要繞軸轉),幾何依 (kind, radius, width) 快取。
//   * 接地陰影共用一份 CircleGeometry + 一份材質。
//
// 結果:car 16 → 9、bus 28 → 9、scooter/motorcycle 17 → 7、bicycle 20 → 7、
// pedestrian 11~12 → 6 個 draw call。
// ---------------------------------------------------------------------------

const actorGeometryCache = new Map();
const sharedActorMaterials = new Map();

const _pieceMatrix = new THREE.Matrix4();
const _pieceQuaternion = new THREE.Quaternion();
const _pieceEuler = new THREE.Euler();
const _piecePosition = new THREE.Vector3();
const _pieceScale = new THREE.Vector3();

function sharedMaterial(key, build) {
  if (!sharedActorMaterials.has(key)) {
    const value = build();
    value.userData.sharedRuntimeResource = true;
    sharedActorMaterials.set(key, value);
  }
  return sharedActorMaterials.get(key);
}

// 頂點色材質:金屬/塑件/騎士等所有非車身色的實體零件共用這一份。
function trimMaterial() {
  return sharedMaterial("trim", () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.18,
  }));
}

function glassMaterial() {
  return sharedMaterial("glass", () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.08,
    metalness: 0.4,
  }));
}

// 燈具:自發光,用 MeshBasicMaterial + 頂點色即可,一份材質吃所有顏色。
function lampMaterial() {
  return sharedMaterial("lamp", () => new THREE.MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
  }));
}

function wheelMaterial() {
  return sharedMaterial("wheel", () => new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.74,
    metalness: 0.25,
  }));
}

function actorShadowMaterial() {
  return sharedMaterial("actor-shadow", () => new THREE.MeshBasicMaterial({
    color: 0x030608,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
}

function actorShadowGeometry() {
  const key = "shadow-disc";
  if (!actorGeometryCache.has(key)) {
    const geometry = new THREE.CircleGeometry(0.5, 20);
    geometry.userData.sharedRuntimeResource = true;
    actorGeometryCache.set(key, geometry);
  }
  return actorGeometryCache.get(key);
}

function actorShadow(group, length, width) {
  const shadow = new THREE.Mesh(actorShadowGeometry(), actorShadowMaterial());
  shadow.name = "ground-shadow";
  shadow.scale.set(length, width, 1);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.018;
  shadow.renderOrder = 1;
  group.add(shadow);
}

function paintGeometry(geometry, color) {
  const tint = new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    colors[index * 3] = tint.r;
    colors[index * 3 + 1] = tint.g;
    colors[index * 3 + 2] = tint.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function placeGeometry(geometry, options) {
  const [px, py, pz] = options.at ?? [0, 0, 0];
  const [rx, ry, rz] = options.rot ?? [0, 0, 0];
  const scale = options.scale ?? 1;
  const [sx, sy, sz] = Array.isArray(scale) ? scale : [scale, scale, scale];
  _pieceEuler.set(rx, ry, rz);
  _pieceMatrix.compose(
    _piecePosition.set(px, py, pz),
    _pieceQuaternion.setFromEuler(_pieceEuler),
    _pieceScale.set(sx, sy, sz),
  );
  geometry.applyMatrix4(_pieceMatrix);
  return geometry;
}

// bucket 內的幾何必須有一致的屬性集合:body 桶永遠不帶頂點色(用實色
// 材質逐車換色),其餘三桶永遠帶頂點色。
function addBody(bucket, geometry, options = {}) {
  bucket.push(placeGeometry(geometry, options));
  return geometry;
}

function addPainted(bucket, geometry, color, options = {}) {
  placeGeometry(geometry, options);
  paintGeometry(geometry, color);
  bucket.push(geometry);
  return geometry;
}

function mergeBucket(bucket) {
  if (bucket.length === 0) return null;
  const merged = mergeGeometries(bucket, false);
  for (const geometry of bucket) geometry.dispose();
  if (!merged) throw new Error("actor 幾何合併失敗(屬性集合不一致)");
  merged.userData.sharedRuntimeResource = true;
  return merged;
}

// 上窄下寬 / 前後偏移的箱體:用來做車頭斜度、A 柱傾角、車頂收邊。
function taperBox(width, height, depth, shape = {}) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const position = geometry.attributes.position;
  const topX = shape.topX ?? 1;
  const topZ = shape.topZ ?? 1;
  const bottomX = shape.bottomX ?? 1;
  const bottomZ = shape.bottomZ ?? 1;
  const topShift = shape.topShift ?? 0;
  const bottomShift = shape.bottomShift ?? 0;
  for (let index = 0; index < position.count; index += 1) {
    const upper = position.getY(index) > 0;
    position.setX(
      index,
      position.getX(index) * (upper ? topX : bottomX)
        + (upper ? topShift : bottomShift),
    );
    position.setZ(index, position.getZ(index) * (upper ? topZ : bottomZ));
  }
  geometry.computeVertexNormals();
  return geometry;
}

// 兩點之間的圓管(車架、前叉、四肢)。
function tubeGeometry(bucket, from, to, radius, color, segments = 7) {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.clone().normalize(),
  );
  const matrix = new THREE.Matrix4().compose(
    start.clone().add(end).multiplyScalar(0.5),
    quaternion,
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(matrix);
  paintGeometry(geometry, color);
  bucket.push(geometry);
  return geometry;
}

// ---------------------------------------------------------------------------
// 車輪:輪胎 + 輪圈 + 輪心 + 輻條。輪面在 XY 平面、軸沿 Z(pivot 繞 z 轉)。
let TYRE_COLOR = 0x14181b;
let RIM_COLOR = 0xa9b1b6;
let HUB_COLOR = 0x6f777c;

function wheelGeometry(kind, radius, width) {
  const key = `wheel:${kind}:${radius.toFixed(3)}:${width.toFixed(3)}`;
  if (actorGeometryCache.has(key)) return actorGeometryCache.get(key);
  const bucket = [];
  if (kind === "spoked") {
    // 自行車:細胎 + 鋼絲輻條感。
    addPainted(bucket, new THREE.TorusGeometry(radius * 0.93, radius * 0.062, 6, 20), TYRE_COLOR);
    addPainted(bucket, new THREE.TorusGeometry(radius * 0.83, radius * 0.030, 5, 20), RIM_COLOR);
    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2;
      addPainted(
        bucket,
        new THREE.CylinderGeometry(radius * 0.014, radius * 0.014, radius * 0.80, 4),
        RIM_COLOR,
        {
          at: [-Math.sin(angle) * radius * 0.41, Math.cos(angle) * radius * 0.41, 0],
          rot: [0, 0, angle],
        },
      );
    }
    addPainted(bucket, new THREE.CylinderGeometry(radius * 0.09, radius * 0.09, width * 2.2, 8), HUB_COLOR, {
      rot: [Math.PI / 2, 0, 0],
    });
  } else if (kind === "moto") {
    // 機車:胖胎 + 五爪鋁圈。
    addPainted(bucket, new THREE.TorusGeometry(radius * 0.88, radius * 0.19, 8, 20), TYRE_COLOR);
    addPainted(bucket, new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, width * 0.62, 16), RIM_COLOR, {
      rot: [Math.PI / 2, 0, 0],
    });
    addPainted(bucket, new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, width * 1.25, 8), HUB_COLOR, {
      rot: [Math.PI / 2, 0, 0],
    });
    for (let index = 0; index < 5; index += 1) {
      const angle = (index / 5) * Math.PI * 2;
      addPainted(bucket, new THREE.BoxGeometry(radius * 0.13, radius * 0.55, width * 0.68), RIM_COLOR, {
        at: [-Math.sin(angle) * radius * 0.36, Math.cos(angle) * radius * 0.36, 0],
        rot: [0, 0, angle],
      });
    }
  } else {
    // 汽車/公車:實心胎 + 輪圈 + 五爪。dual = 後軸雙輪。
    const offsets = kind === "dual" ? [-width * 0.56, width * 0.56] : [0];
    for (const offset of offsets) {
      addPainted(bucket, new THREE.CylinderGeometry(radius, radius, width, 16), TYRE_COLOR, {
        at: [0, 0, offset],
        rot: [Math.PI / 2, 0, 0],
      });
      addPainted(bucket, new THREE.CylinderGeometry(radius * 0.63, radius * 0.63, width * 1.03, 14), RIM_COLOR, {
        at: [0, 0, offset],
        rot: [Math.PI / 2, 0, 0],
      });
      addPainted(bucket, new THREE.CylinderGeometry(radius * 0.19, radius * 0.19, width * 1.1, 8), HUB_COLOR, {
        at: [0, 0, offset],
        rot: [Math.PI / 2, 0, 0],
      });
      for (let index = 0; index < 5; index += 1) {
        const angle = (index / 5) * Math.PI * 2;
        addPainted(bucket, new THREE.BoxGeometry(radius * 0.15, radius * 0.5, width * 1.04), RIM_COLOR, {
          at: [-Math.sin(angle) * radius * 0.32, Math.cos(angle) * radius * 0.32, offset],
          rot: [0, 0, angle],
        });
      }
    }
  }
  const merged = mergeBucket(bucket);
  actorGeometryCache.set(key, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// 騎士(合併進 trim 桶,不增加任何 draw call)。行人用的是外部 rigged
// 模型;騎士維持程序化的簡化版,但改成有肘/膝分節、依車種調整前傾角。
const RIDER_CLOTHING = [
  0x2d4f74, 0x8a3a34, 0x2f6349, 0x54406e, 0x2b3440, 0xa06a2c, 0x3c6a72, 0x6b3550,
];
const RIDER_TROUSERS = [0x22303c, 0x2c2f36, 0x38414c, 0x1f2933];
const RIDER_SKIN = [0xd9a87f, 0xc08f68, 0xe3bc98, 0xa9764f];
const HELMET_COLORS = [0xe9ecea, 0xe0a83a, 0x3f6fa4, 0xc2503f, 0x2a2f33, 0xd8d2c4];

function addRider(bucket, style, variant, layout) {
  const clothing = RIDER_CLOTHING[variant % RIDER_CLOTHING.length];
  const trousers = RIDER_TROUSERS[variant % RIDER_TROUSERS.length];
  const skin = RIDER_SKIN[variant % RIDER_SKIN.length];
  const helmetColor = HELMET_COLORS[variant % HELMET_COLORS.length];
  const lean = layout.lean;
  const seat = layout.seat;
  const handle = layout.handle;
  const foot = layout.foot;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  // 軀幹沿傾角往前上方延伸。
  const torsoLength = 0.56;
  const hipY = seat[1] + 0.10;
  const shoulder = [
    seat[0] + sin * torsoLength,
    hipY + cos * torsoLength,
  ];

  const hips = taperBox(0.34, 0.20, 0.36, { topZ: 0.92 });
  addPainted(bucket, hips, trousers, { at: [seat[0], hipY - 0.04, 0], rot: [0, 0, -lean * 0.4] });

  const torso = taperBox(0.34, torsoLength, 0.40, { topX: 0.88, topZ: 0.86 });
  addPainted(bucket, torso, clothing, {
    at: [(seat[0] + shoulder[0]) / 2, (hipY + shoulder[1]) / 2, 0],
    rot: [0, 0, -lean],
  });

  const neckY = shoulder[1] + 0.09;
  addPainted(bucket, new THREE.CylinderGeometry(0.055, 0.06, 0.10, 8), skin, {
    at: [shoulder[0] + sin * 0.09, neckY, 0],
  });
  const headX = shoulder[0] + sin * 0.14 + 0.02;
  const headY = neckY + 0.11;
  addPainted(bucket, new THREE.SphereGeometry(0.105, 12, 9), skin, {
    at: [headX, headY, 0],
    scale: [1.05, 1.12, 0.98],
  });
  if (style === "bicycle") {
    // 自行車:通風式安全帽(半殼 + 通風脊)。
    addPainted(
      bucket,
      new THREE.SphereGeometry(0.128, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.56),
      helmetColor,
      { at: [headX - 0.005, headY + 0.03, 0], scale: [1.18, 1.0, 1.0] },
    );
  } else {
    // 機車/速克達:全罩安全帽 + 深色鏡片。
    addPainted(bucket, new THREE.SphereGeometry(0.145, 14, 11), helmetColor, {
      at: [headX - 0.01, headY + 0.015, 0],
      scale: [1.12, 1.08, 1.0],
    });
    addPainted(bucket, taperBox(0.09, 0.09, 0.20, { topZ: 0.8 }), 0x11242e, {
      at: [headX + 0.115, headY + 0.02, 0],
      rot: [0, 0, -0.15],
    });
  }

  for (const side of [-1, 1]) {
    // 手臂:肩 → 肘 → 握把,兩段。
    const shoulderPoint = [shoulder[0] - sin * 0.06, shoulder[1] - 0.04, side * 0.17];
    const elbow = [
      (shoulderPoint[0] + handle[0]) / 2 - 0.02,
      (shoulderPoint[1] + handle[1]) / 2 - 0.07,
      side * 0.215,
    ];
    const grip = [handle[0], handle[1], side * 0.24];
    tubeGeometry(bucket, shoulderPoint, elbow, 0.052, clothing);
    tubeGeometry(bucket, elbow, grip, 0.044, style === "bicycle" ? clothing : skin);
    addPainted(bucket, new THREE.SphereGeometry(0.05, 8, 6), skin, { at: grip });

    // 腿:臀 → 膝 → 腳踏,兩段 + 鞋。
    const hipPoint = [seat[0] + 0.02, hipY - 0.06, side * 0.135];
    const knee = style === "bicycle"
      ? [seat[0] + 0.30, hipY - 0.20, side * 0.135]
      : [foot[0] + 0.24, hipY - 0.16, side * 0.16];
    const footPoint = [foot[0], foot[1] + 0.05, side * 0.165];
    tubeGeometry(bucket, hipPoint, knee, 0.075, trousers);
    tubeGeometry(bucket, knee, footPoint, 0.058, trousers);
    addPainted(bucket, taperBox(0.24, 0.075, 0.115, { topX: 0.88 }), 0x15191d, {
      at: [footPoint[0] + 0.03, footPoint[1] - 0.05, footPoint[2]],
    });
  }
}

// ---------------------------------------------------------------------------
// 汽車:引擎蓋斜度、A 柱與擋風玻璃、四個有輪圈的輪子、後視鏡、
// 頭燈(暖白)/尾燈(紅)。
const CAR_PROFILES = [
  { length: 4.16, width: 1.72, wheelbase: 2.52, roof: 1.70, roofHeight: 0.50, tail: "hatch" },
  { length: 4.42, width: 1.78, wheelbase: 2.64, roof: 1.90, roofHeight: 0.52, tail: "sedan" },
  { length: 4.58, width: 1.86, wheelbase: 2.72, roof: 2.08, roofHeight: 0.64, tail: "wagon" },
  { length: 4.48, width: 1.79, wheelbase: 2.68, roof: 1.84, roofHeight: 0.48, tail: "sedan" },
];

function buildCar(variant) {
  const profile = CAR_PROFILES[variant % CAR_PROFILES.length];
  const { length, width, wheelbase, roof, roofHeight, tail } = profile;
  const body = [];
  const trim = [];
  const glass = [];
  const lamp = [];
  const half = length / 2;
  const beltline = 0.94;
  const cabinX = -length * 0.06;
  const cabinFront = cabinX + roof * 0.5;
  const cabinRear = cabinX - roof * 0.5;

  // 下半身(門檻 + 側裙,底部略收)。
  addBody(body, taperBox(length, 0.36, width, { bottomX: 0.985, bottomZ: 0.93 }), {
    at: [0, 0.48, 0],
  });
  // 上半身(肩線,往上略收 = tumblehome)。
  addBody(body, taperBox(length * 0.995, 0.34, width, { topX: 0.975, topZ: 0.955 }), {
    at: [0, 0.79, 0],
  });
  // 引擎蓋:向前下傾。
  addBody(body, taperBox(length * 0.30, 0.13, width * 0.93, { topX: 0.90 }), {
    at: [half - length * 0.16, 0.98, 0],
    rot: [0, 0, 0.055],
  });
  // 行李廂蓋 / 尾門。
  if (tail === "sedan") {
    addBody(body, taperBox(length * 0.22, 0.12, width * 0.92, { topX: 0.92 }), {
      at: [-half + length * 0.12, 0.99, 0],
      rot: [0, 0, -0.03],
    });
  }
  // 車室:上收 + 前後縮 = A 柱與 C 柱傾角。
  addBody(body, taperBox(roof, roofHeight, width * 0.92, { topX: 0.74, topZ: 0.86 }), {
    at: [cabinX, 0.96 + roofHeight * 0.5, 0],
  });
  if (tail === "wagon") {
    addBody(body, taperBox(length * 0.20, roofHeight * 0.92, width * 0.88, { topX: 0.9, topZ: 0.9 }), {
      at: [cabinRear - length * 0.07, 0.96 + roofHeight * 0.46, 0],
    });
  }

  // 擋風玻璃(後傾)與後窗。
  addPainted(glass, taperBox(0.06, roofHeight * 1.02, width * 0.80, { topX: 1, topZ: 0.84 }), 0x9fc3d2, {
    at: [cabinFront + 0.10, 0.98 + roofHeight * 0.48, 0],
    rot: [0, 0, 0.44],
  });
  addPainted(glass, taperBox(0.05, roofHeight * 0.94, width * 0.78, { topZ: 0.86 }), 0x9fc3d2, {
    at: [cabinRear - (tail === "wagon" ? 0.16 : 0.08), 0.98 + roofHeight * 0.48, 0],
    rot: [0, 0, tail === "wagon" ? -0.16 : -0.40],
  });
  // 側窗:前後各一片,中間留 B 柱。
  for (const side of [-1, 1]) {
    addPainted(glass, taperBox(roof * 0.40, roofHeight * 0.62, 0.03, { topX: 0.80 }), 0x8ab2c4, {
      at: [cabinX + roof * 0.21, 0.99 + roofHeight * 0.48, side * width * 0.451],
    });
    addPainted(glass, taperBox(roof * 0.34, roofHeight * 0.58, 0.03, { topX: 0.80 }), 0x8ab2c4, {
      at: [cabinX - roof * 0.22, 0.99 + roofHeight * 0.46, side * width * 0.451],
    });
  }

  // 保險桿、水箱罩、側裙飾條。
  addPainted(trim, taperBox(0.16, 0.30, width * 0.99, { topZ: 0.98 }), 0x2c333a, {
    at: [half - 0.02, 0.52, 0],
  });
  addPainted(trim, taperBox(0.16, 0.30, width * 0.99, { topZ: 0.98 }), 0x2c333a, {
    at: [-half + 0.02, 0.52, 0],
  });
  addPainted(trim, new THREE.BoxGeometry(0.05, 0.16, width * 0.52), 0x1a2026, {
    at: [half + 0.01, 0.76, 0],
  });
  for (const side of [-1, 1]) {
    addPainted(trim, new THREE.BoxGeometry(length * 0.66, 0.05, 0.05), 0x252c33, {
      at: [-length * 0.02, 0.94, side * width * 0.5],
    });
    // 後視鏡:短支架 + 鏡殼。
    addPainted(trim, new THREE.BoxGeometry(0.10, 0.045, 0.10), 0x2b3239, {
      at: [cabinFront + 0.02, 1.00, side * width * 0.52],
    });
    addPainted(trim, taperBox(0.09, 0.12, 0.05, { topX: 0.8 }), 0x2b3239, {
      at: [cabinFront + 0.02, 1.03, side * width * 0.575],
      rot: [0, 0, 0.1],
    });
    // 輪拱襯。
    for (const wheelX of [wheelbase * 0.5, -wheelbase * 0.5]) {
      addPainted(trim, new THREE.TorusGeometry(0.40, 0.045, 4, 10, Math.PI), 0x1c2126, {
        at: [wheelX, 0.40, side * width * 0.487],
        rot: [0, 0, 0],
      });
    }
  }
  // 車牌。
  addPainted(trim, new THREE.BoxGeometry(0.03, 0.12, 0.34), 0xe8eae4, {
    at: [-half - 0.09, 0.58, 0],
  });

  // 燈具。
  for (const side of [-1, 1]) {
    addPainted(lamp, taperBox(0.07, 0.13, width * 0.26, { topX: 0.7 }), 0xf7f1d6, {
      at: [half + 0.01, 0.82, side * width * 0.33],
    });
    addPainted(lamp, taperBox(0.06, 0.12, width * 0.24, { topX: 0.7 }), 0xd93a30, {
      at: [-half - 0.01, 0.86, side * width * 0.34],
    });
  }

  const wheelRadius = 0.33;
  return {
    body: mergeBucket(body),
    trim: mergeBucket(trim),
    glass: mergeBucket(glass),
    lamp: mergeBucket(lamp),
    wheels: [wheelbase * 0.5, -wheelbase * 0.5].flatMap((x) => (
      [-1, 1].map((side) => ({
        kind: "solid",
        x,
        y: wheelRadius + 0.02,
        z: side * width * 0.46,
        radius: wheelRadius,
        width: 0.21,
      }))
    )),
    shadow: [length * 0.94, width * 0.92],
  };
}

// ---------------------------------------------------------------------------
// 公車:車身分節(裙板 / 腰線 / 上段 / 頂蓋)、整排車窗、靠月台側車門、
// 空白路線牌(§14 清場規則:不得出現可辨識商標或真實路線號碼)。
const BUS_UPPER_COLORS = [0xe9e5d9, 0xf1efe7, 0xdde3e5, 0xefe3c6];

function buildBus(variant) {
  const length = [10.2, 10.5, 10.7, 10.9][variant % 4];
  const width = variant % 2 === 0 ? 2.42 : 2.5;
  const upperColor = BUS_UPPER_COLORS[variant % BUS_UPPER_COLORS.length];
  const body = [];
  const trim = [];
  const glass = [];
  const lamp = [];
  const half = length / 2;
  const roofY = 3.24;

  // 裙板(深色底盤)。
  addPainted(trim, taperBox(length, 0.52, width, { bottomZ: 0.9 }), 0x2b3238, {
    at: [0, 0.50, 0],
  });
  // 下段(車身色)。
  addBody(body, taperBox(length, 0.94, width, {}), { at: [0, 1.23, 0] });
  // 腰線飾帶。
  addPainted(trim, new THREE.BoxGeometry(length * 1.001, 0.11, width * 1.006), 0x1d242a, {
    at: [0, 1.76, 0],
  });
  // 上段(淺色)+ 頂蓋收邊。
  addPainted(trim, taperBox(length, 1.16, width, { topX: 0.995, topZ: 0.965 }), upperColor, {
    at: [0, 2.40, 0],
  });
  addPainted(trim, taperBox(length * 0.985, 0.26, width * 0.965, { topX: 0.975, topZ: 0.80 }), upperColor, {
    at: [0, 3.11, 0],
  });

  // 整排車窗(每側 8 片)。
  for (const side of [-1, 1]) {
    for (let index = 0; index < 8; index += 1) {
      addPainted(glass, new THREE.BoxGeometry(0.90, 0.94, 0.06), 0x1c3f4f, {
        at: [-length * 0.42 + index * (length * 0.105), 2.42, side * width * 0.5],
      });
    }
  }
  // 前擋 / 後窗。
  addPainted(glass, taperBox(0.07, 1.45, width * 0.88, { topZ: 0.94 }), 0x2a5567, {
    at: [half + 0.02, 2.30, 0],
    rot: [0, 0, 0.06],
  });
  addPainted(glass, taperBox(0.06, 1.16, width * 0.86, { topZ: 0.95 }), 0x1c3f4f, {
    at: [-half - 0.02, 2.42, 0],
    rot: [0, 0, -0.04],
  });

  // 車門:一律開在 local -z 側 —— NW 車道(direction +1、rotation.y 0)
  // 對到 t=-3.4 的月台,SE 車道(direction -1、rotation.y π)對到 t=+5.2,
  // 兩者的月台都落在 local -z。
  for (const doorX of [half - 1.55, -length * 0.10]) {
    addPainted(trim, new THREE.BoxGeometry(0.09, 1.98, 1.02), 0x27343b, {
      at: [doorX, 1.52, -width * 0.5],
    });
    addPainted(glass, new THREE.BoxGeometry(0.05, 1.30, 0.86), 0x1c3f4f, {
      at: [doorX, 1.80, -width * 0.515],
    });
    addPainted(trim, new THREE.BoxGeometry(0.06, 1.98, 0.05), 0x11171b, {
      at: [doorX, 1.52, -width * 0.53],
    });
  }

  // 空白路線牌(無號碼、無商標)+ 側面小牌。
  addPainted(lamp, new THREE.BoxGeometry(0.05, 0.30, 1.55), 0xe9a83a, {
    at: [half + 0.06, 2.98, 0],
  });
  addPainted(lamp, new THREE.BoxGeometry(0.05, 0.22, 0.85), 0xe9a83a, {
    at: [-length * 0.34, 2.70, -width * 0.51],
  });

  // 車頂空調 + 通風口。
  addPainted(trim, taperBox(2.6, 0.30, 1.36, { topX: 0.94, topZ: 0.9 }), 0xcdd2d1, {
    at: [-1.5, roofY + 0.10, 0],
  });
  addPainted(trim, taperBox(0.9, 0.18, 1.0, { topX: 0.9 }), 0xcdd2d1, {
    at: [2.4, roofY + 0.05, 0],
  });

  // 保險桿、後視鏡(公車鏡臂較長)。
  addPainted(trim, taperBox(0.22, 0.42, width * 0.99, { topZ: 0.98 }), 0x2c333a, {
    at: [half - 0.04, 0.62, 0],
  });
  addPainted(trim, taperBox(0.22, 0.42, width * 0.99, { topZ: 0.98 }), 0x2c333a, {
    at: [-half + 0.04, 0.62, 0],
  });
  for (const side of [-1, 1]) {
    tubeGeometry(
      trim,
      [half - 0.05, 2.72, side * width * 0.48],
      [half - 0.02, 2.66, side * (width * 0.5 + 0.30)],
      0.035,
      0x232a30,
    );
    addPainted(trim, taperBox(0.10, 0.46, 0.16, { topX: 0.85 }), 0x232a30, {
      at: [half - 0.02, 2.46, side * (width * 0.5 + 0.32)],
    });
  }
  addPainted(trim, new THREE.BoxGeometry(0.03, 0.14, 0.38), 0xe8eae4, {
    at: [-half - 0.12, 0.72, 0],
  });

  for (const side of [-1, 1]) {
    addPainted(lamp, taperBox(0.07, 0.20, 0.30, { topX: 0.8 }), 0xf7f1d6, {
      at: [half + 0.03, 0.98, side * width * 0.34],
    });
    addPainted(lamp, taperBox(0.06, 0.42, 0.24, { topX: 0.8 }), 0xd93a30, {
      at: [-half - 0.03, 1.06, side * width * 0.35],
    });
  }

  const wheelRadius = 0.48;
  return {
    body: mergeBucket(body),
    trim: mergeBucket(trim),
    glass: mergeBucket(glass),
    lamp: mergeBucket(lamp),
    wheels: [
      ...[-1, 1].map((side) => ({
        kind: "solid",
        x: length * 0.33,
        y: wheelRadius + 0.02,
        z: side * width * 0.43,
        radius: wheelRadius,
        width: 0.24,
      })),
      ...[-1, 1].map((side) => ({
        kind: "dual",
        x: -length * 0.30,
        y: wheelRadius + 0.02,
        z: side * width * 0.40,
        radius: wheelRadius,
        width: 0.20,
      })),
    ],
    shadow: [length * 0.95, width * 0.94],
  };
}

// ---------------------------------------------------------------------------
// 速克達:踏板穿越式車架、前護腿板、平座墊、尾箱、後照鏡。
function buildScooter(variant, riderVariant) {
  const scale = [0.95, 0.99, 1.03, 1.06][variant % 4];
  const radius = 0.255 * scale;
  const wheelbase = 1.30 * scale;
  const body = [];
  const trim = [];
  const glass = [];
  const lamp = [];
  const frontX = wheelbase * 0.5;
  const rearX = -wheelbase * 0.5;

  // 踏板 + 中央地板。
  addPainted(trim, taperBox(0.80, 0.09, 0.44, { topZ: 0.94 }), 0x272e34, {
    at: [-0.04, 0.36, 0],
  });
  // 前護腿板(向前上方傾),擋風性格是速克達最好認的輪廓。
  addBody(body, taperBox(0.22, 0.86, 0.50, { topX: 0.7, topZ: 0.74, topShift: 0.06 }), {
    at: [0.40, 0.82, 0],
    rot: [0, 0, -0.10],
  });
  // 車頭上方儀表罩。
  addBody(body, taperBox(0.26, 0.20, 0.36, { topX: 0.7, topZ: 0.8 }), {
    at: [0.50, 1.19, 0],
    rot: [0, 0, -0.18],
  });
  // 座墊下車身。
  addBody(body, taperBox(0.86, 0.40, 0.44, { topX: 0.92, topZ: 0.9, bottomX: 0.86 }), {
    at: [-0.34, 0.72, 0],
  });
  addPainted(trim, taperBox(0.66, 0.15, 0.38, { topX: 0.94, topZ: 0.92 }), 0x181d22, {
    at: [-0.30, 0.97, 0],
  });
  // 尾箱。
  addBody(body, taperBox(0.32, 0.32, 0.38, { topX: 0.88, topZ: 0.9 }), {
    at: [-0.68, 1.06, 0],
  });
  // 前土除 + 前叉。
  addPainted(trim, new THREE.TorusGeometry(radius * 1.18, 0.035, 4, 8, Math.PI * 0.5), 0x2a3138, {
    at: [frontX, radius + 0.02, 0],
    rot: [0, 0, 0.7],
  });
  for (const side of [-1, 1]) {
    tubeGeometry(
      trim,
      [0.53, 1.08, side * 0.055],
      [frontX, radius + 0.04, side * 0.075],
      0.028,
      0xb9c0c4,
    );
  }
  // 排氣管。
  tubeGeometry(trim, [-0.30, 0.36, -0.15], [-0.74, 0.40, -0.17], 0.05, 0x9aa2a6);
  // 龍頭 + 握把。
  addPainted(trim, new THREE.CylinderGeometry(0.022, 0.022, 0.60, 8), 0xbfc6c9, {
    at: [0.55, 1.14, 0],
    rot: [Math.PI / 2, 0, 0],
  });
  for (const side of [-1, 1]) {
    addPainted(trim, new THREE.CylinderGeometry(0.032, 0.032, 0.13, 8), 0x1b2126, {
      at: [0.55, 1.14, side * 0.24],
      rot: [Math.PI / 2, 0, 0],
    });
    // 後照鏡:支桿 + 鏡面。
    tubeGeometry(trim, [0.55, 1.16, side * 0.20], [0.52, 1.38, side * 0.27], 0.014, 0x2a3138);
    addPainted(glass, taperBox(0.035, 0.10, 0.15, { topX: 0.9 }), 0x93b4c2, {
      at: [0.52, 1.40, side * 0.275],
      rot: [0, 0, 0.15],
    });
  }
  // 頭燈 / 尾燈 / 車牌。
  addPainted(lamp, taperBox(0.07, 0.14, 0.30, { topX: 0.7 }), 0xf7f1cc, {
    at: [0.53, 0.98, 0],
    rot: [0, 0, -0.18],
  });
  addPainted(lamp, taperBox(0.06, 0.11, 0.24, { topX: 0.75 }), 0xd93a30, {
    at: [-0.85, 1.00, 0],
  });
  addPainted(trim, new THREE.BoxGeometry(0.02, 0.13, 0.22), 0xe8eae4, {
    at: [-0.87, 0.80, 0],
  });

  addRider(trim, "scooter", riderVariant, {
    lean: 0.06,
    seat: [-0.30, 1.05],
    handle: [0.55, 1.16],
    foot: [-0.02, 0.40],
  });

  return {
    body: mergeBucket(body),
    trim: mergeBucket(trim),
    glass: mergeBucket(glass),
    lamp: mergeBucket(lamp),
    wheels: [frontX, rearX].map((x) => ({
      kind: "moto",
      x,
      y: radius + 0.02,
      z: 0,
      radius,
      width: 0.10,
    })),
    shadow: [1.78, 0.60],
  };
}

// ---------------------------------------------------------------------------
// 重機:油箱、外露引擎、長軸距、倒立前叉、排氣管、後照鏡,騎士前傾。
function buildMotorcycle(variant, riderVariant) {
  const scale = [0.96, 1.0, 1.04, 1.07][variant % 4];
  const radius = 0.315 * scale;
  const wheelbase = 1.50 * scale;
  const body = [];
  const trim = [];
  const glass = [];
  const lamp = [];
  const frontX = wheelbase * 0.5;
  const rearX = -wheelbase * 0.5;

  // 引擎組(外露汽缸是重機與速克達最大的外型差異)。
  addPainted(trim, taperBox(0.50, 0.40, 0.42, { topX: 0.9 }), 0x272d31, {
    at: [0.0, 0.58, 0],
  });
  for (const side of [-1, 1]) {
    addPainted(trim, taperBox(0.30, 0.30, 0.18, { topX: 0.82 }), 0x8d9498, {
      at: [0.08, 0.80, side * 0.20],
      rot: [0, 0, -0.22],
    });
  }
  // 車架管。
  tubeGeometry(trim, [0.44, 1.02, 0], [-0.16, 0.86, 0], 0.036, 0x3c444a);
  tubeGeometry(trim, [-0.16, 0.86, 0], [rearX, radius + 0.06, 0], 0.032, 0x3c444a);
  tubeGeometry(trim, [-0.16, 0.86, 0], [-0.52, 1.00, 0], 0.032, 0x3c444a);

  // 油箱(車身色,重機的視覺主體)。
  addBody(body, taperBox(0.74, 0.40, 0.52, { topX: 0.74, topZ: 0.58, topShift: -0.03 }), {
    at: [0.20, 0.96, 0],
    rot: [0, 0, -0.06],
  });
  // 尾殼。
  addBody(body, taperBox(0.44, 0.24, 0.32, { topX: 0.60, topZ: 0.7, topShift: -0.05 }), {
    at: [-0.58, 1.05, 0],
    rot: [0, 0, 0.10],
  });
  // 車頭整流罩。
  addBody(body, taperBox(0.22, 0.34, 0.36, { topX: 0.68, topZ: 0.72 }), {
    at: [0.56, 1.06, 0],
    rot: [0, 0, -0.22],
  });
  addPainted(glass, taperBox(0.05, 0.22, 0.28, { topX: 0.7, topZ: 0.72 }), 0x8fb8c8, {
    at: [0.56, 1.28, 0],
    rot: [0, 0, 0.35],
  });
  // 座墊。
  addPainted(trim, taperBox(0.60, 0.13, 0.34, { topX: 0.92 }), 0x171c21, {
    at: [-0.30, 1.03, 0],
  });

  // 倒立前叉(粗上細下)+ 前土除。
  for (const side of [-1, 1]) {
    tubeGeometry(trim, [0.50, 1.12, side * 0.10], [frontX - 0.02, 0.62, side * 0.11], 0.042, 0x9aa2a6);
    tubeGeometry(trim, [frontX - 0.02, 0.62, side * 0.11], [frontX, radius + 0.02, side * 0.11], 0.030, 0x3c444a);
  }
  addPainted(trim, new THREE.TorusGeometry(radius * 1.16, 0.035, 4, 8, Math.PI * 0.5), 0x2a3138, {
    at: [frontX, radius + 0.02, 0],
    rot: [0, 0, 0.85],
  });
  // 排氣管 + 尾管。
  tubeGeometry(trim, [-0.10, 0.46, -0.14], [-0.60, 0.62, -0.19], 0.055, 0x9aa2a6);
  addPainted(trim, new THREE.CylinderGeometry(0.075, 0.065, 0.30, 10), 0x767e83, {
    at: [-0.72, 0.66, -0.20],
    rot: [0, 0, Math.PI / 2 - 0.28],
  });
  // 後搖臂。
  tubeGeometry(trim, [-0.22, 0.62, 0.09], [rearX, radius + 0.02, 0.09], 0.038, 0x8d9498);
  tubeGeometry(trim, [-0.22, 0.62, -0.09], [rearX, radius + 0.02, -0.09], 0.038, 0x8d9498);

  // 龍頭 / 握把 / 後照鏡。
  addPainted(trim, new THREE.CylinderGeometry(0.022, 0.022, 0.68, 8), 0xbfc6c9, {
    at: [0.50, 1.16, 0],
    rot: [Math.PI / 2, 0, 0],
  });
  for (const side of [-1, 1]) {
    addPainted(trim, new THREE.CylinderGeometry(0.032, 0.032, 0.13, 8), 0x1b2126, {
      at: [0.50, 1.16, side * 0.27],
      rot: [Math.PI / 2, 0, 0],
    });
    tubeGeometry(trim, [0.52, 1.18, side * 0.22], [0.50, 1.42, side * 0.30], 0.014, 0x2a3138);
    addPainted(glass, taperBox(0.035, 0.11, 0.16, { topX: 0.9 }), 0x93b4c2, {
      at: [0.50, 1.44, side * 0.305],
      rot: [0, 0, 0.15],
    });
  }
  // 圓形頭燈 + 尾燈 + 車牌。
  addPainted(lamp, new THREE.SphereGeometry(0.105, 12, 9), 0xf7f1cc, {
    at: [0.66, 1.02, 0],
    scale: [0.7, 1.0, 1.0],
  });
  addPainted(lamp, taperBox(0.06, 0.10, 0.22, { topX: 0.75 }), 0xd93a30, {
    at: [-0.80, 1.02, 0],
  });
  addPainted(trim, new THREE.BoxGeometry(0.02, 0.13, 0.22), 0xe8eae4, {
    at: [-0.80, 0.82, 0],
  });

  addRider(trim, "motorcycle", riderVariant, {
    lean: 0.30,
    seat: [-0.28, 1.10],
    handle: [0.50, 1.18],
    foot: [-0.18, 0.46],
  });

  return {
    body: mergeBucket(body),
    trim: mergeBucket(trim),
    glass: mergeBucket(glass),
    lamp: mergeBucket(lamp),
    wheels: [frontX, rearX].map((x) => ({
      kind: "moto",
      x,
      y: radius + 0.02,
      z: 0,
      radius,
      width: 0.13,
    })),
    shadow: [1.92, 0.62],
  };
}

// ---------------------------------------------------------------------------
// 自行車:車架三角(上管/下管/立管 + 後三角)、輻條輪、騎士前傾。
function buildBicycle(variant, riderVariant) {
  const scale = [0.96, 1.0, 1.03, 1.06][variant % 4];
  const radius = 0.345 * scale;
  const wheelbase = 1.06 * scale;
  const body = [];
  const trim = [];
  const glass = [];
  const lamp = [];
  const frontX = wheelbase * 0.5;
  const rearX = -wheelbase * 0.5;
  const hubY = radius + 0.02;
  const crank = [-0.03, 0.30, 0];
  const seatTop = [-0.20, 0.94, 0];
  const headTop = [0.36, 1.00, 0];
  const headBottom = [0.40, 0.72, 0];

  // 主三角(車身色)+ 後三角。
  const frameTubes = [
    [crank, headBottom, 0.026],
    [crank, seatTop, 0.024],
    [seatTop, headTop, 0.024],
    [headTop, headBottom, 0.028],
    [crank, [rearX, hubY, 0.045], 0.020],
    [crank, [rearX, hubY, -0.045], 0.020],
    [seatTop, [rearX, hubY, 0.045], 0.017],
    [seatTop, [rearX, hubY, -0.045], 0.017],
  ];
  for (const [from, to, tubeRadius] of frameTubes) {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(tubeRadius, tubeRadius, direction.length(), 7);
    geometry.applyMatrix4(new THREE.Matrix4().compose(
      start.clone().add(end).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize(),
      ),
      new THREE.Vector3(1, 1, 1),
    ));
    body.push(geometry);
  }
  // 前叉 + 立管。
  for (const side of [-1, 1]) {
    tubeGeometry(trim, [0.40, 0.72, side * 0.03], [frontX, hubY, side * 0.05], 0.018, 0xc4cacd);
  }
  tubeGeometry(trim, [0.36, 0.98, 0], [0.42, 1.06, 0], 0.020, 0xc4cacd);
  // 座管 + 座墊。
  tubeGeometry(trim, seatTop, [-0.22, 1.02, 0], 0.018, 0x2a3138);
  addPainted(trim, taperBox(0.26, 0.06, 0.13, { topX: 0.86, topZ: 0.7 }), 0x171c21, {
    at: [-0.23, 1.06, 0],
    rot: [0, 0, -0.06],
  });
  // 把手(平把 + 握把)。
  addPainted(trim, new THREE.CylinderGeometry(0.017, 0.017, 0.48, 8), 0x2a3138, {
    at: [0.42, 1.08, 0],
    rot: [Math.PI / 2, 0, 0],
  });
  for (const side of [-1, 1]) {
    addPainted(trim, new THREE.CylinderGeometry(0.026, 0.026, 0.11, 8), 0x171c21, {
      at: [0.42, 1.08, side * 0.20],
      rot: [Math.PI / 2, 0, 0],
    });
  }
  // 大盤 + 曲柄 + 踏板 + 鏈條感。
  addPainted(trim, new THREE.CylinderGeometry(0.10, 0.10, 0.014, 12), 0xb9c0c4, {
    at: [crank[0], crank[1], 0.055],
    rot: [Math.PI / 2, 0, 0],
  });
  addPainted(trim, new THREE.BoxGeometry(0.028, 0.17, 0.02), 0x8d9498, {
    at: [crank[0] + 0.05, crank[1] + 0.06, 0.075],
    rot: [0, 0, -0.5],
  });
  addPainted(trim, new THREE.BoxGeometry(0.028, 0.17, 0.02), 0x8d9498, {
    at: [crank[0] - 0.05, crank[1] - 0.06, -0.075],
    rot: [0, 0, -0.5],
  });
  addPainted(trim, new THREE.BoxGeometry(0.12, 0.02, 0.06), 0x171c21, {
    at: [crank[0] + 0.10, crank[1] + 0.12, 0.085],
  });
  addPainted(trim, new THREE.BoxGeometry(0.12, 0.02, 0.06), 0x171c21, {
    at: [crank[0] - 0.10, crank[1] - 0.12, -0.085],
  });
  // 後貨架。
  addPainted(trim, new THREE.BoxGeometry(0.30, 0.02, 0.16), 0x3c444a, {
    at: [-0.34, 0.80, 0],
  });
  // 前燈 / 尾燈。
  addPainted(lamp, new THREE.SphereGeometry(0.055, 8, 6), 0xf7f1cc, {
    at: [0.46, 0.86, 0],
  });
  addPainted(lamp, new THREE.BoxGeometry(0.04, 0.07, 0.11), 0xd93a30, {
    at: [-0.24, 0.86, 0],
  });

  addRider(trim, "bicycle", riderVariant, {
    lean: 0.42,
    seat: [-0.23, 1.12],
    handle: [0.42, 1.10],
    foot: [-0.03, 0.44],
  });

  return {
    body: mergeBucket(body),
    trim: mergeBucket(trim),
    glass: mergeBucket(glass),
    lamp: mergeBucket(lamp),
    wheels: [frontX, rearX].map((x) => ({
      kind: "spoked",
      x,
      y: hubY,
      z: 0,
      radius,
      width: 0.05,
    })),
    shadow: [1.72, 0.50],
  };
}

function vehicleBuild(type, bodyVariant, riderVariant) {
  // 汽車與公車沒有騎士,riderVariant 不得進快取鍵——否則同一款車會被
  // 建成 8 份一模一樣的幾何,reseed 幾輪之後就白吃掉一堆 GPU buffer。
  const riderKey = (type === "car" || type === "bus") ? 0 : riderVariant;
  const key = `vehicle:${type}:${bodyVariant}:${riderKey}`;
  if (actorGeometryCache.has(key)) return actorGeometryCache.get(key);
  let build;
  if (type === "bus") build = buildBus(bodyVariant);
  else if (type === "car") build = buildCar(bodyVariant);
  else if (type === "motorcycle") build = buildMotorcycle(bodyVariant, riderVariant);
  else if (type === "bicycle") build = buildBicycle(bodyVariant, riderVariant);
  else build = buildScooter(bodyVariant, riderVariant);
  for (const wheel of build.wheels) {
    wheel.geometry = wheelGeometry(wheel.kind, wheel.radius, wheel.width);
  }
  actorGeometryCache.set(key, build);
  return build;
}

// 機車待轉區標線(執行期加畫)。實景 GLB 只有實地量到的標線,巷口
// 這格待轉區是本模擬為了呈現兩段式左轉而加的,所以做成 runtime 疊加
// 物件、可隨開關隱藏,不動 canonical 場景。
function roadPaint(width, height, color, opacity) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

const HOOK_BOX_LABEL_TEXT = "機車待轉";

function hookBoxLabelTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 320;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const font = (size) => `bold ${size}px "PingFang TC", "Heiti TC", `
    + `"Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  // 依實際量到的字寬縮到框內,避免字型 fallback 時擠成一團。
  let size = 232;
  context.font = font(size);
  const maxWidth = canvas.width * 0.94;
  const measured = context.measureText(HOOK_BOX_LABEL_TEXT).width;
  if (measured > maxWidth) {
    size = Math.floor(size * (maxWidth / measured));
    context.font = font(size);
  }
  context.fillStyle = "#eef4ef";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    HOOK_BOX_LABEL_TEXT,
    canvas.width / 2,
    canvas.height / 2 + size * 0.04,
  );
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildHookTurnBox() {
  const group = new THREE.Group();
  group.name = "Runtime_MotorcycleHookTurnBox";
  const width = HOOK_BOX.halfS * 2;
  const depth = HOOK_BOX.halfT * 2;

  const fill = roadPaint(width, depth, 0x14432f, 0.42);
  fill.position.y = 0.011;
  group.add(fill);

  const stroke = 0.16;
  for (const [w, d, ds, dt] of [
    [width, stroke, 0, HOOK_BOX.halfT - stroke / 2],
    [width, stroke, 0, -(HOOK_BOX.halfT - stroke / 2)],
    [stroke, depth, HOOK_BOX.halfS - stroke / 2, 0],
    [stroke, depth, -(HOOK_BOX.halfS - stroke / 2), 0],
  ]) {
    const bar = roadPaint(w, d, 0xf3f6f1, 0.95);
    bar.position.set(ds, 0.013, dt);
    group.add(bar);
  }

  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(2.24, 0.70),
    new THREE.MeshBasicMaterial({
      map: hookBoxLabelTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  // 平面法線朝上(看正面),搭配 simulationRoot 的 z 鏡射,字才是正的。
  label.rotation.x = Math.PI / 2;
  label.position.set(-0.42, 0.015, 0);
  group.add(label);

  // 起步方向箭頭(+s):停等的機車綠燈後往西北向車道走。
  const arrow = new THREE.Group();
  const shaft = roadPaint(1.15, 0.15, 0xf3f6f1, 0.95);
  shaft.position.set(0, 0.014, 0);
  arrow.add(shaft);
  for (const sign of [-1, 1]) {
    const head = roadPaint(0.62, 0.15, 0xf3f6f1, 0.95);
    head.position.set(0.42, 0.014, sign * 0.2);
    head.rotation.z = sign * 0.62;
    arrow.add(head);
  }
  arrow.position.set(HOOK_BOX.halfS - 0.72, 0, 0);
  group.add(arrow);

  group.position.set(HOOK_BOX.s, 0, HOOK_BOX.t);
  return group;
}

function actorMesh(type, color, appearance) {
  const group = new THREE.Group();
  group.name = `runtime-${type}`;
  group.userData.actorType = type;
  group.userData.visualParts = [];
  group.userData.wheels = [];
  const build = vehicleBuild(
    type,
    appearance.bodyVariantId ?? 0,
    appearance.riderVariantId ?? 0,
  );
  if (build.body) {
    registerPart(
      group,
      new THREE.Mesh(build.body, material(color, 0.42, 0.2)),
      `${type}-body`,
    );
  }
  if (build.trim) {
    registerPart(
      group,
      new THREE.Mesh(build.trim, trimMaterial()),
      `${type}-trim`,
    );
  }
  if (build.glass) {
    registerPart(
      group,
      new THREE.Mesh(build.glass, glassMaterial()),
      `${type}-glass`,
      false,
    );
  }
  if (build.lamp) {
    registerPart(
      group,
      new THREE.Mesh(build.lamp, lampMaterial()),
      `${type}-lights`,
      false,
    );
  }
  for (const wheel of build.wheels) {
    const pivot = new THREE.Group();
    pivot.name = "wheel-pivot";
    pivot.position.set(wheel.x, wheel.y, wheel.z);
    const mesh = new THREE.Mesh(wheel.geometry, wheelMaterial());
    mesh.name = `${type}-wheel`;
    mesh.userData.actorPart = mesh.name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    group.add(pivot);
    group.userData.visualParts.push(mesh.name);
    group.userData.wheels.push({ pivot, radius: wheel.radius });
  }
  actorShadow(group, build.shadow[0], build.shadow[1]);
  return group;
}

// ---------------------------------------------------------------------------
// 行人:外部 rigged 模型(viewer/models/pedestrian_walker.glb,CC-BY-4.0,
// 由 Khronos glTF-Sample-Assets 的 Cesium Man 改作 —— 商標貼圖已移除、
// 依身體部位切成 5 個材質、Walk 修成 2.000 s 無縫循環、Idle 為合成中性
// 站姿。授權與來源記錄見 viewer/models/ASSETS.md)。
//
// 共用:所有人共用同一份 BufferGeometry(SkeletonUtils.clone 只複製骨架
// 與節點),材質逐人 clone 才能換衣服顏色;同一人的 5 個 SkinnedMesh 併
// 回同一個 Skeleton,骨骼矩陣貼圖由 5 份降為 1 份。
const PEDESTRIAN_MODEL_URL = "models/pedestrian_walker.glb?v=5df69332";
let PEDESTRIAN_MODEL_HEIGHT_M = 1.5066;
// 實測:踩地腳相對根部的後退速度 = 0.754 m/s @ timeScale 1。走路動畫
// 的 timeScale 必須除以它,腳才不會打滑。
let PEDESTRIAN_WALK_CYCLE_MPS = 0.754;
const PEDESTRIAN_PART_NAMES = Object.freeze({
  PedSkin: "pedestrian-head",
  PedHair: "pedestrian-hair",
  PedShirt: "pedestrian-torso",
  PedPants: "pedestrian-hips",
  PedShoes: "pedestrian-shoe",
});
// 整套穿搭而非各部位獨立亂數,避免出現螢光綠上衣配桃紅褲子。
const PEDESTRIAN_OUTFITS = Object.freeze([
  { PedShirt: 0x4a6fb5, PedPants: 0x2b3038, PedShoes: 0x17181c },
  { PedShirt: 0xb2534a, PedPants: 0x3b4a63, PedShoes: 0x2a2320 },
  { PedShirt: 0xe6e4dc, PedPants: 0x24303f, PedShoes: 0xc8c4bc },
  { PedShirt: 0x2f6b5c, PedPants: 0x2f3542, PedShoes: 0x1d2126 },
  { PedShirt: 0x6d5a86, PedPants: 0x3a3f48, PedShoes: 0x23252a },
  { PedShirt: 0x2c3a4c, PedPants: 0x4a4f58, PedShoes: 0x1a1c20 },
  { PedShirt: 0xc8973c, PedPants: 0x2c3138, PedShoes: 0x2b2521 },
  { PedShirt: 0x9aa4ae, PedPants: 0x272d35, PedShoes: 0x191b1f },
]);
const PEDESTRIAN_SKINS = Object.freeze([0xdcb08c, 0xc08f68, 0xe6c2a0, 0xa8764f]);
const PEDESTRIAN_HAIR = Object.freeze([0x1d1512, 0x241c1a, 0x2b1d15, 0x3c2b1e]);

let pedestrianPrototype = null;
let pedestrianWalkClip = null;
let pedestrianIdleClip = null;
let pedestrianPaletted = false;

// GLB 的 5 個 primitive 共用同一份頂點屬性(POSITION/NORMAL/TEXCOORD_0/
// JOINTS_0/WEIGHTS_0 都是同一個 accessor),只有 index 不同 —— 所以可以
// 零成本併成一份 BufferGeometry:接上同樣的屬性、把 5 段 index 串起來,
// 頂點數與三角形數完全不變,draw call 由 5 降為 1。
// TEXCOORD_0 已被烘成 8 格調色盤座標(u=(區塊序號+0.5)/8,順序
// skin/hair/shirt/pants/shoes),所以合併後仍能逐部位換色。
function mergePedestrianPrimitives(parts) {
  const base = parts[0].geometry;
  const shared = parts.every((part) => (
    part.geometry.index
    && part.geometry.attributes.position === base.attributes.position
    && part.geometry.attributes.uv === base.attributes.uv
  ));
  if (!shared) return null;
  const total = parts.reduce((sum, part) => sum + part.geometry.index.count, 0);
  const indices = total > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  let cursor = 0;
  for (const part of parts) {
    indices.set(part.geometry.index.array, cursor);
    cursor += part.geometry.index.count;
  }
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(base.attributes)) {
    geometry.setAttribute(name, attribute);
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.sharedRuntimeResource = true;
  return geometry;
}

const PEDESTRIAN_PALETTE_ORDER = Object.freeze([
  "PedSkin", "PedHair", "PedShirt", "PedPants", "PedShoes",
]);

function pedestrianPaletteTexture(palette) {
  const data = new Uint8Array(8 * 4);
  for (const [slot, role] of PEDESTRIAN_PALETTE_ORDER.entries()) {
    const hex = palette[role] ?? 0xffffff;
    data[slot * 4] = (hex >> 16) & 0xff;
    data[slot * 4 + 1] = (hex >> 8) & 0xff;
    data[slot * 4 + 2] = hex & 0xff;
    data[slot * 4 + 3] = 0xff;
  }
  const texture = new THREE.DataTexture(data, 8, 1, THREE.RGBAFormat);
  // 一定要 NearestFilter,否則相鄰調色盤格會內插出髒色。
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function loadPedestrianModel() {
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
    loader.load(
      PEDESTRIAN_MODEL_URL,
      (gltf) => {
        const clips = gltf.animations ?? [];
        pedestrianWalkClip = clips.find((clip) => clip.name === "Walk")
          ?? clips[0] ?? null;
        pedestrianIdleClip = clips.find((clip) => clip.name === "Idle")
          ?? pedestrianWalkClip;
        if (!pedestrianWalkClip) {
          console.warn("行人模型缺少動畫,改用程序化行人。");
          resolve();
          return;
        }
        const parts = [];
        gltf.scene.traverse((node) => {
          if (node.isSkinnedMesh) parts.push(node);
        });
        const merged = parts.length > 1
          ? mergePedestrianPrimitives(parts)
          : null;
        if (merged) {
          const host = parts[0];
          const single = new THREE.SkinnedMesh(
            merged,
            new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 }),
          );
          single.name = "PedestrianBody";
          single.position.copy(host.position);
          single.quaternion.copy(host.quaternion);
          single.scale.copy(host.scale);
          single.bindMode = host.bindMode;
          host.parent.add(single);
          single.bind(host.skeleton, host.bindMatrix);
          for (const part of parts) part.removeFromParent();
          pedestrianPaletted = true;
        }
        gltf.scene.traverse((node) => {
          if (node.isSkinnedMesh) {
            node.castShadow = LOW_LOAD_RENDER_PROFILE.shadows;
            node.receiveShadow = true;
            // 蒙皮後的包圍盒會超出 bind pose,關掉視錐剔除避免近距離消失。
            node.frustumCulled = false;
            // 幾何是全體行人共用的原型,reseed 時 clearActors 不得 dispose。
            node.geometry.userData.sharedRuntimeResource = true;
          }
        });
        pedestrianPrototype = gltf.scene;
        resolve();
      },
      undefined,
      (error) => {
        console.warn(
          `行人模型載入失敗,改用程序化行人:${error?.message ?? error}`,
        );
        resolve();
      },
    );
  });
}

// 由 spawn 序號決定身形,不動 runtime 的 mulberry32 亂數串流(動了會讓
// 既有驗收腳本裡的車輛/行人配置整批位移)。
function pedestrianVariantHash(index, salt) {
  let value = (index + 1) * 2654435761 + salt * 40503;
  value ^= value >>> 13;
  value = (value * 1274126177) >>> 0;
  return (value >>> 8) / 0x1000000;
}

function skinnedPedestrianMesh(index, colorIndex) {
  const group = new THREE.Group();
  group.name = "runtime-pedestrian";
  group.userData.actorType = "pedestrian";
  group.userData.visualParts = [];
  group.userData.wheels = [];
  const model = skeletonClone(pedestrianPrototype);
  const parts = [];
  model.traverse((node) => {
    if (node.isSkinnedMesh) parts.push(node);
  });
  // SkeletonUtils 會讓同一個人的 5 個 SkinnedMesh 各自拿到一份 Skeleton
  // wrapper(bone 陣列指向同一批 bone),導致每人上傳 5 份骨骼矩陣貼圖。
  if (parts.length > 1) {
    const skeleton = parts[0].skeleton;
    for (let i = 1; i < parts.length; i += 1) {
      parts[i].bind(skeleton, parts[i].bindMatrix);
    }
  }
  const outfit = PEDESTRIAN_OUTFITS[colorIndex % PEDESTRIAN_OUTFITS.length];
  const skin = PEDESTRIAN_SKINS[
    Math.floor(pedestrianVariantHash(index, 7) * PEDESTRIAN_SKINS.length)
      % PEDESTRIAN_SKINS.length
  ];
  const hair = PEDESTRIAN_HAIR[
    Math.floor(pedestrianVariantHash(index, 19) * PEDESTRIAN_HAIR.length)
      % PEDESTRIAN_HAIR.length
  ];
  const palette = { ...outfit, PedSkin: skin, PedHair: hair };
  if (pedestrianPaletted) {
    // 合併版:一個 SkinnedMesh + 一張 8×1 調色盤貼圖,逐人換整套穿搭。
    const part = parts[0];
    part.material = part.material.clone();
    part.material.map = pedestrianPaletteTexture(palette);
    part.material.needsUpdate = true;
    part.castShadow = true;
    part.receiveShadow = true;
    part.frustumCulled = false;
    part.name = "pedestrian-body";
    part.userData.actorPart = "pedestrian-body";
    // visualParts 保留舊詞彙:這些部位確實都在這份合併幾何裡。
    group.userData.visualParts.push(
      ...Object.values(PEDESTRIAN_PART_NAMES),
      "pedestrian-body",
    );
  } else {
    for (const part of parts) {
      const role = part.material?.name ?? "";
      part.material = part.material.clone();
      if (palette[role] != null) part.material.color.setHex(palette[role]);
      part.material.roughness = role === "PedShoes" ? 0.6 : 0.82;
      part.material.metalness = 0;
      part.castShadow = true;
      part.receiveShadow = true;
      part.frustumCulled = false;
      const name = PEDESTRIAN_PART_NAMES[role] ?? "pedestrian-body";
      part.name = name;
      part.userData.actorPart = name;
      group.userData.visualParts.push(name);
    }
  }
  // 身高 1.58 ~ 1.78 m。原模型 1.5066 m,腳底恰在 y=0。
  const height = 1.58 + pedestrianVariantHash(index, 3) * 0.20;
  model.scale.setScalar(height / PEDESTRIAN_MODEL_HEIGHT_M);
  group.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const walk = mixer.clipAction(pedestrianWalkClip);
  const idle = mixer.clipAction(pedestrianIdleClip);
  walk.play();
  idle.play();
  walk.setEffectiveWeight(0);
  idle.setEffectiveWeight(1);
  // 隨機起始相位,否則所有人會踢正步。
  walk.time = pedestrianVariantHash(index, 11) * pedestrianWalkClip.duration;
  idle.time = pedestrianVariantHash(index, 23) * pedestrianIdleClip.duration;
  group.userData.gait = { mixer, walk, idle, blend: 0 };
  group.userData.groundOffset = 0;
  actorShadow(group, 0.5, 0.32);
  return group;
}

function limb(group, name, position, length, radius, color) {
  const pivot = new THREE.Group();
  pivot.name = `${name}-pivot`;
  pivot.position.set(...position);
  const segment = cylinder(radius, length, color, 8);
  segment.position.y = -length * 0.5;
  segment.name = name;
  pivot.add(segment);
  group.add(pivot);
  group.userData.visualParts.push(name);
  return pivot;
}

// Fallback:外部模型載入失敗時才用的程序化行人(維持原本的積木人)。
function proceduralPedestrianMesh(color, variant = 0) {
  const group = new THREE.Group();
  group.name = "runtime-pedestrian";
  group.userData.actorType = "pedestrian";
  group.userData.visualParts = [];
  group.userData.wheels = [];
  const skins = [0xc98b67, 0xa96d50, 0xe0a47b];
  const skin = skins[variant % skins.length];

  const torso = box(0.43, 0.62, 0.27, color, 0.68);
  torso.position.y = 1.15;
  registerPart(group, torso, "pedestrian-torso");
  const hips = box(0.32, 0.18, 0.24, 0x1b2935, 0.78);
  hips.position.y = 0.8;
  registerPart(group, hips, "pedestrian-hips");

  const leftArm = limb(group, "pedestrian-left-arm", [-0.25, 1.42, 0], 0.57, 0.055, color);
  const rightArm = limb(group, "pedestrian-right-arm", [0.25, 1.42, 0], 0.57, 0.055, color);
  const leftLeg = limb(group, "pedestrian-left-leg", [-0.11, 0.76, 0], 0.7, 0.07, 0x182632);
  const rightLeg = limb(group, "pedestrian-right-leg", [0.11, 0.76, 0], 0.7, 0.07, 0x182632);
  for (const x of [-0.11, 0.11]) {
    const shoe = box(0.14, 0.08, 0.25, 0x11181e, 0.82);
    shoe.position.set(x, 0.06, 0.07);
    registerPart(group, shoe, "pedestrian-shoe");
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 9), material(skin, 0.72));
  head.position.y = 1.63;
  registerPart(group, head, "pedestrian-head");
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(0.195, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.52),
    material([0x1b1817, 0x33251f, 0x232b35][variant % 3], 0.82),
  );
  hair.position.y = 1.67;
  registerPart(group, hair, "pedestrian-hair", false);

  if (variant % 4 === 0) {
    const backpack = box(0.3, 0.46, 0.16, 0x314c60, 0.72);
    backpack.position.set(0, 1.16, -0.2);
    registerPart(group, backpack, "pedestrian-backpack");
  }
  actorShadow(group, 0.48, 0.3);
  group.userData.limbs = { leftArm, rightArm, leftLeg, rightLeg };
  group.userData.groundOffset = 0.08;
  return group;
}

function pedestrianMesh(index, colorIndex, fallbackColor) {
  if (pedestrianPrototype && pedestrianWalkClip) {
    return skinnedPedestrianMesh(index, colorIndex);
  }
  return proceduralPedestrianMesh(fallbackColor, colorIndex);
}

function applyPedestrianHeading(mesh, heading) {
  const yaw = {
    t_positive: 0,
    t_negative: Math.PI,
    s_positive: Math.PI / 2,
    s_negative: -Math.PI / 2,
  };
  mesh.rotation.y = yaw[heading] ?? 0;
}

function animatePedestrianMesh(pedestrian, delta) {
  const moving = [
    "sidewalk_approach",
    "crossing",
    "sidewalk_departure",
  ].includes(pedestrian.state)
    // 上車前那段沿月台走到車門的路也要有步態,否則是滑過去的。
    || (pedestrian.state === "boarding" && !pedestrian.boarded);
  const mesh = pedestrian.mesh;
  const gaitRig = mesh.userData.gait;
  if (gaitRig) {
    // 外部 rigged 模型:Walk / Idle 兩支 clip 用權重交叉淡入(0.25 s),
    // 硬切會因為 Idle 站姿比 Walk 平均高 3.5 cm 而跳動。
    const target = moving && !runtime.reducedMotion ? 1 : 0;
    const step = Math.min(1, Math.max(0, delta) / 0.25);
    gaitRig.blend += THREE.MathUtils.clamp(target - gaitRig.blend, -step, step);
    gaitRig.walk.setEffectiveWeight(gaitRig.blend);
    gaitRig.idle.setEffectiveWeight(1 - gaitRig.blend);
    // 步頻對齊移動速度,腳才不會打滑(實測循環速度 0.754 m/s)。
    gaitRig.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(
      (pedestrian.speed || 0) / PEDESTRIAN_WALK_CYCLE_MPS,
      0.4,
      2.6,
    ));
    gaitRig.mixer.update(runtime.reducedMotion ? 0 : Math.max(0, delta));
    mesh.position.y = (mesh.userData.groundOffset ?? 0)
      + (pedestrian.groundY || 0);
    return;
  }
  const gait = moving && !runtime.reducedMotion
    ? Math.sin(performance.now() * 0.008 + pedestrian.gaitOffset) * 0.52
    : 0;
  const limbs = mesh.userData.limbs;
  limbs.leftArm.rotation.x = gait;
  limbs.rightArm.rotation.x = -gait;
  limbs.leftLeg.rotation.x = -gait;
  limbs.rightLeg.rotation.x = gait;
  mesh.position.y = (mesh.userData.groundOffset ?? 0.08)
    + (pedestrian.groundY || 0)
    + (moving && !runtime.reducedMotion ? Math.abs(gait) * 0.035 : 0);
}

function recyclePedestrian(pedestrian) {
  // 到達對側後:站上該側人行道,重擲下一次穿越(直行/交錯式擇一),
  // 沿人行道走到新的路緣等待點。
  const newSide = -pedestrian.side;
  pedestrian.travelDirection *= -1;
  pedestrian.state = "sidewalk_approach";
  pedestrian.s = pedestrian.departureS;
  pedestrian.t = pedestrian.targetSidewalkT;
  // 從月台回收的人身上還帶著月台面高與上車狀態,不清掉會浮在人行道上。
  pedestrian.groundY = 0;
  pedestrian.boarded = false;
  pedestrian.boardTarget = null;
  rollPedestrianCrossing(random, pedestrian, newSide);
  pedestrian.gaitOffset = random() * Math.PI * 2;
  pedestrian.heading = pedestrian.travelDirection > 0
    ? "s_positive"
    : "s_negative";
}

function vehicleTypeCounts() {
  return Object.fromEntries(
    ["car", "scooter", "motorcycle", "bus", "bicycle"].map((type) => [
      type,
      runtime.vehicles.filter((vehicle) => vehicle.type === type).length,
    ]),
  );
}

function publishDebugState() {
  window.__trafficDirectorDebug = {
    snapshot: () => ({
      seed: Number(ui.seedLabel.textContent),
      vehicleCounts: vehicleTypeCounts(),
      vehicles: runtime.vehicles.map((vehicle) => ({
        id: vehicle.id,
        type: vehicle.type,
        route: vehicle.route,
        sideAccess: vehicle.sideAccess,
        s: vehicle.mesh.position.x,
        t: vehicle.mesh.position.z,
        bodyColorId: vehicle.bodyColorId,
        bodyVariantId: vehicle.bodyVariantId,
        riderVariantId: vehicle.riderVariantId,
        visualScale: vehicle.visualScale,
        desiredSpeed: vehicle.desiredSpeed,
        reactionDelayS: vehicle.reactionDelayS,
        spawnSlot: vehicle.spawnSlot,
        turn: vehicle.turn ?? null,
        turnState: vehicle.turnState ?? null,
        hookSlotIndex: vehicle.hookSlotIndex ?? null,
        fromLane90: Boolean(vehicle.fromLane90),
        busDwellRemaining: vehicle.busDwellRemaining ?? 0,
        busPlatform: vehicle.busPlatform ?? null,
        visualParts: [...vehicle.mesh.userData.visualParts],
      })),
      pedestrians: runtime.pedestrians.map((pedestrian) => ({
        id: pedestrian.id,
        state: pedestrian.state,
        s: pedestrian.mesh.position.x,
        t: pedestrian.mesh.position.z,
        curbS: pedestrian.curbS,
        visualParts: [...pedestrian.mesh.userData.visualParts],
      })),
      phase: runtime.currentPhaseId,
      activePhase: runtime.currentPhaseId,
      pendingPhase: runtime.command?.state === "active"
        ? null
        : runtime.command?.requestedPhaseId ?? null,
      requestedGesture: runtime.command?.requestedGesture ?? null,
      candidatePhase: runtime.command?.requestedPhaseId ?? null,
      decisionState: runtime.command?.state ?? "active",
      decisionReason: runtime.command?.reasonCode ?? "command_active",
      activeKbotGesture: runtime.rules.phases[
        runtime.kbotPosePhaseId
      ]?.gesture ?? "ALL_STOP",
      kbotPosePhase: runtime.kbotPosePhaseId,
      kbotAppearance: runtime.kbotAppearance,
      kbotMotion: {
        mixerTimeS: runtime.kbotMixer?.time ?? null,
        sampleTimeS: runtime.kbotSampleTimeS,
        gestureClockS: runtime.kbotGestureClock,
        holderYawRad: runtime.kbotHolder?.rotation.y ?? null,
        holderPosition: runtime.kbotHolder
          ? runtime.kbotHolder.position.toArray()
          : null,
        walkKind: runtime.kbotWalk.kind,
        walkEntryDone: runtime.kbotWalk.entryDone,
        robotOnRoadway: robotOnRoadway(),
        safeZone: robotSafeZone(),
        station: kbotStationLabel(),
        dutyTarget: (() => {
          const target = runtime.kbotHolder ? kbotDutyTarget() : null;
          return target ? { x: target.x, z: target.z, id: target.id ?? null } : null;
        })(),
        reducedMotion: runtime.reducedMotion,
        postPreview: runtime.kbotPostPreview,
        postEditId: runtime.kbotPostEditId,
        posts: structuredClone(KBOT_POSTS),
        probeQuaternion: runtime.kbotProbe
          ? runtime.kbotProbe.quaternion.toArray()
          : null,
      },
      crosswalkClear: !vehicleCrosswalkConflict(),
      conflictZoneClear: !intersectionConflict(),
      pedestrianConflict: pedestrianConflict(),
      downstreamClear: !runtime.downstreamBlocked,
      signalHeads: runtime.signalHeadCount,
      collisions: runtime.collisions,
      busBoardings: runtime.busBoardings,
      pedestrianStates: Object.fromEntries(
        [...runtime.pedestrians.reduce((counts, pedestrian) => {
          counts.set(pedestrian.state, (counts.get(pedestrian.state) ?? 0) + 1);
          return counts;
        }, new Map())],
      ),
      render: {
        ...runtime.renderStats,
        pixelRatio: renderer?.getPixelRatio() ?? null,
        shadows: renderer?.shadowMap.enabled ?? null,
        drawCalls: renderer?.info.render.calls ?? null,
        triangles: renderer?.info.render.triangles ?? null,
      },
    }),
    requestCommand: ({ phaseId, gesture, requestKind = "gesture" }) => {
      submitManualCommand({ phaseId, gesture, requestKind });
      return runtime.command?.state;
    },
    setDownstreamBlocked: (blocked) => {
      runtime.downstreamBlocked = Boolean(blocked);
      ui.downstreamBlocked.checked = runtime.downstreamBlocked;
      enforceActiveSafety();
      updateSafetyUi();
      return runtime.downstreamBlocked;
    },
  };
  // Read-only debug hook for browser verification of KBot motion.
  window.__kbotProbeWorldPos = () => (
    runtime.kbotProbe
      ? runtime.kbotProbe.getWorldPosition(new THREE.Vector3()).toArray()
      : null
  );
  // §18 崗位微調 hook:CDP 驗收不必操 DOM 也能改崗位/讀判定/取匯出片段。
  window.__kbotPosts = () => ({
    posts: structuredClone(KBOT_POSTS),
    defaults: structuredClone(KBOT_POSTS_DEFAULT),
    selected: runtime.kbotPostEditId,
    preview: runtime.kbotPostPreview,
    verdict: kbotPostVerdict(KBOT_POSTS[runtime.kbotPostEditId]),
  });
  window.__setKbotPost = (id, patch = {}) => {
    if (!KBOT_POST_IDS.includes(id)) throw new Error(`未知崗位:${id}`);
    for (const key of ["x", "y", "z"]) {
      if (patch[key] === undefined) continue;
      const range = KBOT_POST_RANGES[key];
      KBOT_POSTS[id][key] = Math.round(THREE.MathUtils.clamp(
        Number(patch[key]), range.min, range.max,
      ) * 100) / 100;
    }
    if (id === runtime.kbotPostEditId) syncKbotPostInputs();
    onKbotPostsChanged();
    return structuredClone(KBOT_POSTS[id]);
  };
  // 走隱藏 <select> 的 change 事件,分段按鈕的 is-active 才會一起對上
  // (與驗收腳本的 setSelect 完全同一條路徑)。
  window.__selectKbotPost = (id) => {
    if (!KBOT_POST_IDS.includes(id)) throw new Error(`未知崗位:${id}`);
    ui.kbotPostTarget.value = id;
    ui.kbotPostTarget.dispatchEvent(new Event("change", { bubbles: true }));
    return runtime.kbotPostEditId;
  };
  window.__setKbotPostPreview = (enabled) => {
    setKbotPostPreview(enabled);
    return runtime.kbotPostPreview;
  };
  window.__kbotPostExportCode = () => kbotPostExportCode();
  window.__resetKbotPosts = () => {
    resetKbotPosts();
    return structuredClone(KBOT_POSTS);
  };
  // Read-only verification hooks (SPEC_VIEWER_V2 §6).
  window.__vehicleStates = () => runtime.vehicles.map((vehicle) => ({
    id: vehicle.id,
    type: vehicle.type,
    lane_t: vehicle.mesh.position.z,
    s: vehicle.mesh.position.x,
    movement: vehicle.movement,
  }));
  window.__renderStats = () => ({
    measuredFps: runtime.renderStats.measuredFps,
    drawCalls: renderer?.info.render.calls ?? 0,
    triangles: renderer?.info.render.triangles ?? 0,
    mode: runtime.renderProfile.id,
  });
  // §17 擬物化預算稽核 hook:逐 actor 統計 mesh 數(= draw call)、三角形、
  // 共用幾何/材質數。改車輛或行人模型時用它盯住 draw call 紅線。
  window.__actorRenderAudit = () => {
    const triangleCount = (geometry) => (
      geometry.index
        ? geometry.index.count / 3
        : geometry.attributes.position.count / 3
    );
    const byType = {};
    const geometries = new Set();
    const materials = new Set();
    let meshes = 0;
    let triangles = 0;
    for (const actor of [...runtime.vehicles, ...runtime.pedestrians]) {
      const type = actor.mesh.userData.actorType;
      let actorMeshes = 0;
      let actorTriangles = 0;
      actor.mesh.traverse((node) => {
        if (!node.isMesh && !node.isSkinnedMesh) return;
        actorMeshes += 1;
        actorTriangles += triangleCount(node.geometry);
        geometries.add(node.geometry.uuid);
        materials.add(node.material.uuid);
      });
      meshes += actorMeshes;
      triangles += actorTriangles;
      const bucket = byType[type] ?? (byType[type] = {
        actors: 0,
        meshMin: Infinity, meshMax: 0, trisMin: Infinity, trisMax: 0,
      });
      bucket.actors += 1;
      bucket.meshMin = Math.min(bucket.meshMin, actorMeshes);
      bucket.meshMax = Math.max(bucket.meshMax, actorMeshes);
      bucket.trisMin = Math.min(bucket.trisMin, actorTriangles);
      bucket.trisMax = Math.max(bucket.trisMax, actorTriangles);
    }
    return {
      actors: runtime.vehicles.length + runtime.pedestrians.length,
      byType,
      actorMeshes: meshes,
      actorTriangles: triangles,
      uniqueActorGeometries: geometries.size,
      uniqueActorMaterials: materials.size,
      pedestrianModel: pedestrianPrototype ? "rigged-glb" : "procedural-fallback",
      sceneDrawCalls: renderer?.info.render.calls ?? 0,
      sceneTriangles: renderer?.info.render.triangles ?? 0,
      sceneGeometries: renderer?.info.memory.geometries ?? 0,
    };
  };
  // 手勢方位驗證 hook:兩支前臂相對於 holder 的模擬座標偏移量。
  window.__kbotArmOffsets = () => {
    if (!runtime.kbotHolder || !runtime.simulationRoot) return null;
    const inverse = new THREE.Matrix4()
      .copy(runtime.simulationRoot.matrixWorld).invert();
    const result = { yaw: runtime.kbotHolder.rotation.y };
    for (const side of ["left", "right"]) {
      const node = runtime.kbotArms[side];
      if (!node) continue;
      const point = node.getWorldPosition(new THREE.Vector3())
        .applyMatrix4(inverse);
      result[side] = [
        Number((point.x - runtime.kbotHolder.position.x).toFixed(3)),
        Number(point.y.toFixed(3)),
        Number((point.z - runtime.kbotHolder.position.z).toFixed(3)),
      ];
    }
    return result;
  };
  // 手勢幅度驗證 hook(§16):兩隻手掌相對於 holder 的模擬座標偏移量。
  // __kbotArmOffsets 讀的是前臂 mesh 原點=手肘樞紐,肘部屈伸幾乎不動它,
  // 拿來量「手勢有沒有在動」會嚴重低估;驗收請用這一支。
  window.__kbotHandOffsets = () => {
    if (!runtime.kbotHolder || !runtime.simulationRoot) return null;
    const inverse = new THREE.Matrix4()
      .copy(runtime.simulationRoot.matrixWorld).invert();
    const result = { yaw: runtime.kbotHolder.rotation.y };
    for (const side of ["left", "right"]) {
      const node = runtime.kbotHands[side];
      if (!node) continue;
      const point = node.getWorldPosition(new THREE.Vector3())
        .applyMatrix4(inverse);
      result[side] = [
        Number((point.x - runtime.kbotHolder.position.x).toFixed(3)),
        Number(point.y.toFixed(3)),
        Number((point.z - runtime.kbotHolder.position.z).toFixed(3)),
      ];
    }
    return result;
  };
  // 驗證用相機 hook(唯讀腳本操作,不影響 UI 狀態)。
  // 契約:模擬座標進、同步瞬移生效、回傳 true。錄影腳本定位完立刻截圖,
  // 因此這條路徑**永遠不套用過渡動畫**,並且會關掉跟隨(否則跟隨迴圈會在
  // 1 秒內把 target 拉走十幾公尺)。
  window.__setCamera = (position, target) => {
    cameraDirector.transition = null;
    if (cameraDirector.mode === "follow") {
      cameraDirector.mode = "orbit";
      cameraDirector.followReady = false;
      applyCameraModeConstraints();
      syncCameraModeButtons();
    }
    camera.position.copy(simulationPoint(position[0], position[1], position[2]));
    controls.target.copy(simulationPoint(target[0], target[1], target[2]));
    controls.update();
    return true;
  };
  // §20 相機系統驗證 hook。
  window.__cameraState = () => ({
    mode: cameraDirector.mode,
    projection: cameraDirector.projection,
    preset: cameraDirector.preset,
    transitioning: cameraIsTransitioning(),
    position: camera.position.toArray().map((v) => Number(v.toFixed(4))),
    target: controls.target.toArray().map((v) => Number(v.toFixed(4))),
    distance: Number(camera.position.distanceTo(controls.target).toFixed(4)),
    azimuthDeg: Number(
      THREE.MathUtils.radToDeg(cameraSpherical().theta).toFixed(3),
    ),
    polarDeg: Number(
      THREE.MathUtils.radToDeg(cameraSpherical().phi).toFixed(3),
    ),
    zoom: Number(camera.zoom.toFixed(4)),
    selection: cameraDirector.selection
      ? {
        id: cameraDirector.selection.id,
        kind: cameraDirector.selection.kind,
        label: cameraDirector.selection.label,
      }
      : null,
    blockers: cameraDirector.blockers.length,
  });
  window.__pickAt = (x, y) => {
    const hit = cameraPickAt(x, y);
    if (!hit) return null;
    selectCameraTarget(hit);
    return {
      id: hit.id,
      kind: hit.kind,
      label: hit.label,
      center: hit.center.toArray().map((v) => Number(v.toFixed(4))),
      radius: Number(hit.radius.toFixed(4)),
    };
  };
  window.__focusObject = (id, options = {}) => focusCameraOn(id, options);
  window.__frameSelected = (options = {}) => (
    cameraDirector.selection
      ? cameraFrameTarget(cameraDirector.selection, options)
      : false
  );
  window.__setCameraMode = (mode, options = {}) => setCameraMode(mode, options);
  window.__setCameraPreset = (name, options = {}) => (
    applyCameraPreset(name, options)
  );
  window.__setCameraProjection = (kind) => (
    setCameraProjection(kind, { silent: true })
  );
  // 相機是否落在任一建物包圍盒內(防穿模驗收用)。
  window.__cameraInsideBlocker = () => pointInsideBlocker(camera.position);
  // 世界座標 → 標準化裝置座標(Focus 置中驗收用)。
  window.__projectPoint = (point) => {
    const vector = new THREE.Vector3(point[0], point[1], point[2]);
    vector.project(camera);
    return [Number(vector.x.toFixed(4)), Number(vector.y.toFixed(4))];
  };
  // 巷90 轉向驗證 hook。
  window.__lane90States = () => runtime.vehicles
    .filter((vehicle) => vehicle.route === "lane90")
    .map((vehicle) => ({
      id: vehicle.id,
      type: vehicle.type,
      turn: vehicle.turn,
      state: vehicle.turnState,
      slot: vehicle.hookSlotIndex,
      s: Number(vehicle.mesh.position.x.toFixed(2)),
      t: Number(vehicle.mesh.position.z.toFixed(2)),
      sideAccess: vehicle.sideAccess,
      movement: vehicle.movement,
      speed: Number((vehicle.speed ?? 0).toFixed(2)),
    }));
  // 公車停靠驗證 hook。
  window.__busStates = () => runtime.vehicles
    .filter((vehicle) => vehicle.type === "bus")
    .map((vehicle) => ({
      id: vehicle.id,
      s: Number(vehicle.mesh.position.x.toFixed(2)),
      lane_t: Number(vehicle.mesh.position.z.toFixed(2)),
      direction: vehicle.direction,
      dwellRemaining: Number((vehicle.busDwellRemaining ?? 0).toFixed(2)),
      dwellDone: Boolean(vehicle.busDwellDone),
      platform: vehicle.busPlatform ?? null,
    }));
  // §19 參數登錄表驗證 hook。
  window.__params = () => Object.fromEntries(
    paramRegistry.defs().map((def) => [def.id, def.get()]),
  );
  window.__paramMeta = () => paramRegistry.defs().map((def) => ({
    id: def.id, group: def.group, label: def.label, unit: def.unit ?? "",
    min: def.min, max: def.max, step: def.step, apply: def.apply,
    kind: def.kind ?? "number", calib: Boolean(def.calib),
    value: def.get(), default: paramRegistry.defaultOf(def.id),
    dirty: paramRegistry.isDirty(def.id),
  }));
  window.__setParam = (id, value) => {
    const applied = paramRegistry.set(id, value);
    if (applied === null) throw new Error(`未知參數:${id}`);
    paramRegistry.save();
    syncParamRow(id);
    updateParamSummary();
    return applied;
  };
  window.__resetParams = () => {
    paramRegistry.resetAll();
    paramRegistry.clearSaved();
    syncAllParamRows();
    return paramRegistry.dirtyIds().length;
  };
  window.__paramCode = () => paramRegistry.toCodeSnippet();
  // 亮度參數是直接寫到 renderer/light 上的,要有探針才驗得到。
  window.__lightingProbe = () => ({
    exposure: renderer?.toneMappingExposure ?? null,
    hemisphere: runtime.hemiLight?.intensity ?? null,
    sun: runtime.sunLight?.intensity ?? null,
  });
  // 行人狀態(含上車動線)驗證 hook。
  window.__pedestrianStates = () => runtime.pedestrians.map((pedestrian) => ({
    state: pedestrian.state,
    s: Number(pedestrian.s.toFixed(2)),
    t: Number(pedestrian.t.toFixed(2)),
    platform: pedestrian.busPlatform ?? null,
    boarded: Boolean(pedestrian.boarded),
    boardTargetS: pedestrian.boardTarget
      ? Number(pedestrian.boardTarget.s.toFixed(2))
      : null,
    visible: pedestrian.mesh.visible,
  }));
  // §17 行人步態驗收 hook:確認外部 rigged 模型的走路循環有在跑、而且
  // 步頻確實跟著移動速度走(timeScale = speed / 0.754,腳才不會打滑)。
  window.__pedestrianGait = () => runtime.pedestrians.map((pedestrian) => {
    const rig = pedestrian.mesh.userData.gait;
    return {
      state: pedestrian.state,
      speed: Number((pedestrian.speed ?? 0).toFixed(3)),
      rig: rig ? "rigged-glb" : "procedural-fallback",
      walkWeight: rig ? Number(rig.walk.getEffectiveWeight().toFixed(3)) : null,
      walkTimeScale: rig
        ? Number(rig.walk.getEffectiveTimeScale().toFixed(3))
        : null,
      walkTime: rig ? Number(rig.walk.time.toFixed(3)) : null,
      // 每步的前進距離 = 循環速度 × 循環長度 ÷ timeScale 的補償後應等於
      // 實際移動速度;比值偏離 1 就是打滑。
      strideRatio: rig && (pedestrian.speed ?? 0) > 0.05
        ? Number((
          (rig.walk.getEffectiveTimeScale() * PEDESTRIAN_WALK_CYCLE_MPS)
          / pedestrian.speed
        ).toFixed(3))
        : null,
    };
  });
  // 待轉區標線目前是否在場景裡(預設關閉)。
  window.__hookBoxVisible = () => Boolean(runtime.hookTurnBox?.visible);
  // 錄影素材清場用:依名稱樣式開關場景節點,回傳實際命中的名字
  // (回傳清單是刻意的——藏掉什麼要看得見,不能默默清場)。
  // 預設不藏任何東西;只有錄影腳本會呼叫它。
  window.__setNodeVisibility = (pattern, visible) => {
    const regex = new RegExp(pattern, "i");
    const names = [];
    scene.traverse((object) => {
      if (object.name && regex.test(object.name)) {
        object.visible = Boolean(visible);
        names.push(object.name);
      }
    });
    return names;
  };
  // 畫線帶驗收 hook(§16):把符合名稱樣式的實景節點(例如行人穿越道的
  // 每一條白漆條紋)的幾何包圍盒換算回「模擬座標 (s, t)」。這是唯一能
  // 客觀證明「KBot 到底站不站在斑馬線上」的資料——CROSSWALK_BANDS 只記
  // 錄整體外框,會把中央 4.25 m 的無畫線空白帶(BRT 分向島)一起算進去。
  window.__paintedNodeBounds = (pattern) => {
    const regex = new RegExp(pattern, "i");
    const inverse = new THREE.Matrix4()
      .copy(runtime.simulationRoot.matrixWorld).invert();
    const corner = new THREE.Vector3();
    const result = [];
    scene.traverse((object) => {
      if (!object.isMesh || !object.name || !regex.test(object.name)) return;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const local = object.geometry.boundingBox;
      const entry = {
        name: object.name,
        sMin: Infinity, sMax: -Infinity, tMin: Infinity, tMax: -Infinity,
      };
      for (const x of [local.min.x, local.max.x]) {
        for (const y of [local.min.y, local.max.y]) {
          for (const z of [local.min.z, local.max.z]) {
            corner.set(x, y, z)
              .applyMatrix4(object.matrixWorld).applyMatrix4(inverse);
            entry.sMin = Math.min(entry.sMin, corner.x);
            entry.sMax = Math.max(entry.sMax, corner.x);
            entry.tMin = Math.min(entry.tMin, corner.z);
            entry.tMax = Math.max(entry.tMax, corner.z);
          }
        }
      }
      result.push(entry);
    });
    return result;
  };
  // 路口佔用診斷 hook:列出此刻讓 intersectionConflict() 為真的車輛。
  // 「清空相位一直等不到淨空」時,這是唯一能指認兇手的資料。
  window.__conflictVehicles = () => runtime.vehicles
    .filter((actor) => actor.turnState === "turning"
      || vehicleOccupiesTransitionConflict(
        vehicleEnvelope(actor), CROSSWALK_CLEARANCE_MARGIN,
      ))
    .map((actor) => ({
      id: actor.id,
      type: actor.type,
      route: actor.route,
      turnState: actor.turnState ?? null,
      s: Number(actor.mesh.position.x.toFixed(2)),
      t: Number(actor.mesh.position.z.toFixed(2)),
      lane: actor.lane ?? null,
      speed: Number((actor.speed ?? 0).toFixed(2)),
      movement: actor.movement,
    }));
  // 號誌驗證 hook:各 aspect 節點目前可見性。
  window.__signalStates = () => runtime.signalAspectNodes.map((node) => ({
    // head 是 §20 相機 focus 用的分組鍵(附加欄位,舊消費者不受影響)。
    head: node.userData.traffic_director_signal_head_id,
    aspect: node.userData.traffic_director_signal_aspect,
    kind: node.userData.traffic_director_signal_kind,
    movement: node.userData.traffic_director_signal_movement,
    visible: node.visible,
  }));
}

function clearActors() {
  for (const actor of [...runtime.vehicles, ...runtime.pedestrians]) {
    runtime.simulationRoot.remove(actor.mesh);
    actor.mesh.traverse((child) => {
      if (child.geometry && !child.geometry.userData.sharedRuntimeResource) {
        child.geometry.dispose();
      }
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const childMaterial of materials) {
        if (childMaterial && !childMaterial.userData.sharedRuntimeResource) {
          // 行人的 8×1 調色盤貼圖是逐人 new 的,material.dispose() 不會
          // 連帶釋放,reseed 會累積。
          childMaterial.map?.dispose();
          childMaterial.dispose();
        }
      }
    });
  }
  runtime.vehicles = [];
  runtime.pedestrians = [];
}

function spawnActors() {
  clearActors();
  const baseSeed = runtime.rules.simulation_constants.seed + runtime.seedOffset;
  const plan = buildSpawnPlan(
    baseSeed,
    runtime.rules.simulation_constants.vehicle_mix_project_assumption,
    runtime.rules.simulation_constants.pedestrian_walk_speed_mps,
    runtime.trafficMode,
  );
  random = mulberry32(baseSeed ^ 0x9e3779b9);
  const palette = [
    0xb52c2f,
    0x205b94,
    0xd9dde0,
    0xe5952c,
    0x26825d,
    0x592f78,
    0x17212a,
    0xe8d8b5,
    0x2d8b9e,
    0x8a5c3f,
  ];
  for (const [index, vehicle] of plan.vehicles.entries()) {
    const mesh = actorMesh(
      vehicle.type,
      palette[vehicle.bodyColorId % palette.length],
      vehicle,
    );
    mesh.scale.setScalar(vehicle.visualScale);
    mesh.position.set(vehicle.s, 0.08, vehicle.t);
    // 巷90車流由市場側(+t)向路口(-t)行駛。
    mesh.rotation.y = vehicle.sideAccess
      ? Math.PI / 2
      : vehicle.direction > 0
        ? 0
        : Math.PI;
    runtime.simulationRoot.add(mesh);
    const actor = {
      ...vehicle,
      mesh,
      lane: vehicle.t,
      speed: 0,
      reactionElapsedS: 0,
      span: SCENE_LENGTH - 20,
      passed: false,
      turnState: vehicle.sideAccess ? "alley" : null,
      turnPath: null,
      turnIndex: 0,
      hookSlotIndex: null,
      mergeAfterTurn: false,
      fromLane90: false,
      busDwellRemaining: 0,
      busDwellDone: false,
      busPlatform: null,
    };
    runtime.vehicles.push(actor);
    applyLateralPlacement(actor);
  }

  const clothing = [0x168982, 0xc94d46, 0xd69c27, 0x314f91, 0x7d5296];
  for (const [index, pedestrian] of plan.pedestrians.entries()) {
    const mesh = pedestrianMesh(
      index,
      pedestrian.colorIndex,
      clothing[pedestrian.colorIndex % clothing.length],
    );
    mesh.position.set(
      pedestrian.s,
      mesh.userData.groundOffset ?? 0,
      pedestrian.t,
    );
    applyPedestrianHeading(mesh, pedestrian.heading);
    runtime.simulationRoot.add(mesh);
    runtime.pedestrians.push({
      ...pedestrian,
      mesh,
    });
  }

  // §21:reseed 會換掉整批 mesh,重新套用目前的圖層開關。
  applySceneLayer("vehicles");
  applySceneLayer("pedestrians");
  ui.seedLabel.textContent = String(baseSeed);
  ui.trafficModeLabel.textContent =
    `模式 ${TRAFFIC_DENSITY_MODES[plan.mode]?.label ?? plan.mode}`;
  ui.busLaneCount.textContent = String(plan.busLaneCount ?? BUS_LANES.length);
  ui.spawnAdjustNote.hidden = !(plan.spawnReductions > 0);
  ui.spawnAdjustNote.textContent = plan.spawnReductions > 0
    ? `防碰撞減車 ${plan.spawnReductions}`
    : "";
  updateMetrics();
  publishDebugState();
}

// KBot 站在車道上(行穿線中央指揮、或正在移動穿越車道)時,和行人一樣
// 構成硬性安全閘門:任何車流放行都要等他退到安全區。安全區 =
// 兩側人行道(實測路緣線 kerbT 外 0.3 m)或中央公車站月台;中央分向
// 緩衝帶只有 0.9 m 寬且夾在兩條公車道之間,不算安全區。
function robotSafeZone() {
  if (!runtime.kbotHolder || !runtime.kbotReady) return "sidewalk_pos";
  return controllerSafeZone(
    runtime.kbotHolder.position.x,
    runtime.kbotHolder.position.z,
  );
}

function robotOnRoadway() {
  return Boolean(runtime.kbotHolder)
    && runtime.kbotReady
    && robotSafeZone() === null;
}

function pedestrianConflict() {
  if (robotOnRoadway()) return true;
  // safeZone = 交錯式穿越走在分向島庇護帶上(含島上等待),不擋車流。
  return runtime.pedestrians.some(
    (pedestrian) =>
      pedestrian.state === "crossing"
      && !pedestrian.safeZone
      && Math.abs(pedestrian.mesh.position.z) < ROAD_HALF_WIDTH + 0.4,
  );
}

// 巷90車流從 x∈[-11,-3] 的巷口進入,與行穿線(s∈[10.6,16.3])完全不相交;
// 只有真的走到巷口附近的行人才需要擋下巷90放行,否則行人相位尾端的穿越者
// 會讓 lane90_release 空等 20 秒以上。
function lane90PedestrianConflict() {
  // 只有真的位於巷口區(x∈[-13,-1] 且貼近市場側路緣 z>12)的穿越者
  // 才擋巷90;交錯式行穿線(z≤1.3 轉折)與直行行穿線都離巷口路徑很遠。
  return runtime.pedestrians.some(
    (pedestrian) =>
      pedestrian.state === "crossing"
      && pedestrian.mesh.position.x > -13
      && pedestrian.mesh.position.x < -1
      && pedestrian.mesh.position.z > 12,
  );
}

function pedestrianConflictForPhase(phaseId) {
  return phaseId === "lane90_release"
    ? lane90PedestrianConflict()
    : pedestrianConflict();
}

function allowedMovements() {
  const phase = runtime.rules.phases[runtime.currentPhaseId];
  return new Set(phase.allowed_movements);
}

function movementAllowed(movement) {
  if (runtime.currentPhaseId === "clearance") return false;
  if (runtime.downstreamBlocked) return false;
  const conflict = movement === "lane90_oneway"
    ? lane90PedestrianConflict()
    : pedestrianConflict();
  if (conflict) return false;
  return allowedMovements().has(movement);
}

// 黃燈尾段(SPEC_VIEWER_V2 §13):綠燈最後 AMBER_TAIL_S 秒,尚未越過
// 第一道實畫停止線的車輛開始停等,已進入路口者照 §10 的「過了就讓它
// 過去」語意繼續完成通過。這既是真實號誌行為,也把全紅淨空時間從
// 十秒級壓到三秒級——舊版沒有黃燈,車輛一路衝到綠燈結束才被攔,
// 導致每個循環都有十秒以上的 crosswalk_not_clear 空轉。
let AMBER_TAIL_S = 3.0;

function movementAmber(movement) {
  if (!runtime.rules) return false;
  if (!allowedMovements().has(movement)) return false;
  if (runtime.command?.state !== "active") return false;
  if (runtime.phaseDuration >= 900) return false;
  return runtime.phaseDuration - runtime.phaseElapsed <= AMBER_TAIL_S;
}

// 車輛運動用的放行判斷(黃燈尾段視為不放行);相位決策與安全閘門
// 仍使用 movementAllowed,語意不變。
function vehicleMovementAllowed(movement) {
  return movementAllowed(movement) && !movementAmber(movement);
}

function vehicleEnvelope(actor) {
  return {
    s: actor.mesh.position.x,
    t: actor.sideAccess ? actor.mesh.position.z : actor.lane,
    length: actor.length,
    direction: actor.direction,
    sideAccess: actor.sideAccess,
    laneClass: actor.lanePosition === "bus" ? "bus" : "general",
  };
}

function vehicleCrosswalkConflict() {
  return runtime.vehicles.some(
    (actor) => !vehicleClearsCrosswalk(
      vehicleEnvelope(actor),
      CROSSWALK_CLEARANCE_MARGIN,
    ),
  );
}

function intersectionConflict() {
  return runtime.vehicles.some((actor) => (
    // 正在完成轉向動作的巷90車輛人在路口裡,一律算佔用;停在待轉區的
    // 不算(那是畫設的停等區,不在任何車流路徑上)。
    actor.turnState === "turning"
    || vehicleOccupiesTransitionConflict(
      vehicleEnvelope(actor),
      CROSSWALK_CLEARANCE_MARGIN,
    )
  ));
}

function followingBlocked(actor) {
  // 煞停所需距離納入門檻,讓跟車從物理煞車距離外就開始減速,而不是
  // 貼到 2.3 m 才一幀急停(SPEC_VIEWER_V2 §7)。
  let nearest = Infinity;
  for (const other of runtime.vehicles) {
    if (other === actor || other.movement !== actor.movement) continue;
    if (!actor.sideAccess && other.lane !== actor.lane) continue;
    if (
      actor.sideAccess
      && Math.abs(other.mesh.position.x - actor.mesh.position.x) > 1.5
    ) continue;
    const delta = actor.sideAccess
      ? actor.mesh.position.z - other.mesh.position.z
      : (other.mesh.position.x - actor.mesh.position.x) * actor.direction;
    if (delta > 0) nearest = Math.min(nearest, delta - other.length * 0.5);
  }
  const brakingDistance = actor.speed * actor.speed / (2 * 3.8);
  return nearest < actor.length * 0.5 + 2.3 + brakingDistance;
}

// 「網狀線淨空」:前方同車道隊伍(停止或未放行)未讓出斑馬線帶之後的
// 完整車位(車長+2.3 m)前,不得駛入帶內,改停在帶前 0.4 m。回傳到
// 保持點的剩餘距離(無需保持時為 Infinity)。防止紅燈長隊伍第 N 輛
// 停在斑馬線上、把 intersection_not_clear 卡死。
function keepClearHoldDistance(actor, permitted) {
  if (actor.sideAccess) return Infinity;
  const direction = actor.direction;
  const halfLength = actor.length * 0.5;
  const centerU = actor.mesh.position.x * direction;
  const frontU = centerU + halfLength;
  let leaderRearU = Infinity;
  let leaderStopped = false;
  for (const other of runtime.vehicles) {
    if (
      other === actor
      || other.sideAccess
      || other.movement !== actor.movement
      || other.lane !== actor.lane
    ) continue;
    const otherCenterU = other.mesh.position.x * other.direction;
    if (otherCenterU <= centerU) continue;
    const otherRearU = otherCenterU - other.length * 0.5;
    if (otherRearU < leaderRearU) {
      leaderRearU = otherRearU;
      leaderStopped = other.speed < 0.5;
    }
  }
  if (!Number.isFinite(leaderRearU)) return Infinity;
  if (permitted && !leaderStopped) return Infinity;
  const requiredSpace = actor.length + FOLLOW_MIN_BUMPER_GAP_M;
  let holdDistance = Infinity;
  for (const band of CROSSWALK_BANDS) {
    if (actor.lane < band.tMin - 1 || actor.lane > band.tMax + 1) continue;
    const nearU = (direction > 0 ? band.sMin : band.sMax) * direction;
    const farU = (direction > 0 ? band.sMax : band.sMin) * direction;
    if (frontU > nearU - 0.05) continue;
    if (leaderRearU - farU < requiredSpace) {
      holdDistance = Math.min(holdDistance, nearU - 0.4 - frontU);
    }
  }
  return Math.max(0, holdDistance);
}

// 一般車道車體沿實測的道路橫移折線擺放(公車道與巷90除外,皆為直線)。
function applyLateralPlacement(actor) {
  if (actor.sideAccess) return;
  const baseYaw = actor.direction > 0 ? 0 : Math.PI;
  if (actor.lanePosition === "bus") {
    actor.mesh.position.z = actor.lane;
    actor.mesh.rotation.y = baseYaw;
    return;
  }
  const s = actor.mesh.position.x;
  actor.mesh.position.z = actor.lane + roadCurveOffset(actor.direction, s);
  actor.mesh.rotation.y = baseYaw - roadCurveSlope(actor.direction, s);
}

function recycleMainVehicle(actor) {
  // 只在自己的行進終點換邊(方向感知),並且落點退到同車道最後一輛之後,
  // 避免回收瞬移乒乓與落點重疊(SPEC_VIEWER_V2 §7)。
  let entryU = -SCENE_LENGTH / 2 - random() * 24;
  let rearmost = null;
  let rearmostU = Infinity;
  for (const other of runtime.vehicles) {
    if (
      other === actor
      || other.sideAccess
      || other.movement !== actor.movement
      || other.lane !== actor.lane
    ) continue;
    const otherU = other.mesh.position.x * other.direction;
    if (otherU < rearmostU) {
      rearmostU = otherU;
      rearmost = other;
    }
  }
  if (rearmost) {
    entryU = Math.min(
      entryU,
      rearmostU - minimumSpawnHeadway(rearmost, actor),
    );
  }
  actor.mesh.position.x = entryU * actor.direction;
  actor.passed = false;
  // 下一趟再停靠一次公車站。
  actor.busDwellDone = false;
  actor.busDwellRemaining = 0;
}

// ---- 車輛遇行人一律停讓(規則 pedestrian_behavior.vehicle_yield_is_hard_gate)
// 相位閘門是「不放行」,這裡補上車輛個體層級的停讓:已進入路口、正在
// 通過的車遇到自己車道前方的行人,一樣要煞停。回傳到停讓點的距離。
function pedestrianYieldDistance(actor) {
  if (actor.sideAccess) return Infinity;
  const direction = actor.direction;
  const laneT = actor.mesh.position.z;
  const frontU = actor.mesh.position.x * direction + actor.length * 0.5;
  let nearest = Infinity;
  for (const pedestrian of runtime.pedestrians) {
    if (pedestrian.state !== "crossing" || pedestrian.safeZone) continue;
    if (Math.abs(pedestrian.t - laneT) > 2.2) continue;
    const gap = pedestrian.s * direction - frontU;
    if (gap > -1.0 && gap < 24) {
      nearest = Math.min(nearest, Math.max(0, gap - 1.8));
    }
  }
  return nearest;
}

// ---- 中央公車道停靠:公車在月台候車帶中段停車 6–12 秒再開走。
function busDwellDistance(actor, delta) {
  if (actor.type !== "bus" || actor.lanePosition !== "bus") return Infinity;
  if (actor.busDwellRemaining > 0) {
    actor.busDwellRemaining = Math.max(0, actor.busDwellRemaining - delta);
    if (actor.busDwellRemaining === 0) actor.busDwellDone = true;
    return 0;
  }
  if (actor.busDwellDone) return Infinity;
  const stop = BUS_DWELL_STOPS[String(actor.direction)];
  if (!stop) return Infinity;
  const distance = (stop.s - actor.mesh.position.x) * actor.direction;
  if (distance < -1.5) {
    actor.busDwellDone = true;
    return Infinity;
  }
  if (distance <= 0.4) {
    actor.mesh.position.x = stop.s;
    actor.speed = 0;
    actor.busPlatform = stop.platform;
    actor.busDwellRemaining = BUS_DWELL_SECONDS.min
      + random() * (BUS_DWELL_SECONDS.max - BUS_DWELL_SECONDS.min);
    return 0;
  }
  return Math.max(0, distance);
}

function platformHasDwellingBus(platform) {
  if (!platform) return false;
  return runtime.vehicles.some((actor) => (
    actor.type === "bus"
    && actor.busDwellRemaining > 0
    && actor.busPlatform === platform
  ));
}

// ---- 巷90 轉向(SPEC_VIEWER_V2 §13)
let LANE90_TURN_SPEED = 4.2;

function hookBoxOccupancy() {
  const used = new Set();
  for (const actor of runtime.vehicles) {
    if (actor.turn !== "hook") continue;
    if (actor.turnState !== "turning" && actor.turnState !== "hook_wait") continue;
    if (Number.isInteger(actor.hookSlotIndex)) used.add(actor.hookSlotIndex);
  }
  return used;
}

function nextFreeHookSlot() {
  const used = hookBoxOccupancy();
  for (const index of HOOK_BOX_FILL_ORDER) {
    if (!used.has(index)) return index;
  }
  return -1;
}

function startLane90Turn(actor) {
  if (actor.turn === "hook") {
    const slot = nextFreeHookSlot();
    if (slot < 0) return false;          // 待轉區滿了 → 巷口續等
    actor.hookSlotIndex = slot;
    actor.turnPath = buildLane90TurnPath("hook", actor.columnS, slot);
  } else {
    actor.turnPath = buildLane90TurnPath("right", actor.columnS);
  }
  actor.turnState = "turning";
  actor.turnIndex = 0;
  actor.mergeAfterTurn = actor.turn !== "hook";
  if (!actor.passed) {
    runtime.throughput += 1;
    actor.passed = true;
  }
  return true;
}

function finishLane90Turn(actor) {
  if (actor.turn === "hook" && !actor.mergeAfterTurn) {
    // 進入待轉區停等,面向起步方向(+s)。
    const slot = hookBoxSlot(actor.hookSlotIndex);
    actor.turnState = "hook_wait";
    actor.speed = 0;
    actor.mesh.position.x = slot.s;
    actor.mesh.position.z = slot.t;
    actor.mesh.rotation.y = 0;
    return;
  }
  // 併入羅斯福路,之後照一般車道邏輯行駛。
  actor.sideAccess = false;
  actor.turnState = "merged";
  actor.fromLane90 = true;
  actor.lanePosition = "outer";
  if (actor.turn === "hook") {
    actor.movement = "roosevelt_northwest";
    actor.direction = 1;
    actor.lane = LANE90_HOOK_LANE_T;
  } else {
    actor.movement = "roosevelt_southeast";
    actor.direction = -1;
    actor.lane = LANE90_RIGHT_LANE_T;
  }
  actor.mesh.rotation.y = actor.direction > 0 ? 0 : Math.PI;
  applyLateralPlacement(actor);
}

function advanceLane90Turn(actor, delta) {
  const blocked = turnPathBlocked(actor);
  const target = blocked ? 0 : Math.min(actor.desiredSpeed, LANE90_TURN_SPEED);
  const acceleration = target > actor.speed ? 2.2 : 4.2;
  actor.speed += THREE.MathUtils.clamp(
    target - actor.speed,
    -acceleration * delta,
    acceleration * delta,
  );
  actor.speed = Math.max(0, actor.speed);
  let remaining = actor.speed * delta;
  while (remaining > 0 && actor.turnIndex < actor.turnPath.length) {
    const point = actor.turnPath[actor.turnIndex];
    const deltaS = point.s - actor.mesh.position.x;
    const deltaT = point.t - actor.mesh.position.z;
    const span = Math.hypot(deltaS, deltaT);
    if (span <= remaining || span < 1e-6) {
      actor.mesh.position.x = point.s;
      actor.mesh.position.z = point.t;
      remaining -= span;
      actor.turnIndex += 1;
      continue;
    }
    const step = remaining / span;
    actor.mesh.position.x += deltaS * step;
    actor.mesh.position.z += deltaT * step;
    // 車體朝向:+s→0、-s→π、-t→π/2 ⇒ ψ = atan2(-Δt, Δs)。
    actor.mesh.rotation.y = Math.atan2(-deltaT, deltaS);
    remaining = 0;
  }
  if (actor.turnIndex >= actor.turnPath.length) finishLane90Turn(actor);
}

// 轉向途中只讓兩件事擋下來:前方同路徑的車、以及路徑前方的行人。
function turnPathBlocked(actor) {
  for (const other of runtime.vehicles) {
    if (other === actor || other.route !== "lane90") continue;
    if (other.turnState !== "turning" && other.turnState !== "hook_wait") continue;
    if (other.turn !== actor.turn) continue;
    const gap = Math.hypot(
      other.mesh.position.x - actor.mesh.position.x,
      other.mesh.position.z - actor.mesh.position.z,
    );
    // 已停進待轉格的車用「車體淨空」判定,不用跟車距離(§14 死結修正)。
    const parked = other.turnState === "hook_wait";
    const ahead = parked || (other.turnIndex ?? 0) > (actor.turnIndex ?? 0);
    const clearance = parked
      ? HOOK_PARKED_CLEARANCE_M
      : actor.length * 0.5 + other.length * 0.5 + 1.6;
    if (ahead && gap < clearance) return true;
  }
  for (const pedestrian of runtime.pedestrians) {
    if (pedestrian.state !== "crossing" || pedestrian.safeZone) continue;
    const gap = Math.hypot(
      pedestrian.s - actor.mesh.position.x,
      pedestrian.t - actor.mesh.position.z,
    );
    if (gap < 4.5) return true;
  }
  return false;
}

function lane90ColumnTailT(actor) {
  let tail = actor.columnBaseT ?? actor.recycleT;
  for (const other of runtime.vehicles) {
    if (other === actor || other.route !== "lane90") continue;
    if (!other.sideAccess || other.columnIndex !== actor.columnIndex) continue;
    if (other.turnState === "turning") continue;
    tail = Math.max(tail, other.mesh.position.z);
  }
  return tail + SIDE_COLUMN_HEADWAY_M;
}

// 併入羅斯福路的巷90車輛跑到場景盡頭後回到自己的巷內縱列尾端,
// 巷口車流量因此維持恆定。
function returnToLane90(actor) {
  actor.sideAccess = true;
  actor.movement = "lane90_oneway";
  actor.direction = 1;
  actor.lanePosition = "side";
  actor.turnState = "alley";
  actor.turnPath = null;
  actor.turnIndex = 0;
  actor.hookSlotIndex = null;
  actor.mergeAfterTurn = false;
  actor.fromLane90 = false;
  actor.turn = lane90TurnFor(actor.type, random);
  actor.mesh.position.x = actor.columnS;
  actor.mesh.position.z = lane90ColumnTailT(actor);
  actor.mesh.rotation.y = Math.PI / 2;
  actor.speed = 0;
  actor.passed = false;
}

function updateSideAccessVehicle(actor, delta) {
  const state = actor.turnState ?? "alley";

  if (state === "hook_wait") {
    // 待轉區:等羅斯福路西北向放行才起步(兩段式左轉的第二段)。
    actor.speed = 0;
    if (vehicleMovementAllowed("roosevelt_northwest")) {
      actor.turnPath = buildHookMergePath(hookBoxSlot(actor.hookSlotIndex));
      actor.turnIndex = 0;
      actor.mergeAfterTurn = true;
      actor.turnState = "turning";
    }
    return;
  }

  if (state === "turning") {
    advanceLane90Turn(actor, delta);
    return;
  }

  // 巷內排隊 → 巷口停止線 → 放行後開始轉向。
  // 關掉兩段式左轉時,原本要待轉的車改成右轉(巷口不會因此塞住)。
  if (!runtime.hookTurnEnabled && actor.turn === "hook") actor.turn = "right";
  // 待轉區客滿就繼續在巷口停等,不要駛進路口再退回來。
  const slotAvailable = actor.turn !== "hook" || nextFreeHookSlot() >= 0;
  const permitted = vehicleMovementAllowed("lane90_oneway") && slotAvailable;
  let target = followingBlocked(actor) ? 0 : actor.desiredSpeed;
  const stopDistance = Math.max(0, actor.mesh.position.z - SIDE_STOP_T);
  if (!permitted) target = Math.min(target, stopDistance * 0.65);
  const acceleration = target > actor.speed ? 2.0 : 3.8;
  actor.speed += THREE.MathUtils.clamp(
    target - actor.speed,
    -acceleration * delta,
    acceleration * delta,
  );
  actor.speed = Math.max(0, actor.speed);
  const committedBefore = actor.mesh.position.z < SIDE_STOP_T;
  actor.mesh.position.z -= actor.speed * delta;
  if (!permitted && !committedBefore && actor.mesh.position.z < SIDE_STOP_T) {
    actor.mesh.position.z = SIDE_STOP_T;
    actor.speed = 0;
  }
  if (permitted && actor.mesh.position.z <= SIDE_STOP_T - 0.2) {
    startLane90Turn(actor);
  }
}

function updateVehicles(delta) {
  for (const actor of runtime.vehicles) {
    if (actor.sideAccess) {
      updateSideAccessVehicle(actor, delta);
      for (const wheel of actor.mesh.userData.wheels) {
        wheel.pivot.rotation.z -= actor.speed * delta / wheel.radius;
      }
      continue;
    }

    const permitted = vehicleMovementAllowed(actor.movement);
    if (permitted) actor.reactionElapsedS += delta;
    else actor.reactionElapsedS = 0;
    const envelope = vehicleEnvelope(actor);
    const pendingLine = permitted ? null : nextStopLine(envelope);
    const waitingForReaction = (
      permitted && actor.reactionElapsedS < actor.reactionDelayS
    );
    let target = (followingBlocked(actor) || waitingForReaction)
      ? 0
      : actor.desiredSpeed;
    if (!permitted) {
      // 漸進逼近實畫停止線:目標速度與剩餘距離成正比,自然收斂於線前,
      // 不再於 18 m 接近窗直接鎖死(避免車停在路口中央)。
      const stopDistance = pendingLine
        ? distanceToNextStop(envelope)
        : Infinity;
      if (Number.isFinite(stopDistance)) {
        target = Math.min(target, stopDistance * 0.65);
      }
    }
    const holdDistance = keepClearHoldDistance(actor, permitted);
    if (Number.isFinite(holdDistance)) {
      target = Math.min(target, holdDistance * 0.65);
    }
    const yieldDistance = pedestrianYieldDistance(actor);
    if (Number.isFinite(yieldDistance)) {
      target = Math.min(target, yieldDistance * 0.55);
    }
    const busDistance = busDwellDistance(actor, delta);
    if (Number.isFinite(busDistance)) {
      target = Math.min(target, busDistance * 0.55);
    }
    const acceleration = target > actor.speed ? 2.0 : 3.8;
    actor.speed += THREE.MathUtils.clamp(target - actor.speed, -acceleration * delta, acceleration * delta);
    actor.speed = Math.max(0, actor.speed);
    for (const wheel of actor.mesh.userData.wheels) {
      wheel.pivot.rotation.z -= actor.speed * delta / wheel.radius;
    }

    const previousConflict =
      Math.abs(actor.mesh.position.x) < CONFLICT_HALF_LENGTH;

    actor.mesh.position.x += actor.direction * actor.speed * delta;
    if (pendingLine) {
      const frontU = (
        actor.mesh.position.x + actor.direction * actor.length * 0.5
      ) * actor.direction;
      if (frontU > pendingLine.stop * actor.direction) {
        actor.mesh.position.x =
          pendingLine.stop - actor.direction * actor.length * 0.5;
        actor.speed = 0;
      }
    }
    const wrapExit = actor.direction > 0
      ? actor.mesh.position.x > SCENE_LENGTH / 2
      : actor.mesh.position.x < -SCENE_LENGTH / 2;
    if (wrapExit) {
      if (actor.fromLane90) {
        returnToLane90(actor);
        continue;
      }
      recycleMainVehicle(actor);
    }

    const nowConflict =
      Math.abs(actor.mesh.position.x) < CONFLICT_HALF_LENGTH;
    if (!previousConflict && nowConflict && !actor.passed) {
      runtime.throughput += 1;
      actor.passed = true;
    }
    if (!nowConflict && actor.passed) {
      const beyond = actor.direction > 0
        ? actor.mesh.position.x > CONFLICT_HALF_LENGTH
        : actor.mesh.position.x < -CONFLICT_HALF_LENGTH;
      if (beyond) actor.passed = false;
    }
    applyLateralPlacement(actor);
  }
  enforceFollowSafety();
  detectCollisions();
}

// 「碰撞」計數過去只是個永遠停在 0 的裝飾數字。改成真的偵測:同車道
// 保桿重疊、或車輛掃到站在車道上的機器人;同一組只在事件開始時計一次。
const activeCollisionKeys = new Set();

function detectCollisions() {
  const active = new Set();
  const laneGroups = new Map();
  for (const actor of runtime.vehicles) {
    if (actor.sideAccess) continue;
    const laneKey = `${actor.movement}:${actor.lane}`;
    if (!laneGroups.has(laneKey)) laneGroups.set(laneKey, []);
    laneGroups.get(laneKey).push(actor);
  }
  for (const group of laneGroups.values()) {
    group.sort((a, b) =>
      a.mesh.position.x * a.direction - b.mesh.position.x * b.direction);
    for (let index = 0; index + 1 < group.length; index += 1) {
      const rear = group[index];
      const front = group[index + 1];
      const gap = (front.mesh.position.x - rear.mesh.position.x) * front.direction
        - (front.length + rear.length) / 2;
      if (gap < 0) active.add(`${rear.id}|${front.id}`);
    }
  }
  if (runtime.kbotHolder && runtime.kbotReady && robotOnRoadway()) {
    const { x, z } = runtime.kbotHolder.position;
    for (const actor of runtime.vehicles) {
      if (Math.abs(actor.mesh.position.x - x) < actor.length * 0.5 + 0.45
        && Math.abs(actor.mesh.position.z - z) < 1.5) {
        active.add(`kbot|${actor.id}`);
      }
    }
  }
  for (const key of active) {
    if (!activeCollisionKeys.has(key)) runtime.collisions += 1;
  }
  activeCollisionKeys.clear();
  for (const key of active) activeCollisionKeys.add(key);
}

// SPEC_VIEWER_V2 §5 follow guarantee: after every integration step the
// bumper-to-bumper gap between same-lane leader/follower stays ≥ 2 m. The
// follower is pushed back (front-to-back, so corrections cascade) and its
// speed is capped at the leader's.
function enforceFollowSafety() {
  const laneGroups = new Map();
  for (const actor of runtime.vehicles) {
    if (actor.sideAccess) continue;
    const laneKey = `${actor.movement}:${actor.lane}`;
    if (!laneGroups.has(laneKey)) laneGroups.set(laneKey, []);
    laneGroups.get(laneKey).push(actor);
  }
  for (const group of laneGroups.values()) {
    group.sort((a, b) =>
      a.mesh.position.x * a.direction - b.mesh.position.x * b.direction);
    for (let index = group.length - 2; index >= 0; index -= 1) {
      const rear = group[index];
      const front = group[index + 1];
      const bumperGap =
        (front.mesh.position.x - rear.mesh.position.x) * front.direction
        - (front.length + rear.length) / 2;
      if (bumperGap < FOLLOW_MIN_BUMPER_GAP_M) {
        const rearU = front.mesh.position.x * front.direction
          - (front.length + rear.length) / 2
          - FOLLOW_MIN_BUMPER_GAP_M;
        rear.mesh.position.x = rearU * rear.direction;
        rear.speed = Math.min(rear.speed, front.speed);
      }
    }
  }
}

function updatePedestrians(delta) {
  const baseWalk = runtime.rules.phases[runtime.currentPhaseId].pedestrian_walk;
  const remaining = runtime.phaseDuration - runtime.phaseElapsed;
  for (const pedestrian of runtime.pedestrians) {
    // WALK 尾端不放行「來不及抵達下一個安全點」的進入/再出發(已在
    // 危險段者照常走完)。門檻依各自路線(直行=全程、交錯式=半段)
    // 與使用者設定的相位秒數自動調整。
    let walkAllowed = baseWalk;
    if (walkAllowed && runtime.phaseDuration < 900) {
      const needS = (pedestrian.crossing?.entryCrossS ?? 24) * 0.45;
      walkAllowed = remaining > Math.min(needS, runtime.phaseDuration * 0.6);
    }
    // 月台候車者:同月台真的有公車停靠、且就在身邊時才上車。
    const dockedBus = pedestrian.state === "waiting_for_bus"
      && Boolean(pedestrian.busPlatform)
      ? runtime.vehicles.find((actor) => (
        actor.type === "bus"
        && actor.busDwellRemaining > 0
        && actor.busPlatform === pedestrian.busPlatform
        && Math.abs(actor.mesh.position.x - pedestrian.s)
          <= BUS_BOARDING_RADIUS_M
      ))
      : undefined;
    const next = advancePedestrian(pedestrian, {
      delta,
      walkAllowed,
      busAtPlatform: Boolean(dockedBus),
      busDoorS: dockedBus ? dockedBus.mesh.position.x : null,
    });
    Object.assign(pedestrian, next);
    if (pedestrian.state === "boarding") {
      // 走到車門前照常顯示;boarded 之後才藏起來(人在車上),公車開走
      // 這位乘客隨車離開,由回收機制換一位新的行人從人行道出現。
      const dwelling = platformHasDwellingBus(pedestrian.busPlatform);
      if (pedestrian.boarded) {
        pedestrian.mesh.visible = false;
        if (!dwelling) {
          recyclePedestrian(pedestrian);
          pedestrian.mesh.visible = true;
          runtime.busBoardings += 1;
        }
      } else if (!dwelling) {
        // 走到一半公車開走了:退回月台候車,等下一班或逾時續行對側。
        pedestrian.state = "waiting_for_bus";
        pedestrian.boardTarget = null;
        pedestrian.waitElapsed = 0;
      }
    }
    if (pedestrian.state === "complete") recyclePedestrian(pedestrian);
    pedestrian.mesh.position.x = pedestrian.s;
    pedestrian.mesh.position.z = pedestrian.t;
    applyPedestrianHeading(pedestrian.mesh, pedestrian.heading);
    animatePedestrianMesh(pedestrian, delta);
  }
}

function phaseDurationFromTimeline(entry) {
  const fps = runtime.rules.simulation_constants.fps;
  return (entry.end_frame - entry.start_frame + 1) / fps;
}

function initializePhases() {
  runtime.phases = runtime.rules.demo_timeline.map((entry) => ({
    ...entry,
    duration: phaseDurationFromTimeline(entry),
  }));
  startAutomaticCycle();
}

function applyPhase(phaseId, duration = null) {
  runtime.currentPhaseId = phaseId;
  runtime.phaseElapsed = 0;
  runtime.phaseDuration = duration ?? (
    phaseId === "clearance"
      ? runtime.rules.simulation_constants.clearance_s
      : phaseDurationForId(phaseId)
  );
  updatePhaseUi();
  syncSignalAspects();
  syncKbotPose();
}

function phaseDurationForId(phaseId) {
  // 使用者在模擬控制面板設定的秒數優先於 Blender timeline 預設。
  const override = runtime.phaseSeconds[phaseId];
  if (Number.isFinite(override) && override > 0) return override;
  const entry = runtime.phases.find((item) => item.phase === phaseId);
  return entry ? entry.duration : 5;
}

function commandRequestKind(phaseId) {
  return phaseId === "pedestrian_crossing" ? "walk_signal" : "gesture";
}

function submitManualCommand({ phaseId, gesture, requestKind }) {
  // 手動指令=插入一個自然時長的相位(套用使用者設定秒數),結束後若
  // 自動循環開著就繼續循環——號誌不再永久 HOLD 不變。想長期鎖定,
  // 先關掉「自動循環」再按指令即可(相位結束後維持 HOLD)。
  submitCommand({
    phaseId,
    gesture: requestKind === "walk_signal"
      ? PEDESTRIAN_WALK_COMMAND.kbotGesture
      : gesture,
    requestKind,
    source: "manual",
    targetDuration: runtime.auto ? phaseDurationForId(phaseId) : 999,
  });
}

function submitCommand({
  phaseId,
  gesture,
  requestKind = "gesture",
  source = "manual",
  targetDuration = 999,
  targetIndex = null,
  initialClearanceElapsed = 0,
}) {
  const initialDecision = resolveTrafficCommand({
    requestedPhaseId: phaseId,
    requestedGesture: gesture,
    requestKind,
    gestureElapsedS: 0,
    clearanceElapsedS: initialClearanceElapsed,
    gestureStabilityS: runtime.rules.simulation_constants.gesture_stability_s,
    clearanceMinimumS: runtime.rules.simulation_constants.clearance_s,
    conflictZoneClear: !intersectionConflict(),
    crosswalkClear: !vehicleCrosswalkConflict(),
    pedestrianConflict: pedestrianConflictForPhase(phaseId),
    downstreamClear: !runtime.downstreamBlocked,
  });
  runtime.command = {
    requestedPhaseId: phaseId,
    requestedGesture: gesture,
    requestKind,
    source,
    targetDuration,
    targetIndex,
    gestureElapsedS: 0,
    clearanceElapsedS: initialClearanceElapsed,
    state: initialDecision.state,
    reasonCode: initialDecision.reasonCode,
  };

  if (phaseId === "all_stop") {
    runtime.command.state = "active";
    runtime.command.reasonCode = "immediate_all_stop";
    if (targetIndex !== null) runtime.phaseIndex = targetIndex;
    applyPhase("all_stop", targetDuration);
    updateCommandUi();
    return;
  }

  if (initialDecision.reasonCode === "invalid_command") {
    applyPhase("all_stop", 999);
    updateCommandUi();
    return;
  }

  applyPhase("clearance", 999);
  reevaluatePendingCommand(0);
}

function commandSafetyContext(command = runtime.command) {
  return {
    requestedPhaseId: command?.requestedPhaseId,
    requestedGesture: command?.requestedGesture,
    requestKind: command?.requestKind,
    gestureElapsedS: command?.gestureElapsedS ?? 0,
    clearanceElapsedS: command?.clearanceElapsedS ?? 0,
    gestureStabilityS: runtime.rules.simulation_constants.gesture_stability_s,
    clearanceMinimumS: runtime.rules.simulation_constants.clearance_s,
    conflictZoneClear: !intersectionConflict(),
    crosswalkClear: !vehicleCrosswalkConflict(),
    pedestrianConflict: pedestrianConflictForPhase(command?.requestedPhaseId),
    downstreamClear: !runtime.downstreamBlocked,
  };
}

function safetyReadyForGesture(command) {
  const context = commandSafetyContext(command);
  return (
    context.clearanceElapsedS + 1e-9 >= context.clearanceMinimumS
    && context.conflictZoneClear
    && context.crosswalkClear
    && (
      command.requestedPhaseId === "pedestrian_crossing"
      || (!context.pedestrianConflict && context.downstreamClear)
    )
  );
}

function reevaluatePendingCommand(delta) {
  const command = runtime.command;
  if (!command || command.state === "active") return;
  command.clearanceElapsedS += Math.max(0, delta);
  if (safetyReadyForGesture(command)) {
    command.gestureElapsedS += Math.max(0, delta);
  } else {
    command.gestureElapsedS = 0;
  }
  const decision = resolveTrafficCommand(commandSafetyContext(command));
  command.state = decision.state;
  command.reasonCode = decision.reasonCode;

  if (decision.state === "active") {
    if (command.targetIndex !== null) runtime.phaseIndex = command.targetIndex;
    applyPhase(command.requestedPhaseId, command.targetDuration);
  } else {
    if (runtime.currentPhaseId !== decision.safePhaseId) {
      applyPhase(decision.safePhaseId, 999);
    }
    syncKbotPose();
  }
  updateCommandUi();
}

function enforceActiveSafety() {
  const command = runtime.command;
  if (!command || command.state !== "active") return false;
  if (!runtime.rules.phases[runtime.currentPhaseId]?.allowed_movements.length) {
    return false;
  }
  let reasonCode = null;
  if (pedestrianConflictForPhase(runtime.currentPhaseId)) {
    reasonCode = "pedestrian_conflict";
  } else if (runtime.downstreamBlocked) reasonCode = "downstream_not_clear";
  if (!reasonCode) return false;

  command.state = "blocked";
  command.reasonCode = reasonCode;
  command.clearanceElapsedS = 0;
  command.gestureElapsedS = 0;
  applyPhase("clearance", 999);
  updateCommandUi();
  return true;
}

function activateAutomaticPassivePhase(entry, index) {
  runtime.phaseIndex = index;
  runtime.command = {
    requestedPhaseId: entry.phase,
    requestedGesture: "ALL_STOP",
    requestKind: "automatic_phase",
    source: "automatic",
    targetDuration: phaseDurationForId(entry.phase),
    targetIndex: index,
    gestureElapsedS: runtime.rules.simulation_constants.gesture_stability_s,
    clearanceElapsedS: runtime.rules.simulation_constants.clearance_s,
    state: "active",
    reasonCode: entry.phase === "clearance"
      ? "automatic_clearance"
      : "immediate_all_stop",
  };
  applyPhase(entry.phase, phaseDurationForId(entry.phase));
  updateCommandUi();
}

function startAutomaticCycle() {
  runtime.auto = true;
  ui.autoMode.checked = true;
  ui.modeBadge.textContent = "自動";
  activateAutomaticPassivePhase(runtime.phases[0], 0);
}

function advanceAutomaticPhase() {
  const nextIndex = (runtime.phaseIndex + 1) % runtime.phases.length;
  const next = runtime.phases[nextIndex];
  if (next.phase === "all_stop" || next.phase === "clearance") {
    activateAutomaticPassivePhase(next, nextIndex);
    return;
  }
  const priorStopTime = ["all_stop", "clearance"].includes(runtime.currentPhaseId)
    ? Math.min(
      runtime.phaseDuration,
      runtime.rules.simulation_constants.clearance_s,
    )
    : 0;
  submitCommand({
    phaseId: next.phase,
    gesture: runtime.rules.phases[next.phase].gesture,
    requestKind: commandRequestKind(next.phase),
    source: "automatic",
    targetDuration: phaseDurationForId(next.phase),
    targetIndex: nextIndex,
    initialClearanceElapsed: priorStopTime,
  });
}

function updatePhaseMachine(delta) {
  runtime.phaseElapsed += delta;
  if (runtime.command && runtime.command.state !== "active") {
    reevaluatePendingCommand(delta);
    return;
  }
  if (enforceActiveSafety()) return;
  if (runtime.phaseElapsed < runtime.phaseDuration) return;
  if (runtime.auto) {
    advanceAutomaticPhase();
  } else {
    runtime.phaseElapsed = runtime.phaseDuration;
  }
}

function phaseDescription(phaseId) {
  const descriptions = {
    all_stop: "所有方向保持停止，等待路口清空。",
    roosevelt_flow: "前後來車停止，KBot 左右向的羅斯福路車流放行。",
    clearance: "所有新進入均被封鎖，清除衝突區。",
    pedestrian_crossing: "車輛全停；行人由人行道抵達路緣，WALK 後才走行人穿越道。",
    lane90_release: "僅巷90單向車流可通過，其餘方向停止。",
  };
  return descriptions[phaseId] ?? "";
}

function updatePhaseUi() {
  const phase = runtime.rules.phases[runtime.currentPhaseId];
  ui.phaseLabel.textContent = phase.label_zh_tw;
  ui.phaseDescription.textContent = phaseDescription(runtime.currentPhaseId);
  ui.phaseSignal.className = "phase-signal";
  if (runtime.currentPhaseId === "pedestrian_crossing") {
    ui.phaseSignal.classList.add("is-walk");
  } else if (phase.allowed_movements.length > 0) {
    ui.phaseSignal.classList.add("is-go");
  } else {
    ui.phaseSignal.classList.add("is-stop");
  }
  updateCommandUi();
  updateSafetyUi();
}

const GESTURE_LABELS = Object.freeze({
  ALL_STOP: "手臂上舉／全向停止",
  STOP_FRONT_BACK_GO_LEFT_RIGHT: "兩臂平伸／前後停左右行",
  GO_FROM_LEFT: "左方來車招行",
});

const DECISION_REASON_LABELS = Object.freeze({
  immediate_all_stop: "全停具有最高優先權，已立即撤銷其他放行。",
  minimum_clearance: "KBot 維持全停；等待至少 2 秒的相位清空時間。",
  intersection_not_clear: "路口衝突區仍有車體，維持 KBot 全停與全紅。",
  crosswalk_not_clear: "行穿線車體包絡尚未保留 0.8 公尺淨空。",
  pedestrian_conflict: "行人仍在衝突區，車流放行被安全閘門阻擋。",
  downstream_not_clear: "下游堵塞，禁止新車進入路口。",
  gesture_stability: "路口已淨空；確認 KBot 指揮動作穩定 0.4 秒。",
  command_active: "安全閘門已通過，KBot、實景號誌與人車同步執行。",
  automatic_clearance: "自動循環進入全停清空相位。",
  invalid_command: "未知或不相符的手勢請求，已故障安全回到全停。",
});

function updateCommandUi() {
  const command = runtime.command;
  if (!command) return;
  const stateLabels = {
    active: "執行中",
    pending: "等待中",
    blocked: "已阻擋",
  };
  const requestedPhase = runtime.rules.phases[command.requestedPhaseId];
  const posePhase = runtime.rules.phases[runtime.kbotPosePhaseId]
    ?? runtime.rules.phases[runtime.currentPhaseId];
  ui.modeBadge.textContent = !runtime.auto
    ? "手動"
    : (command.source === "manual" ? "手動插入" : "自動");
  ui.commandDecision.dataset.state = command.state;
  ui.decisionState.textContent = stateLabels[command.state] ?? "安全停止";
  ui.requestedCommand.textContent = command.requestKind === "walk_signal"
    ? "行人 WALK（KBot 全停＋號誌）"
    : requestedPhase?.label_zh_tw ?? command.requestedPhaseId;
  ui.requestedGesture.textContent = command.requestKind === "walk_signal"
    ? "WALK 訊號請求"
    : GESTURE_LABELS[command.requestedGesture] ?? command.requestedGesture;
  ui.activeGesture.textContent = GESTURE_LABELS[posePhase.gesture]
    ?? posePhase.gesture;
  ui.candidatePhase.textContent = requestedPhase?.label_zh_tw
    ?? command.requestedPhaseId;
  ui.decisionReason.textContent = DECISION_REASON_LABELS[command.reasonCode]
    ?? command.reasonCode;

  for (const button of ui.commandButtons) {
    const requested = button.dataset.phase === command.requestedPhaseId;
    if (requested) button.dataset.requestState = command.state;
    else delete button.dataset.requestState;
    button.setAttribute(
      "aria-busy",
      String(requested && command.state === "pending"),
    );
    button.setAttribute(
      "aria-pressed",
      String(
        command.state === "active"
        && button.dataset.phase === runtime.currentPhaseId
      ),
    );
  }
}

function updateSafetyUi() {
  const locks = [];
  if (runtime.currentPhaseId === "clearance") locks.push("路口清空中");
  if (
    runtime.currentPhaseId === "clearance"
    && vehicleCrosswalkConflict()
  ) locks.push("行穿線尚未淨空 0.8 m");
  if (robotOnRoadway()) locks.push("KBot 於車道護送中");
  // §18:崗位預覽會把 KBot 從勤務狀態機摘出來釘在崗位上,面板要交代
  // 「為什麼他不動了」。安全閘門本身沒有放寬。
  if (runtime.kbotPostPreview) locks.push("崗位預覽中:KBot 暫離勤務");
  if (
    runtime.currentPhaseId !== "pedestrian_crossing"
    && pedestrianConflict()
    && !robotOnRoadway()
  ) locks.push("行人占用衝突區");
  if (runtime.downstreamBlocked) locks.push("下游堵塞");
  if (locks.length === 0) {
    ui.safetyLocks.innerHTML = `
      <span class="lock-pill is-safe">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
        安全閘門正常
      </span>`;
  } else {
    ui.safetyLocks.innerHTML = locks
      .map(
        (lock) => `
          <span class="lock-pill is-blocked">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>
            ${lock}
          </span>`,
      )
      .join("");
  }
}

function syncSignalAspects() {
  if (!runtime.rules || runtime.signalAspectNodes.length === 0) return;
  const phase = runtime.rules.phases[runtime.currentPhaseId];
  const allowed = new Set(phase.allowed_movements);
  for (const node of runtime.signalAspectNodes) {
    const { traffic_director_signal_aspect: aspect } = node.userData;
    const { traffic_director_signal_kind: kind } = node.userData;
    const { traffic_director_signal_movement: movement } = node.userData;
    if (kind === "vehicle") {
      // 場景本來就烘焙了 amber 燈殼,舊版從未點亮過;黃燈尾段點它。
      const amber = movementAmber(movement);
      node.visible = (
        (aspect === "green" && allowed.has(movement) && !amber)
        || (aspect === "amber" && amber)
        || (aspect === "red" && !allowed.has(movement))
      );
    } else if (kind === "pedestrian") {
      node.visible = (
        (aspect === "walk" && phase.pedestrian_walk)
        || (aspect === "red" && !phase.pedestrian_walk)
      );
    } else {
      node.visible = false;
    }
  }
}

function syncKbotPose() {
  if (!runtime.kbotMixer || runtime.kbotAnimations.length === 0) return;
  const candidatePose = (
    runtime.command
    && runtime.command.state === "pending"
    && runtime.command.reasonCode === "gesture_stability"
  );
  const posePhaseId = candidatePose
    ? runtime.command.requestedPhaseId
    : runtime.currentPhaseId;
  const entry = runtime.phases.find(
    (item) => item.phase === posePhaseId,
  );
  const fallback = runtime.phases.find((item) => item.phase === "all_stop");
  const phaseChanged = runtime.kbotPosePhaseId !== posePhaseId;
  if (phaseChanged) runtime.kbotGestureClock = 0;
  runtime.kbotPosePhaseId = posePhaseId;
  if (!kbotWalking()) {
    runtime.kbotYawTargetRad = kbotYawForPhase(posePhaseId);
  }
  // Only re-pin the mixer on a phase change; continuous playback is
  // advanced every frame by updateKbotGestureAnimation.
  if (!phaseChanged) return;
  const selected = entry ?? fallback;
  const sample = kbotMotionSample({
    phaseId: posePhaseId,
    elapsedS: 0,
    startFrame: selected.start_frame,
    fps: runtime.rules.simulation_constants.fps,
  });
  setKbotMixerTime(sample.clipTimeS);
}

// 站上人行道後的朝向表。座標細節:simulationRoot 帶 z 鏡射,鏡射共軛
// 會翻轉 y 軸旋轉方向,所以 holder.rotation.y = α 在模擬座標中把向量轉
// -α:facing(α) = (sin α, -cos α)(α=0 面向 -t,即面向車道)。
// 平時面向路口車流;放行巷90 時面向 -x(巷口來車)→ α = -π/2。
// 朝向一律由「注視點」推算,崗位換了、避車處換了都自動正確。
function kbotYawTowards(x, z) {
  const position = runtime.kbotHolder.position;
  const dx = x - position.x;
  const dz = z - position.z;
  if (Math.hypot(dx, dz) < 0.05) return runtime.kbotYawTargetRad;
  return Math.atan2(dx, -dz);
}

// 各相位的注視點:
//   lane90_release      → 巷口(招引巷內來車);
//   pedestrian_crossing → 東南向來車(他正在攔的那一股),身體側對
//                         行穿線,行人從他面前通過;
//   其餘(羅斯福路放行 / 全停 / 清空)→ 路面中心線,身體與羅斯福路
//     垂直,兩臂平伸才落在「前後停、左右行」的正確方位。
function kbotYawForPhase(phaseId) {
  if (!runtime.kbotHolder) return 0;
  const position = runtime.kbotHolder.position;
  if (phaseId === "lane90_release") {
    return kbotYawTowards(LANE90_MOUTH.x, LANE90_MOUTH.z);
  }
  if (phaseId === "pedestrian_crossing") {
    return kbotYawTowards(position.x + 8, position.z);
  }
  return kbotYawTowards(position.x, 0);
}

function normalizeAngle(radians) {
  let value = radians;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

function updateKbotYaw(delta) {
  if (!runtime.kbotHolder) return;
  if (!kbotWalking()) {
    runtime.kbotYawTargetRad = kbotYawForPhase(runtime.kbotPosePhaseId);
  }
  const current = runtime.kbotHolder.rotation.y;
  const target = runtime.kbotYawTargetRad;
  if (runtime.reducedMotion) {
    runtime.kbotHolder.rotation.y = target;
    return;
  }
  // 走最短角度,避免 atan2 跨 ±π 時繞遠路。
  const difference = normalizeAngle(target - current);
  const maxStep = 2.2 * delta;
  runtime.kbotHolder.rotation.y = current
    + THREE.MathUtils.clamp(difference, -maxStep, maxStep);
}

// ---- KBot 勤務狀態機:進場走入 → 斑馬線旁站位;每個行人相位沿斑馬線
// 邊走到護送點、相位尾端走回。走動中面向行進方向、播放烘焙步行循環;
// 動作效果關閉時直接就位、不巡走。
function kbotWalking() {
  return Boolean(runtime.kbotWalk.targets);
}

// 烘焙的步行循環是以 KBOT_WALK_DESIGN_SPEED 設計的,實際速度不同就
// 等比調整播放速率(§13)。
function kbotGaitRate() {
  return (runtime.kbotWalk.speed || KBOT_WALK_SPEED) / KBOT_WALK_DESIGN_SPEED;
}

function kbotStartWalk(targets, kind) {
  runtime.kbotWalk.targets = targets.map((point) => ({ ...point }));
  runtime.kbotWalk.kind = kind;
  runtime.kbotWalk.clock = 0;
  runtime.kbotWalk.speed = kind === "entry"
    ? KBOT_WALK_SPEED
    : KBOT_DUTY_SPEED;
}

function kbotNear(point, tolerance = 0.05) {
  const position = runtime.kbotHolder.position;
  return Math.hypot(position.x - point.x, position.z - point.z) < tolerance;
}

function kbotArrived() {
  const walk = runtime.kbotWalk;
  const kind = walk.kind;
  walk.targets = null;
  walk.kind = null;
  if (kind === "entry") walk.entryDone = true;
  runtime.kbotHolder.position.y = walk.baseY;
  runtime.kbotYawTargetRad = kbotYawForPhase(runtime.kbotPosePhaseId);
}

function updateKbotWalk(delta) {
  const walk = runtime.kbotWalk;
  if (!runtime.kbotHolder || !runtime.kbotReady) return;
  const position = runtime.kbotHolder.position;
  // 崗位預覽:接管勤務狀態機,把 KBot 釘在「目前選中的崗位」上,拖滑桿
  // 當幀就看得到他移動(不走路——拖曳中一步一步走會抖,而且看不出座標)。
  // 關掉預覽後下一幀就回到 kbotDutyTarget() 的常規決策,他會自己走回去。
  if (runtime.kbotPostPreview) {
    const post = KBOT_POSTS[runtime.kbotPostEditId] ?? KBOT_STAND;
    position.set(post.x, post.y, post.z);
    walk.baseY = post.y;
    walk.targets = null;
    walk.kind = null;
    walk.entryDone = true;
    runtime.kbotYawTargetRad = kbotYawForPhase(runtime.kbotPosePhaseId);
    return;
  }
  if (runtime.reducedMotion) {
    if (!walk.entryDone || walk.targets) {
      position.set(KBOT_STAND.x, KBOT_STAND.y, KBOT_STAND.z);
      walk.baseY = KBOT_STAND.y;
      walk.entryDone = true;
      walk.targets = null;
      walk.kind = null;
      runtime.kbotYawTargetRad = kbotYawForPhase(runtime.kbotPosePhaseId);
    }
    return;
  }

  if (walk.targets) {
    if (walk.kind === "duty") {
      // 走動途中相位變了就改道(仍沿行穿線中線換邊)。
      const desired = kbotDutyTarget();
      const final = walk.targets[walk.targets.length - 1];
      if (
        desired
        && Math.hypot(final.x - desired.x, final.z - desired.z) > 0.1
      ) {
        kbotStartWalk(kbotRouteTo(desired), "duty");
      }
    }
    let remaining = (walk.speed || KBOT_WALK_SPEED) * delta;
    while (remaining > 0 && walk.targets.length > 0) {
      const target = walk.targets[0];
      const dx = target.x - position.x;
      const dz = target.z - position.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= remaining || distance < 1e-6) {
        position.x = target.x;
        position.z = target.z;
        walk.baseY = target.y;
        walk.targets.shift();
        remaining -= distance;
        continue;
      }
      const step = remaining / distance;
      position.x += dx * step;
      position.z += dz * step;
      walk.baseY += (target.y - walk.baseY) * step;
      // 面向行進方向:facing(α) = (sin α, -cos α) ⇒ α = atan2(dx, -dz)。
      // (鏡射父節點使 +yaw 在模擬座標為 -α 旋轉;之前用 atan2(-dx,-dz)
      // 會在 ±x 向路段側著走。)
      runtime.kbotYawTargetRad = Math.atan2(dx, -dz);
      remaining = 0;
    }
    if (walk.targets && walk.targets.length === 0) {
      kbotArrived();
      return;
    }
    walk.bobPhase += delta * 4.7 * kbotGaitRate();
    position.y = walk.baseY + Math.abs(Math.sin(walk.bobPhase)) * 0.025;
    return;
  }

  // ---- 閒置決策:依相位走到對應崗位 ----
  if (!walk.entryDone) {
    walk.entryDelayS -= delta;
    if (walk.entryDelayS <= 0) kbotStartWalk(kbotEntryPath(), "entry");
    return;
  }
  const desired = kbotDutyTarget();
  if (desired && !kbotNear(desired, 0.12)) {
    kbotStartWalk(kbotRouteTo(desired), "duty");
  }
}

// 走完 kbotRouteFrom 產生的折線所需秒數。§16:舊版用直線距離,對「要換
// 邊」的路線最多低估 8.3 m / 6.2 s,預算算不準就會走到一半發現來不及。
function kbotTravelTimeS(from, to) {
  let length = 0;
  let previous = from;
  for (const point of kbotRouteFrom(from, to)) {
    length += Math.hypot(point.x - previous.x, point.z - previous.z);
    previous = point;
  }
  return length / KBOT_DUTY_SPEED;
}

// 最近的避車處(人行道轉角),回傳 holder 座標。
function kbotRefugeFor(x, z) {
  const refuge = nearestControllerRefuge(x, z);
  return {
    id: refuge.id,
    label: refuge.label,
    x: refuge.s,
    y: refuge.y,
    z: refuge.t,
  };
}

// 相位 → 這一刻該站的位置。四條規則:
//   1. 崗位只有「走得到且站得住」才去(去程+回避車處+最短駐留時間必須
//      塞得進相位剩餘秒數),否則就在安全處指揮——手勢照做,不做那種
//      走兩步就折返的假動作。
//   2. 已經站在本相位崗位上(且崗位本身是安全區)就留守到相位結束,不會
//      因為「回程預算」在最後幾秒被叫走(舊版讓巷90 只站得住 0.5 秒)。
//   3. 行人相位的崗位在車道畫線上,相位尾聲一定要退——退到人行道崗位
//      (CONTROLLER_REFUGES 已無公車站月台),沿同一條畫線正北直走。
//   4. 其餘相位一律回到 stand 崗位待命(舊版 return null = 原地不動,
//      實測會讓他永遠停在第一次退避的地方,一輪 65.7% 站在公車站)。
function kbotDutyTarget() {
  const position = runtime.kbotHolder.position;
  const phase = runtime.currentPhaseId;
  const held = runtime.phaseDuration >= 900;
  const remaining = runtime.phaseDuration - runtime.phaseElapsed;

  if (phase === "pedestrian_crossing") {
    const post = KBOT_POSTS.crosswalk;
    const refuge = kbotRefugeFor(post.x, post.z);
    const budget = kbotTravelTimeS(position, post)
      + kbotTravelTimeS(post, refuge)
      + KBOT_POST_MIN_DWELL_S;
    if (held || remaining > budget) return post;
    // 相位尾聲:沿畫線退回人行道崗位(不是公車站月台)。
    return robotOnRoadway()
      ? kbotRefugeFor(position.x, position.z)
      : KBOT_POSTS.stand;
  }

  if (phase === "lane90_release") {
    const post = KBOT_POSTS.lane90;
    const budget = kbotTravelTimeS(position, post) + KBOT_POST_MIN_DWELL_S;
    // 一旦上路就讓他走完:去程時間隨著接近同步縮短,這個判斷式在途中
    // 保持成立,不會走到一半掉頭。到崗後(巷口人行道=安全區)留守到
    // 相位結束,回程留給下一個相位走。
    if (held || remaining > budget || kbotNear(post, 1.0)) return post;
    return robotOnRoadway()
      ? kbotRefugeFor(position.x, position.z)
      : KBOT_POSTS.stand;
  }

  if (robotOnRoadway()) return kbotRefugeFor(position.x, position.z);
  return KBOT_POSTS.stand;
}

// 崗位/避車處之間的路線:同一側直走;要換邊一律沿直行行穿線中線
// (s = kbotCrossS(),即行人穿越道畫線的縱向中線)南北向穿越,絕不
// 斜切路口。kbotTravelTimeS 也走這支,預算與實走路徑才會一致。
function kbotRouteFrom(from, post) {
  const route = [];
  const crossS = kbotCrossS();
  if (Math.abs(from.z - post.z) >= 3.0) {
    if (Math.abs(from.x - crossS) > 0.6) {
      route.push({ x: crossS, y: from.y, z: from.z });
    }
    if (Math.abs(post.x - crossS) > 0.6) {
      route.push({ x: crossS, y: post.y, z: post.z });
    }
  }
  route.push({ x: post.x, y: post.y, z: post.z });
  return route;
}

function kbotRouteTo(post) {
  return kbotRouteFrom(runtime.kbotHolder.position, post);
}

// 姿勢連續性:任何 >0.2 s 的取樣時間跳躍(相位切換、殘餘 wrap)都先
// 快照全節點姿勢,之後 0.4 s 內以 smoothstep 由舊姿勢混合到新姿勢,
// 消除手勢瞬間跳變。
const kbotBlendQuat = new THREE.Quaternion();
const kbotBlendVec = new THREE.Vector3();

function captureKbotPose() {
  const model = runtime.kbotHolder?.children[0];
  if (!model || runtime.reducedMotion) return;
  const pose = [];
  model.traverse((node) => {
    pose.push({
      node,
      quaternion: node.quaternion.clone(),
      position: node.position.clone(),
    });
  });
  runtime.kbotBlend = { elapsed: 0, duration: 0.4, pose };
}

function setKbotMixerTime(clipTimeS) {
  if (Math.abs(clipTimeS - runtime.kbotSampleTimeS) > 0.2) captureKbotPose();
  runtime.kbotMixer.setTime(clipTimeS);
  runtime.kbotSampleTimeS = clipTimeS;
}

function applyKbotPoseBlend(delta) {
  const blend = runtime.kbotBlend;
  if (!blend) return;
  blend.elapsed += delta;
  const raw = Math.min(1, blend.elapsed / blend.duration);
  if (raw >= 1) {
    runtime.kbotBlend = null;
    return;
  }
  const eased = raw * raw * (3 - 2 * raw);
  for (const entry of blend.pose) {
    kbotBlendQuat.copy(entry.node.quaternion);
    entry.node.quaternion.copy(entry.quaternion).slerp(kbotBlendQuat, eased);
    kbotBlendVec.copy(entry.node.position);
    entry.node.position.copy(entry.position).lerp(kbotBlendVec, eased);
  }
}

function updateKbotGestureAnimation(delta) {
  updateKbotWalk(delta);
  updateKbotYaw(delta);
  if (
    !runtime.kbotMixer
    || runtime.kbotAnimations.length === 0
  ) return;
  if (kbotWalking()) {
    // 走動中(進場/護送/返回):播放 MuJoCo 烘焙的步行循環(取模無縫
    // 迴圈);起步/停步的姿勢跳躍由 setKbotMixerTime 的 crossfade 平滑。
    // 步態播放速率與實際步行速度等比:快走時腳步也跟著快,腳掌不打滑。
    runtime.kbotWalk.clock += delta * kbotGaitRate();
    if (!runtime.reducedMotion) {
      const fps = runtime.rules.simulation_constants.fps;
      const frame = KBOT_WALK_CLIP.loopStartFrame
        + ((runtime.kbotWalk.clock * fps) % KBOT_WALK_CLIP.loopSpanFrames);
      const clipTimeS = frame / fps;
      if (Math.abs(clipTimeS - runtime.kbotSampleTimeS) > 1e-5) {
        setKbotMixerTime(clipTimeS);
      }
    }
    applyKbotPoseBlend(delta);
    return;
  }
  const entry = runtime.phases.find(
    (item) => item.phase === runtime.kbotPosePhaseId,
  );
  if (!entry) return;
  runtime.kbotGestureClock += delta;
  const cycleFrames = Number(
    runtime.rules.gestures.GO_FROM_LEFT.beckon_cycle_frames ?? 24,
  );
  const sample = kbotMotionSample({
    phaseId: runtime.kbotPosePhaseId,
    elapsedS: runtime.kbotGestureClock,
    startFrame: entry.start_frame,
    endFrame: entry.end_frame,
    fps: runtime.rules.simulation_constants.fps,
    cycleFrames,
    animateGesture: (
      runtime.command?.state === "active"
      && runtime.currentPhaseId === "lane90_release"
    ),
    reducedMotion: runtime.reducedMotion,
  });
  if (Math.abs(sample.clipTimeS - runtime.kbotSampleTimeS) > 1e-5) {
    setKbotMixerTime(sample.clipTimeS);
  }
  applyKbotPoseBlend(delta);
}

// 目前 KBot 站在哪裡(給面板與錄影字卡看)。
function kbotStationLabel() {
  if (!runtime.kbotHolder || !runtime.kbotReady) return "進場中";
  if (kbotWalking()) return "移動中";
  const position = runtime.kbotHolder.position;
  for (const post of Object.values(KBOT_POSTS)) {
    if (Math.hypot(position.x - post.x, position.z - post.z) < 1.0) {
      return post.label;
    }
  }
  const refuge = nearestControllerRefuge(position.x, position.z);
  if (Math.hypot(refuge.s - position.x, refuge.t - position.z) < 1.2) {
    return refuge.label;
  }
  return robotOnRoadway() ? "車道上" : "人行道";
}

// 輪廓燈/補光燈跟著機器人走(舊版釘在固定站位,人一離開就變黑)。
function simulationPointFast(x, y, z, target) {
  return target.set(x, y, z).applyMatrix4(runtime.simulationRoot.matrixWorld);
}

const lightScratch = new THREE.Vector3();

function updateKbotLights() {
  if (!runtime.kbotRim || !runtime.kbotHolder || !runtime.kbotReady) return;
  const position = runtime.kbotHolder.position;
  runtime.kbotRim.position.copy(simulationPointFast(
    position.x - 4.5, 6.5, position.z - 3.5, lightScratch,
  ));
  runtime.kbotRim.target.position.copy(simulationPointFast(
    position.x, position.y + 1.03, position.z, lightScratch,
  ));
  runtime.kbotRim.target.updateMatrixWorld();
  runtime.kbotFill.position.copy(simulationPointFast(
    position.x + 2.8, 3.8, position.z + 1.6, lightScratch,
  ));
}

// ---------------------------------------------------------------------------
// §18 機器人崗位微調(頁面內即時調位工具)
//
// 設計前提:這是校正工具,不是新的預設行為。runtime.kbotPostPreview 預設
// false,關閉時整支模組只做兩件事——(a) 讀 KBOT_POSTS 的地方全部改成執行
// 期讀取(見 §18 常數註解),(b) 崗位標記隱藏。其餘行為、安全閘門、碰撞
// 計數、驗收 hook 一律與沒有這組 UI 時完全相同。
//
// 安全閘門刻意「不」放寬:把崗位拖到車道上,robotOnRoadway() 就會是 true,
// 羅斯福路放行照樣被鎖成 HOLD。使用者需求是「顯示出來讓他自己判斷」,所以
// 面板用紅色 pill 明說後果,而不是禁止他拖。
// ---------------------------------------------------------------------------

// BRT 中央分向島:直行行穿線外框內、但實際沒有畫線的空白帶(§16 實測,
// 由 28 條 MainCrosswalk_Straight656_Stripe_* 的包圍盒解出)。
const CROSSWALK_STRAIGHT_GAP_T = Object.freeze({ tMin: -1.73, tMax: 2.52 });

const KBOT_POST_RANGES = Object.freeze({
  x: Object.freeze({ min: -20, max: 26 }),
  z: Object.freeze({ min: -18, max: 18 }),
  y: Object.freeze({ min: 0, max: 0.4 }),
});

function kbotPostMarkerMaterials() {
  return {
    ring: new THREE.MeshBasicMaterial({
      color: 0x6fe3a8, transparent: true, opacity: 0.85, depthWrite: false,
      side: THREE.DoubleSide,
    }),
    pole: new THREE.MeshBasicMaterial({
      color: 0x6fe3a8, transparent: true, opacity: 0.55, depthWrite: false,
    }),
  };
}

// 三個崗位標記(環 + 立柱),只在預覽開啟時顯示。
function buildKbotPostMarkers() {
  const group = new THREE.Group();
  group.name = "Runtime_KbotPostMarkers";
  group.visible = false;
  const ringGeometry = new THREE.RingGeometry(0.55, 0.78, 28);
  const poleGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1.9, 8);
  const markers = {};
  for (const id of KBOT_POST_IDS) {
    const marker = new THREE.Group();
    marker.name = `KbotPostMarker_${id}`;
    const materials = kbotPostMarkerMaterials();
    const ring = new THREE.Mesh(ringGeometry, materials.ring);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    marker.add(ring);
    const pole = new THREE.Mesh(poleGeometry, materials.pole);
    pole.position.y = 0.95;
    marker.add(pole);
    marker.userData.markerMaterials = materials;
    marker.userData.poleMesh = pole;
    group.add(marker);
    markers[id] = marker;
  }
  group.userData.markers = markers;
  return group;
}

function updateKbotPostMarkers() {
  const group = runtime.kbotPostMarkers;
  if (!group) return;
  // §21:「加畫標線」圖層關掉時,崗位標記一起收起來。
  group.visible = runtime.kbotPostPreview && layerEnabled("markings");
  if (!group.visible) return;
  for (const id of KBOT_POST_IDS) {
    const post = KBOT_POSTS[id];
    const marker = group.userData.markers[id];
    marker.position.set(post.x, post.y - 0.02, post.z);
    const selected = id === runtime.kbotPostEditId;
    const safe = controllerSafeZone(post.x, post.z) !== null;
    const color = safe ? 0x6fe3a8 : 0xff7d72;
    const { ring, pole } = marker.userData.markerMaterials;
    ring.color.setHex(color);
    pole.color.setHex(color);
    ring.opacity = selected ? 0.92 : 0.34;
    pole.opacity = 0.42;
    // 選中的崗位站著 KBot 本人,立柱會從他身體穿出去;那根柱子只是給沒站
    // 人的另外兩個崗位當「遠處看得到」的指示,選中時收起來。
    marker.userData.poleMesh.visible = !selected;
  }
}

function kbotPostVerdict(post) {
  const zone = controllerSafeZone(post.x, post.z);
  const zoneLabels = {
    sidewalk_pos: "水源市場側人行道",
    sidewalk_neg: "對側人行道",
    platform_se: "中央公車站月台(東南向)",
    platform_nw: "中央公車站月台(西北向)",
  };
  const band = CROSSWALK_BANDS.find(
    (entry) => post.x >= entry.sMin && post.x <= entry.sMax
      && post.z >= entry.tMin && post.z <= entry.tMax,
  ) ?? null;
  const inStraightGap = band?.id === "straight"
    && post.z > CROSSWALK_STRAIGHT_GAP_T.tMin
    && post.z < CROSSWALK_STRAIGHT_GAP_T.tMax;
  const blocksPedestrians = post.x >= STRAIGHT_CROSS_CORRIDOR.sMin - 0.6
    && post.x <= STRAIGHT_CROSS_CORRIDOR.sMax + 0.6
    && Math.abs(post.z) <= ROAD_HALF_WIDTH;
  const refuge = nearestControllerRefuge(post.x, post.z);
  return {
    zone,
    zoneLabel: zone ? zoneLabels[zone] ?? zone : null,
    onRoadway: zone === null,
    bandId: band?.id ?? null,
    inStraightGap,
    blocksPedestrians,
    refugeLabel: refuge?.label ?? null,
    refugeDistance: refuge
      ? Math.hypot(refuge.s - post.x, refuge.t - post.z)
      : null,
  };
}

function pillHtml(kind, text) {
  let icon = '<path d="m5 12 4 4L19 6"/>';
  if (kind === "is-blocked") {
    icon = '<path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/>';
  } else if (kind === "is-note") {
    // 中性項目用實心點,不要用打勾——打勾會被讀成「這項通過」。
    icon = '<circle cx="12" cy="12" r="4" fill="currentcolor"/>';
  }
  return `<span class="lock-pill ${kind}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
      ${text}
    </span>`;
}

function updateKbotPostVerdictUi() {
  if (!ui.kbotPostVerdict) return;
  const post = KBOT_POSTS[runtime.kbotPostEditId];
  const verdict = kbotPostVerdict(post);
  const pills = [];
  pills.push(verdict.onRoadway
    ? pillHtml("is-blocked", "在車道上 — 實跑會鎖住羅斯福路放行(HOLD)")
    : pillHtml("is-safe", `安全區:${verdict.zoneLabel}`));
  if (verdict.bandId === "straight" && verdict.inStraightGap) {
    pills.push(pillHtml(
      "is-blocked",
      "落在 BRT 中央分向島(行穿線外框內、但沒有畫線)",
    ));
  } else if (verdict.bandId) {
    pills.push(pillHtml("is-note", `在行穿線畫線帶(${verdict.bandId})`));
  } else {
    pills.push(pillHtml("is-note", "不在行穿線畫線帶"));
  }
  pills.push(verdict.blocksPedestrians
    ? pillHtml("is-blocked", "擋在行人穿越走廊上(行人會穿過身體)")
    : pillHtml("is-note", "不擋行人穿越走廊"));
  if (verdict.refugeLabel) {
    pills.push(pillHtml(
      "is-note",
      `最近避車處 ${verdict.refugeLabel} ${verdict.refugeDistance.toFixed(1)} m`,
    ));
  }
  ui.kbotPostVerdict.innerHTML = pills.join("");
}

// 滑桿讀數一律從 runtime 的崗位值來(不從 input.value):range 元素會把值
// 對齊到 step 網格,若讀 input.value 就有機會把 8.33 這種預設值悄悄改掉。
function syncKbotPostInputs() {
  const post = KBOT_POSTS[runtime.kbotPostEditId];
  for (const [input, key, output] of runtime.kbotPostInputs ?? []) {
    input.value = String(post[key]);
    if (output) output.textContent = `${post[key].toFixed(2)} m`;
  }
  if (ui.kbotPostTarget) ui.kbotPostTarget.value = runtime.kbotPostEditId;
  updateKbotPostMarkers();
  updateKbotPostVerdictUi();
}

function applyKbotPostFromInputs() {
  const post = KBOT_POSTS[runtime.kbotPostEditId];
  for (const [input, key, output] of runtime.kbotPostInputs ?? []) {
    const range = KBOT_POST_RANGES[key];
    const value = Math.round(THREE.MathUtils.clamp(
      Number.parseFloat(input.value) || 0, range.min, range.max,
    ) * 100) / 100;
    post[key] = value;
    if (output) output.textContent = `${value.toFixed(2)} m`;
  }
  onKbotPostsChanged();
}

// 崗位值變了之後統一走這支:標記、判定文字、以及(預覽開啟時)機器人本體
// 都在同一幀更新,不必等下一個相位。
function onKbotPostsChanged() {
  syncParamRowsIfReady();
  updateKbotPostMarkers();
  updateKbotPostVerdictUi();
  if (runtime.kbotPostPreview && runtime.kbotHolder && runtime.kbotReady) {
    updateKbotWalk(0);
    updateKbotLights();
  }
}

function formatPostNumber(value) {
  return Number(value).toFixed(2);
}

// 可以直接貼回 traffic_director.js 的 KBOT_POSTS_DEFAULT 字面量。
function kbotPostExportCode() {
  const body = KBOT_POST_IDS.map((id) => {
    const post = KBOT_POSTS[id];
    return `  ${id}: Object.freeze({\n`
      + `    id: "${post.id}", label: "${post.label}",`
      + ` x: ${formatPostNumber(post.x)},`
      + ` y: ${formatPostNumber(post.y)},`
      + ` z: ${formatPostNumber(post.z)},\n`
      + "  }),";
  }).join("\n");
  return [
    "// 由 viewer 的「機器人崗位微調」匯出(§18)。貼回 traffic_director.js",
    "// 的 KBOT_POSTS_DEFAULT,並同步下列鏡像,否則 node 測試會綠著騙人:",
    "//   mujoco/test_v4_direction_and_turns.mjs 的 POSTS",
    "//   SPEC_VIEWER_V2.md 的崗位座標表",
    "// 改完務必跑 python3 mujoco/stamp_versions.py。",
    "const KBOT_POSTS_DEFAULT = Object.freeze({",
    body,
    "});",
    "",
  ].join("\n");
}

function showKbotPostExport(code, note) {
  if (!ui.kbotPostExport) return;
  ui.kbotPostExport.value = code;
  ui.kbotPostExport.hidden = false;
  ui.kbotPostExport.focus({ preventScroll: true });
  ui.kbotPostExport.select();
  if (ui.kbotPostCopyNote) ui.kbotPostCopyNote.textContent = note;
}

function copyKbotPosts() {
  const code = kbotPostExportCode();
  if (ui.kbotPostExport) ui.kbotPostExport.value = code;
  const fallback = () => showKbotPostExport(
    code, "無法寫入剪貼簿,已展開程式碼片段(已全選,請按 ⌘C)。",
  );
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    fallback();
    return Promise.resolve(false);
  }
  return clipboard.writeText(code).then(
    () => {
      if (ui.kbotPostCopyNote) {
        ui.kbotPostCopyNote.textContent = "已複製 KBOT_POSTS_DEFAULT 片段到剪貼簿。";
      }
      return true;
    },
    () => {
      fallback();
      return false;
    },
  );
}

function resetKbotPosts() {
  for (const id of KBOT_POST_IDS) {
    Object.assign(KBOT_POSTS[id], KBOT_POSTS_DEFAULT[id]);
  }
  if (ui.kbotPostExport) ui.kbotPostExport.hidden = true;
  if (ui.kbotPostCopyNote) ui.kbotPostCopyNote.textContent = "已還原出廠座標。";
  syncKbotPostInputs();
  onKbotPostsChanged();
}

function setKbotPostPreview(enabled) {
  runtime.kbotPostPreview = Boolean(enabled);
  if (ui.kbotPostPreview) ui.kbotPostPreview.checked = runtime.kbotPostPreview;
  onKbotPostsChanged();
  if (!runtime.kbotPostPreview) updateKbotPostMarkers();
  updateSafetyUi();
}

function setupKbotPostEditor() {
  if (!ui.kbotPostS) return;
  runtime.kbotPostInputs = [
    [ui.kbotPostS, "x", ui.kbotPostSValue],
    [ui.kbotPostT, "z", ui.kbotPostTValue],
    [ui.kbotPostY, "y", ui.kbotPostYValue],
  ];
  for (const [input] of runtime.kbotPostInputs) {
    // input = 拖曳中即時更新;change = 鍵盤/驗收腳本寫入 .value 後的落值。
    input.addEventListener("input", applyKbotPostFromInputs);
    input.addEventListener("change", applyKbotPostFromInputs);
  }
  bindSegmented(ui.kbotPostSegmented, ui.kbotPostTarget, "post");
  ui.kbotPostTarget.addEventListener("change", () => {
    runtime.kbotPostEditId = KBOT_POST_IDS.includes(ui.kbotPostTarget.value)
      ? ui.kbotPostTarget.value
      : "stand";
    syncKbotPostInputs();
    onKbotPostsChanged();
  });
  ui.kbotPostPreview.addEventListener("change", () => {
    setKbotPostPreview(ui.kbotPostPreview.checked);
  });
  ui.kbotPostCopy.addEventListener("click", () => {
    copyKbotPosts();
  });
  ui.kbotPostReset.addEventListener("click", resetKbotPosts);
  syncKbotPostInputs();
}

function updateMetrics() {
  ui.vehicleCount.textContent = String(runtime.vehicles.length);
  ui.pedestrianCount.textContent = String(runtime.pedestrians.length);
  ui.crossingCount.textContent = String(
    runtime.pedestrians.filter((pedestrian) => pedestrian.state === "crossing").length,
  );
  const counts = vehicleTypeCounts();
  ui.carCount.textContent = String(counts.car);
  ui.scooterCount.textContent = String(counts.scooter);
  ui.motorcycleCount.textContent = String(counts.motorcycle);
  ui.busCount.textContent = String(counts.bus);
  ui.bicycleCount.textContent = String(counts.bicycle);
  ui.sidewalkPedestrianCount.textContent = String(runtime.pedestrians.length);
  ui.throughputCount.textContent = String(runtime.throughput);
  ui.collisionCount.textContent = String(runtime.collisions);
  ui.hookWaitCount.textContent = String(runtime.vehicles.filter(
    (actor) => actor.turnState === "hook_wait",
  ).length);
  ui.boardingCount.textContent = String(runtime.busBoardings);
  ui.kbotPostLabel.textContent = kbotStationLabel();
  const remaining = Math.max(0, runtime.phaseDuration - runtime.phaseElapsed);
  ui.phaseCountdown.textContent = (
    runtime.command?.state !== "active" || runtime.phaseDuration >= 900
  )
    ? "HOLD"
    : remaining.toFixed(1).padStart(4, "0");
}

function populateSources() {
  ui.sourceList.replaceChildren();
  for (const source of runtime.rules.sources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = source.title_zh_tw;
    item.append(link);
    ui.sourceList.append(item);
  }
  ui.ruleSetLabel.textContent = runtime.rules.rule_set_id;
}

// 相位節奏預設(SPEC_VIEWER_V2 §13)。Blender demo_timeline 的原始秒數
// (羅斯福路 8s / 行人 25.5s / 巷90 5s)拿來錄影並不合理:幹道綠燈太短、
// 巷90 短到機器人走不到巷口。這裡提供三組可切換的節奏,預設「標準」。
const PACING_PRESETS = Object.freeze({
  brisk: Object.freeze({
    label: "快速", roosevelt_flow: 16, pedestrian_crossing: 14, lane90_release: 10,
  }),
  standard: Object.freeze({
    label: "標準", roosevelt_flow: 24, pedestrian_crossing: 24, lane90_release: 16,
  }),
  filming: Object.freeze({
    label: "錄影", roosevelt_flow: 32, pedestrian_crossing: 30, lane90_release: 22,
  }),
});

function applyPacingPreset(presetId) {
  const preset = PACING_PRESETS[presetId] ?? PACING_PRESETS.standard;
  for (const phaseId of [
    "roosevelt_flow", "pedestrian_crossing", "lane90_release",
  ]) {
    runtime.phaseSeconds[phaseId] = preset[phaseId];
  }
  for (const [input, phaseId] of runtime.durationInputs ?? []) {
    input.value = String(preset[phaseId]);
  }
  syncDurationOutputs();
  syncParamRowsIfReady();
}

// 滑桿旁的即時秒數。applyPacingPreset 與驗收腳本(直接寫 .value 再送
// change)都會改動滑桿,所以讀值一律走這支,不靠 input 事件。
function syncDurationOutputs() {
  for (const [input, , output] of runtime.durationInputs ?? []) {
    if (output) output.textContent = `${Math.round(Number(input.value) || 0)} 秒`;
  }
}

// 分段按鈕與隱藏 <select> 的雙向繫結:按鈕改值後轉發 change,select 被
// 外部(驗收腳本)改值時也回頭把 is-active 對上,兩條路徑共用同一個來源。
function bindSegmented(container, select, datasetKey) {
  const buttons = [...container.querySelectorAll("button")];
  const sync = () => {
    for (const button of buttons) {
      button.classList.toggle(
        "is-active", button.dataset[datasetKey] === select.value,
      );
    }
  };
  for (const button of buttons) {
    button.addEventListener("click", () => {
      if (select.value === button.dataset[datasetKey]) return;
      select.value = button.dataset[datasetKey];
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  select.addEventListener("change", sync);
  sync();
}

// 機車待轉區預設關閉:那組方框標線是模擬執行期加畫的,實景 GLB 沒有。
// 關閉時連帶收掉加畫標線與「待轉中」計數,巷90 機慢車一律右轉。
function applyHookTurnSetting(enabled) {
  runtime.hookTurnEnabled = enabled;
  // §21:圖層開關是另一層 AND(兩個都開才畫)。
  if (runtime.hookTurnBox) {
    runtime.hookTurnBox.visible = enabled && layerEnabled("markings");
  }
  if (ui.hookWaitChip) ui.hookWaitChip.hidden = !enabled;
}

// 改了塗裝色之後重新上色目前場上的 KBot(材質是共用的,直接重跑上色即可)。
function repaintKbot() {
  if (runtime.kbotModel) applyKbotGreenTint(runtime.kbotModel);
}

// ---------------------------------------------------------------------------
// §19 參數登錄表(viewer 段)
//
// 只放「綁定住在這個檔案」的參數;core 的那 57 個由 coreParamDefs() 提供。
// 相位秒數與 KBot 崗位本來就有專屬 UI(§15/§18),這裡一併登錄,讓「全部
// 參數」是唯一的完整清單 —— set 之後會回頭同步原本那些控制項。
// ---------------------------------------------------------------------------
const PHASE_SECOND_PARAMS = [
  ["roosevelt_flow", "羅斯福路綠燈"],
  ["pedestrian_crossing", "行人穿越綠燈"],
  ["lane90_release", "巷90 放行"],
];

function phaseSecondParam(phaseId, label) {
  return {
    id: `signal.${phaseId}`,
    group: "signal",
    label: `${label}秒數`,
    unit: "秒",
    min: 3,
    max: 120,
    step: 1,
    apply: "live",
    get: () => Math.round(phaseDurationForId(phaseId)),
    set: (v) => {
      runtime.phaseSeconds[phaseId] = v;
      const entry = (runtime.durationInputs ?? [])
        .find(([, id]) => id === phaseId);
      if (entry) {
        entry[0].value = String(v);
        syncDurationOutputs();
      }
    },
  };
}

function kbotPostParam(postId, axis, label) {
  const range = KBOT_POST_RANGES[axis];
  return {
    id: `kbot.${postId}.${axis}`,
    group: "kbot",
    label,
    unit: "m",
    min: range.min,
    max: range.max,
    step: 0.01,
    apply: "live",
    get: () => KBOT_POSTS[postId][axis],
    set: (v) => {
      KBOT_POSTS[postId][axis] = Math.round(v * 100) / 100;
      if (postId === runtime.kbotPostEditId) syncKbotPostInputs();
      onKbotPostsChanged();
    },
  };
}

function colorParam(id, group, label, read, write) {
  return {
    id, group, label, unit: "", kind: "color",
    min: 0, max: 0xffffff, step: 1, apply: "respawn",
    get: read, set: write,
  };
}

function viewerParamDefs() {
  const defs = [];
  for (const [phaseId, label] of PHASE_SECOND_PARAMS) {
    defs.push(phaseSecondParam(phaseId, label));
  }
  defs.push(
    {
      id: "signal.amberTail", group: "signal", label: "黃燈尾段",
      unit: "秒", min: 0, max: 10, step: 0.5, apply: "live",
      get: () => AMBER_TAIL_S, set: (v) => { AMBER_TAIL_S = v; },
    },
    {
      id: "signal.conflictHalfLength", group: "signal", label: "路口衝突區半長",
      unit: "m", min: 2, max: 30, step: 0.5, apply: "live",
      get: () => CONFLICT_HALF_LENGTH, set: (v) => { CONFLICT_HALF_LENGTH = v; },
    },
    {
      id: "signal.crosswalkMargin", group: "signal", label: "行穿線淨空餘裕",
      unit: "m", min: 0, max: 5, step: 0.1, apply: "live",
      get: () => CROSSWALK_CLEARANCE_MARGIN,
      set: (v) => { CROSSWALK_CLEARANCE_MARGIN = v; },
    },

    {
      id: "following.minBumperGap", group: "following", label: "跟車最小保桿間距",
      unit: "m", min: 0.5, max: 12, step: 0.1, apply: "live",
      get: () => FOLLOW_MIN_BUMPER_GAP_M,
      set: (v) => { FOLLOW_MIN_BUMPER_GAP_M = v; },
    },
    {
      id: "following.roadHalfWidth", group: "following", label: "路面半寬",
      unit: "m", min: 5, max: 40, step: 0.5, apply: "respawn", calib: true,
      get: () => ROAD_HALF_WIDTH, set: (v) => { ROAD_HALF_WIDTH = v; },
    },
    {
      id: "following.sceneLength", group: "following", label: "場景縱深",
      unit: "m", min: 60, max: 400, step: 5, apply: "respawn", calib: true,
      get: () => SCENE_LENGTH, set: (v) => { SCENE_LENGTH = v; },
    },

    {
      id: "speed.lane90Turn", group: "speed", label: "巷90 轉彎速限",
      unit: "m/s", min: 0.5, max: 12, step: 0.1, apply: "live",
      get: () => LANE90_TURN_SPEED, set: (v) => { LANE90_TURN_SPEED = v; },
    },

    {
      id: "kbot.walkSpeed", group: "kbot", label: "走路速度",
      unit: "m/s", min: 0.2, max: 3, step: 0.05, apply: "live",
      get: () => KBOT_WALK_SPEED, set: (v) => { KBOT_WALK_SPEED = v; },
    },
    {
      id: "kbot.dutySpeed", group: "kbot", label: "勤務轉移速度",
      unit: "m/s", min: 0.2, max: 4, step: 0.05, apply: "live",
      get: () => KBOT_DUTY_SPEED, set: (v) => { KBOT_DUTY_SPEED = v; },
    },
    {
      id: "kbot.postMinDwell", group: "kbot", label: "值得走過去的最短駐留",
      unit: "秒", min: 0, max: 20, step: 0.5, apply: "live",
      get: () => KBOT_POST_MIN_DWELL_S,
      set: (v) => { KBOT_POST_MIN_DWELL_S = v; },
    },
    {
      id: "kbot.entryDelay", group: "kbot", label: "進場延遲",
      unit: "秒", min: 0, max: 30, step: 0.5, apply: "respawn",
      get: () => KBOT_ENTRY_DELAY_S, set: (v) => { KBOT_ENTRY_DELAY_S = v; },
    },
  );
  for (const postId of KBOT_POST_IDS) {
    const label = KBOT_POSTS[postId].label;
    defs.push(kbotPostParam(postId, "x", `崗位 ${label}｜x`));
    defs.push(kbotPostParam(postId, "y", `崗位 ${label}｜y`));
    defs.push(kbotPostParam(postId, "z", `崗位 ${label}｜z`));
  }
  defs.push(
    {
      id: "pedestrian.modelHeight", group: "pedestrian", label: "行人模型基準身高",
      unit: "m", min: 1.0, max: 2.2, step: 0.005, apply: "respawn",
      get: () => PEDESTRIAN_MODEL_HEIGHT_M,
      set: (v) => { PEDESTRIAN_MODEL_HEIGHT_M = v; },
    },
    {
      id: "pedestrian.walkCycleMps", group: "pedestrian", label: "步態循環基準速度",
      unit: "m/s", min: 0.2, max: 3, step: 0.01, apply: "live",
      get: () => PEDESTRIAN_WALK_CYCLE_MPS,
      set: (v) => { PEDESTRIAN_WALK_CYCLE_MPS = v; },
    },

    {
      id: "render.performanceFps", group: "render", label: "高效能目標張數",
      unit: "fps", min: 15, max: 144, step: 1, apply: "live",
      get: () => RENDER_PROFILES.performance.targetFps,
      set: (v) => {
        RENDER_PROFILES = Object.freeze({
          ...RENDER_PROFILES,
          performance: Object.freeze({
            ...RENDER_PROFILES.performance, targetFps: v,
          }),
        });
        applyRenderProfile(runtime.renderProfile?.id ?? "performance");
      },
    },
    {
      id: "render.powersaveFps", group: "render", label: "省電目標張數",
      unit: "fps", min: 10, max: 120, step: 1, apply: "live",
      get: () => RENDER_PROFILES.powersave.targetFps,
      set: (v) => {
        RENDER_PROFILES = Object.freeze({
          ...RENDER_PROFILES,
          powersave: Object.freeze({
            ...RENDER_PROFILES.powersave, targetFps: v,
          }),
        });
        applyRenderProfile(runtime.renderProfile?.id ?? "performance");
      },
    },
    {
      id: "render.maxPixelRatio", group: "render", label: "高效能最大像素比",
      unit: "×", min: 0.5, max: 3, step: 0.05, apply: "live",
      get: () => RENDER_PROFILES.performance.maxPixelRatio,
      set: (v) => {
        RENDER_PROFILES = Object.freeze({
          ...RENDER_PROFILES,
          performance: Object.freeze({
            ...RENDER_PROFILES.performance, maxPixelRatio: v,
          }),
        });
        applyRenderProfile(runtime.renderProfile?.id ?? "performance");
      },
    },
    {
      id: "render.uiUpdateHz", group: "render", label: "面板更新頻率",
      unit: "Hz", min: 1, max: 30, step: 1, apply: "live",
      get: () => RENDER_PROFILES.performance.uiUpdateHz,
      set: (v) => {
        RENDER_PROFILES = Object.freeze({
          ...RENDER_PROFILES,
          performance: Object.freeze({
            ...RENDER_PROFILES.performance, uiUpdateHz: v,
          }),
        });
        applyRenderProfile(runtime.renderProfile?.id ?? "performance");
      },
    },
    {
      id: "render.exposure", group: "render", label: "曝光",
      unit: "", min: 0.2, max: 3, step: 0.01, apply: "live",
      get: () => LIGHTING.exposure,
      set: (v) => {
        LIGHTING = { ...LIGHTING, exposure: v };
        if (renderer) renderer.toneMappingExposure = v;
      },
    },
    {
      id: "render.hemiIntensity", group: "render", label: "環境光強度",
      unit: "", min: 0, max: 6, step: 0.05, apply: "live",
      get: () => LIGHTING.hemisphere,
      set: (v) => {
        LIGHTING = { ...LIGHTING, hemisphere: v };
        if (runtime.hemiLight) runtime.hemiLight.intensity = v;
      },
    },
    {
      id: "render.sunIntensity", group: "render", label: "陽光強度",
      unit: "", min: 0, max: 10, step: 0.05, apply: "live",
      get: () => LIGHTING.sun,
      set: (v) => {
        LIGHTING = { ...LIGHTING, sun: v };
        if (runtime.sunLight) runtime.sunLight.intensity = v;
      },
    },

    colorParam("appearance.kbotBody", "appearance", "KBot 殼體色",
      () => KBOT_GREEN_TINT.body_black,
      (v) => {
        KBOT_GREEN_TINT = Object.freeze({
          ...KBOT_GREEN_TINT, body_black: v, orca_black: v,
        });
        repaintKbot();
      }),
    colorParam("appearance.kbotJoint", "appearance", "KBot 關節色",
      () => KBOT_GREEN_TINT.joint_graphite,
      (v) => {
        KBOT_GREEN_TINT = Object.freeze({
          ...KBOT_GREEN_TINT, joint_graphite: v,
        });
        repaintKbot();
      }),
    colorParam("appearance.tyre", "appearance", "輪胎色",
      () => TYRE_COLOR, (v) => { TYRE_COLOR = v; }),
    colorParam("appearance.rim", "appearance", "輪圈色",
      () => RIM_COLOR, (v) => { RIM_COLOR = v; }),
    colorParam("appearance.hub", "appearance", "輪轂色",
      () => HUB_COLOR, (v) => { HUB_COLOR = v; }),
  );
  return defs;
}

// ---------------------------------------------------------------------------
// §19 「全部參數」面板:由登錄表自動長出控制項
//
// 手刻 90 個滑桿不可維護,所以 UI 完全由 paramRegistry.defs() 產生。
// 之後新增參數只要往 coreParamDefs()/viewerParamDefs() 加一筆,面板自動出現。
// ---------------------------------------------------------------------------
let paramRegistry = null;
const paramRows = new Map();

// 專屬 UI(相位秒數滑桿、崗位微調)也會直接改底層值,改完要回頭把登錄表
// 那幾列對上,否則同一個參數在兩個地方顯示不同數字。
function syncParamRowsIfReady() {
  if (!paramRegistry) return;
  syncAllParamRows();
}

function paramDisplayValue(def) {
  const value = def.get();
  if (def.kind === "color") {
    return `#${Math.round(value).toString(16).padStart(6, "0")}`;
  }
  const decimals = def.step >= 1 ? 0 : (def.step >= 0.1 ? 1 : 2);
  return `${value.toFixed(decimals)}${def.unit ? ` ${def.unit}` : ""}`;
}

function syncParamRow(id) {
  const row = paramRows.get(id);
  if (!row) return;
  const def = paramRegistry.def(id);
  const value = def.get();
  if (def.kind === "color") {
    row.color.value = `#${Math.round(value).toString(16).padStart(6, "0")}`;
  } else {
    row.slider.value = String(value);
    row.number.value = String(Number(value.toFixed(4)));
  }
  row.readout.textContent = paramDisplayValue(def);
  const dirty = paramRegistry.isDirty(id);
  row.element.classList.toggle("is-dirty", dirty);
  row.reset.disabled = !dirty;
}

function syncAllParamRows() {
  for (const id of paramRows.keys()) syncParamRow(id);
  updateParamSummary();
}

function updateParamSummary() {
  if (!ui.paramDirtyCount) return;
  const dirty = paramRegistry.dirtyIds();
  ui.paramDirtyCount.textContent = String(dirty.length);
  ui.paramSummary.classList.toggle("is-dirty", dirty.length > 0);
}

// respawn 類參數改了只影響下次生成,所以要提示、並提供一鍵重新產生。
function noteParamNeedsRespawn(def) {
  if (!ui.paramRespawnNote) return;
  if (def.apply !== "respawn") return;
  ui.paramRespawnNote.hidden = false;
}

function commitParam(id, rawValue, { fromSlider = false } = {}) {
  const def = paramRegistry.def(id);
  const applied = paramRegistry.set(id, rawValue);
  if (applied === null) return;
  noteParamNeedsRespawn(def);
  paramRegistry.save();
  syncParamRow(id);
  updateParamSummary();
  // 同組其他列可能被連動(例如崗位 x 會改變安全區判定文字)
  if (def.group === "kbot" && !fromSlider) updateKbotPostVerdictUi();
}

function buildParamRow(def) {
  const row = document.createElement("div");
  row.className = "param-row";
  row.dataset.paramId = def.id;
  row.dataset.search = `${def.id} ${def.label}`.toLowerCase();

  const head = document.createElement("div");
  head.className = "param-row-head";
  const name = document.createElement("strong");
  name.textContent = def.label;
  const readout = document.createElement("output");
  readout.className = "param-readout";
  head.append(name, readout);

  const controls = document.createElement("div");
  controls.className = "param-row-controls";

  let slider = null;
  let number = null;
  let color = null;
  if (def.kind === "color") {
    color = document.createElement("input");
    color.type = "color";
    color.className = "param-color";
    color.addEventListener("input", () => {
      commitParam(def.id, Number.parseInt(color.value.slice(1), 16));
    });
    controls.append(color);
  } else {
    slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(def.min);
    slider.max = String(def.max);
    slider.step = String(def.step);
    slider.className = "param-slider";
    slider.addEventListener("input", () => {
      commitParam(def.id, Number(slider.value), { fromSlider: true });
    });

    number = document.createElement("input");
    number.type = "number";
    number.min = String(def.min);
    number.max = String(def.max);
    number.step = String(def.step);
    number.className = "param-number";
    number.addEventListener("change", () => {
      commitParam(def.id, Number(number.value));
    });
    controls.append(slider, number);
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "param-reset";
  reset.title = "還原這一項的預設值";
  reset.textContent = "↺";
  reset.addEventListener("click", () => {
    paramRegistry.reset(def.id);
    noteParamNeedsRespawn(def);
    paramRegistry.save();
    syncParamRow(def.id);
    updateParamSummary();
  });
  controls.append(reset);

  const meta = document.createElement("small");
  meta.className = "param-meta";
  const applyLabel = def.apply === "respawn" ? "需重新產生" : "即時生效";
  meta.textContent = `${def.id}　·　${applyLabel}`;

  row.append(head, controls, meta);
  paramRows.set(def.id, {
    element: row, slider, number, color, readout, reset,
  });
  return row;
}

function buildParamPanel() {
  const host = ui.paramGroups;
  if (!host) return;
  host.textContent = "";
  paramRows.clear();
  const defs = paramRegistry.defs();
  for (const group of PARAM_GROUPS) {
    const members = defs.filter((def) => def.group === group.id);
    if (members.length === 0) continue;

    const block = document.createElement("details");
    block.className = "param-block";
    if (group.calibration) block.classList.add("is-calibration");
    block.dataset.groupId = group.id;

    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.className = "param-block-title";
    title.textContent = group.label;
    const count = document.createElement("span");
    count.className = "param-block-count";
    count.textContent = `${members.length} 項`;
    summary.append(title, count);
    block.append(summary);

    const note = document.createElement("p");
    note.className = "param-block-note";
    note.textContent = group.note;
    block.append(note);

    if (group.calibration) {
      const warn = document.createElement("p");
      warn.className = "param-calib-warning";
      warn.textContent = "⚠ 這些是實景實測值。改了模擬會偏離 Blender 場景幾何，"
        + "車道、斑馬線與月台的對位都會跑掉。";
      block.append(warn);
    }

    for (const def of members) block.append(buildParamRow(def));

    const groupReset = document.createElement("button");
    groupReset.type = "button";
    groupReset.className = "secondary-button param-group-reset";
    groupReset.textContent = group.calibration
      ? "回到實測值"
      : `還原「${group.label}」預設值`;
    groupReset.addEventListener("click", () => {
      for (const id of paramRegistry.resetGroup(group.id)) syncParamRow(id);
      if (members.some((def) => def.apply === "respawn")) {
        noteParamNeedsRespawn({ apply: "respawn" });
      }
      paramRegistry.save();
      updateParamSummary();
    });
    block.append(groupReset);

    host.append(block);
  }
  syncAllParamRows();
}

function filterParamRows(query) {
  const needle = query.trim().toLowerCase();
  for (const block of ui.paramGroups.querySelectorAll(".param-block")) {
    let shown = 0;
    for (const row of block.querySelectorAll(".param-row")) {
      const hit = !needle || row.dataset.search.includes(needle);
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    block.hidden = shown === 0;
    if (needle && shown > 0) block.open = true;
  }
}

function downloadParamJson() {
  const payload = JSON.stringify(paramRegistry.toJSON(), null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "gongguan_params.json";
  link.click();
  URL.revokeObjectURL(url);
}

function importParamJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      const { applied, unknown } = paramRegistry.fromJSON(data);
      paramRegistry.save();
      syncAllParamRows();
      if (ui.paramRespawnNote) ui.paramRespawnNote.hidden = false;
      showParamExport(
        `已套用 ${applied.length} 項${unknown.length
          ? `，略過 ${unknown.length} 個不認得的鍵：${unknown.join(", ")}`
          : ""}`,
      );
    } catch (error) {
      showParamExport(`匯入失敗：${error.message}`);
    }
  };
  reader.readAsText(file);
}

function showParamExport(text) {
  if (!ui.paramExport) return;
  ui.paramExport.hidden = false;
  ui.paramExport.value = text;
  ui.paramExport.focus();
  ui.paramExport.select();
}

async function copyParamCode() {
  const code = paramRegistry.toCodeSnippet();
  try {
    await navigator.clipboard.writeText(code);
    showParamExport(`${code}\n\n（已複製到剪貼簿）`);
  } catch {
    showParamExport(code);
  }
}

function setupParamPanel() {
  paramRegistry = createParamRegistry([...coreParamDefs(), ...viewerParamDefs()]);
  const restored = paramRegistry.load();
  buildParamPanel();
  if (restored.applied.length > 0 && ui.paramRestoredNote) {
    ui.paramRestoredNote.hidden = false;
    ui.paramRestoredCount.textContent = String(restored.applied.length);
  }
  ui.paramSearch?.addEventListener("input", () => {
    filterParamRows(ui.paramSearch.value);
  });
  ui.paramResetAll?.addEventListener("click", () => {
    paramRegistry.resetAll();
    paramRegistry.clearSaved();
    syncAllParamRows();
    if (ui.paramRespawnNote) ui.paramRespawnNote.hidden = false;
    if (ui.paramRestoredNote) ui.paramRestoredNote.hidden = true;
  });
  ui.paramRespawn?.addEventListener("click", () => {
    resetRunCounters();
    spawnActors();
    if (ui.paramRespawnNote) ui.paramRespawnNote.hidden = true;
  });
  ui.paramExportJson?.addEventListener("click", downloadParamJson);
  ui.paramCopyCode?.addEventListener("click", copyParamCode);
  ui.paramImportInput?.addEventListener("change", () => {
    const file = ui.paramImportInput.files?.[0];
    if (file) importParamJson(file);
    ui.paramImportInput.value = "";
  });
  updateParamSummary();
}

function resetRunCounters() {
  runtime.throughput = 0;
  runtime.collisions = 0;
  runtime.busBoardings = 0;
  activeCollisionKeys.clear();
}

function setupUiEvents() {
  for (const button of ui.commandButtons) {
    if (
      button.dataset.requestKind === "gesture"
      && OFFICIAL_GESTURE_TO_PHASE[button.dataset.gesture]
      !== button.dataset.phase
    ) {
      throw new Error(`介面手勢映射不合法：${button.dataset.gesture}`);
    }
    button.addEventListener("click", () => submitManualCommand({
      phaseId: button.dataset.phase,
      gesture: button.dataset.gesture,
      requestKind: button.dataset.requestKind,
    }));
  }
  ui.autoMode.addEventListener("change", () => {
    runtime.auto = ui.autoMode.checked;
    ui.modeBadge.textContent = runtime.auto ? "自動" : "手動";
    if (runtime.auto) startAutomaticCycle();
  });
  ui.downstreamBlocked.addEventListener("change", () => {
    runtime.downstreamBlocked = ui.downstreamBlocked.checked;
    enforceActiveSafety();
    updateSafetyUi();
  });
  ui.motionEffects.addEventListener("change", () => {
    runtime.reducedMotion = !ui.motionEffects.checked;
  });
  ui.highPerformance.addEventListener("change", () => {
    applyRenderProfile(
      ui.highPerformance.checked ? "performance" : "powersave",
    );
  });
  // 紅綠燈秒數設定:改值即存入 override,下一次該相位啟動時生效
  // (自動循環與手動插入都適用)。
  const durationInputs = [
    [ui.durationRoosevelt, "roosevelt_flow", ui.durationRooseveltValue],
    [ui.durationPedestrian, "pedestrian_crossing", ui.durationPedestrianValue],
    [ui.durationLane90, "lane90_release", ui.durationLane90Value],
  ];
  runtime.durationInputs = durationInputs;
  for (const [input, phaseId] of durationInputs) {
    input.value = String(Math.round(phaseDurationForId(phaseId)));
    const commit = () => {
      const seconds = THREE.MathUtils.clamp(
        Number.parseFloat(input.value) || 0, 3, 120,
      );
      input.value = String(seconds);
      runtime.phaseSeconds[phaseId] = seconds;
      syncDurationOutputs();
    };
    // input = 拖曳中即時更新讀數;change = 鍵盤/程式寫入後的最終落值。
    input.addEventListener("input", commit);
    input.addEventListener("change", commit);
  }
  syncDurationOutputs();
  bindSegmented(ui.pacingSegmented, ui.pacingPreset, "pacing");
  bindSegmented(ui.densitySegmented, ui.trafficDensity, "density");
  setupKbotPostEditor();
  ui.trafficDensity.addEventListener("change", () => {
    // Mode switch = regenerate with the current seed (reseed flow without
    // bumping the seed offset), per SPEC_VIEWER_V2 §4c.
    runtime.trafficMode = ui.trafficDensity.value;
    resetRunCounters();
    spawnActors();
  });
  ui.reseedButton.addEventListener("click", () => {
    runtime.seedOffset += 1;
    resetRunCounters();
    spawnActors();
  });
  ui.hookTurn.addEventListener("change", () => {
    applyHookTurnSetting(ui.hookTurn.checked);
  });
  ui.recordingMode.addEventListener("change", () => {
    document.body.classList.toggle("is-recording", ui.recordingMode.checked);
    requestAnimationFrame(() => {
      resizeRenderer();
    });
  });
  ui.pacingPreset.addEventListener("change", () => {
    applyPacingPreset(ui.pacingPreset.value);
  });
  for (const button of ui.cameraButtons) {
    button.addEventListener("click", () => {
      setCamera(button.dataset.camera);
    });
  }
  for (const button of ui.cameraViewButtons) {
    button.addEventListener("click", () => {
      applyCameraPreset(button.dataset.view);
    });
  }
  for (const button of ui.cameraModeButtons) {
    button.addEventListener("click", () => {
      setCameraMode(button.dataset.cameraMode);
      showCameraNotice(
        `相機模式:${cameraModeConfig(button.dataset.cameraMode).label}`,
      );
    });
  }
  setupPanelTabs();
  setupViewCube();
  setupViewportMenus();
  setupLayerMenu();
  registerViewportUiHooks();
  for (const button of ui.cameraActionButtons) {
    button.addEventListener("click", () => {
      const action = button.dataset.cameraAction;
      if (action === "home") {
        applyCameraPreset("overview");
        showCameraNotice("已重置視角");
      } else if (action === "projection") {
        setCameraProjection(
          cameraDirector.projection === "perspective"
            ? "orthographic"
            : "perspective",
        );
      } else if (action === "focus") {
        if (cameraDirector.selection) {
          cameraFrameTarget(cameraDirector.selection);
          showCameraNotice(`聚焦:${cameraDirector.selection.label}`);
        } else {
          showCameraNotice("尚未選取物件:在場景中點一下 KBot、車輛或路口");
        }
      }
    });
  }
}

function simulationPoint(x, y, z) {
  runtime.simulationRoot.updateMatrixWorld(true);
  return new THREE.Vector3(x, y, z).applyMatrix4(
    runtime.simulationRoot.matrixWorld,
  );
}

// =====================================================================
// §20 相機系統(cameraDirector)
// ---------------------------------------------------------------------
// OrbitControls 之上薄薄一層:模式、平滑過渡、Focus/Frame、防穿模護欄。
// 硬性契約:window.__setCamera 仍是「同步瞬移」,只有 UI 路徑才有過渡。
// =====================================================================

const CAMERA_FOV_DEG = 48;
const CAMERA_TARGET_Y_RANGE = [0.35, 14];
const CAMERA_TARGET_RADIUS_MAX = 130;
const CAMERA_MIN_GROUND_CLEARANCE = 0.9;
const CAMERA_TRANSITION_MS = 620;
const ORTHO_BASE_HALF_HEIGHT = 20;

// 每個模式定義:互動權限 + 俯角/距離護欄 + 預設機位。
const CAMERA_MODES = {
  orbit: {
    label: "Orbit",
    rotate: true, pan: true, zoom: true,
    minPolar: 0.02, maxPolar: Math.PI * 0.47,
    minDistance: 5, maxDistance: 350,
    preset: "overview",
  },
  follow: {
    label: "Follow",
    rotate: true, pan: true, zoom: true,
    minPolar: 0.08, maxPolar: Math.PI * 0.47,
    minDistance: 4, maxDistance: 120,
    preset: "robot",
  },
  fixed: {
    label: "Fixed",
    rotate: false, pan: false, zoom: false,
    minPolar: 0.02, maxPolar: Math.PI * 0.47,
    minDistance: 5, maxDistance: 350,
    preset: "fixedpost",
  },
  top: {
    label: "Top",
    rotate: true, pan: true, zoom: true,
    minPolar: 0, maxPolar: Math.PI * 0.055,
    minDistance: 24, maxDistance: 350,
    preset: "topdown",
  },
  street: {
    label: "Street",
    rotate: true, pan: true, zoom: true,
    minPolar: Math.PI * 0.28, maxPolar: Math.PI * 0.47,
    minDistance: 5, maxDistance: 110,
    preset: "street",
  },
};

// 預設視角 → 模式的對應(六顆舊 data-camera 全部保留原 key)。
const CAMERA_PRESET_MODES = {
  overview: "orbit",
  isometric: "orbit",
  street: "street",
  robot: "follow",
  crosswalk: "orbit",
  hook: "orbit",
  busstop: "orbit",
  intersection: "orbit",
  topdown: "top",
  fixedpost: "fixed",
};

const cameraDirector = {
  mode: "orbit",
  projection: "perspective",
  preset: "overview",
  transition: null,
  selection: null,
  followOffset: new THREE.Vector3(),
  followReady: false,
  blockers: [],
  busStopMeshes: [],
  homeCenter: new THREE.Vector3(),
  userTookOver: false,
};

let orthoCamera = null;
let perspectiveCamera = null;
const cameraPickRaycaster = new THREE.Raycaster();
const cameraGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const kbotFollowTarget = new THREE.Vector3();
const cameraScratchA = new THREE.Vector3();
const cameraScratchB = new THREE.Vector3();

function cameraModeConfig(mode = cameraDirector.mode) {
  return CAMERA_MODES[mode] ?? CAMERA_MODES.orbit;
}

function cameraIsTransitioning() {
  return cameraDirector.transition !== null;
}

// 世界座標球面座標(以 controls.target 為中心)。
function cameraSpherical(position = camera.position, target = controls.target) {
  const offset = cameraScratchA.copy(position).sub(target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.radius = Math.max(spherical.radius, 0.001);
  return spherical;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

// 平滑過渡:在球面座標插值(半徑取對數插值、方位角走最短弧),避免
// 直接 lerp position 造成的「穿地直線」與遠近突變。
function cameraFlyTo(position, target, options = {}) {
  const durationMs = options.durationMs ?? CAMERA_TRANSITION_MS;
  if (options.immediate || durationMs <= 0) {
    cameraDirector.transition = null;
    cameraApplyPose(target, cameraSphericalFromPose(position, target));
    controls.enabled = cameraModeConfig().rotate
      || cameraModeConfig().pan || cameraModeConfig().zoom;
    controls.update();
    return;
  }
  const fromTarget = controls.target.clone();
  const fromSpherical = cameraSpherical();
  const toSpherical = cameraSphericalFromPose(position, target);
  let deltaTheta = toSpherical.theta - fromSpherical.theta;
  while (deltaTheta > Math.PI) deltaTheta -= Math.PI * 2;
  while (deltaTheta < -Math.PI) deltaTheta += Math.PI * 2;
  cameraDirector.transition = {
    fromTarget,
    toTarget: target.clone(),
    fromSpherical,
    toSpherical,
    deltaTheta,
    elapsed: 0,
    durationS: durationMs / 1000,
  };
  controls.enabled = false;
}

function cameraSphericalFromPose(position, target) {
  const spherical = new THREE.Spherical().setFromVector3(
    cameraScratchB.copy(position).sub(target),
  );
  spherical.radius = Math.max(spherical.radius, 0.001);
  return spherical;
}

function cameraApplyPose(target, spherical) {
  controls.target.copy(target);
  camera.position.copy(target).add(
    cameraScratchB.setFromSphericalCoords(
      spherical.radius, spherical.phi, spherical.theta,
    ),
  );
  camera.lookAt(target);
  if (camera.isOrthographicCamera) syncOrthoZoomToDistance(spherical.radius);
}

function advanceCameraTransition(delta) {
  const transition = cameraDirector.transition;
  if (!transition) return;
  transition.elapsed += delta;
  const raw = Math.min(1, transition.elapsed / transition.durationS);
  const eased = easeInOutCubic(raw);
  const target = cameraScratchA.copy(transition.fromTarget)
    .lerp(transition.toTarget, eased);
  const spherical = new THREE.Spherical(
    transition.fromSpherical.radius
      * ((transition.toSpherical.radius / transition.fromSpherical.radius)
        ** eased),
    THREE.MathUtils.lerp(
      transition.fromSpherical.phi, transition.toSpherical.phi, eased,
    ),
    transition.fromSpherical.theta + transition.deltaTheta * eased,
  );
  cameraApplyPose(target, spherical);
  if (raw >= 1) {
    cameraDirector.transition = null;
    applyCameraModeConstraints();
    if (cameraDirector.mode === "follow") captureFollowOffset();
    controls.update();
  }
}

function applyCameraModeConstraints() {
  const config = cameraModeConfig();
  controls.enableRotate = config.rotate;
  controls.enablePan = config.pan;
  controls.enableZoom = config.zoom;
  controls.minPolarAngle = config.minPolar;
  controls.maxPolarAngle = config.maxPolar;
  controls.minDistance = config.minDistance;
  controls.maxDistance = config.maxDistance;
  controls.enabled = config.rotate || config.pan || config.zoom;
}

// ---------------------------------------------------------------- Follow
function captureFollowOffset() {
  if (!runtime.kbotHolder || !runtime.kbotReady) {
    cameraDirector.followReady = false;
    return;
  }
  runtime.kbotHolder.getWorldPosition(kbotFollowTarget);
  cameraDirector.followOffset.copy(camera.position).sub(kbotFollowTarget);
  cameraDirector.followReady = true;
}

// offset-follow:記住切入瞬間的相對位移,機位與注視點一起跟著機器人走,
// 距離與方位角不再隨機器人走遠而漂移(舊版只 lerp target)。
function updateKbotCameraFollow(delta) {
  if (cameraDirector.mode !== "follow") return;
  if (!runtime.kbotHolder || !runtime.kbotReady) return;
  if (cameraIsTransitioning()) return;
  if (!cameraDirector.followReady) captureFollowOffset();
  if (!cameraDirector.followReady) return;
  runtime.kbotHolder.getWorldPosition(kbotFollowTarget);
  const alpha = 1 - Math.exp(-delta / 0.28);
  const desiredTarget = cameraScratchA.copy(kbotFollowTarget);
  desiredTarget.y += 1.15;
  controls.target.lerp(desiredTarget, alpha);
  const desiredPosition = cameraScratchB.copy(kbotFollowTarget)
    .add(cameraDirector.followOffset);
  camera.position.lerp(desiredPosition, alpha);
}

// 使用者一動相機就退出 Follow(san §8),並在畫面下緣給明確提示。
function handleUserCameraTakeover() {
  if (cameraIsTransitioning()) return;
  cameraDirector.userTookOver = true;
  if (cameraDirector.mode !== "follow") return;
  setCameraMode("orbit", { fly: false });
  showCameraNotice("已退出跟隨:相機改為 Orbit 自由視角");
}

// ------------------------------------------------------------- 護欄
function pointInsideBlocker(point) {
  for (const box of cameraDirector.blockers) {
    if (box.containsPoint(point)) return true;
  }
  return false;
}

// 每幀 O(建物數) 的包圍盒判定(不是對 4860 個 mesh raycast):
// 相機一旦落進建物包圍盒就沿視線往外推,直到脫離或到達最大距離。
function enforceCameraGuards() {
  const target = controls.target;
  target.y = THREE.MathUtils.clamp(
    target.y, CAMERA_TARGET_Y_RANGE[0], CAMERA_TARGET_Y_RANGE[1],
  );
  const dx = target.x - cameraDirector.homeCenter.x;
  const dz = target.z - cameraDirector.homeCenter.z;
  const planarRadius = Math.hypot(dx, dz);
  if (planarRadius > CAMERA_TARGET_RADIUS_MAX) {
    const scale = CAMERA_TARGET_RADIUS_MAX / planarRadius;
    target.x = cameraDirector.homeCenter.x + dx * scale;
    target.z = cameraDirector.homeCenter.z + dz * scale;
  }
  const config = cameraModeConfig();
  const offset = cameraScratchA.copy(camera.position).sub(target);
  let radius = offset.length();
  if (radius > 0.001 && cameraDirector.blockers.length > 0) {
    const direction = cameraScratchB.copy(offset).divideScalar(radius);
    let guard = 0;
    while (guard < 48 && pointInsideBlocker(camera.position)) {
      radius += 0.8;
      if (radius > config.maxDistance) break;
      camera.position.copy(target).addScaledVector(direction, radius);
      guard += 1;
    }
  }
  if (camera.position.y < CAMERA_MIN_GROUND_CLEARANCE) {
    camera.position.y = CAMERA_MIN_GROUND_CLEARANCE;
  }
}

// 建物包圍盒快取:環境 GLB 直接掛 scene(世界座標),不吃 z 鏡射。
function buildCameraBlockers() {
  cameraDirector.blockers = [];
  // §21:同一趟把建物節點收起來當「場景建物」圖層的控制對象。
  runtime.buildingNodes = [];
  if (!runtime.environment) return;
  for (const child of runtime.environment.children) {
    if (!/building/i.test(child.name)) continue;
    runtime.buildingNodes.push(child);
    const box = new THREE.Box3().setFromObject(child);
    if (box.isEmpty()) continue;
    box.expandByScalar(0.7);
    cameraDirector.blockers.push(box);
  }
}

// 公車站候車亭碎片:名稱前綴收集後,依世界座標歸到最近的月台。
function buildBusStopPickMeshes() {
  cameraDirector.busStopMeshes = [];
  if (!runtime.environment) return;
  const seCenter = simulationPoint(21, 1.4, BUS_PLATFORMS.se.row);
  const nwCenter = simulationPoint(-21, 1.4, BUS_PLATFORMS.nw.row);
  const center = new THREE.Vector3();
  runtime.environment.traverse((node) => {
    if (!node.isMesh) return;
    if (!/busstop/i.test(node.name)) return;
    node.updateWorldMatrix(true, false);
    new THREE.Box3().setFromObject(node).getCenter(center);
    node.userData.__cameraPickId = center.distanceToSquared(seCenter)
      <= center.distanceToSquared(nwCenter) ? "busstop:se" : "busstop:nw";
    cameraDirector.busStopMeshes.push(node);
  });
}

// -------------------------------------------------------- 靜態聚焦目標表
function staticFocusTarget(id) {
  switch (id) {
    case "intersection":
      return {
        id, kind: "intersection", label: "路口中心",
        center: simulationPoint(0, 1.2, 0), radius: 21,
      };
    case "crosswalk":
      return {
        id, kind: "crosswalk", label: "行穿線崗位",
        center: simulationPoint(
          KBOT_POSTS.crosswalk.x, 1.1, KBOT_POSTS.crosswalk.z,
        ),
        radius: 9,
      };
    case "hook":
      return {
        id, kind: "hook", label: "巷90 待轉區",
        center: simulationPoint(HOOK_BOX.s, 0.8, HOOK_BOX.t),
        radius: Math.max(HOOK_BOX.halfS, HOOK_BOX.halfT) + 3.5,
      };
    case "busstop:se":
      return {
        id, kind: "busstop", label: "中央公車站(東南向)",
        center: simulationPoint(21, 1.4, BUS_PLATFORMS.se.row), radius: 10,
      };
    case "busstop:nw":
      return {
        id, kind: "busstop", label: "中央公車站(西北向)",
        center: simulationPoint(-21, 1.4, BUS_PLATFORMS.nw.row), radius: 10,
      };
    default:
      return null;
  }
}

const STATIC_FOCUS_IDS = [
  "intersection", "crosswalk", "hook", "busstop:se", "busstop:nw",
];

// 命中地面時退回「最近的靜態登錄目標」,但只在該目標自己的作用半徑內才算,
// 否則點空曠路面會誤選到十幾公尺外的月台。
function nearestStaticFocusTarget(point) {
  let best = null;
  let bestScore = Infinity;
  for (const id of STATIC_FOCUS_IDS) {
    const target = staticFocusTarget(id);
    const distance = target.center.distanceTo(point);
    if (distance > target.radius + 3) continue;
    const score = distance / target.radius;
    if (score < bestScore) {
      best = target;
      bestScore = score;
    }
  }
  return best;
}

function signalFocusTarget(headId) {
  const nodes = runtime.signalAspectNodes.filter(
    (node) => node.userData.traffic_director_signal_head_id === headId,
  );
  if (nodes.length === 0) return null;
  const box = new THREE.Box3();
  for (const node of nodes) box.union(new THREE.Box3().setFromObject(node));
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const sample = nodes[0].userData;
  return {
    id: `signal:${headId}`,
    kind: "signal",
    label: `號誌 ${headId}(${sample.traffic_director_signal_movement})`,
    center,
    radius: Math.max(sphere.radius, 1.2),
  };
}

function actorFocusTarget(node) {
  if (node === runtime.kbotHolder) {
    const center = runtime.kbotHolder.getWorldPosition(new THREE.Vector3());
    center.y += 0.7;
    return {
      id: "kbot", kind: "kbot", label: "KBot 指揮官",
      center, radius: 1.15, object: runtime.kbotHolder, objectOffsetY: 0.7,
    };
  }
  const actorType = node.userData.actorType;
  if (!actorType) return null;
  const center = node.getWorldPosition(new THREE.Vector3());
  const isPedestrian = actorType === "pedestrian";
  center.y += isPedestrian ? 0.9 : 0.8;
  return {
    id: `${actorType}:${node.id}`,
    kind: isPedestrian ? "pedestrian" : "vehicle",
    label: isPedestrian ? "行人" : `車輛(${actorType})`,
    center,
    radius: isPedestrian ? 1.1 : 2.4,
    object: node,
    objectOffsetY: isPedestrian ? 0.9 : 0.8,
  };
}

function resolveFocusTarget(id) {
  if (!id) return null;
  if (id === "kbot") {
    if (!runtime.kbotHolder) return null;
    return actorFocusTarget(runtime.kbotHolder);
  }
  if (id.startsWith("signal:")) return signalFocusTarget(id.slice(7));
  const staticTarget = staticFocusTarget(id);
  if (staticTarget) return staticTarget;
  if (cameraDirector.selection && cameraDirector.selection.id === id) {
    return refreshFocusTarget(cameraDirector.selection);
  }
  return null;
}

function refreshFocusTarget(target) {
  if (!target) return null;
  if (target.object && target.object.parent) {
    const center = target.object.getWorldPosition(new THREE.Vector3());
    center.y += target.objectOffsetY ?? 0;
    target.center = center;
  } else if (target.object) {
    // 物件已被回收(車輛離場),退回靜態座標。
    target.object = null;
  }
  return target;
}

// ------------------------------------------------------------- picking
function cameraPickAt(clientX, clientY) {
  if (!renderer) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  cameraPickRaycaster.setFromCamera(ndc, camera);
  // 1) 動態 actor:只打 simulationRoot(392 mesh),便宜。
  if (runtime.simulationRoot) {
    const hits = cameraPickRaycaster.intersectObject(
      runtime.simulationRoot, true,
    );
    for (const hit of hits) {
      let node = hit.object;
      while (node && node !== runtime.simulationRoot) {
        if (node === runtime.kbotHolder || node.userData.actorType) {
          const target = actorFocusTarget(node);
          if (target) return target;
          break;
        }
        node = node.parent;
      }
    }
  }
  // 2) 號誌:只打「亮著的」燈,Raycaster 不檢查 visible,得自己過濾。
  const litSignals = runtime.signalAspectNodes.filter((node) => node.visible);
  if (litSignals.length > 0) {
    const hits = cameraPickRaycaster.intersectObjects(litSignals, false);
    if (hits.length > 0) {
      const headId = hits[0].object.userData.traffic_director_signal_head_id;
      const target = signalFocusTarget(headId);
      if (target) return target;
    }
  }
  // 3) 公車站候車亭。
  if (cameraDirector.busStopMeshes.length > 0) {
    const hits = cameraPickRaycaster.intersectObjects(
      cameraDirector.busStopMeshes, false,
    );
    if (hits.length > 0) {
      return staticFocusTarget(hits[0].object.userData.__cameraPickId);
    }
  }
  // 4) 地面平面 → 最近的靜態登錄目標(路口 / 行穿線 / 待轉區 / 月台)。
  const groundHit = new THREE.Vector3();
  if (cameraPickRaycaster.ray.intersectPlane(cameraGroundPlane, groundHit)) {
    return nearestStaticFocusTarget(groundHit);
  }
  return null;
}

// ---------------------------------------------------------- Focus / Frame
function cameraFrameTarget(target, options = {}) {
  const resolved = refreshFocusTarget(target);
  if (!resolved) return false;
  const config = cameraModeConfig();
  const halfFov = THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2);
  const fitDistance = (resolved.radius / Math.sin(halfFov)) * 1.3;
  const distance = THREE.MathUtils.clamp(
    fitDistance, config.minDistance, config.maxDistance,
  );
  const current = cameraSpherical();
  const phi = THREE.MathUtils.clamp(
    current.phi,
    Math.max(config.minPolar, THREE.MathUtils.degToRad(24)),
    Math.min(config.maxPolar, THREE.MathUtils.degToRad(78)),
  );
  const position = resolved.center.clone().add(
    new THREE.Vector3().setFromSphericalCoords(distance, phi, current.theta),
  );
  if (position.y < resolved.center.y + 1.0) {
    position.y = resolved.center.y + 1.0;
  }
  cameraDirector.selection = resolved;
  updateCameraSelectionLabel();
  cameraFlyTo(position, resolved.center.clone(), options);
  return true;
}

function focusCameraOn(id, options = {}) {
  const target = resolveFocusTarget(id);
  if (!target) return false;
  return cameraFrameTarget(target, options);
}

function selectCameraTarget(target) {
  cameraDirector.selection = target;
  updateCameraSelectionLabel();
}

// ------------------------------------------------------------- 模式 / 投影
function setCameraMode(mode, options = {}) {
  if (!CAMERA_MODES[mode]) return false;
  cameraDirector.mode = mode;
  cameraDirector.followReady = false;
  applyCameraModeConstraints();
  syncCameraModeButtons();
  if (options.fly !== false) {
    applyCameraPreset(cameraModeConfig(mode).preset, {
      keepMode: true,
      immediate: options.immediate === true,
    });
  } else if (mode === "follow") {
    captureFollowOffset();
  }
  return true;
}

function setCameraProjection(kind, options = {}) {
  const wanted = kind === "orthographic" ? "orthographic" : "perspective";
  if (wanted === cameraDirector.projection) return wanted;
  const target = controls.target.clone();
  const spherical = cameraSpherical();
  const halfFov = THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2);
  if (wanted === "orthographic") {
    if (!orthoCamera) {
      orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 2000);
      orthoCamera.name = "TrafficDirector_OrthoCamera";
    }
    orthoCamera.position.copy(camera.position);
    orthoCamera.up.copy(camera.up);
    camera = orthoCamera;
    cameraDirector.projection = "orthographic";
    resizeRenderer();
    syncOrthoZoomToDistance(spherical.radius);
  } else {
    const halfHeight = ORTHO_BASE_HALF_HEIGHT / Math.max(camera.zoom, 0.0001);
    const distance = THREE.MathUtils.clamp(
      halfHeight / Math.tan(halfFov),
      cameraModeConfig().minDistance,
      cameraModeConfig().maxDistance,
    );
    camera = perspectiveCamera;
    cameraDirector.projection = "perspective";
    spherical.radius = distance;
    resizeRenderer();
  }
  controls.object = camera;
  cameraApplyPose(target, spherical);
  controls.update();
  syncProjectionButton();
  if (options.silent !== true) {
    showCameraNotice(
      cameraDirector.projection === "orthographic"
        ? "投影:正交(Orthographic)"
        : "投影:透視(Perspective)",
    );
  }
  return cameraDirector.projection;
}

function syncOrthoZoomToDistance(distance) {
  if (!camera.isOrthographicCamera) return;
  const halfFov = THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2);
  const halfHeight = Math.max(distance * Math.tan(halfFov), 0.5);
  camera.zoom = ORTHO_BASE_HALF_HEIGHT / halfHeight;
  camera.updateProjectionMatrix();
}

function resizeRenderer() {
  const width = Math.max(ui.scene.clientWidth, 1);
  const height = Math.max(ui.scene.clientHeight, 1);
  const aspect = width / height;
  if (perspectiveCamera) {
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();
  }
  if (orthoCamera) {
    orthoCamera.left = -ORTHO_BASE_HALF_HEIGHT * aspect;
    orthoCamera.right = ORTHO_BASE_HALF_HEIGHT * aspect;
    orthoCamera.top = ORTHO_BASE_HALF_HEIGHT;
    orthoCamera.bottom = -ORTHO_BASE_HALF_HEIGHT;
    orthoCamera.updateProjectionMatrix();
  }
  renderer.setSize(width, height);
}

// --------------------------------------------------------------- 預設視角
function cameraPresetPose(name) {
  const kbot = runtime.kbotHolder && runtime.kbotReady
    ? runtime.kbotHolder.position
    : KBOT_STAND;
  const presets = {
    overview: {
      position: simulationPoint(-28, 35, -34),
      target: simulationPoint(8, 0.9, 0),
    },
    // 等角視:模擬座標 45° 方位 + 54.7° 俯角(對齊羅斯福路軸,不是世界軸)。
    isometric: {
      position: simulationPoint(43.3, 44.5, 43.3),
      target: simulationPoint(0, 1.2, 0),
    },
    // 路口聚焦:從東南上空看整個路口與行穿線。
    intersection: {
      position: simulationPoint(24, 15, -21),
      target: simulationPoint(0, 1.2, 0),
    },
    // 正上方俯視(Top 模式的預設機位)。
    topdown: {
      position: simulationPoint(0.4, 118, 0.4),
      target: simulationPoint(0, 0.6, 0),
    },
    // 固定監控點:路口東南角的定點監視機位。
    fixedpost: {
      position: simulationPoint(26, 11, -19),
      target: simulationPoint(2, 1.2, 1),
    },
    street: {
      position: simulationPoint(28, 4.8, -17),
      target: simulationPoint(2, 1.2, 0),
    },
    robot: {
      position: simulationPoint(kbot.x - 4.8, kbot.y + 3.35, kbot.z - 8.2),
      target: simulationPoint(kbot.x, kbot.y + 1.03, kbot.z),
    },
    // 行人穿越:從對側(t 負半邊)看整條直行行穿線與站在中央的 KBot。
    // 舊機位放在水源市場側人行道(25.5, 6.2, 19.5),視線要穿過東南向排隊
    // 車陣與中央公車站候車亭,行人相位時 KBot 幾乎總是被公車擋住(§14
    // 實拍驗收發現);改到對側後視線只跨過空的路面,機器人保持在畫面中央。
    // §16:崗位移到 +t 半段畫線帶(t=8.33)後,舊機位 (26.0, 8.0, -8.0) 的
    // 視線會斜擦過中央公車站月台(s≈17)、被停靠中的公車與號誌桿擋住。改到
    // 對側路面西南角:視線在 s≈13.7 跨過公車道(月台起點 s=16.2 以西),
    // 機器人與穿越中的行人一起在畫面中央,實拍已驗收。
    crosswalk: {
      position: simulationPoint(12.0, 6.0, -4.0),
      target: simulationPoint(
        KBOT_POSTS.crosswalk.x, 1.1, KBOT_POSTS.crosswalk.z,
      ),
    },
    // 機車待轉區:看巷口出來的機慢車跨越路口停進待轉格。
    hook: {
      position: simulationPoint(HOOK_BOX.s + 12.5, 7.4, HOOK_BOX.t - 12.0),
      target: simulationPoint(HOOK_BOX.s - 1.0, 0.7, HOOK_BOX.t + 2.5),
    },
    // 中央公車站:候車、公車進站與上車。舊機位(31.0, 6.8, 17.5)在水源
    // 市場側,畫面左三分之一被建物、正中被燈桿切開,靠站的公車只露一角
    // (§14 實拍驗收發現);改成從路面上方俯看月台,車門側與候車者全露出。
    busstop: {
      // 注視點取月台列與路面中線的一半(t = 2.6),車身與月台各佔半個畫面。
      position: simulationPoint(30.0, 11.0, 10.0),
      target: simulationPoint(19.0, 1.4, BUS_PLATFORMS.se.row * 0.5),
    },
  };
  return presets[name] ?? presets.overview;
}

function applyCameraPreset(name, options = {}) {
  const key = CAMERA_PRESET_MODES[name] ? name : "overview";
  const pose = cameraPresetPose(key);
  cameraDirector.preset = key;
  if (options.keepMode !== true) {
    const mode = CAMERA_PRESET_MODES[key] ?? "orbit";
    cameraDirector.mode = mode;
    cameraDirector.followReady = false;
    // 這裡**不要**套 applyCameraModeConstraints():過渡還沒開始就換上目的地
    // 模式的 min/maxPolarAngle,下一次 controls.update() 會立刻把俯角夾到
    // 端點,實測第一幀就吃掉 49%–82% 的行程(看起來就是先瞬移再緩動)。
    // 限制交給 cameraStepTransition() 在 raw>=1 收尾時才套。
    syncCameraModeButtons();
  }
  cameraDirector.userTookOver = false;
  cameraFlyTo(pose.position, pose.target, {
    immediate: options.immediate === true,
    durationMs: options.durationMs,
  });
  if (options.immediate === true && cameraDirector.mode === "follow") {
    captureFollowOffset();
  }
  syncCameraViewButtons(key);
  return true;
}

// 舊進入點:六顆 [data-camera] 按鈕與既有程式碼都走這裡(改成平滑過渡)。
function setCamera(name, options = {}) {
  return applyCameraPreset(name, options);
}

// -------------------------------------------------------------- 互動綁定
// OrbitControls 的 pointerdown 是非 capture,所以 capture 階段先改
// mouseButtons.LEFT 就能做出「Shift+左鍵 = Pan」。
function setupCameraInteraction() {
  const element = renderer.domElement;
  let downX = 0;
  let downY = 0;
  let downAtMs = 0;
  let downButton = -1;

  element.addEventListener("pointerdown", (event) => {
    // 不要在這裡改寫 controls.mouseButtons.LEFT:three r170 的 OrbitControls
    // 原生就支援「左鍵 + shift/ctrl/meta = pan」(OrbitControls.js:1238),
    // 而它的 case MOUSE.PAN 分支看到 shiftKey 會再翻回 ROTATE(:1258)——
    // 兩者相消,結果是 Shift+拖曳變成旋轉,跟畫面上的提示文字矛盾。
    downX = event.clientX;
    downY = event.clientY;
    downAtMs = performance.now();
    downButton = event.button;
  }, true);

  element.addEventListener("pointerup", (event) => {
    if (downButton !== 0 || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (moved > 5 || performance.now() - downAtMs > 400) return;
    const hit = cameraPickAt(event.clientX, event.clientY);
    if (hit) {
      selectCameraTarget(hit);
      showCameraNotice(`已選取:${hit.label}(雙擊或按 F 聚焦)`);
    } else {
      selectCameraTarget(null);
    }
  });

  element.addEventListener("dblclick", (event) => {
    const hit = cameraPickAt(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    cameraFrameTarget(hit);
    showCameraNotice(`聚焦:${hit.label}`);
  });

  controls.addEventListener("start", handleUserCameraTakeover);

  window.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "f" || event.key === "F") {
      if (cameraDirector.selection) {
        cameraFrameTarget(cameraDirector.selection);
        showCameraNotice(`聚焦:${cameraDirector.selection.label}`);
      }
    } else if (event.key === "Home") {
      applyCameraPreset("overview");
      showCameraNotice("已重置視角");
    }
  });
}

// ------------------------------------------------------------------ UI 同步
let cameraNoticeTimer = 0;

function showCameraNotice(text) {
  if (!ui.cameraNotice) return;
  ui.cameraNotice.textContent = text;
  ui.cameraNotice.hidden = false;
  clearTimeout(cameraNoticeTimer);
  cameraNoticeTimer = setTimeout(() => {
    if (ui.cameraNotice) ui.cameraNotice.hidden = true;
  }, 2600);
}

function syncCameraViewButtons(activeKey) {
  for (const button of ui.cameraButtons) {
    button.classList.toggle("is-active", button.dataset.camera === activeKey);
  }
  for (const button of ui.cameraViewButtons) {
    button.classList.toggle("is-active", button.dataset.view === activeKey);
  }
}

function syncCameraModeButtons() {
  for (const button of ui.cameraModeButtons) {
    button.classList.toggle(
      "is-active", button.dataset.cameraMode === cameraDirector.mode,
    );
  }
}

function syncProjectionButton() {
  if (!ui.projectionToggle) return;
  const isOrtho = cameraDirector.projection === "orthographic";
  ui.projectionToggle.textContent = isOrtho ? "Ortho" : "Persp";
  ui.projectionToggle.classList.toggle("is-active", isOrtho);
  ui.projectionToggle.setAttribute("aria-pressed", String(isOrtho));
}

function updateCameraSelectionLabel() {
  if (!ui.cameraSelectionLabel) return;
  const selection = cameraDirector.selection;
  ui.cameraSelectionLabel.textContent = selection
    ? `已選:${selection.label}`
    : "未選取物件";
  if (ui.focusSelected) ui.focusSelected.disabled = !selection;
}

// =====================================================================
// §21 Viewport 操作 UI(ViewCube / View 選單 / Layers 選單 / 底部提示)
// ---------------------------------------------------------------------
// 全部是 DOM(ViewCube 用 CSS 3D transform),沒有任何東西畫進 WebGL canvas:
// 這樣 body.is-recording 一條 CSS 就能整組藏掉,record_demo_video.mjs 那份
// 硬寫的隱藏清單一行都不用改(畫進 canvas 的 gizmo 就藏不掉)。
//
// ViewCube 的六個面對齊「街道基底」(simulationRoot 的 s / t 軸),不是世界軸:
// 世界 Front 偏離羅斯福路主軸 43.3°,對齊世界軸的方塊按 Front 會斜切路口。
// 基底取右手系 (X, Y, Z) = (sHat, up, -tHat) —— simulationRoot 的行列式是 -1
// (z 鏡射),直接拿 (sHat, up, tHat) 當基底會左右相反。
// =====================================================================

const VIEWCUBE_FACES = ["front", "back", "right", "left", "top", "bottom"];

const viewCubeState = {
  basis: new THREE.Matrix4(),
  lastQuaternion: new THREE.Quaternion(0, 0, 0, 0),
  ready: false,
};

const cubeMatrix = new THREE.Matrix4();
const cubeQuaternion = new THREE.Quaternion();
const cubeDirection = new THREE.Vector3();

function buildViewCubeBasis() {
  if (!runtime.simulationRoot) return;
  const origin = simulationPoint(0, 0, 0);
  const sHat = simulationPoint(1, 0, 0).sub(origin).normalize();
  const tHat = simulationPoint(0, 0, 1).sub(origin).normalize();
  viewCubeState.basis.makeBasis(
    sHat, new THREE.Vector3(0, 1, 0), tHat.clone().negate(),
  );
  viewCubeState.ready = true;
}

// 方塊局部軸 → 世界方向(= 該面朝外的法線,也就是「站在那一面看場景」的機位方向)。
function cubeFaceWorldDirection(faceId) {
  if (!viewCubeState.ready) return null;
  const direction = new THREE.Vector3();
  switch (faceId) {
    case "front": direction.setFromMatrixColumn(viewCubeState.basis, 2); break;
    case "back":
      direction.setFromMatrixColumn(viewCubeState.basis, 2).negate(); break;
    case "right": direction.setFromMatrixColumn(viewCubeState.basis, 0); break;
    case "left":
      direction.setFromMatrixColumn(viewCubeState.basis, 0).negate(); break;
    case "top": direction.set(0, 1, 0); break;
    case "bottom": direction.set(0, -1, 0); break;
    default: return null;
  }
  return direction.normalize();
}

// 每幀把「相機朝向 × 街道基底」寫成 CSS matrix3d。
// three 的座標是 X 右 / Y 上 / Z 朝觀者,CSS 3D 的 Y 是朝下,所以要做
// S·M·S 共軛(S = diag(1,-1,1)),否則方塊會上下顛倒、左右鏡射。
function updateViewCube(force = false) {
  if (!ui.viewCubeStage || !viewCubeState.ready || !camera) return;
  camera.getWorldQuaternion(cubeQuaternion);
  // 0.0035 rad ≈ 0.2°:小於這個角度不重寫 transform,省掉每幀的 style 寫入。
  if (!force && cubeQuaternion.angleTo(viewCubeState.lastQuaternion) < 0.0035) {
    return;
  }
  viewCubeState.lastQuaternion.copy(cubeQuaternion);
  // M = R_cam⁻¹ · R_street(世界 → 相機空間 → 方塊局部軸在畫面上的落點)。
  cubeMatrix.makeRotationFromQuaternion(cubeQuaternion).transpose()
    .multiply(viewCubeState.basis);
  const e = cubeMatrix.elements;
  ui.viewCubeStage.style.transform = "matrix3d("
    + `${e[0]},${-e[1]},${e[2]},0,`
    + `${-e[4]},${e[5]},${-e[6]},0,`
    + `${e[8]},${-e[9]},${e[10]},0,`
    + "0,0,0,1)";
  // 背向的面關掉 pointer-events(CSS backface-visibility 不保證擋得住命中測試)。
  const facingZ = {
    right: e[2], left: -e[2],
    top: e[6], bottom: -e[6],
    front: e[10], back: -e[10],
  };
  let bestFace = null;
  let bestZ = -Infinity;
  for (const face of ui.viewCubeFaces) {
    const id = face.dataset.cubeFace;
    const z = facingZ[id] ?? 0;
    face.classList.toggle("is-back", z <= 0.05);
    if (z > bestZ) {
      bestZ = z;
      bestFace = id;
    }
  }
  for (const face of ui.viewCubeFaces) {
    face.classList.toggle("is-facing", face.dataset.cubeFace === bestFace);
  }
}

// 點方塊 = 換朝向,不換注視點(保留使用者目前的 orbit 支點),並套用平滑過渡。
function applyViewCubeFace(faceId) {
  const direction = cubeFaceWorldDirection(faceId);
  if (!direction) return false;
  // 方塊是「自由定向」入口:Top 面進 Top 模式,其餘面一律回到 Orbit,
  // 免得在 Street / Fixed / Follow 的俯角鎖之下按了沒反應。
  const wantedMode = faceId === "top" ? "top" : "orbit";
  if (cameraDirector.mode !== wantedMode) {
    setCameraMode(wantedMode, { fly: false });
  }
  const config = cameraModeConfig();
  const target = controls.target.clone();
  const current = cameraSpherical();
  const distance = THREE.MathUtils.clamp(
    current.radius, config.minDistance, config.maxDistance,
  );
  const wanted = new THREE.Spherical().setFromVector3(direction);
  const phi = THREE.MathUtils.clamp(
    wanted.phi, config.minPolar + 0.002, config.maxPolar,
  );
  // 正上/正下沒有方位角可言,沿用目前的方位角,轉起來才不會突然甩頭。
  const theta = (faceId === "top" || faceId === "bottom")
    ? current.theta
    : wanted.theta;
  const position = target.clone().add(
    new THREE.Vector3().setFromSphericalCoords(distance, phi, theta),
  );
  cameraDirector.preset = `face:${faceId}`;
  cameraDirector.userTookOver = false;
  syncCameraViewButtons(null);
  cameraFlyTo(position, target);
  return true;
}

// =====================================================================
// §22 控制面板:分頁 + 收合
// ---------------------------------------------------------------------
// 分頁「只切 CSS class」,不 unmount 任何節點 —— §19 的 #paramGroups 與
// §18 的崗位微調必須永遠在 DOM 裡(驗收腳本用 el.click() / .value 直接操作,
// 那不需要可見性,但需要元素存在)。收合同理:只加 body.is-panel-collapsed。
// =====================================================================

const PANEL_TABS = ["command", "sim", "params"];

function setPanelTab(id) {
  const next = PANEL_TABS.includes(id) ? id : PANEL_TABS[0];
  for (const button of ui.panelTabs) {
    const on = button.dataset.panelTab === next;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-selected", String(on));
  }
  for (const pane of ui.panelPanes) {
    // pane 的 id 是 panelPaneCommand / panelPaneSim / panelPaneParams
    const key = pane.id.replace("panelPane", "").toLowerCase();
    pane.classList.toggle("is-active", key === next);
  }
  if (ui.panelScroll) ui.panelScroll.scrollTop = 0;
  runtime.panelTab = next;
}

function setPanelCollapsed(collapsed) {
  document.body.classList.toggle("is-panel-collapsed", collapsed);
  if (ui.panelCollapse) {
    ui.panelCollapse.setAttribute("aria-expanded", String(!collapsed));
    ui.panelCollapse.setAttribute(
      "aria-label", collapsed ? "展開控制面板" : "收合控制面板",
    );
  }
  // 場景寬度變了,renderer 要跟著換(resize 事件不會為 grid 變動觸發)。
  requestAnimationFrame(() => {
    if (renderer) resizeRenderer();
  });
}

function setupPanelTabs() {
  for (const button of ui.panelTabs) {
    button.addEventListener("click", () => {
      // 收合時點分頁 = 展開並切到那一頁(工具軟體的慣例)。
      if (document.body.classList.contains("is-panel-collapsed")) {
        setPanelCollapsed(false);
      }
      setPanelTab(button.dataset.panelTab);
    });
  }
  if (ui.panelCollapse) {
    ui.panelCollapse.addEventListener("click", () => {
      setPanelCollapsed(!document.body.classList.contains("is-panel-collapsed"));
    });
  }
  // N 鍵收合/展開側邊面板(Blender 的側欄慣例)。
  window.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key !== "n" && event.key !== "N") return;
    setPanelCollapsed(!document.body.classList.contains("is-panel-collapsed"));
  });
  setPanelTab("command");

  // §22 驗收 hook。
  window.__panelState = () => ({
    tab: runtime.panelTab,
    collapsed: document.body.classList.contains("is-panel-collapsed"),
    panes: ui.panelPanes.map((pane) => ({
      id: pane.id,
      active: pane.classList.contains("is-active"),
      // display 是分頁切換的實際效果;元素永遠在 DOM 裡。
      display: getComputedStyle(pane).display,
    })),
    scrollHeight: ui.panelScroll ? ui.panelScroll.scrollHeight : 0,
    clientHeight: ui.panelScroll ? ui.panelScroll.clientHeight : 0,
  });
  window.__setPanelTab = (id) => {
    setPanelTab(id);
    return runtime.panelTab;
  };
  window.__setPanelCollapsed = (collapsed) => {
    setPanelCollapsed(Boolean(collapsed));
    return document.body.classList.contains("is-panel-collapsed");
  };
}

function setupViewCube() {
  for (const face of ui.viewCubeFaces) {
    if (face.tagName !== "BUTTON") continue;
    face.addEventListener("click", () => {
      const id = face.dataset.cubeFace;
      applyViewCubeFace(id);
      showCameraNotice(`視角:${id.toUpperCase()}`);
    });
  }
}

// ------------------------------------------------------- View / Layers 選單
function viewportMenuPairs() {
  return [
    [ui.viewMenuButton, ui.viewMenu],
    [ui.layersMenuButton, ui.layersMenu],
  ].filter(([button, popover]) => button && popover);
}

function closeViewportMenus(except = null) {
  for (const [button, popover] of viewportMenuPairs()) {
    if (popover === except) continue;
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
}

function toggleViewportMenu(popover) {
  const pair = viewportMenuPairs().find(([, node]) => node === popover);
  if (!pair) return false;
  const open = popover.hidden;
  closeViewportMenus(open ? popover : null);
  popover.hidden = !open;
  pair[0].setAttribute("aria-expanded", String(open));
  if (open && popover === ui.layersMenu) refreshLayerCounts();
  return open;
}

function setupViewportMenus() {
  for (const [button, popover] of viewportMenuPairs()) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleViewportMenu(popover);
    });
  }
  // View 選單:按下任一視角/模式就收起來(Layers 是多選,不收)。
  ui.viewMenu?.addEventListener("click", (event) => {
    if (event.target.closest("button")) closeViewportMenus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".menu-holder")) {
      return;
    }
    closeViewportMenus();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const open = viewportMenuPairs().some(([, popover]) => !popover.hidden);
    if (!open) return;
    closeViewportMenus();
    ui.viewMenuButton?.focus();
  });
}

// ------------------------------------------------------------- 場景圖層
const SCENE_LAYERS = [
  { id: "vehicles", label: "車輛" },
  { id: "pedestrians", label: "行人" },
  { id: "kbot", label: "KBot 指揮官" },
  { id: "signals", label: "號誌燈" },
  { id: "markings", label: "加畫標線" },
  { id: "buildings", label: "場景建物" },
];

const sceneLayerState = Object.fromEntries(
  SCENE_LAYERS.map((layer) => [layer.id, true]),
);

function layerEnabled(id) {
  return sceneLayerState[id] !== false;
}

// 每個圖層負責的節點清單(每次現查,車輛/行人會隨 reseed 換一批新 mesh)。
function sceneLayerNodes(id) {
  switch (id) {
    case "vehicles":
      return runtime.vehicles.map((actor) => actor.mesh).filter(Boolean);
    case "pedestrians":
      return runtime.pedestrians.map((actor) => actor.mesh).filter(Boolean);
    case "kbot":
      return runtime.kbotHolder ? [runtime.kbotHolder] : [];
    case "signals":
      return runtime.signalAspects ? [runtime.signalAspects] : [];
    case "markings":
      return [runtime.hookTurnBox, runtime.kbotPostMarkers].filter(Boolean);
    case "buildings":
      return runtime.buildingNodes ?? [];
    default:
      return [];
  }
}

function applySceneLayer(id) {
  const visible = layerEnabled(id);
  if (id === "markings") {
    // 標線有自己的開關(#hookTurn / 崗位預覽),圖層只是再乘一層 AND。
    if (runtime.hookTurnBox && ui.hookTurn) {
      runtime.hookTurnBox.visible = ui.hookTurn.checked && visible;
    }
    updateKbotPostMarkers();
    return;
  }
  if (id === "pedestrians") {
    // 已上車的乘客要維持隱藏(人在公車上),不能被圖層開關無條件掀出來。
    for (const pedestrian of runtime.pedestrians ?? []) {
      const onBus = pedestrian.state === "boarding" && pedestrian.boarded;
      pedestrian.mesh.visible = visible && !onBus;
    }
    return;
  }
  for (const node of sceneLayerNodes(id)) node.visible = visible;
}

function applyAllSceneLayers() {
  for (const layer of SCENE_LAYERS) applySceneLayer(layer.id);
}

function setSceneLayer(id, visible) {
  if (!(id in sceneLayerState)) return false;
  sceneLayerState[id] = Boolean(visible);
  applySceneLayer(id);
  syncLayerInputs();
  refreshLayerCounts();
  return true;
}

function syncLayerInputs() {
  for (const layer of SCENE_LAYERS) {
    const input = document.querySelector(`#layer-${layer.id}`);
    if (input) input.checked = layerEnabled(layer.id);
  }
}

function refreshLayerCounts() {
  for (const layer of SCENE_LAYERS) {
    const cell = document.querySelector(`[data-layer="${layer.id}"] .layer-count`);
    if (cell) cell.textContent = String(sceneLayerNodes(layer.id).length);
  }
}

function setupLayerMenu() {
  if (!ui.layerList) return;
  ui.layerList.textContent = "";
  for (const layer of SCENE_LAYERS) {
    const row = document.createElement("label");
    row.className = "layer-row";
    row.dataset.layer = layer.id;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `layer-${layer.id}`;
    input.checked = layerEnabled(layer.id);
    input.setAttribute("aria-label", `圖層:${layer.label}`);
    const box = document.createElement("i");
    box.className = "layer-box";
    box.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = layer.label;
    const count = document.createElement("span");
    count.className = "layer-count";
    count.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => {
      setSceneLayer(layer.id, input.checked);
      showCameraNotice(
        `圖層 ${layer.label}:${input.checked ? "顯示" : "隱藏"}`,
      );
    });
    row.append(input, box, text, count);
    ui.layerList.append(row);
  }
  refreshLayerCounts();
}

// §21 驗收 hook:圖層狀態 + 實際 visible 節點數(要能證明物件真的消失了)。
function registerViewportUiHooks() {
  window.__layerState = () => Object.fromEntries(SCENE_LAYERS.map((layer) => {
    const nodes = sceneLayerNodes(layer.id);
    return [layer.id, {
      enabled: layerEnabled(layer.id),
      nodes: nodes.length,
      visibleNodes: nodes.filter((node) => node.visible).length,
    }];
  }));
  window.__setLayer = (id, visible) => setSceneLayer(id, visible);
  window.__viewCubeState = () => {
    const faces = {};
    for (const face of ui.viewCubeFaces) {
      faces[face.dataset.cubeFace] = {
        back: face.classList.contains("is-back"),
        facing: face.classList.contains("is-facing"),
      };
    }
    return {
      ready: viewCubeState.ready,
      transform: ui.viewCubeStage?.style.transform ?? "",
      faces,
    };
  };
  window.__applyViewCubeFace = (faceId) => applyViewCubeFace(faceId);
  window.__cubeFaceDirection = (faceId) => (
    cubeFaceWorldDirection(faceId)?.toArray() ?? null
  );
  window.__viewportMenuState = () => Object.fromEntries(
    viewportMenuPairs().map(([button, popover]) => [
      popover.id,
      { open: !popover.hidden, expanded: button.getAttribute("aria-expanded") },
    ]),
  );
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1821);
  scene.fog = new THREE.Fog(0x0b1821, 120, 420);

  perspectiveCamera = new THREE.PerspectiveCamera(
    CAMERA_FOV_DEG,
    ui.scene.clientWidth / ui.scene.clientHeight,
    0.1,
    900,
  );
  perspectiveCamera.name = "TrafficDirector_PerspectiveCamera";
  camera = perspectiveCamera;

  renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(
    devicePixelRatio,
    runtime.renderProfile.maxPixelRatio,
  ));
  renderer.setSize(ui.scene.clientWidth, ui.scene.clientHeight);
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LIGHTING.exposure;
  renderer.domElement.setAttribute(
    "aria-label",
    "KBot 在公館路口指揮隨機車流與行人的三維畫面",
  );
  ui.scene.append(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 350;
  controls.maxPolarAngle = Math.PI * 0.47;
  // 互動方案 B(見 §20 回報):左鍵拖曳 = Orbit、Shift+左鍵 = Pan、
  // 中鍵 = Dolly、右鍵 = Pan、滾輪 = Zoom;左鍵「點一下不拖」= 選取。
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.85;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  setupCameraInteraction();

  // Runtime actors use Roosevelt/cross-road coordinates. Yaw is calibrated
  // against the painted lane lines of the V54 environment: 0.75π alone is
  // ~1.7° off the true road axis (cars drift a full lane over the scene
  // length), so the fitted correction atan(-0.02957) is applied
  // (SPEC_VIEWER_V2 §7).
  runtime.simulationRoot = new THREE.Group();
  runtime.simulationRoot.name = "V54_Runtime_Actors";
  runtime.simulationRoot.position.set(-1.2, 0, 0.9);
  runtime.simulationRoot.rotation.y = Math.PI * 0.75 + Math.atan(-0.02957);
  runtime.simulationRoot.scale.set(1, 1, -1);
  scene.add(runtime.simulationRoot);
  runtime.hookTurnBox = buildHookTurnBox();
  runtime.simulationRoot.add(runtime.hookTurnBox);
  // 崗位標記(§18):預設 visible=false,只有開啟「崗位預覽」才顯示。
  runtime.kbotPostMarkers = buildKbotPostMarkers();
  runtime.simulationRoot.add(runtime.kbotPostMarkers);
  cameraDirector.homeCenter.copy(simulationPoint(0, 0, 0));
  buildViewCubeBasis();
  applyCameraModeConstraints();
  setCamera("overview", { immediate: true });
  updateCameraSelectionLabel();
  syncCameraModeButtons();
  syncProjectionButton();
  updateViewCube(true);

  runtime.hemiLight = new THREE.HemisphereLight(
    0xb8e1f2, 0x24302c, LIGHTING.hemisphere,
  );
  scene.add(runtime.hemiLight);
  const sun = new THREE.DirectionalLight(0xfff4d6, LIGHTING.sun);
  runtime.sunLight = sun;
  sun.position.copy(simulationPoint(-32, 58, -38));
  sun.castShadow = LOW_LOAD_RENDER_PROFILE.shadows;
  sun.shadow.camera.left = -75;
  sun.shadow.camera.right = 75;
  sun.shadow.camera.top = 75;
  sun.shadow.camera.bottom = -75;
  scene.add(sun);

  // 中性色輪廓燈:先前的青藍色打在綠色機身上會產生病態色偏。
  const kbotRim = new THREE.SpotLight(0xe4efe8, 34, 18, Math.PI / 4, 0.65, 1.4);
  kbotRim.position.copy(simulationPoint(
    KBOT_STAND.x - 4.5,
    6.5,
    KBOT_STAND.z - 3.5,
  ));
  kbotRim.target.position.copy(
    simulationPoint(KBOT_STAND.x, KBOT_STAND.y + 1.03, KBOT_STAND.z),
  );
  scene.add(kbotRim, kbotRim.target);
  runtime.kbotRim = kbotRim;
  const kbotFill = new THREE.PointLight(0xeaf2ec, 7, 10, 1.6);
  kbotFill.position.copy(simulationPoint(
    KBOT_STAND.x + 2.8,
    3.8,
    KBOT_STAND.z + 1.6,
  ));
  scene.add(kbotFill);
  runtime.kbotFill = kbotFill;

  window.addEventListener("resize", () => {
    resizeRenderer();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clock?.start();
      lastRenderAtMs = performance.now();
    }
  });

  clock = new THREE.Clock();
}

function animate(nowMs = performance.now()) {
  requestAnimationFrame(animate);
  if (document.hidden) {
    clock.getDelta();
    return;
  }
  const minimumFrameIntervalMs = 1000 / runtime.renderProfile.targetFps;
  if (nowMs - lastRenderAtMs < minimumFrameIntervalMs) return;
  lastRenderAtMs = nowMs;
  const delta = Math.min(clock.getDelta(), 0.05);
  updatePhaseMachine(delta);
  updateVehicles(delta);
  updatePedestrians(delta);
  updateKbotGestureAnimation(delta);
  const uiIntervalMs = 1000 / runtime.renderProfile.uiUpdateHz;
  if (nowMs - lastUiUpdateAtMs >= uiIntervalMs) {
    lastUiUpdateAtMs = nowMs;
    updateSafetyUi();
    updateMetrics();
    syncSignalAspects();
  }
  advanceCameraTransition(delta);
  updateKbotCameraFollow(delta);
  updateKbotLights();
  controls.update();
  enforceCameraGuards();
  updateViewCube();
  renderer.render(scene, camera);
  runtime.renderStats.renderedFrames += 1;
  fpsWindowFrames += 1;
  if (fpsWindowStartedAtMs === 0) fpsWindowStartedAtMs = nowMs;
  const fpsWindowMs = nowMs - fpsWindowStartedAtMs;
  if (fpsWindowMs >= 1000) {
    runtime.renderStats.measuredFps = Number(
      (fpsWindowFrames * 1000 / fpsWindowMs).toFixed(1),
    );
    fpsWindowStartedAtMs = nowMs;
    fpsWindowFrames = 0;
  }
}

async function main() {
  try {
    const response = await fetch(RULES_URL);
    if (!response.ok) throw new Error(`規則 HTTP ${response.status}`);
    runtime.rules = await response.json();
    runtime.auto = ui.autoMode.checked;
    runtime.downstreamBlocked = ui.downstreamBlocked.checked;
    runtime.reducedMotion = !ui.motionEffects.checked;
    runtime.trafficMode = ui.trafficDensity.value;
    applyRenderProfile(
      ui.highPerformance.checked ? "performance" : "powersave",
    );
    random = mulberry32(runtime.rules.simulation_constants.seed);

    initThree();
    await loadEnvironment();
    // 行人模型:載入失敗不中斷模擬,退回程序化行人(KBot 才是 fail-closed)。
    await loadPedestrianModel();
    initializePhases();
    populateSources();
    setupUiEvents();
    applyPacingPreset(ui.pacingPreset.value);
    applyHookTurnSetting(ui.hookTurn.checked);
    // 登錄表要在節奏預設套用完之後才建,快照到的預設值才是使用者看到的預設。
    setupParamPanel();
    spawnActors();
    await loadSignalAspects();
    await loadKbot();
    applyAllSceneLayers();
    animate();
  } catch (error) {
    console.error(error);
    setModelStatus("error", "指定 V54 場景載入失敗");
    setFatalError(
      `模擬無法啟動：${error.message}。請從專案根目錄執行 python3 -m http.server 8765。`,
    );
  }
}

main();
