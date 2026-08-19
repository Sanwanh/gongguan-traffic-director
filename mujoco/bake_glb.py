#!/usr/bin/env python
"""bake_glb.py — bake the MuJoCo trajectory into the KBot GLB (SPEC_MUJOCO.md 烘焙).

Run:  uv run --with mujoco,numpy python mujoco/bake_glb.py

Reads mujoco/kbot_trajectory.npz + mujoco/mapping.json, backs up
viewer/models/kbot_traffic_director.glb as kbot_traffic_director.orig.glb
(idempotent: if the backup exists it is the source of truth), then rewrites the
samplers of all 89 per-node clips:

  mesh nodes (88):  T_glb_i(f) = C @ T_mj_geom(f) @ D_i     (from mapping.json)
                    decomposed into translation + continuity-fixed quaternion +
                    the node's original static scale, 1067 LINEAR keys @ f/24 s.
  root node (1):    the original artist clip (CUBICSPLINE, root turns to face
                    each traffic phase) resampled to the same dense 1067 keys,
                    so behaviour is preserved and every clip shares one timeline.

New accessors/bufferViews are appended to the BIN chunk; clip count, names,
channel targets/paths and node/mesh structure are unchanged. Fail-closed: any
error or failed self-check restores the backup and exits 1.
"""

import json
import os
import shutil
import struct
import sys

import numpy as np
from pathlib import Path

PKG = str(Path(__file__).resolve().parent.parent)
GLB_MAIN = os.path.join(PKG, "viewer/models/kbot_traffic_director.glb")
GLB_ORIG = os.path.join(PKG, "viewer/models/kbot_traffic_director.orig.glb")
NPZ = os.path.join(PKG, "mujoco/kbot_trajectory.npz")
MAPPING = os.path.join(PKG, "mujoco/mapping.json")

ROOT_NAME = "TrafficDirector_KBot_Root"
FPS = 24.0
MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
NCOMP = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}

# ------------------------------------------------------------------ GLB parse

def parse_glb(path):
    data = open(path, "rb").read()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    if magic != MAGIC:
        raise ValueError(f"not a GLB: {path}")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    if jtype != CHUNK_JSON:
        raise ValueError("first chunk is not JSON")
    gltf = json.loads(data[20:20 + jlen].decode("utf-8"))
    blen, btype = struct.unpack_from("<II", data, 20 + jlen)
    if btype != CHUNK_BIN:
        raise ValueError("second chunk is not BIN")
    binchunk = data[20 + jlen + 8: 20 + jlen + 8 + blen]
    return gltf, bytearray(binchunk)


