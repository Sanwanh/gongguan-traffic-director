// Build viewer/models/pedestrian_walker.glb from Khronos CesiumMan (CC-BY-4.0).
//
// Derivative changes (all recorded in ASSETS.md):
//   1. Cesium logo texture + sampler + image + original TEXCOORD_0 removed
//      (the logo is a Cesium trademark, explicitly excluded from the CC-BY grant).
//   2. Single primitive split into 5 body-region primitives, each with its own
//      untextured material -> per-part runtime recolouring.
//   3. TEXCOORD_0 rewritten as an 8-slot palette coordinate so the 5 primitives
//      can optionally be merged into a single draw call with a tiny palette texture.
//   4. Walk clip named "Walk", time-shifted to start at t=0 and closed into an
//      exact 2.0 s loop.
//   5. Added synthesized "Idle" clip (mean pose of the walk cycle + breathing).
//
// Rig, joint hierarchy, inverse bind matrices, vertex positions/normals/skin
// weights are bit-for-bit the originals.

import { writeFileSync } from "node:fs";

// ---- inlined from glblib.mjs so this script is self-contained ----
import { readFileSync } from "node:fs";

const CS = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function loadGLB(path) {
  const buf = readFileSync(path);
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off), t = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (t === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    if (t === 0x004e4942) bin = body;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  const g = json;
  const acc = (i) => {
    const a = g.accessors[i], b = g.bufferViews[a.bufferView];
    const cs = CS[a.componentType], nc = NC[a.type];
    const stride = b.byteStride || cs * nc;
    const base = (b.byteOffset || 0) + (a.byteOffset || 0);
    const out = [];
    for (let k = 0; k < a.count; k++) {
      const row = [];
      for (let c = 0; c < nc; c++) {
        const o = base + k * stride + c * cs;
        row.push(a.componentType === 5126 ? bin.readFloatLE(o)
          : a.componentType === 5125 ? bin.readUInt32LE(o)
          : a.componentType === 5123 ? bin.readUInt16LE(o)
          : a.componentType === 5122 ? bin.readInt16LE(o)
          : a.componentType === 5121 ? bin.readUInt8(o)
          : bin.readInt8(o));
      }
      out.push(nc === 1 ? row[0] : row);
    }
    return out;
  };
  return { g, bin, acc };
}

// ---------- matrix (column-major, glTF) ----------
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function trs(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation ?? [0, 0, 0], q = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function xform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}
function worldMatrices(g) {
  const parent = new Map();
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const world = new Array(g.nodes.length);
  const W = (i) => {
    if (world[i]) return world[i];
    const local = trs(g.nodes[i]);
    const p = parent.get(i);
    return (world[i] = p == null ? local : mul(W(p), local));
  };
  g.nodes.forEach((_, i) => W(i));
  return world;
}

// ---- end inlined helpers ----


const SRC = process.argv[2] ?? "cand/CesiumMan.glb";
const DST = process.argv[3] ?? "out/pedestrian_walker.glb";

const { g: src, acc } = loadGLB(SRC);
const world = worldMatrices(src);
const skin = src.skins[0];
const ibm = acc(skin.inverseBindMatrices);
const sprim = src.meshes[0].primitives[0];
const POS = acc(sprim.attributes.POSITION);
const NRM = acc(sprim.attributes.NORMAL);
const JNT = acc(sprim.attributes.JOINTS_0);
const WGT = acc(sprim.attributes.WEIGHTS_0);
const IDX = acc(sprim.indices);
const jointName = skin.joints.map((j) => src.nodes[j].name);

// ---------------------------------------------------------------- regions
const REGIONS = [
  { name: "PedSkin",  color: [0.86, 0.68, 0.55, 1] },
  { name: "PedHair",  color: [0.14, 0.11, 0.10, 1] },
  { name: "PedShirt", color: [0.28, 0.44, 0.72, 1] },
  { name: "PedPants", color: [0.22, 0.24, 0.30, 1] },
  { name: "PedShoes", color: [0.12, 0.12, 0.14, 1] },
];
const HEAD = new Set(["Skeleton_neck_joint_1", "Skeleton_neck_joint_2"]);
const HAND = new Set(["Skeleton_arm_joint_L__2_", "Skeleton_arm_joint_R__3_"]);
const FOREARM = new Set(["Skeleton_arm_joint_L__3_", "Skeleton_arm_joint_R__2_"]);
const UPPERARM = new Set(["Skeleton_arm_joint_L__4_", "Skeleton_arm_joint_R"]);
const FOOT = new Set(["leg_joint_L_3", "leg_joint_R_3", "leg_joint_L_5", "leg_joint_R_5"]);
const HAIR_Y = 1.395, HEM_Y = 0.735;

