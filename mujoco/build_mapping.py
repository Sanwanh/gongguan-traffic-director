#!/usr/bin/env python
"""build_mapping.py — GLB <-> MJCF geom mapping + calibration (SPEC_MUJOCO.md section: GLB 對應與校準)

Run:  uv run --with mujoco,numpy,scipy python mujoco/build_mapping.py

Reads the KBot traffic-director GLB (prefers the .orig backup if present, so
re-runs after baking still calibrate against the original data) and the KBot
MJCF, then:

 1. Name-maps GLB nodes  Mesh_<name>_idNN_geom  ->  MJCF geom  <name>.
 2. Attaches Mesh_None_* (ORCA hand parts, absent from the headless MJCF) to
    the nearest mapped arm-end geom (wrist/forearm/upper-arm, distance <0.45m
    in GLB rest pose; otherwise nearest any mapped geom + warning).
 3. Solves the global conversion C (rotation + uniform scale + translation,
    expected Z-up -> Y-up) by least squares over the mapped geoms, and the
    per-node constants D_i = T_mj_rest_i^-1 . C^-1 . T_glb_rest_i.
    Residual gate: every mapped geom must satisfy pos < 2cm and rot < 3deg.
    Calibration paths, in order (fail-closed):
      a) GLB rest = static node TRS         vs MuJoCo rest = qpos0
      b) GLB rest = animation frame-1 sample vs MuJoCo rest = qpos0
      c) GLB rest = static node TRS         vs MuJoCo q_snapshot recovered by
         per-arm IK (the GLB was exported in a gesture pose, not qpos0; the
         10 arm-link poses over 5 DOF per arm over-determine the snapshot, so
         a <2cm/3deg fit is a genuine verification, and only then are the D_i
         true rigid mesh offsets valid at every animation frame).
    If no path passes the gate -> write mapping_failure_report.json, exit 1,
    and do NOT write mapping.json.
 4. Writes mapping.json: C, per-node {geom, D (4x4), attach_parent, ...} and a
    residual report.
"""

import json
import os
import re
import struct
import sys
import shutil
from datetime import datetime, timezone

import numpy as np
import mujoco

# ---------------------------------------------------------------- constants
PKG = "/Users/san/Gongguan-Business-District-Digital-Twin/output/robot_package"
GLB_MAIN = os.path.join(PKG, "viewer/models/kbot_traffic_director.glb")
GLB_ORIG = os.path.join(PKG, "viewer/models/kbot_traffic_director.orig.glb")
MJCF = "/Users/san/ksim/examples/kbot/robot/kbot-headless/robot.mjcf"
OUT_JSON = os.path.join(PKG, "mujoco/mapping.json")
FAIL_JSON = os.path.join(PKG, "mujoco/mapping_failure_report.json")

POS_TOL = 0.02          # 2 cm
ROT_TOL_DEG = 3.0       # 3 degrees
NONE_ATTACH_MAX = 0.45  # m, GLB rest-pose distance to an arm-end geom

# arm-end geoms allowed as attach parents for Mesh_None_* (wrist/forearm/upper-arm)
ARM_END_GEOMS = [
    "PRT0001",                      # right wrist
    "KC_C_401R_R_UpForearmDrive",   # right forearm
    "KC_C_202R",                    # right upper arm (lower bicep)
    "PRT0001_2",                    # left wrist
    "KC_C_401L_Up_Forearm_Drive",   # left forearm
    "KD_C_301L_LowerBicepDrive",    # left upper arm (lower bicep)
]

RIGHT_ARM_JOINTS = ["dof_right_shoulder_pitch_03", "dof_right_shoulder_roll_03",
                    "dof_right_shoulder_yaw_02", "dof_right_elbow_02", "dof_right_wrist_00"]
LEFT_ARM_JOINTS = ["dof_left_shoulder_pitch_03", "dof_left_shoulder_roll_03",
                   "dof_left_shoulder_yaw_02", "dof_left_elbow_02", "dof_left_wrist_00"]
