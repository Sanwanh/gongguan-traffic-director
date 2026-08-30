// Property tests for SPEC_VIEWER_V2 §4 (lane rules) and §5 (spawn safety).
// Run: node mujoco/test_lane_rules.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUS_LANES,
  MAIN_ROOSEVELT_LANES,
  SPAWN_SPAN_M,
  TRAFFIC_DENSITY_MODES,
  applyLiveTrafficBudget,
  buildSpawnPlan,
  directionForSplit,
  laneForVehicle,
  laneForVehicleByQuota,
  mulberry32,
  resetLiveTrafficBudget,
  spawnHeadwayViolations,
  vdVolumeToPopulation,
} from "../viewer/traffic_simulation_core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(
  join(here, "..", "traffic_rules", "taiwan_traffic_director_rules.json"),
  "utf8",
));
const mix = rules.simulation_constants.vehicle_mix_project_assumption;
const pedestrianSpeed = rules.simulation_constants.pedestrian_walk_speed_mps;

const seeds = Array.from({ length: 20 }, (_, index) => 20260728 + index);
const modes = Object.keys(TRAFFIC_DENSITY_MODES);
const allLanes = [...MAIN_ROOSEVELT_LANES, ...BUS_LANES];
const failures = [];
let checkedPlans = 0;
let checkedVehicles = 0;
let totalReductions = 0;

function laneOf(vehicle) {
  return allLanes.find((lane) =>
    lane.movement === vehicle.movement
    && Math.abs(lane.t - vehicle.t) < 1e-9);
}

for (const seed of seeds) {
  for (const mode of modes) {
    const plan = buildSpawnPlan(seed, mix, pedestrianSpeed, mode);
    checkedPlans += 1;
    totalReductions += plan.spawnReductions ?? 0;
    const budget = TRAFFIC_DENSITY_MODES[mode];
    const main = plan.vehicles.filter((vehicle) => !vehicle.sideAccess);

    if (
      plan.spawnReductions === 0
      && (main.length < budget.mainVehicleMin
        || main.length > budget.mainVehicleMax)
    ) {
      failures.push(`${seed}/${mode}: main count ${main.length} outside `
        + `${budget.mainVehicleMin}-${budget.mainVehicleMax}`);
    }
    if (plan.pedestrians.length < budget.pedestrianMin
      || plan.pedestrians.length > budget.pedestrianMax) {
      failures.push(`${seed}/${mode}: pedestrian count `
        + `${plan.pedestrians.length} outside budget`);
    }

    for (const vehicle of main) {
      checkedVehicles += 1;
      const lane = laneOf(vehicle);
      if (!lane) {
        failures.push(
          `${seed}/${mode}/${vehicle.id}: t=${vehicle.t} matches no lane`,
        );
        continue;
      }
      if (vehicle.type === "bus" && !BUS_LANES.includes(lane)) {
        failures.push(
          `${seed}/${mode}/${vehicle.id}: bus off bus lane (t=${vehicle.t})`,
        );
      }
      if (vehicle.type !== "bus" && BUS_LANES.includes(lane)) {
        failures.push(
          `${seed}/${mode}/${vehicle.id}: ${vehicle.type} on bus lane`,
        );
      }
      if (!lane.allowed.includes(vehicle.type)) {
        failures.push(`${seed}/${mode}/${vehicle.id}: ${vehicle.type} not in `
          + `allowed [${lane.allowed.join(",")}] of lane t=${lane.t}`);
      }
    }

    // §5 spawn gaps, checked with the spec's follower-speed formula:
    // gap >= (frontLen + rearLen)/2 + max(6, followerSpeed * 1.2).
    const byLane = new Map();
    for (const vehicle of main) {
      const key = `${vehicle.movement}:${vehicle.t}`;
      if (!byLane.has(key)) byLane.set(key, []);
      byLane.get(key).push(vehicle);
    }
    for (const [laneKey, group] of byLane) {
      const ordered = [...group].sort(
        (a, b) => a.s * a.direction - b.s * b.direction,
      );
      for (let index = 0; index + 1 < ordered.length; index += 1) {
        const rear = ordered[index];
        const front = ordered[index + 1];
        const gap = (front.s - rear.s) * front.direction;
        const needed = (front.length + rear.length) / 2
          + Math.max(6, rear.desiredSpeed * 1.2);
        if (gap + 1e-6 < needed) {
          failures.push(`${seed}/${mode}: ${laneKey} ${rear.id}->${front.id} `
            + `gap ${gap.toFixed(2)} < ${needed.toFixed(2)}`);
        }
      }
    }
    if (spawnHeadwayViolations(plan.vehicles).length > 0) {
      failures.push(`${seed}/${mode}: core spawnHeadwayViolations non-empty`);
    }

    // Determinism: same seed + mode must reproduce identical placement.
    const replay = buildSpawnPlan(seed, mix, pedestrianSpeed, mode);
    if (JSON.stringify(replay.vehicles) !== JSON.stringify(plan.vehicles)) {
      failures.push(`${seed}/${mode}: plan not deterministic`);
    }
  }
}