def read_accessor(gltf, binchunk, idx):
    a = gltf["accessors"][idx]
    bv = gltf["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    n = NCOMP[a["type"]]
    arr = np.frombuffer(bytes(binchunk), dtype="<f4", count=a["count"] * n, offset=off)
    return arr.reshape(a["count"], n).astype(np.float64)

# ------------------------------------------------------------------ math

def mats_to_quats_xyzw(R):
    """Batch rotation matrices (N,3,3) -> unit quaternions (N,4) xyzw."""
    N = R.shape[0]
    q = np.empty((N, 4))
    m00, m11, m22 = R[:, 0, 0], R[:, 1, 1], R[:, 2, 2]
    t0 = 1.0 + m00 + m11 + m22
    t1 = 1.0 + m00 - m11 - m22
    t2 = 1.0 - m00 + m11 - m22
    t3 = 1.0 - m00 - m11 + m22
    case = np.stack([t0, t1, t2, t3], 1).argmax(1)

    i = case == 0
    s = np.sqrt(np.maximum(t0[i], 1e-12)) * 2.0
    q[i, 3] = 0.25 * s
    q[i, 0] = (R[i, 2, 1] - R[i, 1, 2]) / s
    q[i, 1] = (R[i, 0, 2] - R[i, 2, 0]) / s
    q[i, 2] = (R[i, 1, 0] - R[i, 0, 1]) / s

    i = case == 1
    s = np.sqrt(np.maximum(t1[i], 1e-12)) * 2.0
    q[i, 0] = 0.25 * s
    q[i, 3] = (R[i, 2, 1] - R[i, 1, 2]) / s
    q[i, 1] = (R[i, 0, 1] + R[i, 1, 0]) / s
    q[i, 2] = (R[i, 0, 2] + R[i, 2, 0]) / s

    i = case == 2
    s = np.sqrt(np.maximum(t2[i], 1e-12)) * 2.0
    q[i, 1] = 0.25 * s
    q[i, 3] = (R[i, 0, 2] - R[i, 2, 0]) / s
    q[i, 0] = (R[i, 0, 1] + R[i, 1, 0]) / s
    q[i, 2] = (R[i, 1, 2] + R[i, 2, 1]) / s

    i = case == 3
    s = np.sqrt(np.maximum(t3[i], 1e-12)) * 2.0
    q[i, 2] = 0.25 * s
    q[i, 3] = (R[i, 1, 0] - R[i, 0, 1]) / s
    q[i, 0] = (R[i, 0, 2] + R[i, 2, 0]) / s
    q[i, 1] = (R[i, 1, 2] + R[i, 2, 1]) / s

    return q / np.linalg.norm(q, axis=1, keepdims=True)


def project_so3(M):
    """Batch polar projection (N,3,3) -> nearest proper rotations."""
    U, _S, Vt = np.linalg.svd(M)
    R = U @ Vt
    neg = np.linalg.det(R) < 0
    if neg.any():
        Uf = U[neg].copy()
        Uf[:, :, 2] *= -1.0
        R[neg] = Uf @ Vt[neg]
    return R


def fix_quat_continuity(q):
    """Flip signs in place so adjacent keys stay in the same hemisphere."""
    d = np.sum(q[1:] * q[:-1], axis=1)
    flip = np.cumprod(np.where(d < 0.0, -1.0, 1.0))
    q[1:] *= flip[:, None]
    return q


def resample_cubicspline(times, vals, t_query):
    """glTF CUBICSPLINE evaluation. vals is (K,3,D) = [in-tan, value, out-tan]."""
    K = len(times)
    a_in, v, b_out = vals[:, 0, :], vals[:, 1, :], vals[:, 2, :]
    idx = np.clip(np.searchsorted(times, t_query, side="right") - 1, 0, K - 2)
    t0, t1 = times[idx], times[idx + 1]
    dt = (t1 - t0)[:, None]
    u = np.clip((t_query - t0) / (t1 - t0), 0.0, 1.0)[:, None]
    u2, u3 = u * u, u * u * u
    out = ((2 * u3 - 3 * u2 + 1) * v[idx] + (u3 - 2 * u2 + u) * (b_out[idx] * dt)
           + (-2 * u3 + 3 * u2) * v[idx + 1] + (u3 - u2) * (a_in[idx + 1] * dt))
    out[t_query <= times[0]] = v[0]
    out[t_query >= times[-1]] = v[-1]
    return out

# ------------------------------------------------------------------ appender

class BinAppender:
    def __init__(self, gltf, base_len):
        self.g = gltf
        self.base = base_len
        self.blob = bytearray()

    def add(self, arr, acc_type, with_minmax=False):
        arr32 = np.ascontiguousarray(arr, dtype="<f4")
        flat = arr32.reshape(arr32.shape[0], -1)
        off = self.base + len(self.blob)
        self.blob += arr32.tobytes()
        bv_idx = len(self.g["bufferViews"])
        self.g["bufferViews"].append(
            {"buffer": 0, "byteLength": arr32.nbytes, "byteOffset": off})
        acc = {"bufferView": bv_idx, "componentType": 5126,
               "count": int(arr32.shape[0]), "type": acc_type}
        if with_minmax:
            acc["min"] = [float(x) for x in flat.min(axis=0)]
            acc["max"] = [float(x) for x in flat.max(axis=0)]
        idx = len(self.g["accessors"])
        self.g["accessors"].append(acc)
        return idx

# ------------------------------------------------------------------ main

def restore_backup(reason):
    if os.path.exists(GLB_ORIG):
        shutil.copy2(GLB_ORIG, GLB_MAIN)
        print(f"[bake_glb] FAIL-CLOSED: restored {GLB_MAIN} from backup ({reason})")
    else:
        print(f"[bake_glb] FAIL ({reason}); no backup existed, GLB untouched")


def bake():
    # 1. backup (idempotent: the .orig backup is always the bake source)
    if not os.path.exists(GLB_ORIG):
        shutil.copy2(GLB_MAIN, GLB_ORIG)
        print(f"[bake_glb] backed up original -> {GLB_ORIG}")
    else:
        print(f"[bake_glb] backup exists, baking from {GLB_ORIG}")
    size_before = os.path.getsize(GLB_ORIG)

    gltf, binchunk = parse_glb(GLB_ORIG)
    if len(binchunk) % 4:
        binchunk += b"\0" * (-len(binchunk) % 4)
    mapping = json.load(open(MAPPING))
    z = np.load(NPZ, allow_pickle=True)

    frames = z["frames"]                       # (F,) 1..1067
    F = len(frames)
    geom_names = [str(s) for s in z["geom_names"]]
    npz_col = {n: i for i, n in enumerate(geom_names)}
    xpos = z["geom_xpos"]                      # (F, G, 3)
    xmat = z["geom_xmat"].reshape(F, -1, 3, 3)  # (F, G, 3, 3)

    C = np.asarray(mapping["C"], dtype=np.float64)
    C_R, C_t = C[:3, :3], C[:3, 3]

    nodes = gltf["nodes"]
    node_by_name = {n.get("name"): i for i, n in enumerate(nodes)}
    root_idx = node_by_name[ROOT_NAME]

    t_query = frames.astype(np.float64) / FPS
    times_f4 = t_query.astype("<f4")

    # 2. per-mesh-node track computation: T_glb(f) = C @ T_mj(f) @ D
    tracks = {}  # node_idx -> {"translation": (F,3), "rotation": (F,4), "scale": (F,3)}
    for name, entry in mapping["nodes"].items():
        nid = entry["node_index"]
        if nodes[nid].get("name") != name:
            raise RuntimeError(f"mapping/node mismatch: {name} vs node {nid}")
        col = npz_col[entry["geom"]]
        D = np.asarray(entry["D"], dtype=np.float64)
        D_R, D_t = D[:3, :3], D[:3, 3]
        R_mj = xmat[:, col]                    # (F,3,3)
        p_mj = xpos[:, col]                    # (F,3)
        # rotation part (may carry the ~1e-8 uniform scale of C): project to SO(3)
        M = np.einsum("ij,fjk,kl->fil", C_R, R_mj, D_R)
        # translation part
        t = np.einsum("ij,fj->fi", C_R, np.einsum("fij,j->fi", R_mj, D_t) + p_mj) + C_t
        s_static = np.asarray(nodes[nid].get("scale", [1.0, 1.0, 1.0]), dtype=np.float64)
        R = project_so3(M / s_static[None, None, :])   # remove column scale, orthonormalize
        q = fix_quat_continuity(mats_to_quats_xyzw(R))
        tracks[nid] = {
            "translation": t,
            "rotation": q,
            "scale": np.tile(s_static, (F, 1)),
        }

    # 3. root clip: dense resample of the original artist animation
    root_anim = next(a for a in gltf["animations"]
                     if a["channels"][0]["target"]["node"] == root_idx)
    root_tracks = {}
    for ch in root_anim["channels"]:
        smp = root_anim["samplers"][ch["sampler"]]
        times = read_accessor(gltf, binchunk, smp["input"])[:, 0]
        vals = read_accessor(gltf, binchunk, smp["output"])
        if smp.get("interpolation") == "CUBICSPLINE":
            vals = vals.reshape(len(times), 3, -1)
        else:  # LINEAR/STEP: promote to [0, v, 0] layout for the same evaluator
            vals = np.stack([np.zeros_like(vals), vals, np.zeros_like(vals)], axis=1)
        out = resample_cubicspline(times, vals, t_query)
        if ch["target"]["path"] == "rotation":
            out /= np.linalg.norm(out, axis=1, keepdims=True)
            out = fix_quat_continuity(out)
        root_tracks[ch["target"]["path"]] = out

    # 4. rewrite every sampler (structure, clip names, channels untouched)
    app = BinAppender(gltf, len(binchunk))
    time_acc = app.add(times_f4.reshape(-1, 1), "SCALAR", with_minmax=True)
    n_rewritten = 0
    for anim in gltf["animations"]:
        nid = anim["channels"][0]["target"]["node"]
        src = root_tracks if nid == root_idx else tracks[nid]
        for ch in anim["channels"]:
            path = ch["target"]["path"]
            data = src[path]
            acc_type = "VEC4" if path == "rotation" else "VEC3"
            out_acc = app.add(data, acc_type)
            smp = anim["samplers"][ch["sampler"]]
            smp["input"] = time_acc
            smp["output"] = out_acc
            smp["interpolation"] = "LINEAR"
            n_rewritten += 1
    print(f"[bake_glb] rewrote {n_rewritten} samplers across "
          f"{len(gltf['animations'])} clips ({F} keys each, LINEAR, t = frame/24)")

    # 5. serialize
    new_bin = bytes(binchunk) + bytes(app.blob)
    new_bin += b"\0" * (-len(new_bin) % 4)
    gltf["buffers"][0]["byteLength"] = len(new_bin)
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(new_bin)
    with open(GLB_MAIN, "wb") as f:
        f.write(struct.pack("<III", MAGIC, 2, total))
        f.write(struct.pack("<II", len(js), CHUNK_JSON))
        f.write(js)
        f.write(struct.pack("<II", len(new_bin), CHUNK_BIN))
        f.write(new_bin)
    size_after = os.path.getsize(GLB_MAIN)
    growth = size_after - size_before
    print(f"[bake_glb] size {size_before:,} -> {size_after:,} bytes "
          f"(growth {growth/1e6:.2f} MB, limit 15 MB)")
    if growth >= 15 * 2**20:
        raise RuntimeError(f"size growth {growth} exceeds 15MB")

    # 6. self-check: re-parse the written file and probe values
    g2, bin2 = parse_glb(GLB_MAIN)
    if len(g2["animations"]) != len(gltf["animations"]):
        raise RuntimeError("clip count changed")
    probe_nodes = ["Mesh_KC_C_401R_R_UpForearmDrive_visual_id25_geom",
                   "Mesh_torso_visual_id3_geom",
                   "Mesh_None_id27_geom"]
    probe_frames = [1, 594, 1067]
    max_err = 0.0
    for pname in probe_nodes:
        nid = mapping["nodes"][pname]["node_index"]
        anim = next(a for a in g2["animations"]
                    if a["channels"][0]["target"]["node"] == nid)
        ch = next(c for c in anim["channels"] if c["target"]["path"] == "translation")
        written = read_accessor(g2, bin2, anim["samplers"][ch["sampler"]]["output"])
        expect = tracks[nid]["translation"]
        for fr in probe_frames:
            err = float(np.linalg.norm(written[fr - 1] - expect[fr - 1]))
            max_err = max(max_err, err)
    print(f"[bake_glb] self-check probe error (written vs computed): "
          f"{max_err*1000:.5f} mm (gate < 0.1 mm)")
    if max_err >= 1e-4:
        raise RuntimeError(f"self-check probe error {max_err} m")
    print("[bake_glb] OK")
    return 0


def main():
    try:
        return bake()
    except Exception as e:  # noqa: BLE001 — fail-closed by design
        restore_backup(f"{type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