RIGHT_ARM_GEOMS = ["KC_C_101R_ShldYokeDrive_visual", "RS03_3_visual", "KC_C_202R_visual",
                   "KC_C_401R_R_UpForearmDrive_visual", "PRT0001_visual"]
LEFT_ARM_GEOMS = ["KD_C_101L_ShldYokeDrive_visual", "RS03_4_visual", "KD_C_301L_LowerBicepDrive_visual",
                  "KC_C_401L_Up_Forearm_Drive_visual", "PRT0001_2_visual"]

NODE_RE = re.compile(r"^Mesh_(.+)_id(\d+)_geom$")

# ---------------------------------------------------------------- math utils

def quat_xyzw_to_mat(q):
    x, y, z, w = q
    n = np.sqrt(x * x + y * y + z * z + w * w)
    if n == 0:
        return np.eye(3)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def mat_to_quat_wxyz(R):
    q = np.empty(4)
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        q[:] = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q[:] = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q[:] = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q[:] = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    return q / np.linalg.norm(q)


def trs_to_mat(t, q_xyzw, s):
    T = np.eye(4)
    T[:3, :3] = quat_xyzw_to_mat(q_xyzw) * np.asarray(s)
    T[:3, 3] = t
    return T


def rot_angle_deg(R1, R2):
    c = (np.trace(R1.T @ R2) - 1.0) / 2.0
    return float(np.degrees(np.arccos(np.clip(c, -1.0, 1.0))))


def rot_mean(Rs):
    """Chordal L2 mean of rotations via the quaternion eigen method."""
    M = np.zeros((4, 4))
    for R in Rs:
        q = mat_to_quat_wxyz(R)
        M += np.outer(q, q)
    w, v = np.linalg.eigh(M)
    q = v[:, -1]
    ww, x, y, z = q
    return quat_xyzw_to_mat([x, y, z, ww])


def rotvec(R):
    """axis*angle of R (radians)."""
    q = mat_to_quat_wxyz(R)
    w = np.clip(q[0], -1.0, 1.0)
    ang = 2.0 * np.arccos(abs(w))
    v = q[1:] * (1.0 if q[0] >= 0 else -1.0)
    n = np.linalg.norm(v)
    if n < 1e-12:
        return np.zeros(3)
    return v / n * ang

# ---------------------------------------------------------------- GLB parsing

DTYPES = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Glb:
    def __init__(self, path):
        self.path = path
        data = open(path, "rb").read()
        magic, version, length = struct.unpack_from("<III", data, 0)
        if magic != 0x46546C67:
            raise ValueError(f"not a GLB: {path}")
        jlen, jtype = struct.unpack_from("<II", data, 12)
        if jtype != 0x4E4F534A:
            raise ValueError("first chunk is not JSON")
        self.gltf = json.loads(data[20:20 + jlen].decode("utf-8"))
        blen, btype = struct.unpack_from("<II", data, 20 + jlen)
        if btype != 0x004E4942:
            raise ValueError("second chunk is not BIN")
        self.bin_off = 20 + jlen + 8
        self.data = data

    def accessor(self, idx):
        a = self.gltf["accessors"][idx]
        bv = self.gltf["bufferViews"][a["bufferView"]]
        start = self.bin_off + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        n = NCOMP[a["type"]]
        arr = np.frombuffer(self.data, dtype=np.dtype(DTYPES[a["componentType"]]),
                            count=a["count"] * n, offset=start)
        return arr.reshape(a["count"], n).astype(np.float64)

    def node_static_trs(self, i):
        n = self.gltf["nodes"][i]
        return (np.asarray(n.get("translation", [0, 0, 0]), float),
                np.asarray(n.get("rotation", [0, 0, 0, 1]), float),
                np.asarray(n.get("scale", [1, 1, 1]), float))

    def sample_frame1(self):
        """First-key value of every per-node clip -> {node_idx: {path: value}}."""
        out = {}
        for anim in self.gltf["animations"]:
            for ch in anim["channels"]:
                s = anim["samplers"][ch["sampler"]]
                vals = self.accessor(s["output"])
                times = self.accessor(s["input"])[:, 0]
                if s.get("interpolation") == "CUBICSPLINE":
                    v0 = vals.reshape(len(times), 3, -1)[0, 1, :]
                else:
                    v0 = vals[0]
                out.setdefault(ch["target"]["node"], {})[ch["target"]["path"]] = np.asarray(v0, float)
        return out

