// Regression tests for SPEC_VIEWER_V2 §13: controller posts/refuges, lane 90
// turning geometry (right turn + two-stage left), bus dwell stops, and the
// pedestrian boarding state machine.
// Run: node mujoco/test_v4_direction_and_turns.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUS_BOARDING_RADIUS_M,
  BUS_DWELL_SECONDS,
  BUS_DWELL_STOPS,
  BUS_PLATFORMS,
  CONTROLLER_REFUGES,
  CROSSWALK_BANDS,
  HOOK_BOX,
  HOOK_BOX_FILL_ORDER,
  HOOK_PARKED_CLEARANCE_M,
  LANE90_HOOK_CORRIDOR_S,
  LANE90_HOOK_LANE_T,
  LANE90_RIGHT_LANE_T,
  MAIN_ROOSEVELT_LANES,
  SIDE_ACCESS_SPAWNS,
  SIDE_COLUMN_HEADWAY_M,
  SIDE_STOP_T,
  TRAFFIC_DENSITY_MODES,
  advancePedestrian,
  buildHookMergePath,
  buildLane90TurnPath,
  buildSpawnPlan,
  controllerSafeZone,
  hookBoxSlot,
  kerbT,
  lane90TurnFor,
  mulberry32,
  nearestControllerRefuge,
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

// Duty posts mirrored from traffic_director.js KBOT_POSTS_DEFAULT (kept in
// sync by test 1c). §18: the viewer's「機器人崗位微調」panel can change the
// live posts at runtime, but the exported snippet is what gets pasted back
// into KBOT_POSTS_DEFAULT — whenever that happens this mirror must be
// updated too, or the assertions below pass against stale coordinates.
const POSTS = {
  stand: { x: 15.0, z: 17.15 },
  crosswalk: { x: 15.00, z: 8.33 },
  lane90: { x: -0.5, z: 17.00 },
};
const TWO_WHEEL_LENGTH = 2.5;

// 1. Kerb model against the measured CurbPaint centre lines.
{
  const samples = [
    [1, -18.0, 15.60], [1, 56.0, 17.82],
    [-1, -17.5, -16.67], [-1, 57.0, -14.45],
  ];
  for (const [side, s, expected] of samples) {
    if (Math.abs(kerbT(side, s) - expected) > 0.12) {
      failures.push(
        `kerbT(${side}, ${s}) = ${kerbT(side, s).toFixed(2)}, expected ~${expected}`,
      );
    }
  }
  // 1b. Every refuge is classified safe; the crosswalk post is not.
  for (const refuge of CONTROLLER_REFUGES) {
    if (!controllerSafeZone(refuge.s, refuge.t)) {
      failures.push(`refuge ${refuge.id} is not inside a safe zone`);
    }
  }
  if (controllerSafeZone(POSTS.crosswalk.x, POSTS.crosswalk.z)) {
    failures.push("crosswalk post must NOT be a safe zone (robot must retreat)");
  }
  // 1c. Sidewalk posts are safe; lane centres never are.
  for (const post of [POSTS.stand, POSTS.lane90]) {
    if (!controllerSafeZone(post.x, post.z)) {
      failures.push(`sidewalk post (${post.x}, ${post.z}) classified unsafe`);
    }
  }
  for (const lane of MAIN_ROOSEVELT_LANES) {
    for (const s of [-20, -5, 0, 8, 18]) {
      if (controllerSafeZone(s, lane.t)) {
        failures.push(`lane centre t=${lane.t} at s=${s} classified as safe`);
      }
    }
  }
  // 1d. §16: retreating from the crosswalk post goes to the sidewalk head of
  // the crossing (bus platforms are no longer refuges — the user rejected
  // "directing traffic from inside the bus stop"), and from the far half of
  // the crossing to the far sidewalk.
  if (nearestControllerRefuge(POSTS.crosswalk.x, POSTS.crosswalk.z).id
    !== "sidewalk_pos") {
    failures.push("nearest refuge from the crosswalk post is not sidewalk_pos");
  }
  if (CONTROLLER_REFUGES.some((refuge) => refuge.id.startsWith("platform_"))) {
    failures.push("bus platforms must not be controller refuges (§16)");
  }
  // 1e. The retreat from the crosswalk post runs straight up the painted
  // crossing (same s), so it never cuts across a bus lane at an angle.
  {
    const refuge = nearestControllerRefuge(
      POSTS.crosswalk.x, POSTS.crosswalk.z,
    );
    if (Math.abs(refuge.s - POSTS.crosswalk.x) > 0.2) {
      failures.push(
        `crosswalk retreat is not axial: post s=${POSTS.crosswalk.x}, `
        + `refuge s=${refuge.s}`,
      );
    }
  }
  if (nearestControllerRefuge(POSTS.crosswalk.x, -8).id !== "sidewalk_neg") {
    failures.push("nearest refuge from the far half is not sidewalk_neg");
  }
}

