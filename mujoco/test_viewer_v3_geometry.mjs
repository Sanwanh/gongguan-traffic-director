// Regression tests for the V3 marking calibration (SPEC_VIEWER_V2 §7):
// spawn keep-out, painted stop-bar convergence, crosswalk-band t awareness,
// carriageway curve offsets, and side-access geometry.
// Run: node mujoco/test_viewer_v3_geometry.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUS_LANES,
  CROSSWALK_BANDS,
  advancePedestrian,
  buildPedestrianCrossing,
  mulberry32,
  MAIN_ROOSEVELT_LANES,
  SIDE_END_T,
  SIDE_STOP_T,
  STOP_SEQUENCES,
  TRAFFIC_DENSITY_MODES,
  buildSpawnPlan,
  distanceToNextStop,
  kbotMotionSample,
  nextStopLine,
  roadCurveOffset,
  roadCurveSlope,
  vehicleClearsCrosswalk,
  vehicleOccupiesTransitionConflict,
} from "../viewer/traffic_simulation_core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(
  join(here, "..", "traffic_rules", "taiwan_traffic_director_rules.json"),
  "utf8",
));
const mix = rules.simulation_constants.vehicle_mix_project_assumption;
const pedestrianSpeed = rules.simulation_constants.pedestrian_walk_speed_mps;
const failures = [];