# ---------------------------------------------------------------- C estimation

def _rot24():
    """The 24 right-handed axis-permutation rotations (up-axis conversions)."""
    from itertools import permutations, product
    out = []
    for perm in permutations(range(3)):
        for signs in product([1, -1], repeat=3):
            R = np.zeros((3, 3))
            for row, (axis, sg) in enumerate(zip(perm, signs)):
                R[row, axis] = sg
            if np.linalg.det(R) > 0.5:
                out.append(R)
    return out


def fit_C(T_mj_list, T_glb_list, pos_inl_tol=0.03, rot_inl_tol_deg=5.0):
    """Least-squares similarity C under the conjugation export convention:
        T_glb ~= C . T_mj . C^-1   (Blender-style Z-up -> Y-up)
    i.e.  p_glb = s R p_mj + t   and   R_glb = R R_mj R^T.
    Robust to a minority of geoms whose GLB pose differs from the MuJoCo pose
    (initialized from the best of the 24 axis conversions, then refined by
    linear least squares over the inliers).
    Returns (R, s, t, inlier_mask, pos_res, rot_res_deg)."""
    Pm = np.array([T[:3, 3] for T in T_mj_list])
    Pg = np.array([T[:3, 3] for T in T_glb_list])
    Rm = [T[:3, :3] for T in T_mj_list]
    Rg = [T[:3, :3] for T in T_glb_list]
    n = len(Pm)

    def residuals(R, s, t):
        pos = np.linalg.norm(Pg - (s * (Pm @ R.T) + t), axis=1)
        rot = np.array([rot_angle_deg(Rg[i], R @ Rm[i] @ R.T) for i in range(n)])
        return pos, rot

    # --- initialization: best of the 24 axis conversions (s=1, t=0) ---------
    best_R, best_count = np.eye(3), -1
    for R in _rot24():
        pos, rot = residuals(R, 1.0, np.zeros(3))
        count = int(((pos < pos_inl_tol) & (rot < rot_inl_tol_deg)).sum())
        if count > best_count:
            best_count, best_R = count, R
    R_C, s_C, t_C = best_R, 1.0, np.zeros(3)
    pos_res, rot_res = residuals(R_C, s_C, t_C)
    inl = (pos_res < pos_inl_tol) & (rot_res < rot_inl_tol_deg)
    if inl.sum() < 3:
        inl = np.ones(n, bool)

    # --- iterative refinement over inliers ----------------------------------
    for _ in range(10):
        # rotation: stack  R_glb_i R - R R_mj_i = 0  (linear in vec(R), col-major)
        # and       s R p_mj_i = p_glb_i - t         rows, solve LSQ, project SO(3)
        A_rows, b_rows = [], []
        I3 = np.eye(3)
        for i in range(n):
            if not inl[i]:
                continue
            A_rows.append(np.kron(I3, Rg[i]) - np.kron(Rm[i].T, I3))
            b_rows.append(np.zeros(9))
            A_rows.append(s_C * np.kron(Pm[i][None, :], I3))
            b_rows.append(Pg[i] - t_C)
        A = np.vstack(A_rows)
        b = np.concatenate(b_rows)
        vecR, *_ = np.linalg.lstsq(A, b, rcond=None)
        R_est = vecR.reshape(3, 3, order="F")
        U, _, Vt = np.linalg.svd(R_est)
        R_C = U @ np.diag([1, 1, np.sign(np.linalg.det(U @ Vt))]) @ Vt
        # scale + translation closed form over inliers
        pm, pg = Pm[inl].mean(0), Pg[inl].mean(0)
        Pc, Qc = Pm[inl] - pm, Pg[inl] - pg
        denom = float((Pc ** 2).sum())
        s_C = float((Qc * (Pc @ R_C.T)).sum() / denom) if denom > 1e-12 else 1.0
        t_C = pg - s_C * (R_C @ pm)
        pos_res, rot_res = residuals(R_C, s_C, t_C)
        new_inl = (pos_res < pos_inl_tol) & (rot_res < rot_inl_tol_deg)
        if new_inl.sum() < 6:  # never trim below a solvable set
            break
        if (new_inl == inl).all():
            inl = new_inl
            break
        inl = new_inl
    return R_C, s_C, t_C, inl, pos_res, rot_res


