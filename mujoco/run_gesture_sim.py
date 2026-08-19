#!/usr/bin/env python
"""KBot traffic-director gesture simulation (SPEC_MUJOCO.md).

Loads robot.mjcf, welds the base to the world (freejoint removed), adds
position PD actuators (+ velocity feedforward) for the 20 hinges, runs real
dynamics under gravity while tracking minimum-jerk reference trajectories
built from mujoco/gesture_spec.json, samples 1067 frames @24fps of qpos and
every geom's xpos/xmat into mujoco/kbot_trajectory.npz, then runs fail-closed
validation and writes mujoco/sim_report.json.  Exit 0 = all checks pass.

Run:  uv run --with mujoco,numpy python mujoco/run_gesture_sim.py
"""

import json
import math
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np
import mujoco

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MUJOCO_DIR = os.path.join(PKG, "mujoco")
SPEC_PATH = os.path.join(MUJOCO_DIR, "gesture_spec.json")
MJCF_PATH = os.environ.get("KSIM_ROOT", str(Path.home() / "ksim")) + "/examples/kbot/robot/kbot-headless/robot.mjcf"
MJCF_DIR = os.path.dirname(MJCF_PATH)
NPZ_PATH = os.path.join(MUJOCO_DIR, "kbot_trajectory.npz")
REPORT_PATH = os.path.join(MUJOCO_DIR, "sim_report.json")

ACT_CLASS_OF_SUFFIX = {"04": "robstride_04", "03": "robstride_03",
                       "02": "robstride_02", "00": "robstride_00"}


def build_model(spec):
    """Parse robot.mjcf, weld base, swap motors for position+velocity
    actuators, add a floor plane. Returns compiled MjModel."""
    tree = ET.parse(MJCF_PATH)
    root = tree.getroot()

    comp = root.find("compiler")
    comp.set("meshdir", MJCF_DIR)  # mesh files are referenced as meshes/*.stl

    # --- weld base: remove the freejoint so 'base' is fixed to the world ---
    base = root.find('.//body[@name="base"]')
    fj = base.find("freejoint")
    if fj is not None:
        base.remove(fj)

    # --- gravity / timestep ---
    ts = float(spec["sim"]["timestep_s"])
    opt = root.find("option")
    if opt is None:
        opt = ET.SubElement(root, "option")
    opt.set("timestep", repr(ts))
    g = spec["sim"]["gravity"]
    opt.set("gravity", f"{g[0]} {g[1]} {g[2]}")

    # --- floor plane (feet rest ~2mm above z=0 at qpos0) ---
    wb = root.find("worldbody")
    floor = ET.SubElement(wb, "geom")
    floor.set("name", "floor")
    floor.set("type", "plane")
    floor.set("size", "5 5 0.1")
    floor.set("pos", f"0 0 {spec['sim']['floor_z']}")
    floor.set("contype", "1")
    floor.set("conaffinity", "1")
    floor.set("friction", "1.0 0.005 0.0001")
    floor.set("rgba", "0.3 0.3 0.3 1")

    # --- replace <motor> actuators with position PD + velocity feedforward ---
    act = root.find("actuator")
    joints = []  # (joint_name, range_lo, range_hi, class)
    for jel in root.find("worldbody").iter("joint"):
        name = jel.get("name")
        lo, hi = (float(x) for x in jel.get("range").split())
        cls = jel.get("class") or ACT_CLASS_OF_SUFFIX[name.rsplit("_", 1)[-1]]
        joints.append((name, lo, hi, cls))
    for child in list(act):
        act.remove(child)
    gains = spec["actuation"]["classes"]
    for name, lo, hi, cls in joints:
        gcfg = gains[cls]
        pos = ET.SubElement(act, "position")
        pos.set("name", f"{name}_pos")
        pos.set("joint", name)
        pos.set("kp", repr(float(gcfg["kp"])))
        pos.set("ctrlrange", f"{lo} {hi}")
        pos.set("forcerange", f"-{gcfg['forcerange']} {gcfg['forcerange']}")
    for name, lo, hi, cls in joints:
        gcfg = gains[cls]
        vel = ET.SubElement(act, "velocity")
        vel.set("name", f"{name}_vel")
        vel.set("joint", name)
        vel.set("kv", repr(float(gcfg["kv"])))
        vel.set("ctrlrange", "-20 20")
        vel.set("forcerange", f"-{gcfg['forcerange']} {gcfg['forcerange']}")

    xml = ET.tostring(root, encoding="unicode")
    return mujoco.MjModel.from_xml_string(xml)