const skinMats = skin.joints.map((jn, j) => mul(world[jn], ibm[j]));
const wpos = POS.map((p, i) => {
  const o = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = WGT[i][k]; if (!w) continue;
    const q = xform(skinMats[JNT[i][k]], p);
    o[0] += q[0] * w; o[1] += q[1] * w; o[2] += q[2] * w;
  }
  return o;
});
const dom = POS.map((_, i) => {
  let b = 0, bw = -1;
  for (let k = 0; k < 4; k++) if (WGT[i][k] > bw) { bw = WGT[i][k]; b = JNT[i][k]; }
  return jointName[b];
});
const vreg = POS.map((_, i) => {
  const y = wpos[i][1], dj = dom[i];
  if (HEAD.has(dj)) return y > HAIR_Y ? 1 : 0;
  if (HAND.has(dj) || FOREARM.has(dj)) return 0;
  if (UPPERARM.has(dj)) return 2;
  if (FOOT.has(dj)) return 4;
  return y >= HEM_Y ? 2 : 3;
});
// NOTE: a 1-ring majority-vote smoothing pass over these region labels was tried
// and changed exactly 0 vertices -- the plane cuts produce no isolated flips, so
// the remaining stair-step at the hairline/hem is the mesh's own triangle
// resolution (4672 tris) and cannot be denoised away. It reads as a hair fringe
// and is invisible at pedestrian screen size, so it is kept as-is.
// Assign a triangle that straddles two regions by a fixed priority instead of by
// majority vote. Majority vote alternates across the quad band between two edge
// loops and produces a 1-quad zigzag hem; taking a fixed winner instead puts the
// whole band in one region, so every boundary lands exactly on one of the mesh's
// horizontal edge loops (waist loops sit at y = 0.6875 / 0.7475 / 0.8225).
// Ranks are chosen so the garment always wins: sleeves and shirt hem run a little
// long, trousers cover the ankle, the hairline sits slightly low.
const RANK = [0, 4, 3, 2, 1]; // skin, hair, shirt, pants, shoes
const triReg = [];
for (let t = 0; t < IDX.length; t += 3) {
  let best = vreg[IDX[t]];
  for (let k = 1; k < 3; k++) {
    const r = vreg[IDX[t + k]];
    if (RANK[r] > RANK[best]) best = r;
  }
  triReg.push(best);
}

// split vertices per (vertex, region) so palette UVs never interpolate across regions
const remap = new Map();
const nPOS = [], nNRM = [], nJNT = [], nWGT = [], nUV = [];
const PALETTE_SLOTS = 8;
function vid(v, r) {
  const key = v * 8 + r;
  let id = remap.get(key);
  if (id === undefined) {
    id = nPOS.length;
    remap.set(key, id);
    nPOS.push(POS[v]); nNRM.push(NRM[v]); nJNT.push(JNT[v]); nWGT.push(WGT[v]);
    nUV.push([(r + 0.5) / PALETTE_SLOTS, 0.5]);
  }
  return id;
}
const regionIndices = REGIONS.map(() => []);
for (let t = 0; t < IDX.length; t += 3) {
  const r = triReg[t / 3];
  for (let k = 0; k < 3; k++) regionIndices[r].push(vid(IDX[t + k], r));
}

// ---------------------------------------------------------------- animations
const a0 = src.animations[0];
const chanOf = new Map(); // `${node}|${path}` -> {times, values}
for (const ch of a0.channels) {
  const sm = a0.samplers[ch.sampler];
  chanOf.set(`${ch.target.node}|${ch.target.path}`, { times: acc(sm.input), values: acc(sm.output) });
}
const T0 = [...chanOf.values()][0].times[0];
const PERIOD = 2.0;

function meanQuat(list) {
  const ref = list[0];
  const s = [0, 0, 0, 0];
  for (const q of list) {
    const dot = q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3];
    const sg = dot < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) s[k] += q[k] * sg;
  }
  const n = Math.hypot(...s);
  return s.map((v) => v / n);
}
const meanVec = (list) => list[0].map((_, k) => list.reduce((a, v) => a + v[k], 0) / list.length);