// laneForVehicle pure-function properties.
const rng = mulberry32(4242);
const types = ["bus", "car", "taxi", "scooter", "motorcycle", "bicycle"];
for (let index = 0; index < 6000; index += 1) {
  const type = types[index % types.length];
  const lane = laneForVehicle(type, rng);
  if (type === "bus") {
    if (!BUS_LANES.includes(lane)) {
      failures.push("laneForVehicle(bus) returned a non-bus lane");
    }
  } else {
    if (BUS_LANES.includes(lane)) {
      failures.push(`laneForVehicle(${type}) returned a bus lane`);
    }
    if (!lane.allowed.includes(type)) {
      failures.push(`laneForVehicle(${type}) picked a lane that bans it`);
    }
    if (type === "bicycle" && lane.lanePosition !== "outer") {
      failures.push("laneForVehicle(bicycle) not on outer lane");
    }
  }
}

// ---------------------------------------------------------------------------
// §24 即時資料層的純函式(SPEC_VIEWER_V2 §24、data/SCHEMA.md §5)
// ---------------------------------------------------------------------------

// 1) 沒給 options 時,buildSpawnPlan 必須與改動前**位元相同**。
//    這一條是整個 §24 不破壞既有行為的保證。
for (const seed of seeds.slice(0, 6)) {
  for (const mode of modes) {
    const plain = buildSpawnPlan(seed, mix, pedestrianSpeed, mode);
    const emptyOptions = buildSpawnPlan(seed, mix, pedestrianSpeed, mode, {});
    if (JSON.stringify(plain.vehicles) !== JSON.stringify(emptyOptions.vehicles)) {
      failures.push(`${seed}/${mode}: options={} changed the plan`);
    }
    if (plain.directionSplit !== null || plain.laneQuotaApplied !== false) {
      failures.push(`${seed}/${mode}: default plan reports a data layer`);
    }
  }
}

// 2) 映射公式:q = Volume x 12 ; k = q / max(5, v) ; N = k/lanes x span x 6
//    用 2024-11-14 快照裡 VELJA00 的實測值當黃金樣本。
{
  const golden = vdVolumeToPopulation({
    volumeVehPer5Min: 135, avgSpeedKph: 1620 / 27.036,
    laneCount: 6, targetLanes: 6, spanM: 136,
  });
  if (Math.abs(golden.flowVph - 1620) > 0.5) {
    failures.push(`vdVolumeToPopulation flow ${golden.flowVph} != 1620`);
  }
  if (Math.abs(golden.densityVehPerKm - 27.036) > 0.01) {
    failures.push(`vdVolumeToPopulation k ${golden.densityVehPerKm} != 27.036`);
  }
  if (Math.abs(golden.raw - 3.677) > 0.01) {
    failures.push(`vdVolumeToPopulation N ${golden.raw} != 3.677`);
  }
  // 速度為 0 / -99(TDX 的資料異常旗標)時必須套下限,不可除以 0。
  for (const bad of [0, -99, Number.NaN, null]) {
    const floored = vdVolumeToPopulation({
      volumeVehPer5Min: 60, avgSpeedKph: bad, laneCount: 2, targetLanes: 6,
    });
    if (!Number.isFinite(floored.raw) || floored.speedKph !== 5
      || floored.speedFloored !== true) {
      failures.push(`vdVolumeToPopulation did not floor speed=${bad}`);
    }
  }
  // 預設跨距必須是 core 的 SPAWN_SPAN_M,不是另外寫死的數字。
  const defaulted = vdVolumeToPopulation({
    volumeVehPer5Min: 100, avgSpeedKph: 30, laneCount: 3,
  });
  const explicit = vdVolumeToPopulation({
    volumeVehPer5Min: 100, avgSpeedKph: 30, laneCount: 3, spanM: SPAWN_SPAN_M,
  });
  if (defaulted.raw !== explicit.raw) {
    failures.push("vdVolumeToPopulation default span != SPAWN_SPAN_M");
  }
}