def minimum_jerk(u):
    """Minimum-jerk blend factor s(u), u clipped to [0,1]."""
    u = np.clip(u, 0.0, 1.0)
    return 10.0 * u**3 - 15.0 * u**4 + 6.0 * u**5


def build_reference(spec, joint_names):
    """Return ref(fpos_array) -> (n, 20) reference qpos.

    fpos is the continuous frame position (frame f is sampled at fpos = f,
    time t = f/fps).  Each phase p with window [start, end] owns
    fpos in (start-1, end].  Inside a phase:
        r(fpos) = (1-s)*prev_end + s*(base_p + cyc_p(fpos))
    with s = minjerk((fpos - (start-1)) / transition_frames), and the cyclic
    overlays phased so sin() crosses zero at loop_start = start-1+transition.
    prev_end is the previous phase's reference at its own end frame
    (all zeros / standing rest before the first phase).
    """
    fps = float(spec["fps"])
    ttrans = float(spec["transition_frames"])
    jidx = {n: i for i, n in enumerate(joint_names)}
    nj = len(joint_names)

    standing = np.zeros(nj)
    for jn, v in spec["standing_pose"].items():
        standing[jidx[jn]] = v

    phases = []
    prev_end_pose = standing.copy()  # rest = qpos0 (zeros)
    for ph in spec["phases"]:
        gest = spec["gesture_poses"][ph["gesture"]]
        base = standing.copy()
        for jn, v in gest["base"].items():
            base[jidx[jn]] = v
        cycles = []
        for cyc in gest["cycles"]:
            period_frames = (float(cyc["period_frames"]) if "period_frames" in cyc
                             else float(cyc["period_s"]) * fps)
            cycles.append((jidx[cyc["joint"]], float(cyc["amplitude_rad"]),
                           period_frames, float(cyc.get("phase_rad", 0.0))))
        start, end = float(ph["start_frame"]), float(ph["end_frame"])
        rec = {"t0": start - 1.0, "t1": end, "base": base, "cycles": cycles,
               "prev_end": prev_end_pose.copy(), "loop_start": start - 1.0 + ttrans,
               "ttrans": ttrans, "name": ph["phase"]}
        phases.append(rec)

        # reference value at this phase's end frame becomes next prev_end
        prev_end_pose = _eval_phase(rec, np.array([end]), nj)[0]

    def _lookup(fpos):
        for rec in phases:
            if fpos <= rec["t1"] or rec is phases[-1]:
                if fpos > rec["t0"] or rec is phases[0]:
                    return rec
        return phases[-1]

    def ref(fpos_array):
        out = np.empty((len(fpos_array), nj))
        for k, fpos in enumerate(fpos_array):
            rec = _lookup(fpos)
            out[k] = _eval_phase(rec, np.array([fpos]), nj)[0]
        return out

    return ref, phases


def _eval_phase(rec, fpos, nj):
    """Evaluate one phase's reference at fpos (array) -> (n, nj)."""
    s = minimum_jerk((fpos - rec["t0"]) / rec["ttrans"])[:, None]
    tgt = np.tile(rec["base"], (len(fpos), 1))
    for j, amp, period, ph0 in rec["cycles"]:
        tgt[:, j] += amp * np.sin(2.0 * np.pi * (fpos - rec["loop_start"]) / period + ph0)
    return (1.0 - s) * rec["prev_end"] + s * tgt