const ROOT_JOINT = skin.joints[0]; // Skeleton_torso_joint_1
const IDLE_PERIOD = 3.2;
const IDLE_TIMES = [0, 0.8, 1.6, 2.4, 3.2];
const BREATH = [0, 0.0055, 0, -0.0035, 0]; // along the armature-local +Z (= world up)
// The mean-of-walk-cycle pose straightens the legs, so the mean root height sinks
// the feet 6.54 cm below y=0. Lift the root so Idle stands exactly on the ground
// plane (measured with measure_clips.mjs; Walk's own mean foot contact is +0.0017 m
// and needs no correction).
const IDLE_GROUND_LIFT = 0.0654;

// ---------------------------------------------------------------- GLB writer
const bin = [];
let binLen = 0;
function pushView(buf, target) {
  while (binLen % 4) { bin.push(Buffer.alloc(4 - (binLen % 4))); binLen += 4 - (binLen % 4); }
  const bv = { buffer: 0, byteOffset: binLen, byteLength: buf.length };
  if (target) bv.target = target;
  bin.push(buf); binLen += buf.length;
  out.bufferViews.push(bv);
  return out.bufferViews.length - 1;
}
const out = {
  asset: {
    version: "2.0",
    generator: "gongguan-digital-twin pedestrian builder (derivative of Khronos CesiumMan)",
    copyright: "Cesium Man geometry/rig/animation (C) 2017 Cesium, CC-BY-4.0. Cesium logo texture removed. Body-region material split, palette UVs, Idle clip added by the Gongguan Digital Twin project.",
  },
  extras: {
    source: "https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan",
    license: "CC-BY-4.0",
    attribution: "Cesium Man by Cesium (CC BY 4.0), modified: trademark texture removed, mesh split into body-region materials, Idle clip synthesized.",
  },
  scene: 0, scenes: [{ nodes: [0] }],
  nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [],
  skins: [], animations: [],
};

function f32(rows) {
  const nc = Array.isArray(rows[0]) ? rows[0].length : 1;
  const b = Buffer.alloc(rows.length * nc * 4);
  rows.forEach((r, i) => { const a = nc === 1 ? [r] : r; a.forEach((v, k) => b.writeFloatLE(v, (i * nc + k) * 4)); });
  return b;
}
function u16(rows) {
  const nc = Array.isArray(rows[0]) ? rows[0].length : 1;
  const b = Buffer.alloc(rows.length * nc * 2);
  rows.forEach((r, i) => { const a = nc === 1 ? [r] : r; a.forEach((v, k) => b.writeUInt16LE(v, (i * nc + k) * 2)); });
  return b;
}
const minmax = (rows) => ({
  min: rows[0].map((_, k) => Math.min(...rows.map((r) => r[k]))),
  max: rows[0].map((_, k) => Math.max(...rows.map((r) => r[k]))),
});
function accessor(bv, type, comp, count, extra = {}) {
  out.accessors.push({ bufferView: bv, componentType: comp, count, type, ...extra });
  return out.accessors.length - 1;
}

// vertex attributes
const aPOS = accessor(pushView(f32(nPOS), 34962), "VEC3", 5126, nPOS.length, minmax(nPOS));
const aNRM = accessor(pushView(f32(nNRM), 34962), "VEC3", 5126, nNRM.length);
const aUV = accessor(pushView(f32(nUV), 34962), "VEC2", 5126, nUV.length);
const aJNT = accessor(pushView(u16(nJNT), 34962), "VEC4", 5123, nJNT.length);
const aWGT = accessor(pushView(f32(nWGT), 34962), "VEC4", 5126, nWGT.length);

// per-region index accessors + materials + primitives
const primitives = REGIONS.map((R, r) => {
  const idx = regionIndices[r];
  const a = accessor(pushView(u16(idx), 34963), "SCALAR", 5123, idx.length);
  out.materials.push({
    name: R.name,
    doubleSided: false,
    pbrMetallicRoughness: { baseColorFactor: R.color, metallicFactor: 0.0, roughnessFactor: 0.85 },
  });
  return { attributes: { POSITION: aPOS, NORMAL: aNRM, TEXCOORD_0: aUV, JOINTS_0: aJNT, WEIGHTS_0: aWGT }, indices: a, material: r, mode: 4 };
});
out.meshes.push({ name: "Pedestrian", primitives });