// 1. Spawn keep-out: nobody spawns committed past a stop bar or on a band.
for (const seed of Array.from({ length: 20 }, (_, i) => 20260728 + i)) {
  for (const mode of Object.keys(TRAFFIC_DENSITY_MODES)) {
    const plan = buildSpawnPlan(seed, mix, pedestrianSpeed, mode);
    for (const vehicle of plan.vehicles) {
      if (vehicle.sideAccess) continue;
      const envelope = {
        s: vehicle.s,
        t: vehicle.t,
        length: vehicle.length,
        direction: vehicle.direction,
        sideAccess: false,
        laneClass: vehicle.lanePosition === "bus" ? "bus" : "general",
      };
      if (vehicleOccupiesTransitionConflict(envelope)) {
        failures.push(
          `${seed}/${mode}/${vehicle.id}: spawned inside transition conflict `
          + `(s=${vehicle.s.toFixed(2)})`,
        );
      }
      if (!vehicleClearsCrosswalk(envelope)) {
        failures.push(
          `${seed}/${mode}/${vehicle.id}: spawned on a crosswalk band `
          + `(s=${vehicle.s.toFixed(2)}, t=${vehicle.t})`,
        );
      }
    }
    for (const pedestrian of plan.pedestrians) {
      const crossing = pedestrian.crossing;
      const last = crossing.path[crossing.path.length - 1];
      if (Math.sign(last.t) === Math.sign(crossing.curb.t)) {
        failures.push(`${seed}/${mode}/${pedestrian.id}: ${crossing.kind} `
          + "does not end on the far side");
      }
      if (crossing.kind === "straight") {
        // 走廊內縮避開中央公車月台(BusStop_1 x>=15.3)
        if (pedestrian.curbS < 11.2 || pedestrian.curbS > 14.6) {
          failures.push(
            `${seed}/${mode}/${pedestrian.id}: straight curbS `
            + `${pedestrian.curbS} outside corridor [11.2,14.6]`,
          );
        }
      } else if (crossing.kind === "staggered") {
        const [near, refuge] = crossing.path;
        if (near.s < -19.25 || near.s > -7.54) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: staggered near `
            + `s=${near.s} outside painted halves`);
        }
        if (refuge.t < 0.85 || refuge.t > 1.7 || !refuge.refuge
          || !refuge.safeLeg) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: refuge waypoint `
            + `invalid (t=${refuge.t})`);
        }
      } else if (crossing.kind === "bus_se" || crossing.kind === "bus_nw") {
        const wait = crossing.path.find((waypoint) => waypoint.busStop);
        const gate = crossing.path.find((waypoint) => waypoint.refuge);
        if (!wait || !wait.safeLeg || wait.y !== 0.15) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: ${crossing.kind} `
            + "missing safe platform wait waypoint");
        } else if (crossing.kind === "bus_se"
          && (wait.s < 16.3 || wait.s > 25 || wait.t < 4.3 || wait.t > 7.0)) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: bus_se wait spot `
            + `(${wait.s.toFixed(1)},${wait.t}) off platform`);
        } else if (crossing.kind === "bus_nw"
          && (wait.s < -67.8 || wait.s > -12.4 || wait.t > -2.1 || wait.t < -5.8)) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: bus_nw wait spot `
            + `(${wait.s.toFixed(1)},${wait.t}) off platform`);
        }
        if (!gate) {
          failures.push(`${seed}/${mode}/${pedestrian.id}: ${crossing.kind} `
            + "has no refuge gate before re-entering the roadway");
        }
      } else {
        failures.push(`${seed}/${mode}/${pedestrian.id}: unknown crossing `
          + `kind ${crossing.kind}`);
      }
    }
  }
}

// 2. Stop-bar convergence: the viewer's graded-braking loop must bring a
// red-phase vehicle to rest with its front bumper at the painted bar
// (within 0.5 m), never past it, never on a band.
function settleAtStop(direction, laneClass, lane, startS, desiredSpeed) {
  const length = laneClass === "bus" ? 10.8 : 4.8;
  const vehicle = { s: startS, speed: 0 };
  const dt = 1 / 60;
  for (let step = 0; step < 60 * 120; step += 1) {
    const envelope = {
      s: vehicle.s, t: lane, length, direction, laneClass, sideAccess: false,
    };
    const line = nextStopLine(envelope);
    if (!line) return { crossed: true, s: vehicle.s };
    const stopDistance = distanceToNextStop(envelope);
    const target = Math.min(desiredSpeed, stopDistance * 0.65);
    const acceleration = target > vehicle.speed ? 2.0 : 3.8;
    vehicle.speed += Math.max(
      -acceleration * dt,
      Math.min(acceleration * dt, target - vehicle.speed),
    );
    vehicle.speed = Math.max(0, vehicle.speed);
    vehicle.s += direction * vehicle.speed * dt;
    const frontU = (vehicle.s + direction * length * 0.5) * direction;
    if (frontU > line.stop * direction) {
      vehicle.s = line.stop - direction * length * 0.5;
      vehicle.speed = 0;
    }
    if (vehicle.speed < 1e-4 && stopDistance < 1.0 && step > 60) {
      return { crossed: false, s: vehicle.s, line, stopDistance };
    }
  }
  return { crossed: false, timeout: true, s: vehicle.s };
}

const stopCases = [
  { direction: 1, laneClass: "general", lane: -6.22, startS: -60 },
  { direction: 1, laneClass: "bus", lane: -0.44, startS: -60 },
  { direction: -1, laneClass: "general", lane: 9.98, startS: 60 },
  { direction: -1, laneClass: "bus", lane: 2.97, startS: 60 },
];
for (const testCase of stopCases) {
  const settle = settleAtStop(
    testCase.direction, testCase.laneClass, testCase.lane,
    testCase.startS, 7.9,
  );
  const label = `dir=${testCase.direction}/${testCase.laneClass}`;
  if (settle.crossed || settle.timeout) {
    failures.push(`${label}: did not settle at a stop bar (${JSON.stringify(settle)})`);
    continue;
  }
  if (settle.stopDistance > 0.5) {
    failures.push(
      `${label}: settled ${settle.stopDistance.toFixed(2)} m short of the bar`,
    );
  }
  const length = testCase.laneClass === "bus" ? 10.8 : 4.8;
  const envelope = {
    s: settle.s, t: testCase.lane, length,
    direction: testCase.direction, laneClass: testCase.laneClass,
    sideAccess: false,
  };
  if (!vehicleClearsCrosswalk(envelope)) {
    failures.push(`${label}: settled position overlaps a crosswalk band`);
  }
  if (vehicleOccupiesTransitionConflict(envelope)) {
    failures.push(`${label}: settled position counts as occupying conflict`);
  }
}

// 3. t awareness: an SE bus waiting at its second bar (-7.05) must clear the
// negative-t staggered band right next to it, and every waiting position at
// a painted bar must satisfy the 0.8 m crosswalk margin.
{
  const bus = {
    s: -7.05 + 10.8 / 2, t: 2.97, length: 10.8,
    direction: -1, laneClass: "bus", sideAccess: false,
  };
  if (!vehicleClearsCrosswalk(bus)) {
    failures.push("SE bus at bar -7.05 wrongly blocked by stag_neg band");
  }
}
for (const [laneClass, byDirection] of Object.entries(STOP_SEQUENCES)) {
  for (const [directionKey, sequence] of Object.entries(byDirection)) {
    const direction = Number(directionKey);
    const length = laneClass === "bus" ? 10.8 : 4.8;
    const lane = laneClass === "bus"
      ? BUS_LANES.find((entry) => entry.direction === direction).t
      : MAIN_ROOSEVELT_LANES.find((entry) => entry.direction === direction).t;
    for (const line of sequence) {
      const envelope = {
        s: line.stop - direction * length * 0.5,
        t: lane, length, direction, laneClass, sideAccess: false,
      };
      if (!vehicleClearsCrosswalk(envelope)) {
        failures.push(
          `${laneClass}/dir=${direction}: waiting at bar ${line.stop} `
          + "violates the crosswalk margin",
        );
      }
    }
  }
}

// 3b. Pass-through semantics: past the FIRST bar a vehicle is never
// arrested again, and it occupies the conflict zone until clear of the LAST
// exit (so gates stay safe for mid-box movers).
{
  const midBox = {
    s: 4.0, t: -6.22, length: 4.8, direction: 1,
    laneClass: "general", sideAccess: false,
  };
  if (nextStopLine(midBox) !== null) {
    failures.push("mid-box vehicle still arrested by a second stop bar");
  }
  if (!vehicleOccupiesTransitionConflict(midBox)) {
    failures.push("mid-box vehicle not counted in the conflict zone");
  }
  const beyondExit = { ...midBox, s: 32.0 };
  if (vehicleOccupiesTransitionConflict(beyondExit)) {
    failures.push("vehicle beyond the last exit still counted as conflict");
  }
  if (nextStopLine({ ...midBox, s: -25.0 }) === null) {
    failures.push("upstream vehicle lost its first stop bar");
  }
}

// 4. Curve offsets: zero-ish at s=0, clamped at the ends, slope finite.
for (const direction of [1, -1]) {
  if (Math.abs(roadCurveOffset(direction, 0)) > 0.7) {
    failures.push(`curve offset at s=0 too large for dir=${direction}`);
  }
  const farLow = roadCurveOffset(direction, -500);
  const farHigh = roadCurveOffset(direction, 500);
  if (!Number.isFinite(farLow) || !Number.isFinite(farHigh)) {
    failures.push(`curve offset not clamped for dir=${direction}`);
  }
  if (roadCurveSlope(direction, -500) !== 0
    || roadCurveSlope(direction, 500) !== 0) {
    failures.push(`curve slope not zero beyond samples for dir=${direction}`);
  }
  for (let s = -100; s <= 100; s += 5) {
    if (Math.abs(roadCurveSlope(direction, s)) > 0.06) {
      failures.push(`curve slope too steep at s=${s} dir=${direction}`);
    }
  }
}

// 5. Side access geometry: spawns on the market side (+t), stop before the
// road, transition conflict window consistent.
{
  if (!(SIDE_STOP_T > SIDE_END_T)) {
    failures.push("SIDE_STOP_T must be greater than SIDE_END_T");
  }
  const waiting = { sideAccess: true, t: SIDE_STOP_T, length: 2.5 };
  if (vehicleOccupiesTransitionConflict(waiting)) {
    failures.push("side vehicle waiting at SIDE_STOP_T counts as conflict");
  }
  const merging = { sideAccess: true, t: (SIDE_STOP_T + SIDE_END_T) / 2, length: 2.5 };
  if (!vehicleOccupiesTransitionConflict(merging)) {
    failures.push("side vehicle inside the mouth not counted as conflict");
  }
  const plan = buildSpawnPlan(20260728, mix, pedestrianSpeed, "normal");
  for (const vehicle of plan.vehicles.filter((entry) => entry.sideAccess)) {
    if (vehicle.t < 20) {
      failures.push(`${vehicle.id}: side spawn t=${vehicle.t} not on market side`);
    }
    if (vehicle.s < -11 || vehicle.s > -3) {
      failures.push(`${vehicle.id}: side spawn s=${vehicle.s} outside corridor`);
    }
  }
}

// 6. Gesture continuity: in-window playback must never jump — the ping-pong
// triangle wave keeps |frame(t+dt) - frame(t)| <= fps*dt for every window.
for (const window of [
  { start: 49, end: 240 },
  { start: 289, end: 899 },
  { start: 948, end: 1067 },
]) {
  const fps = 24;
  const dt = 1 / 60;
  let previous = null;
  for (let elapsed = 0; elapsed <= 90; elapsed += dt) {
    const sample = kbotMotionSample({
      phaseId: "roosevelt_flow",
      elapsedS: elapsed,
      startFrame: window.start,
      endFrame: window.end,
      fps,
    });
    if (sample.frame < window.start - 1e-9
      || sample.frame > window.end + 1e-9) {
      failures.push(
        `window ${window.start}-${window.end}: frame ${sample.frame} escaped`,
      );
      break;
    }
    if (previous !== null
      && Math.abs(sample.frame - previous) > fps * dt + 1e-6) {
      failures.push(
        `window ${window.start}-${window.end}: frame jump `
        + `${previous.toFixed(2)} -> ${sample.frame.toFixed(2)} at t=${elapsed.toFixed(2)}`,
      );
      break;
    }
    previous = sample.frame;
  }
}

// 6b. Staggered crossing behaviour: WALK drop at the refuge parks the
// pedestrian on the divider strip (safeZone) until the next WALK; the full
// crossing completes afterwards.
{
  const random = mulberry32(777);
  let crossing = null;
  for (let attempt = 0; attempt < 64 && !crossing; attempt += 1) {
    const candidate = buildPedestrianCrossing(random, 1, 1.45);
    if (candidate.kind === "staggered") crossing = candidate;
  }
  if (!crossing) {
    failures.push("buildPedestrianCrossing never produced a staggered plan");
  } else {
    let pedestrian = {
      state: "crossing", pathIndex: 0, safeZone: false,
      s: crossing.curb.s, t: crossing.curb.t,
      crossing, speed: 1.45, waitDelay: 0.4, waitElapsed: 0,
      heading: "t_negative",
    };
    const dt = 0.1;
    let steps = 0;
    // 第一段:WALK 已結束(walkAllowed=false),必須在島上停下
    while (pedestrian.state === "crossing" && steps < 2000) {
      pedestrian = advancePedestrian(pedestrian, { delta: dt, walkAllowed: false });
      steps += 1;
    }
    if (pedestrian.state !== "waiting_at_refuge") {
      failures.push(`staggered did not wait at refuge (state=${pedestrian.state})`);
    } else {
      if (!pedestrian.safeZone) failures.push("refuge wait not marked safeZone");
      if (Math.abs(pedestrian.t - 1.28) > 0.05) {
        failures.push(`refuge wait at t=${pedestrian.t}, expected divider strip`);
      }
      // 下一次 WALK:走完第二段到對側
      steps = 0;
      while (pedestrian.state !== "sidewalk_departure" && steps < 4000) {
        pedestrian = advancePedestrian(pedestrian, { delta: dt, walkAllowed: true });
        steps += 1;
      }
      if (pedestrian.state !== "sidewalk_departure") {
        failures.push("staggered second half never completed");
      } else if (Math.abs(pedestrian.t + 17.5) > 0.05) {
        failures.push(`staggered ended at t=${pedestrian.t}, expected -17.5`);
      }
    }
  }
}

// 7. Bands sanity: three bands, straight band matches the painted extent.
if (CROSSWALK_BANDS.length !== 3) failures.push("expected 3 crosswalk bands");
const straight = CROSSWALK_BANDS.find((band) => band.id === "straight");
if (!straight || straight.sMax < 16 || straight.sMin > 11) {
  failures.push("straight band does not cover the painted zebra [10.59,16.30]");
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} failure(s)`);
  for (const failure of failures.slice(0, 30)) console.error(" -", failure);
  process.exit(1);
}
console.log(
  "PASS viewer V3 geometry: spawn keep-out (60 plans), stop-bar convergence "
  + "(4 lane classes), crosswalk t-awareness, curve offsets, side-access "
  + "geometry, band extents OK",
);