def main():
    spec = json.load(open(SPEC_PATH))
    fps = int(spec["fps"])
    nframes = int(spec["total_frames"])
    nsub = int(spec["sim"]["substeps_per_frame"])
    dt = 1.0 / (fps * nsub)

    model = build_model(spec)
    model.opt.timestep = dt
    data = mujoco.MjData(model)

    njnt = model.njnt
    joint_names = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, i)
                   for i in range(njnt)]
    assert model.nq == 20 and model.nu == 40, (model.nq, model.nu)
    qadr = np.array([model.jnt_qposadr[i] for i in range(njnt)])
    dadr = np.array([model.jnt_dofadr[i] for i in range(njnt)])
    jrange = model.jnt_range.copy()  # (njnt, 2)

    geom_names = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or f"geom_{i}"
                  for i in range(model.ngeom)]
    body_names = [mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, i)
                  for i in range(model.nbody)]
    floor_gid = geom_names.index("floor")
    visual_mask = np.array([model.geom_group[i] == 2 for i in range(model.ngeom)])
    foot_gids = [i for i, n in enumerate(geom_names)
                 if "FootBushing" in n]  # visual mesh + capsules, both feet
    foot_bids = {model.geom_bodyid[g] for g in foot_gids}

    # ---- reference trajectories on the substep grid ----
    ref_fn, phases = build_reference(spec, joint_names)
    nsteps = nframes * nsub
    fpos_grid = np.arange(nsteps + 1) / nsub          # 0 .. 1067
    ref_sub = ref_fn(fpos_grid)                       # (nsteps+1, 20)
    vel_sub = np.gradient(ref_sub, 1.0 / (fps * nsub), axis=0)
    ref_frames = ref_sub[nsub::nsub]                  # (1067, 20) at f=1..1067

    # actuator order: 20 position then 20 velocity, both in joint order
    def set_ctrl(k):
        data.ctrl[:njnt] = ref_sub[k]
        data.ctrl[njnt:] = vel_sub[k]

    # ---- settle at the initial reference before the recording clock ----
    data.qpos[qadr] = ref_sub[0]
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)
    for _ in range(int(round(spec["settle_seconds"] / dt))):
        data.ctrl[:njnt] = ref_sub[0]
        data.ctrl[njnt:] = 0.0
        mujoco.mj_step(model, data)

    # ---- main rollout: 1067 frames @ 24fps ----
    qpos_out = np.zeros((nframes, njnt))
    gxpos = np.zeros((nframes, model.ngeom, 3))
    gxmat = np.zeros((nframes, model.ngeom, 9))
    contact_records = []          # (frame, geom1, geom2)
    substep_qpos_min = np.full(njnt, np.inf)
    substep_qpos_max = np.full(njnt, -np.inf)

    adjacent = _adjacency(model)
    for k in range(1, nsteps + 1):
        set_ctrl(k)
        mujoco.mj_step(model, data)
        q = data.qpos[qadr]
        np.minimum(substep_qpos_min, q, out=substep_qpos_min)
        np.maximum(substep_qpos_max, q, out=substep_qpos_max)
        if k % nsub == 0:
            f = k // nsub  # frame 1..1067
            qpos_out[f - 1] = q
            gxpos[f - 1] = data.geom_xpos
            gxmat[f - 1] = data.geom_xmat.reshape(model.ngeom, 9)
            for ci in range(data.ncon):
                con = data.contact[ci]
                g1, g2 = int(con.geom1), int(con.geom2)
                b1, b2 = int(model.geom_bodyid[g1]), int(model.geom_bodyid[g2])
                # exclude foot-ground
                if (g1 == floor_gid and b2 in foot_bids) or \
                   (g2 == floor_gid and b1 in foot_bids):
                    continue
                # exclude same-body and adjacent (parent-child) body pairs
                if b1 == b2 or (b1, b2) in adjacent or (b2, b1) in adjacent:
                    continue
                contact_records.append((f, geom_names[g1], geom_names[g2]))

    # ---- validation (fail-closed) ----
    vcfg = spec["validation"]
    checks = {}

    # 1. joint ranges with 5% span margin, checked on every substep
    margin = float(vcfg["joint_range_margin_fraction"])
    span = jrange[:, 1] - jrange[:, 0]
    lo_ok = substep_qpos_min >= jrange[:, 0] - margin * span
    hi_ok = substep_qpos_max <= jrange[:, 1] + margin * span
    range_viol = [
        {"joint": joint_names[i],
         "range": [float(jrange[i, 0]), float(jrange[i, 1])],
         "observed": [float(substep_qpos_min[i]), float(substep_qpos_max[i])]}
        for i in range(njnt) if not (lo_ok[i] and hi_ok[i])
    ]
    checks["joint_ranges_within_5pct_margin"] = {
        "pass": not range_viol, "violations": range_viol}

    # 2. self-collision contacts (adjacent bodies and foot-ground excluded)
    checks["no_self_collision_contacts"] = {
        "pass": len(contact_records) <= int(vcfg["self_collision_contacts_max"]),
        "count": len(contact_records),
        "examples": [list(c) for c in contact_records[:10]]}

    # 3. reference vs actual qpos RMS
    err = qpos_out - ref_frames
    rms = float(np.sqrt(np.mean(err**2)))
    per_joint_rms = np.sqrt(np.mean(err**2, axis=0))
    worst_j = int(np.argmax(per_joint_rms))
    checks["ref_vs_actual_rms"] = {
        "pass": rms < float(vcfg["ref_vs_actual_rms_max_rad"]),
        "rms_rad": rms,
        "limit_rad": float(vcfg["ref_vs_actual_rms_max_rad"]),
        "worst_joint": joint_names[worst_j],
        "worst_joint_rms_rad": float(per_joint_rms[worst_j]),
        "max_abs_err_rad": float(np.max(np.abs(err)))}

    # 4. foot geoms move < 1mm (vs frame 1) — gesture frames only; the
    # walk_cycle window (frames > foot_static_end_frame) deliberately swings
    # the feet, so it is excluded from this gate.
    foot_static_end = int(vcfg.get("foot_static_end_frame", nframes))
    foot_disp = np.linalg.norm(
        gxpos[:foot_static_end, foot_gids, :] - gxpos[0:1, foot_gids, :],
        axis=2)
    max_foot_disp = float(foot_disp.max())
    checks["foot_geoms_static"] = {
        "pass": max_foot_disp < float(vcfg["foot_geom_max_displacement_m"]),
        "frames_checked": foot_static_end,
        "max_displacement_m": max_foot_disp,
        "limit_m": float(vcfg["foot_geom_max_displacement_m"])}

    ok = all(c["pass"] for c in checks.values())

    excursion = np.maximum(np.abs(substep_qpos_min), np.abs(substep_qpos_max))
    max_exc_j = int(np.argmax(excursion))
    report = {
        "ok": ok,
        "spec": os.path.relpath(SPEC_PATH, PKG),
        "mjcf": MJCF_PATH,
        "mujoco_version": mujoco.__version__,
        "frames": nframes, "fps": fps,
        "timestep_s": dt, "substeps_per_frame": nsub,
        "settle_seconds": spec["settle_seconds"],
        "checks": checks,
        "metrics": {
            "rms_error_rad": rms,
            "max_abs_tracking_error_rad": float(np.max(np.abs(err))),
            "max_joint_excursion_rad": float(excursion[max_exc_j]),
            "max_joint_excursion_joint": joint_names[max_exc_j],
            "self_collision_contact_count": len(contact_records),
            "max_foot_displacement_mm": max_foot_disp * 1000.0,
            "per_joint_rms_rad": {joint_names[i]: float(per_joint_rms[i])
                                  for i in range(njnt)},
            "per_joint_observed_range_rad": {
                joint_names[i]: [float(substep_qpos_min[i]),
                                 float(substep_qpos_max[i])]
                for i in range(njnt)},
        },
        "phases": spec["phases"],
    }
    with open(REPORT_PATH, "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    if ok:
        # only write the trajectory when validation passes (fail-closed)
        np.savez_compressed(
            NPZ_PATH,
            qpos=qpos_out, ref_qpos=ref_frames,
            joint_names=np.array(joint_names),
            geom_xpos=gxpos, geom_xmat=gxmat,
            geom_names=np.array(geom_names),
            geom_bodyid=model.geom_bodyid.copy(),
            geom_group=model.geom_group.copy(),
            visual_geom_mask=visual_mask,
            body_names=np.array(body_names),
            frames=np.arange(1, nframes + 1),
            time_s=np.arange(1, nframes + 1) / fps,
            fps=np.array(fps),
            phases_json=np.array(json.dumps(spec["phases"])),
        )
        print(f"PASS  rms={rms:.5f} rad  foot_disp={max_foot_disp*1000:.4f} mm  "
              f"contacts={len(contact_records)}")
        print(f"wrote {NPZ_PATH}")
        print(f"wrote {REPORT_PATH}")
        return 0

    if os.path.exists(NPZ_PATH):
        os.remove(NPZ_PATH)  # never leave a stale/invalid trajectory behind
    print("FAIL — see sim_report.json")
    for name, c in checks.items():
        print(f"  {name}: {'pass' if c['pass'] else 'FAIL'}")
    return 1


def _adjacency(model):
    adj = set()
    for b in range(model.nbody):
        p = model.body_parentid[b]
        adj.add((b, p))
        adj.add((p, b))
    return adj


if __name__ == "__main__":
    sys.exit(main())