// nodes: copy hierarchy verbatim
const nodeIndexMap = new Map();
src.nodes.forEach((n, i) => { nodeIndexMap.set(i, out.nodes.length); out.nodes.push({}); });
src.nodes.forEach((n, i) => {
  const o = out.nodes[nodeIndexMap.get(i)];
  o.name = n.name;
  if (n.matrix) o.matrix = n.matrix.slice();
  if (n.translation) o.translation = n.translation.slice();
  if (n.rotation) o.rotation = n.rotation.slice();
  if (n.scale && n.scale.some((v) => v !== 1)) o.scale = n.scale.slice();
  if (n.children) o.children = n.children.map((c) => nodeIndexMap.get(c));
  if (n.mesh != null) { o.name = "PedestrianBody"; o.mesh = 0; o.skin = 0; }
});
out.skins.push({
  name: "PedestrianArmature",
  joints: skin.joints.map((j) => nodeIndexMap.get(j)),
  skeleton: nodeIndexMap.get(skin.skeleton),
  inverseBindMatrices: accessor(pushView(f32(ibm)), "MAT4", 5126, ibm.length),
});

// ---- Walk clip: shift to t=0, append wrap key at t=PERIOD
{
  const times = [...chanOf.values()][0].times.map((t) => +(t - T0).toFixed(6));
  const wrapped = [...times, PERIOD];
  const aIn = accessor(pushView(f32(wrapped)), "SCALAR", 5126, wrapped.length,
    { min: [wrapped[0]], max: [wrapped[wrapped.length - 1]] });
  const channels = [], samplers = [];
  for (const [key, c] of chanOf) {
    const [node, path] = key.split("|");
    const vals = [...c.values, c.values[0]];
    samplers.push({ input: aIn, interpolation: "LINEAR", output: accessor(pushView(f32(vals)), path === "rotation" ? "VEC4" : "VEC3", 5126, vals.length) });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeIndexMap.get(Number(node)), path } });
  }
  out.animations.push({ name: "Walk", channels, samplers });
}
// ---- Idle clip: mean pose of the walk cycle + breathing on the root joint
{
  const aIn = accessor(pushView(f32(IDLE_TIMES)), "SCALAR", 5126, IDLE_TIMES.length,
    { min: [0], max: [IDLE_PERIOD] });
  const channels = [], samplers = [];
  for (const [key, c] of chanOf) {
    const [node, path] = key.split("|");
    const mean = path === "rotation" ? meanQuat(c.values) : meanVec(c.values);
    const vals = IDLE_TIMES.map((_, i) => {
      if (path === "translation" && Number(node) === ROOT_JOINT) {
        return [mean[0], mean[1], mean[2] + IDLE_GROUND_LIFT + BREATH[i]];
      }
      return mean.slice();
    });
    samplers.push({ input: aIn, interpolation: "LINEAR", output: accessor(pushView(f32(vals)), path === "rotation" ? "VEC4" : "VEC3", 5126, vals.length) });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeIndexMap.get(Number(node)), path } });
  }
  out.animations.push({ name: "Idle", channels, samplers });
}

const binBuf = Buffer.concat(bin);
out.buffers.push({ byteLength: binBuf.length });

// serialize
let jsonStr = JSON.stringify(out);
while (Buffer.byteLength(jsonStr) % 4) jsonStr += " ";
const jsonBuf = Buffer.from(jsonStr);
const pad = (4 - (binBuf.length % 4)) % 4;
const binPadded = pad ? Buffer.concat([binBuf, Buffer.alloc(pad)]) : binBuf;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const jc = Buffer.alloc(8); jc.writeUInt32LE(jsonBuf.length, 0); jc.writeUInt32LE(0x4e4f534a, 4);
const bc = Buffer.alloc(8); bc.writeUInt32LE(binPadded.length, 0); bc.writeUInt32LE(0x004e4942, 4);
writeFileSync(DST, Buffer.concat([header, jc, jsonBuf, bc, binPadded]));

console.log(`wrote ${DST}`);
console.log(`  vertices ${nPOS.length} (from ${POS.length}), triangles ${IDX.length / 3}`);
console.log(`  primitives ${primitives.length}:`, REGIONS.map((R, r) => `${R.name}=${regionIndices[r].length / 3}t`).join(" "));
console.log(`  JSON ${jsonBuf.length} B, BIN ${binPadded.length} B, total ${12 + 8 + jsonBuf.length + 8 + binPadded.length} B`);
console.log(`  animations: Walk(${PERIOD}s, ${[...chanOf.values()][0].times.length + 1} keys) Idle(${IDLE_PERIOD}s, ${IDLE_TIMES.length} keys)`);