// 2. Turning paths never intrude on a painted crosswalk band. The body is
// treated as a disc of the vehicle's length (stricter than the s-extent test
// the runtime uses), sampled along every leg.
function pathIntrudes(path, start) {
  const points = [start, ...path];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const steps = Math.max(
      2,
      Math.ceil(Math.hypot(b.s - a.s, b.t - a.t) / 0.25),
    );
    for (let step = 0; step <= steps; step += 1) {
      const s = a.s + (b.s - a.s) * (step / steps);
      const t = a.t + (b.t - a.t) * (step / steps);
      if (!vehicleClearsCrosswalk({ s, t, length: TWO_WHEEL_LENGTH })) {
        return `${s.toFixed(2)},${t.toFixed(2)}`;
      }
    }
  }
  return null;
}

for (const spawn of SIDE_ACCESS_SPAWNS) {
  const start = { s: spawn.s, t: SIDE_STOP_T };
  const right = buildLane90TurnPath("right", spawn.s);
  const hit = pathIntrudes(right, start);
  if (hit) failures.push(`right turn from s=${spawn.s} crosses a band at ${hit}`);
  const last = right[right.length - 1];
  if (Math.abs(last.t - LANE90_RIGHT_LANE_T) > 1e-9) {
    failures.push(`right turn does not end on the SE outer lane (t=${last.t})`);
  }
  for (let slot = 0; slot < HOOK_BOX.slots.length; slot += 1) {
    const hook = buildLane90TurnPath("hook", spawn.s, slot);
    const hookHit = pathIntrudes(hook, start);
    if (hookHit) {
      failures.push(
        `hook turn from s=${spawn.s} slot ${slot} crosses a band at ${hookHit}`,
      );
    }
    const merge = buildHookMergePath(hookBoxSlot(slot));
    const mergeHit = pathIntrudes(merge, hookBoxSlot(slot));
    if (mergeHit) {
      failures.push(`hook merge from slot ${slot} crosses a band at ${mergeHit}`);
    }
    if (Math.abs(merge[merge.length - 1].t - LANE90_HOOK_LANE_T) > 1e-9) {
      failures.push("hook merge does not end on the NW outer lane");
    }
  }
}

// 3. Hook box: slots inside the box, mutually clear, and the whole box stays
// out of the staggered crossing. Waiting riders must not count as occupying
// the junction (a painted waiting area is not a conflict), while the crossing
// legs of the manoeuvre are handled by the viewer's turnState check.
{
  const stagNeg = CROSSWALK_BANDS.find((band) => band.id === "stag_neg");
  if (HOOK_BOX.s - HOOK_BOX.halfS < stagNeg.sMax + 0.8) {
    failures.push("hook box overlaps the stag_neg clearance envelope");
  }
  if (LANE90_HOOK_CORRIDOR_S - TWO_WHEEL_LENGTH / 2 < stagNeg.sMax + 0.8) {
    failures.push("hook corridor overlaps the stag_neg clearance envelope");
  }
  for (let index = 0; index < HOOK_BOX.slots.length; index += 1) {
    const slot = hookBoxSlot(index);
    if (Math.abs(slot.s - HOOK_BOX.s) > HOOK_BOX.halfS
      || Math.abs(slot.t - HOOK_BOX.t) > HOOK_BOX.halfT) {
      failures.push(`hook slot ${index} lies outside the painted box`);
    }
    if (!vehicleClearsCrosswalk({
      s: slot.s, t: slot.t, length: TWO_WHEEL_LENGTH,
    })) {
      failures.push(`hook slot ${index} sits on a crosswalk band`);
    }
    if (vehicleOccupiesTransitionConflict({
      sideAccess: true, t: slot.t, length: TWO_WHEEL_LENGTH,
    })) {
      failures.push(`hook slot ${index} counts as occupying the junction`);
    }
    for (let other = 0; other < index; other += 1) {
      const peer = hookBoxSlot(other);
      if (Math.hypot(slot.s - peer.s, slot.t - peer.t) < 1.2) {
        failures.push(`hook slots ${other}/${index} overlap`);
      }
    }
  }
}

