// Property tests for SPEC_VIEWER_V2 §4 (lane rules) and §5 (spawn safety).
// Run: node mujoco/test_lane_rules.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUS_LANES,
  MAIN_ROOSEVELT_LANES,
  TRAFFIC_DENSITY_MODES,
  buildSpawnPlan,
  laneForVehicle,
  mulberry32,
  spawnHeadwayViolations,
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
  + "laneForVehicle purity checks (6000 draws) OK",
);
