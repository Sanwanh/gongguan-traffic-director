#!/usr/bin/env python3
"""純函式自我測試 —— 不需要 Chrome、不需要模型權重、不需要網路。

    python selftest.py

這一支跑得很快,適合每次改動後先跑它,再跑要 30 秒的 `verify_pipeline.py`。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import scene                                                    # noqa: E402
from aggregate import (BANNED_KEYS, aggregate_frames, assert_privacy_clean,  # noqa: E402
                       degraded_state, stop_line_for_lane)
from homography import (Calibration, apply_h, away_direction,   # noqa: E402
                        monte_carlo, pencil_point, roi_probe_points, solve, solve_h)

FAILURES: list[str] = []
PASSES = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSES
    if condition:
        PASSES += 1
        print(f"  PASS  {name}" + (f"  {detail}" if detail else ""))
    else:
        FAILURES.append(name)
        print(f"  FAIL  {name}  {detail}")


# --------------------------------------------------------------------------
# 一個合成的「攝影機」:已知的相機外參 + 針孔投影,拿來當 homography 的真值。
# --------------------------------------------------------------------------

def synthetic_camera(width=1920, height=1080, focal=1400.0,
                     eye=(30.0, 12.0, -18.0), look=(0.0, 0.0, 2.0)):
    eye = np.array(eye, dtype=float)          # (s, y, t)
    look = np.array(look, dtype=float)
    forward = look - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.array([0.0, 1.0, 0.0]))
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    rotation = np.stack([right, down, forward])

    def project(s: float, t: float) -> tuple[float, float] | None:
        camera = rotation @ (np.array([s, 0.0, t]) - eye)
        if camera[2] <= 0.1:
            return None
        return (width / 2 + focal * camera[0] / camera[2],
                height / 2 + focal * camera[1] / camera[2])

    return project, eye


def main() -> int:
    print("scene.py 與 core 的鏡像")
    ok, messages = scene.verify_against_core()
    check("scene 常數與 traffic_simulation_core.mjs 一致", ok, messages[0])

    print("\n車道指派")
    for lane in scene.MAIN_ROOSEVELT_LANES + scene.BUS_LANES:
        got = scene.assign_lane(lane["t"])
        check(f"車道中心 t={lane['t']} → {lane['lanePosition']}",
              got is not None and got["lanePosition"] == lane["lanePosition"]
              and got["direction"] == lane["direction"])
    check("車道帶外的點不指派", scene.assign_lane(scene.ROADWAY_T_MAX + 5.0) is None)
    check("兩條車道中間仍在容許範圍內",
          scene.assign_lane((-6.22 + -9.02) / 2) is not None)

    print("\n停止線幾何(由 CROSSWALK_BANDS 推出來,沒有手打座標)")
    for lane in scene.MAIN_ROOSEVELT_LANES:
        stop = stop_line_for_lane(lane)
        check(f"{lane['movement']} {lane['lanePosition']} 有停止線",
              stop is not None,
              f"s={stop[0]:.2f} 車陣往 {'+s' if stop and stop[1] > 0 else '-s'} 延伸"
              if stop else "")
    nw = stop_line_for_lane(scene.MAIN_ROOSEVELT_LANES[0])
    se = stop_line_for_lane(scene.MAIN_ROOSEVELT_LANES[3])
    check("西北向的停止線在路口的 -s 側", nw is not None and nw[0] < 0, f"{nw}")
    check("東南向的停止線在路口的 +s 側", se is not None and se[0] > 0, f"{se}")
    check("車陣往上游延伸(方向與行進相反)",
          nw is not None and se is not None and nw[1] < 0 and se[1] > 0)

    print("\nhomography:針孔投影的往返")
    project, eye = synthetic_camera()
    ground = [(s, t) for s in (-18, -6, 6, 16) for t in (-12, -4, 4, 12)]
    pairs = [(project(s, t), (s, t)) for s, t in ground]
    pairs = [(px, st) for px, st in pairs if px is not None]
    h = solve_h([p for p, _ in pairs], [g for _, g in pairs])
    errors = [math.hypot(*(apply_h(h, [px])[0] - np.array(st))) for px, st in pairs]
    check("平面單應性能精確還原針孔投影", max(errors) < 1e-6,
          f"max {max(errors):.2e} m")

    # 沒參與解 H 的點也要準(這才是內插能力,不是記憶)
    holdout = [((s, t), project(s, t)) for s, t in [(-10, 0), (0, 8), (12, -8), (3, 3)]]
    holdout_errors = [math.hypot(*(apply_h(h, [px])[0] - np.array(st)))
                      for st, px in holdout if px is not None]
    check("未參與求解的點也準", max(holdout_errors) < 1e-6,
          f"max {max(holdout_errors):.2e} m")

    print("\nhomography:框底邊偏差的修正方向(解析 Jacobian,不需要相機外參)")
    centre, finite = pencil_point(h)
    pencil_cos, camera_cos = [], []
    for s, t in [(-10, 0), (0, 8), (12, -8), (3, 3), (16, 12)]:
        px = project(s, t)
        if px is None:
            continue
        jac = away_direction(h, px)
        to_camera = np.array([s - eye[0], t - eye[2]])
        camera_cos.append(float(jac @ (to_camera / np.linalg.norm(to_camera))))
        if finite:
            from_centre = np.array([s - centre[0], t - centre[1]])
            pencil_cos.append(abs(float(jac @ (from_centre / np.linalg.norm(from_centre)))))
    check("修正方向與 pencil 點 C 的連線完全共線(這是它該滿足的性質)",
          finite and min(pencil_cos) > 1 - 1e-9,
          f"最差 |cos| = {min(pencil_cos):.12f}" if pencil_cos else "C 在無窮遠")
    check("修正方向與真實相機方位只差幾度(參考值,不是它的定義)",
          min(camera_cos) > 0.99,
          f"最差 cos = {min(camera_cos):.5f} "
          f"({math.degrees(math.acos(min(camera_cos))):.1f}°)")

    print("\n校正閘門")
    width, height = 1920, 1080
    roi = {"id": "t", "sMin": -18, "sMax": 16, "tMin": -12, "tMax": 12, "lanes": 6}
    spread = [{"px": list(project(s, t)), "s": s, "t": t, "band": "a" if s < 0 else "b"}
              for s, t in [(-18, -12), (-18, 12), (16, -12), (16, 12),
                           (-6, -4), (-6, 4), (6, -4), (6, 4)]]
    good = solve("spread", spread, width, height, roi, mc_trials=60)
    check("散開的 8 點通過全部閘門", good.quality["verdict"] == "pass",
          f"cond={good.quality['cond']:.2f} "
          f"MC p95={good.quality['monteCarlo']['p95M']:.3f} m")

    # 病態案例 1:基線縮短。對應關係全對,條件數幾乎不動,誤差卻暴增。
    tight = [{"px": list(project(s, t)), "s": s, "t": t, "band": "a"}
             for s, t in [(-1, -1), (-1, 1), (1, -1), (1, 1),
                          (-0.5, 0), (0.5, 0), (0, -0.5), (0, 0.5)]]
    narrow = solve("tight", tight, width, height, roi, mc_trials=60)
    check("基線太短被抖動自檢擋下", narrow.quality["gates"]["monteCarlo"] == "fail",
          f"cond={narrow.quality['cond']:.2f}(條件數毫無反應)"
          f" MC p95={narrow.quality['monteCarlo']['p95M']} m")
    check("條件數本身抓不到這個病態(所以不能只看條件數)",
          narrow.quality["gates"]["cond"] == "pass")

    # 病態案例 2:所有點共線 → 秩虧,條件數要爆掉。
    collinear = [{"px": list(project(s, 0.0)), "s": s, "t": 0.0, "band": "a"}
                 for s in (-18, -12, -6, 0, 6, 12, 16, 18)]
    degenerate = solve("collinear", collinear, width, height, roi, mc_trials=20)
    check("共線 / 秩虧被條件數擋下", degenerate.quality["gates"]["cond"] == "fail",
          f"cond={degenerate.quality['cond']:.3g}")

    # 病態案例 3:單點對錯 1.2 m → 殘差比值要跳起來。
    wrong = [dict(point) for point in spread]
    wrong[3] = dict(wrong[3], t=wrong[3]["t"] + 1.2)
    mistaken = solve("wrong", wrong, width, height, roi, mc_trials=20)
    check("單點對錯被殘差閘門抓到", mistaken.quality["gates"]["residualRatio"] == "warn",
          f"max={mistaken.quality['residualM']['max']:.3f} m "
          f"(比值只有 {mistaken.quality['residualM']['ratio']:.1f},"
          "所以不能只看比值)")
    check("乾淨的 8 點不會被殘差閘門誤判",
          good.quality["gates"]["residualRatio"] == "pass",
          f"max={good.quality['residualM']['max']:.4f} m")

    print("\n聚合與映射")
    calib = Calibration(id="selftest", h=h, width=width, height=height,
                        roi={"id": "t", "sMin": -18, "sMax": 16,
                             "tMin": scene.ROADWAY_T_MIN, "tMax": scene.ROADWAY_T_MAX,
                             "lanes": 6},
                        quality=good.quality)
    lane_points = []
    for lane in scene.MAIN_ROOSEVELT_LANES:
        for s in (-8, 8):
            lane_points.append({"cls": "car", "score": 0.9, "s": s, "t": lane["t"],
                                "group": "vehicle"})
    state = aggregate_frames([lane_points], calib,
                             detector_info={"model": "selftest", "license": "n/a"})
    roi_length = 16 - (-18)
    expected = len(lane_points) * (scene.GENERAL_LANES / 6) * (scene.SPAWN_SPAN_M / roi_length)
    check("車數換算 = count × (generalLanes/roiLanes) × (spanM/roiLengthM)",
          state["simulation"]["mainVehicleMin"] == int(math.floor(expected)),
          f"expected {expected:.2f} 得到 "
          f"[{state['simulation']['mainVehicleMin']}, "
          f"{state['simulation']['mainVehicleMax']}]")
    check("方向比例由車道歸屬量出(每向各半)",
          abs(state["simulation"]["directionSplit"] - 0.5) < 1e-9)
    check("車速為 null(影像不做跨幀關聯就量不到)",
          state["simulation"]["speedRangeMps"] is None)
    check("逐車道流率為 null,另給誠實命名的 presentCount",
          all(lane["volume"] is None and lane["presentCount"] is not None
              for lane in state["detectors"][0]["lanes"]))
    check("車道權重標成 calibrated",
          state["simulation"]["laneQuotaConfidence"] == "calibrated")

    mixed = [
        {"cls": "car", "score": 0.9, "s": 0, "t": -6.22, "group": "vehicle"},
        {"cls": "car", "score": 0.9, "s": 2, "t": -6.22, "group": "vehicle"},
        {"cls": "motorcycle", "score": 0.8, "s": 0, "t": -11.82, "group": "vehicle"},
        {"cls": "bicycle", "score": 0.5, "s": 4, "t": -11.82, "group": "vehicle"},
        {"cls": "person", "score": 0.8, "s": 13, "t": 0, "group": "person"},
    ]
    mixed_state = aggregate_frames([mixed], calib,
                                   detector_info={"model": "selftest", "license": "n/a"})
    mix = mixed_state["simulation"]["mix"]
    check("車種比例總和為 1", abs(sum(mix.values()) - 1.0) < 1e-9, json.dumps(mix))
    check("自行車是量出來的(VD 永遠量不到)", mix["bicycle"] > 0)
    # mix 的輸出四捨五入到小數 4 位,所以比值只能對到 1% 以內。
    check("速克達/打檔車依專案假設 0.55:0.10 切分",
          abs(mix["scooter"] / max(mix["motorcycle"], 1e-9) - 0.55 / 0.10) < 0.05,
          f"實際比值 {mix['scooter'] / max(mix['motorcycle'], 1e-9):.3f}")
    check("行人數是量出來的", mixed_state["pedestrians"]["count"] == 1.0)

    print("\n隱私守門")
    check("degraded 輸出仍是合法 JSON 且標 degraded",
          degraded_state("測試")["degraded"] is True)
    leaked = dict(mixed_state)
    leaked["detectors"] = [{"bbox": [1, 2, 3, 4]}]
    try:
        assert_privacy_clean(leaked)
        check("禁止欄位會被擋下", False, "沒有 raise")
    except AssertionError as error:
        check("禁止欄位會被擋下", True, str(error))
    serialised = json.dumps(mixed_state, ensure_ascii=False)
    check("正常輸出不含任何禁字",
          not any(f'"{key}"' in serialised for key in BANNED_KEYS))

    print("\nMonte-Carlo 自檢的行為")
    probes = roi_probe_points(good.h, width, height, roi, step=80)
    check("ROI 內找得到探測點", len(probes) > 20, f"{len(probes)} 個")
    tighter = monte_carlo([p["px"] for p in spread], [(p["s"], p["t"]) for p in spread],
                          probes, sigma_px=0.2, trials=40)
    looser = monte_carlo([p["px"] for p in spread], [(p["s"], p["t"]) for p in spread],
                         probes, sigma_px=3.0, trials=40)
    check("點擊雜訊越大、回報的不確定度越大",
          looser["p95M"] > tighter["p95M"] * 3,
          f"σ=0.2px → {tighter['p95M']:.3f} m,σ=3px → {looser['p95M']:.3f} m")

    print(f"\n{PASSES}/{PASSES + len(FAILURES)} 通過")
    if FAILURES:
        print("未通過:" + ", ".join(FAILURES))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