// 3b. Hook box gridlock guard (SPEC_VIEWER_V2 §14). A rider heading for the
// next free slot must never pass closer than HOOK_PARKED_CLEARANCE_M to a
// slot that is already occupied — otherwise turnPathBlocked stalls it inside
// the junction, the clearance phase never sees a clear box, Roosevelt never
// goes green, and the parked riders it is waiting on are never released.
{
  const distanceToSegment = (a, b, point) => {
    const deltaS = b.s - a.s;
    const deltaT = b.t - a.t;
    const lengthSquared = deltaS * deltaS + deltaT * deltaT;
    const u = lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, (
        (point.s - a.s) * deltaS + (point.t - a.t) * deltaT
      ) / lengthSquared));
    return Math.hypot(a.s + u * deltaS - point.s, a.t + u * deltaT - point.t);
  };
  const pathClearance = (path, start, point) => {
    const points = [start, ...path];
    let nearest = Infinity;
    for (let index = 0; index + 1 < points.length; index += 1) {
      nearest = Math.min(
        nearest,
        distanceToSegment(points[index], points[index + 1], point),
      );
    }
    return nearest;
  };
  if (HOOK_BOX_FILL_ORDER.length !== HOOK_BOX.slots.length
    || new Set(HOOK_BOX_FILL_ORDER).size !== HOOK_BOX.slots.length) {
    failures.push("HOOK_BOX_FILL_ORDER is not a permutation of the slots");
  }
  for (const spawn of SIDE_ACCESS_SPAWNS) {
    const start = { s: spawn.s, t: SIDE_STOP_T };
    for (let filled = 1; filled < HOOK_BOX_FILL_ORDER.length; filled += 1) {
      const next = HOOK_BOX_FILL_ORDER[filled];
      const path = buildLane90TurnPath("hook", spawn.s, next);
      for (let earlier = 0; earlier < filled; earlier += 1) {
        const occupied = hookBoxSlot(HOOK_BOX_FILL_ORDER[earlier]);
        const clearance = pathClearance(path, start, occupied);
        if (clearance < HOOK_PARKED_CLEARANCE_M) {
          failures.push(
            `hook slot ${next} approach passes ${clearance.toFixed(2)}m from`
            + ` occupied slot ${HOOK_BOX_FILL_ORDER[earlier]}`
            + ` (< ${HOOK_PARKED_CLEARANCE_M}m ⇒ junction gridlock)`,
          );
        }
      }
    }
  }
}

// 4. Turn assignment purity: cars never hook, two-wheelers get both.
{
  const seen = { car: new Set(), scooter: new Set() };
  for (let index = 0; index < 4000; index += 1) {
    const random = mulberry32(index + 1);
    seen.car.add(lane90TurnFor("car", random));
    seen.scooter.add(lane90TurnFor("scooter", mulberry32(index + 7)));
  }
  if (seen.car.size !== 1 || !seen.car.has("right")) {
    failures.push(`cars must only turn right, saw ${[...seen.car]}`);
  }
  if (!(seen.scooter.has("right") && seen.scooter.has("hook"))) {
    failures.push(`two-wheelers must draw both turns, saw ${[...seen.scooter]}`);
  }
}

// 5. Bus dwell stops sit inside the measured platform waiting bands and every
// waiting pedestrian is inside the boarding radius.
for (const [direction, stop] of Object.entries(BUS_DWELL_STOPS)) {
  const platform = BUS_PLATFORMS[stop.platform];
  if (!platform) {
    failures.push(`bus dwell stop ${direction} names an unknown platform`);
    continue;
  }
  const low = Math.min(platform.waitSMin, platform.waitSMax);
  const high = Math.max(platform.waitSMin, platform.waitSMax);
  if (stop.s < low - 6 || stop.s > high + 6) {
    failures.push(`bus dwell stop ${direction} (s=${stop.s}) is far from the platform`);
  }
  if (Math.max(Math.abs(stop.s - low), Math.abs(stop.s - high))
    > BUS_BOARDING_RADIUS_M) {
    failures.push(
      `bus dwell stop ${direction} cannot reach the whole waiting band`,
    );
  }
}
if (!(BUS_DWELL_SECONDS.min > 0 && BUS_DWELL_SECONDS.max > BUS_DWELL_SECONDS.min)) {
  failures.push("bus dwell seconds range is invalid");
}