def make_C(R, s, t):
    C = np.eye(4)
    C[:3, :3] = s * R
    C[:3, 3] = t
    return C

# ---------------------------------------------------------------- MuJoCo FK

class Robot:
    def __init__(self, path):
        self.m = mujoco.MjModel.from_xml_path(path)
        self.d = mujoco.MjData(self.m)
        self.geom_ids = {}
        for g in range(self.m.ngeom):
            self.geom_ids[mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_GEOM, g)] = g
        self.jnt_qposadr = {}
        self.jnt_range = {}
        for j in range(self.m.njnt):
            name = mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_JOINT, j)
            self.jnt_qposadr[name] = int(self.m.jnt_qposadr[j])
            self.jnt_range[name] = tuple(self.m.jnt_range[j])

    def fk(self, qpos):
        self.d.qpos[:] = qpos
        mujoco.mj_forward(self.m, self.d)

    def geom_T(self, gid):
        T = np.eye(4)
        T[:3, :3] = self.d.geom_xmat[gid].reshape(3, 3)
        T[:3, 3] = self.d.geom_xpos[gid]
        return T

# ---------------------------------------------------------------- IK fallback

def ik_fit_arm(robot, qpos_base, joint_names, geom_names, targets, w_rot=0.1):
    """Fit one arm chain's joint angles so its geom poses match `targets`
    (dict geom_name -> 4x4 target in MuJoCo world). Multi-start least squares."""
    from scipy.optimize import least_squares
    adrs = [robot.jnt_qposadr[j] for j in joint_names]
    lo = np.array([robot.jnt_range[j][0] for j in joint_names]) + 1e-6
    hi = np.array([robot.jnt_range[j][1] for j in joint_names]) - 1e-6
    gids = [robot.geom_ids[g] for g in geom_names]
    Tt = [targets[g] for g in geom_names]

    def residuals(x):
        q = qpos_base.copy()
        for a, v in zip(adrs, x):
            q[a] = v
        robot.fk(q)
        res = []
        for gid, T in zip(gids, Tt):
            Tc = robot.geom_T(gid)
            res.extend(Tc[:3, 3] - T[:3, 3])
            res.extend(w_rot * rotvec(Tc[:3, :3].T @ T[:3, :3]))
        return np.asarray(res)

    pitch_seeds = [0.0, -1.5, -3.1, 1.5, 3.1]
    elbow_seeds = [0.0, -1.2, 1.2, -2.4, 2.4]
    best = None
    for ps in pitch_seeds:
        for es in elbow_seeds:
            x0 = np.clip(np.array([ps, 0.0, 0.0, es, 0.0]), lo, hi)
            sol = least_squares(residuals, x0, bounds=(lo, hi), xtol=1e-12, ftol=1e-12)
            if best is None or sol.cost < best.cost:
                best = sol
            if best.cost < 1e-10:
                break
        if best is not None and best.cost < 1e-10:
            break
    return best.x, float(best.cost)

# ---------------------------------------------------------------- residuals