// 3) applyLiveTrafficBudget:只准動 live、夾在 §19 的值域內、min>max 會互換。
{
  const before = JSON.stringify(
    ["sparse", "normal", "peak"].map((m) => TRAFFIC_DENSITY_MODES[m]),
  );
  applyLiveTrafficBudget({ mainVehicleMin: 999, mainVehicleMax: -5 });
  const after = JSON.stringify(
    ["sparse", "normal", "peak"].map((m) => TRAFFIC_DENSITY_MODES[m]),
  );
  if (before !== after) failures.push("applyLiveTrafficBudget touched other modes");
  const live = TRAFFIC_DENSITY_MODES.live;
  if (live.mainVehicleMin !== 0 || live.mainVehicleMax !== 80) {
    failures.push(`applyLiveTrafficBudget clamp/swap wrong: `
      + `${live.mainVehicleMin}-${live.mainVehicleMax}`);
  }
  const rejected = applyLiveTrafficBudget({ nope: 1, pedestrianMin: "abc" });
  if (!rejected.rejected.some((r) => r.key === "nope" && r.reason === "unknown-key")
    || !rejected.rejected.some((r) => r.key === "pedestrianMin")) {
    failures.push("applyLiveTrafficBudget did not reject bad keys/values");
  }
  const reset = resetLiveTrafficBudget();
  if (reset.mainVehicleMin !== 22 || reset.mainVehicleMax !== 28
    || reset.pedestrianMin !== 10 || reset.pedestrianMax !== 16
    || reset.sideVehiclesPerColumn !== 3) {
    failures.push("resetLiveTrafficBudget did not restore factory values");
  }
  // 預算真的驅動生成數量。
  applyLiveTrafficBudget({ mainVehicleMin: 5, mainVehicleMax: 5 });
  const small = buildSpawnPlan(20260728, mix, pedestrianSpeed, "live");
  const smallMain = small.vehicles.filter((v) => !v.sideAccess).length;
  if (small.spawnReductions === 0 && smallMain !== 5) {
    failures.push(`live budget 5 produced ${smallMain} main vehicles`);
  }
  resetLiveTrafficBudget();
}

// 4) directionForSplit:比例要對得上,而且只回 +1 / -1。
{
  for (const split of [0, 0.25, 0.5, 0.9, 1]) {
    const rng = mulberry32(99);
    let northwest = 0;
    for (let i = 0; i < 20000; i += 1) {
      const direction = directionForSplit(rng, split);
      if (direction !== 1 && direction !== -1) {
        failures.push(`directionForSplit returned ${direction}`);
        break;
      }
      if (direction === 1) northwest += 1;
    }
    if (Math.abs(northwest / 20000 - split) > 0.02) {
      failures.push(`directionForSplit(${split}) gave ${northwest / 20000}`);
    }
  }
  // 越界的 split 要被夾住而不是丟錯。
  const rng = mulberry32(7);
  for (const bad of [-3, 5, Number.NaN, null, undefined]) {
    const direction = directionForSplit(rng, bad);
    if (direction !== 1 && direction !== -1) {
      failures.push(`directionForSplit(${bad}) returned ${direction}`);
    }
  }
}