// 6. Boarding state machine: a bus at the platform boards the waiter; without
// one the waiter eventually gives up and finishes the crossing.
{
  const random = mulberry32(99);
  const plan = buildSpawnPlan(20260728, mix, pedestrianSpeed, "normal");
  const waiter = plan.pedestrians.find(
    (pedestrian) => pedestrian.crossing.kind.startsWith("bus_"),
  );
  if (!waiter) {
    failures.push("no bus-stop pedestrian generated in the default plan");
  } else {
    if (!waiter.busPlatform) failures.push("bus pedestrian has no busPlatform");
    let boarding = { ...waiter, state: "waiting_for_bus", waitElapsed: 0 };
    boarding = advancePedestrian(boarding, {
      delta: 0.5, walkAllowed: false, busAtPlatform: true,
    });
    if (boarding.state !== "boarding") {
      failures.push(`bus arrival should board, got ${boarding.state}`);
    }
    if (!boarding.safeZone) failures.push("boarding pedestrian must be a safe zone");
    let stranded = { ...waiter, state: "waiting_for_bus", waitElapsed: 0 };
    for (let step = 0; step < 400 && stranded.state === "waiting_for_bus"; step += 1) {
      stranded = advancePedestrian(stranded, {
        delta: 0.5, walkAllowed: false, busAtPlatform: false,
      });
    }
    if (stranded.state !== "crossing") {
      failures.push(`stranded waiter should resume crossing, got ${stranded.state}`);
    }
    void random;
  }
}

// 7. Alley queues: per-mode counts, distinct ids, correct column spacing and
// the §7 corridor constraints still hold.
for (const [mode, budget] of Object.entries(TRAFFIC_DENSITY_MODES)) {
  for (let seed = 0; seed < 12; seed += 1) {
    const plan = buildSpawnPlan(20260728 + seed, mix, pedestrianSpeed, mode);
    const side = plan.vehicles.filter((vehicle) => vehicle.sideAccess);
    const expected = budget.sideVehiclesPerColumn * SIDE_ACCESS_SPAWNS.length;
    if (side.length !== expected) {
      failures.push(`${mode}/${seed}: ${side.length} alley vehicles, expected ${expected}`);
    }
    if (new Set(side.map((vehicle) => vehicle.id)).size !== side.length) {
      failures.push(`${mode}/${seed}: duplicate alley vehicle ids`);
    }
    for (const vehicle of side) {
      if (vehicle.t < 20) {
        failures.push(`${mode}/${seed}: ${vehicle.id} spawn t=${vehicle.t} off the market side`);
      }
      if (vehicle.s < -11 || vehicle.s > -3) {
        failures.push(`${mode}/${seed}: ${vehicle.id} spawn s=${vehicle.s} outside the corridor`);
      }
      if (!["right", "hook"].includes(vehicle.turn)) {
        failures.push(`${mode}/${seed}: ${vehicle.id} has turn=${vehicle.turn}`);
      }
      if (vehicle.turn === "hook"
        && !["scooter", "motorcycle", "bicycle"].includes(vehicle.type)) {
        failures.push(`${mode}/${seed}: ${vehicle.type} assigned a two-stage left turn`);
      }
    }
    for (const column of SIDE_ACCESS_SPAWNS) {
      const inColumn = side
        .filter((vehicle) => vehicle.s === column.s)
        .map((vehicle) => vehicle.t)
        .sort((a, b) => a - b);
      for (let index = 0; index + 1 < inColumn.length; index += 1) {
        if (inColumn[index + 1] - inColumn[index] + 1e-9 < SIDE_COLUMN_HEADWAY_M) {
          failures.push(`${mode}/${seed}: alley column ${column.s} spacing too tight`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL viewer V4 direction/turns:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  "PASS viewer V4 direction/turns: kerb model, controller safe zones and"
  + " refuges, lane90 right/hook turn paths clear of every painted crosswalk"
  + " band, hook box slots, turn assignment purity, bus dwell stops and"
  + " boarding state machine, alley queue generation (3 modes x 12 seeds) OK",
);