def eval_residuals(robot, qpos, mapped, T_glb_rest, R_C, s_C, t_C):
    """Per-mapped-geom residual of T_glb ~= C . T_mj . C^-1 under the given qpos."""
    robot.fk(qpos)
    per = {}
    for node_name, geom_name in mapped.items():
        Tg = T_glb_rest[node_name]
        Tm = robot.geom_T(robot.geom_ids[geom_name])
        p_pred = s_C * (R_C @ Tm[:3, 3]) + t_C
        per[node_name] = {
            "geom": geom_name,
            "pos_m": float(np.linalg.norm(Tg[:3, 3] - p_pred)),
            "rot_deg": rot_angle_deg(Tg[:3, :3], R_C @ Tm[:3, :3] @ R_C.T),
        }
    max_pos = max(v["pos_m"] for v in per.values())
    max_rot = max(v["rot_deg"] for v in per.values())
    ok = max_pos < POS_TOL and max_rot < ROT_TOL_DEG
    return per, max_pos, max_rot, ok

# ---------------------------------------------------------------- main

def main():
    glb_path = GLB_ORIG if os.path.exists(GLB_ORIG) else GLB_MAIN
    print(f"[build_mapping] GLB : {glb_path}")
    print(f"[build_mapping] MJCF: {MJCF}")
    glb = Glb(glb_path)
    robot = Robot(MJCF)
    nodes = glb.gltf["nodes"]

    # ---- 1. name mapping ---------------------------------------------------
    mapped = {}          # node_name -> geom_name
    node_index = {}      # node_name -> node idx
    none_nodes = []      # [(node_name, idx)]
    unmatched = []       # named but no MJCF geom -> treated like None nodes
    for i, n in enumerate(nodes):
        name = n.get("name", "")
        if "mesh" not in n:
            continue  # scene root
        m = NODE_RE.match(name)
        node_index[name] = i
        if not m:
            unmatched.append((name, i))
            continue
        stem = m.group(1)
        if stem == "None":
            none_nodes.append((name, i))
        elif stem in robot.geom_ids:
            mapped[name] = stem
        else:
            unmatched.append((name, i))

    print(f"[build_mapping] name-mapped nodes : {len(mapped)}")
    for k in sorted(mapped):
        print(f"    {k}  ->  {mapped[k]}")
    print(f"[build_mapping] Mesh_None_* nodes : {len(none_nodes)}")
    if unmatched:
        print(f"[build_mapping] WARNING unmatched named nodes (treated as attachments): "
              f"{[u[0] for u in unmatched]}")

    # ---- 2. GLB rest transforms -------------------------------------------
    T_glb_static = {}
    for name, i in node_index.items():
        t, q, s = glb.node_static_trs(i)
        T_glb_static[name] = trs_to_mat(t, q, s)

    f1 = glb.sample_frame1()
    T_glb_frame1 = {}
    frame1_differs = False
    for name, i in node_index.items():
        ch = f1.get(i, {})
        t0, q0, s0 = glb.node_static_trs(i)
        t = ch.get("translation", t0)
        q = ch.get("rotation", q0)
        s = ch.get("scale", s0)
        T_glb_frame1[name] = trs_to_mat(t, q, s)
        if (np.abs(t - t0).max() > 1e-5
                or np.abs(np.asarray(q) - q0).max() > 1e-5):
            frame1_differs = True
    print(f"[build_mapping] frame-1 sample differs from static TRS: {frame1_differs}")

    # ---- 3. calibration (fail-closed ladder) ------------------------------
    qpos0 = robot.m.qpos0.copy()
    attempts = []

    def attempt(label, T_glb_rest, qpos):
        Tms, Tgs = [], []
        robot.fk(qpos)
        for node_name, geom_name in mapped.items():
            Tms.append(robot.geom_T(robot.geom_ids[geom_name]))
            Tgs.append(T_glb_rest[node_name])
        R_C, s_C, t_C, inl, _, _ = fit_C(Tms, Tgs)
        per, max_pos, max_rot, ok = eval_residuals(robot, qpos, mapped, T_glb_rest, R_C, s_C, t_C)
        attempts.append({"path": label, "inliers": int(inl.sum()), "total": len(Tms),
                         "max_pos_m": max_pos, "max_rot_deg": max_rot, "pass": bool(ok)})
        print(f"[calibration:{label}] inliers {int(inl.sum())}/{len(Tms)}  "
              f"max_pos {max_pos*100:.2f}cm  max_rot {max_rot:.2f}deg  pass={ok}")
        return R_C, s_C, t_C, per, ok

    ik_info = None
    qpos_cal = qpos0
    rest_used = "static"

    # (a) static TRS vs qpos0
    R_C, s_C, t_C, per, ok = attempt("static_vs_qpos0", T_glb_static, qpos0)
    calibration_path = "static_vs_qpos0"

    # (b) frame-1 sample vs qpos0
    if not ok and frame1_differs:
        R_C, s_C, t_C, per, ok = attempt("frame1_vs_qpos0", T_glb_frame1, qpos0)
        if ok:
            calibration_path = "frame1_vs_qpos0"
            rest_used = "frame1"
    elif not ok:
        print("[calibration] frame-1 == static TRS; frame-1 fallback is identical, skipping re-fit")
        attempts.append({"path": "frame1_vs_qpos0", "skipped": "frame1 identical to static TRS"})

    # (c) recover the GLB snapshot arm pose by IK, then recheck the gate
    if not ok:
        print("[calibration] GLB rest is a gesture snapshot, not qpos0 -> IK snapshot recovery")
        # C from the trimmed inlier fit above (legs/torso agree exactly);
        # convert GLB targets into MuJoCo world for the arm chains
        # (inverse of the conjugation: T_mj = C^-1 . T_glb . C).
        targets = {}
        for node_name, geom_name in mapped.items():
            Tg = T_glb_static[node_name]
            Tt = np.eye(4)
            Tt[:3, :3] = R_C.T @ Tg[:3, :3] @ R_C
            Tt[:3, 3] = R_C.T @ (Tg[:3, 3] - t_C) / s_C
            targets[geom_name] = Tt
        q_snap = qpos0.copy()
        xr, cr = ik_fit_arm(robot, q_snap, RIGHT_ARM_JOINTS, RIGHT_ARM_GEOMS, targets)
        for j, v in zip(RIGHT_ARM_JOINTS, xr):
            q_snap[robot.jnt_qposadr[j]] = v
        xl, cl = ik_fit_arm(robot, q_snap, LEFT_ARM_JOINTS, LEFT_ARM_GEOMS, targets)
        for j, v in zip(LEFT_ARM_JOINTS, xl):
            q_snap[robot.jnt_qposadr[j]] = v
        ik_info = {
            "right_arm": {j: float(v) for j, v in zip(RIGHT_ARM_JOINTS, xr)},
            "left_arm": {j: float(v) for j, v in zip(LEFT_ARM_JOINTS, xl)},
            "right_cost": cr, "left_cost": cl,
        }
        print(f"[ik] right arm {np.round(xr,4).tolist()} cost {cr:.3e}")
        print(f"[ik] left  arm {np.round(xl,4).tolist()} cost {cl:.3e}")
        # refit C over ALL mapped geoms at the recovered snapshot, then gate
        Tms, Tgs = [], []
        robot.fk(q_snap)
        for node_name, geom_name in mapped.items():
            Tms.append(robot.geom_T(robot.geom_ids[geom_name]))
            Tgs.append(T_glb_static[node_name])
        R_C, s_C, t_C, inl, _, _ = fit_C(Tms, Tgs)
        per, max_pos, max_rot, ok = eval_residuals(robot, q_snap, mapped, T_glb_static, R_C, s_C, t_C)
        attempts.append({"path": "static_vs_ik_snapshot", "inliers": int(inl.sum()),
                         "total": len(Tms), "max_pos_m": max_pos, "max_rot_deg": max_rot,
                         "pass": bool(ok)})
        print(f"[calibration:static_vs_ik_snapshot] inliers {int(inl.sum())}/{len(Tms)}  "
              f"max_pos {max_pos*100:.2f}cm  max_rot {max_rot:.2f}deg  pass={ok}")
        if ok:
            calibration_path = "static_vs_ik_snapshot"
            qpos_cal = q_snap
            rest_used = "static"

    if not ok:
        report = {
            "error": "calibration failed: residual gate (<2cm/3deg) not met on any path",
            "attempts": attempts,
            "glb": glb_path, "mjcf": MJCF,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(FAIL_JSON, "w") as f:
            json.dump(report, f, indent=2)
        print(f"[build_mapping] ABORT — no calibration path passed the gate. "
              f"Report: {FAIL_JSON}. mapping.json NOT written.")
        sys.exit(1)

    C = make_C(R_C, s_C, t_C)
    T_glb_rest = T_glb_static if rest_used == "static" else T_glb_frame1
    max_pos = max(v["pos_m"] for v in per.values())
    max_rot = max(v["rot_deg"] for v in per.values())

    # ---- 4. Mesh_None_* attachment (GLB rest pose distances) ---------------
    arm_end_nodes = {}   # node_name -> geom_name, restricted candidate set
    for node_name, geom_name in mapped.items():
        stem = geom_name[:-len("_visual")] if geom_name.endswith("_visual") else geom_name
        if stem in ARM_END_GEOMS:
            arm_end_nodes[node_name] = geom_name
    mapped_pos = {n: T_glb_static[n][:3, 3] for n in mapped}
    attach = {}          # node_name -> {geom, parent_node, distance, match}
    warnings = []
    for name, i in none_nodes + unmatched:
        p = T_glb_static[name][:3, 3]
        cand = sorted(((float(np.linalg.norm(p - mapped_pos[n])), n) for n in arm_end_nodes))
        d_best, n_best = cand[0]
        if d_best < NONE_ATTACH_MAX:
            attach[name] = {"geom": mapped[n_best], "parent_node": n_best,
                            "distance_m": d_best, "match": "nearest_arm_end"}
        else:
            allc = sorted(((float(np.linalg.norm(p - mapped_pos[n])), n) for n in mapped))
            d_any, n_any = allc[0]
            attach[name] = {"geom": mapped[n_any], "parent_node": n_any,
                            "distance_m": d_any, "match": "nearest_any_fallback"}
            warnings.append(f"{name}: nearest arm-end geom at {d_best:.3f}m >= "
                            f"{NONE_ATTACH_MAX}m, attached to nearest mapped geom "
                            f"{mapped[n_any]} at {d_any:.3f}m")
    for w in warnings:
        print(f"[attach] WARNING {w}")
    n_arm = sum(1 for a in attach.values() if a["match"] == "nearest_arm_end")
    print(f"[attach] {len(attach)} unnamed/unmatched nodes attached "
          f"({n_arm} to arm-end geoms, {len(attach)-n_arm} fallback)")

    # ---- 5. per-node constants D_i ----------------------------------------
    robot.fk(qpos_cal)
    C_inv = np.linalg.inv(C)
    nodes_out = {}
    d_dev_max_pos = 0.0
    d_dev_max_rot = 0.0
    for node_name, geom_name in mapped.items():
        Tm = robot.geom_T(robot.geom_ids[geom_name])
        D = np.linalg.inv(Tm) @ C_inv @ T_glb_rest[node_name]
        # under the conjugation export convention D_i == C^-1, so C.D == I
        E = C @ D
        d_dev_max_pos = max(d_dev_max_pos, float(np.linalg.norm(E[:3, 3])))
        d_dev_max_rot = max(d_dev_max_rot, rot_angle_deg(E[:3, :3], np.eye(3)))
        nodes_out[node_name] = {
            "node_index": node_index[node_name],
            "geom": geom_name,
            "geom_id": robot.geom_ids[geom_name],
            "attach_parent": None,
            "match": "name",
            "D": D.tolist(),
        }
    for node_name, a in attach.items():
        Tm = robot.geom_T(robot.geom_ids[a["geom"]])
        D = np.linalg.inv(Tm) @ C_inv @ T_glb_static[node_name]
        nodes_out[node_name] = {
            "node_index": node_index[node_name],
            "geom": a["geom"],
            "geom_id": robot.geom_ids[a["geom"]],
            "attach_parent": a["geom"],
            "attach_parent_node": a["parent_node"],
            "attach_distance_m": a["distance_m"],
            "match": a["match"],
            "D": D.tolist(),
        }
    print(f"[D] mapped-geom C.D_i deviation from identity (expect ~0, D_i ~= C^-1): "
          f"max {d_dev_max_pos*1000:.2f}mm / {d_dev_max_rot:.3f}deg")

    # ---- 6. write mapping.json --------------------------------------------
    out = {
        "generated_by": "build_mapping.py",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "glb": glb_path,
        "mjcf": MJCF,
        "convention": {
            "formula": "T_glb_node(f) = C @ T_mj_geom(f) @ D ; all 4x4 row-major",
            "glb_frame": "node-local TRS relative to TrafficDirector_KBot_Root (Y-up)",
            "mj_frame": "MuJoCo world (Z-up), qpos_calibration below",
            "note": ("exporter used the conjugation Y-up convention "
                     "T_glb = C @ T_mj @ C^-1, so D_i ~= C^-1 for name-mapped "
                     "geoms; Mesh_None_* nodes carry the extra rigid offset to "
                     "their attach parent inside D_i"),
        },
        "C": C.tolist(),
        "C_decomposed": {
            "scale": float(s_C),
            "rotation_quat_wxyz": mat_to_quat_wxyz(R_C).tolist(),
            "translation": t_C.tolist(),
        },
        "calibration": {
            "path": calibration_path,
            "glb_rest_source": rest_used,
            "mujoco_rest": ("qpos0" if ik_info is None else "ik_snapshot"),
            "qpos_calibration": qpos_cal.tolist(),
            "ik": ik_info,
        },
        "nodes": nodes_out,
        "residual_report": {
            "thresholds": {"pos_m": POS_TOL, "rot_deg": ROT_TOL_DEG},
            "max_pos_m": max_pos,
            "max_rot_deg": max_rot,
            "pass": True,
            "attempts": attempts,
            "per_geom": per,
            "CD_identity_deviation_mapped": {"max_pos_m": d_dev_max_pos,
                                             "max_rot_deg": d_dev_max_rot},
            "none_attach": {
                "count": len(attach),
                "arm_end": n_arm,
                "fallback": len(attach) - n_arm,
                "warnings": warnings,
            },
        },
        "counts": {
            "glb_mesh_nodes": len(node_index),
            "name_mapped": len(mapped),
            "none_nodes": len(none_nodes),
            "unmatched_named": len(unmatched),
            "total_nodes_out": len(nodes_out),
        },
    }
    if os.path.exists(OUT_JSON) and not os.path.exists(OUT_JSON + ".orig"):
        shutil.copy2(OUT_JSON, OUT_JSON + ".orig")
    with open(OUT_JSON, "w") as f:
        json.dump(out, f, indent=1)
    if os.path.exists(FAIL_JSON):
        os.remove(FAIL_JSON)
    print(f"[build_mapping] OK — wrote {OUT_JSON}")
    print(f"[build_mapping] path={calibration_path}  nodes={len(nodes_out)}  "
          f"max_pos {max_pos*100:.3f}cm  max_rot {max_rot:.3f}deg")


if __name__ == "__main__":
    main()