// 5) laneForVehicleByQuota:allowed 清單仍是最後守門;權重 0 的位置不得被選。
{
  const rng = mulberry32(20260728);
  const types = ["car", "scooter", "motorcycle", "bicycle", "bus"];
  for (let index = 0; index < 12000; index += 1) {
    const type = types[index % types.length];
    // inner 權重 0 → 除了 bus 以外,不可以有任何車被放到內側車道。
    const quota = {
      1: { inner: 0, middle: 300, outer: 700 },
      "-1": { inner: 0, middle: 300, outer: 700 },
    };
    const lane = laneForVehicleByQuota(type, rng, 0.5, quota);
    if (!lane) { failures.push(`laneForVehicleByQuota(${type}) returned nothing`); continue; }
    if (type === "bus") {
      if (!BUS_LANES.includes(lane)) {
        failures.push("laneForVehicleByQuota(bus) left the bus lane");
      }
      continue;
    }
    if (BUS_LANES.includes(lane)) {
      failures.push(`laneForVehicleByQuota(${type}) landed on a bus lane`);
    }
    if (!lane.allowed.includes(type)) {
      failures.push(`laneForVehicleByQuota(${type}) ignored the allowed list `
        + `of lane t=${lane.t}`);
    }
    if (lane.lanePosition === "inner") {
      failures.push(`laneForVehicleByQuota(${type}) used a zero-weight lane`);
    }
  }
  // quota 為 null 時要退回 laneForVehicle 的既有規則。
  const plainRng = mulberry32(555);
  for (let index = 0; index < 3000; index += 1) {
    const lane = laneForVehicleByQuota("bicycle", plainRng, null, null);
    if (lane.lanePosition !== "outer") {
      failures.push("laneForVehicleByQuota(bicycle, no quota) left the outer lane");
    }
  }
}

// 6) 有 laneQuota 的計畫仍必須守住所有既有的車道與間距規則。
{
  const quota = {
    1: { inner: 100, middle: 300, outer: 600 },
    "-1": { inner: 500, middle: 400, outer: 100 },
  };
  for (const seed of seeds.slice(0, 8)) {
    const plan = buildSpawnPlan(seed, mix, pedestrianSpeed, "normal", {
      directionSplit: 0.62, laneQuota: quota,
    });
    if (plan.directionSplit !== 0.62 || plan.laneQuotaApplied !== true) {
      failures.push(`${seed}: plan did not echo the data layer options`);
    }
    for (const vehicle of plan.vehicles.filter((v) => !v.sideAccess)) {
      const lane = laneOf(vehicle);
      if (!lane) { failures.push(`${seed}: quota plan lane t=${vehicle.t} unknown`); continue; }
      if (!lane.allowed.includes(vehicle.type)) {
        failures.push(`${seed}: quota plan put ${vehicle.type} on a lane that bans it`);
      }
    }
    if (spawnHeadwayViolations(plan.vehicles).length > 0) {
      failures.push(`${seed}: quota plan violates spawn headway`);
    }
    // 呼叫端傳進來的 quota 物件不得被就地改掉。
    if (quota[1].outer !== 600 || quota["-1"].inner !== 500) {
      failures.push("buildSpawnPlan mutated the caller's laneQuota");
    }
  }
  // 方向比例真的生效:0.9 應該讓絕大多數車走 direction=+1。
  const skewed = buildSpawnPlan(20260728, mix, pedestrianSpeed, "peak", {
    directionSplit: 0.9,
  });
  const main = skewed.vehicles.filter((v) => !v.sideAccess);
  const northwest = main.filter((v) => v.direction === 1).length;
  if (northwest / main.length < 0.7) {
    failures.push(`directionSplit 0.9 gave only ${northwest}/${main.length} NW`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} failure(s)`);
  for (const failure of failures.slice(0, 30)) console.error(" -", failure);
  process.exit(1);
}
console.log(
  `PASS lane rules: ${checkedPlans} plans (${seeds.length} seeds x `
  + `${modes.length} modes), ${checkedVehicles} main vehicles; buses only on `
  + "bus lanes, no non-bus on bus lanes, all lane allowed lists respected, "
  + "all same-lane spawn gaps >= spec minimum; "
  + `spawnReductions total=${totalReductions}; `
  + "laneForVehicle purity checks (6000 draws) OK; "
  + "§24 data layer: default path bit-identical, q=k*v mapping golden values, "
  + "budget gate live-only + clamped, direction split, lane quota respects "
  + "every allowed list and never touches zero-weight lanes",
);
