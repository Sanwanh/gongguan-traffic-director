# KBot 動作管線 — 用 MuJoCo 讓機器人真正動起來

## 現況診斷(已確認)

- `viewer/models/kbot_traffic_director.glb`:89 節點、89 條 per-node clips
  (`<node>Action`,translation/rotation/scale),時間 0.0417–44.458s
  (=1067 影格 @24fps)。動畫資料存在且有變化。
- 但 `viewer/traffic_director.js` 的 `syncKbotPose()` 把 mixer **釘在每個相位
  的 start_frame 單一時刻**(靜態姿勢快照);只有 `lane90_release` 用
  24 影格循環。→ 機器人在網頁上看起來不會動。
- 相位影格窗(`traffic_rules/...rules.json` 的 `demo_timeline`):
  all_stop 1–48 / roosevelt_flow 49–240 / clearance 241–288 /
  pedestrian_crossing 289–899 / clearance 900–947 / lane90_release 948–1067。
  fps=24。手勢:ALL_STOP、STOP_FRONT_BACK_GO_LEFT_RIGHT、GO_FROM_LEFT。
- MuJoCo 3.11.0 可用(`uv run --with mujoco`)。KBot MJCF:
  `/Users/san/ksim/examples/kbot/robot/kbot-headless/robot.mjcf`
  (nq=27,20 個 hinge:雙腿各 5、雙臂各 5 = 肩 pitch/roll/yaw+肘+腕;
  32 geoms,mesh 名稱與 GLB 節點對應,如
  `KC_C_401R_R_UpForearmDrive.stl` ↔
  `Mesh_KC_C_401R_R_UpForearmDrive_visual_id25_geom`)。
- GLB 中 `Mesh_None_id27..id91` 等無名節點 = ORCA 手部零件(MJCF 無手指),
  處理方式:剛體跟隨其手腕/前臂父 geom。

## 目標

1. 用 **MuJoCo** 生成全程 1067 影格、物理平滑的連續手勢動畫
   (相位內也持續動作,不是快照)。
2. 烘焙回 GLB(保持 89 clips 結構,viewer loader 不用改)。
3. 小幅補丁 viewer 取樣邏輯:相位窗內連續播放+循環。
4. fail-closed:校準失敗就中止並保留原檔,絕不輸出對不上的動畫。

## 檔案配置(全部在 output/robot_package/)

- `mujoco/gesture_spec.json` — 手勢關節目標與循環定義
- `mujoco/run_gesture_sim.py` — MuJoCo 模擬 → `mujoco/kbot_trajectory.npz`
- `mujoco/build_mapping.py` — GLB↔MJCF geom 對應+校準 → `mujoco/mapping.json`
- `mujoco/bake_glb.py` — 烘焙 → 覆寫 `viewer/models/kbot_traffic_director.glb`
  (先備份 `kbot_traffic_director.orig.glb`)
- `mujoco/verify_motion.py` — 烘焙後 GLB 數值驗證
- viewer 補丁:`viewer/traffic_simulation_core.mjs` + `viewer/traffic_director.js`
  (改動最小化;原始檔各留 `.orig` 備份)

## 手勢設計(joint-space 目標,依台灣交通指揮手勢)

站姿不變(腿部關節鎖定站立姿勢,基座 weld 固定,腳不得滑動)。
所有轉換用 0.5s(12 影格)minimum-jerk / PD 到位;相位內疊加循環動作。

| 相位(影格窗) | 手勢 | 動作 |
| --- | --- | --- |
| all_stop 1–48 | ALL_STOP | 右臂垂直上舉(肩 pitch 舉到頭上,肘微屈),左臂自然下垂;±2° 慢速待機擺動(3s 週期) |
| roosevelt_flow 49–240 | STOP_FRONT_BACK_GO_LEFT_RIGHT | 兩臂左右平伸(肩 roll 90°);右前臂週期性肘屈伸招手(1.5s 週期,幅度 ~40°),左臂保持平伸微擺 |
| clearance 241–288, 900–947 | ALL_STOP | 同 all_stop(由前一姿勢平滑轉換過來) |
| pedestrian_crossing 289–899 | ALL_STOP(+行人綠燈) | 右臂維持上舉,左臂朝行穿線方向(前方 45°)緩慢水平掃動(4s 週期),示意行人通行 |
| lane90_release 948–1067 | GO_FROM_LEFT | 右臂上舉對主線維持停止;左臂平伸朝巷 90,肘部 24 影格(1s)招手循環(規則 `beckon_cycle_frames`=24) |

腕關節隨招手動作小幅擺動(±15°)增加自然感。

## MuJoCo 模擬要求(run_gesture_sim.py)

1. 載入 robot.mjcf;基座固定(weld equality 或改 freejoint→移除後掛
   world;用 MjSpec/XML 前處理皆可)。
2. 為 20 個 hinge 加 position actuators(kp 依 robstride class 級距,
   03≈60Nm 級、02≈17Nm 級、04≈120Nm 級,合理即可),重力開啟,
   跑真實 dynamics(timestep ≤ 0.004),控制目標 = 手勢 spec 的
   minimum-jerk 參考軌跡。
3. 以 24fps 取樣 1067 影格 qpos + 每個 visual geom 的 xpos/xmat →
   `kbot_trajectory.npz`。
4. **驗證(fail-closed)**:全程關節都在 MJCF range 內(含 5% 裕度);
   無自碰撞接觸(排除相鄰 body 對與腳-地面);參考 vs 實際 qpos RMS
   誤差 < 0.05 rad(PD 跟得上);腳部 geom 位移 < 1mm。
   任一失敗 → exit 1 並輸出報告 `mujoco/sim_report.json`。

## GLB 對應與校準(build_mapping.py)

1. 名稱對應:GLB `Mesh_<name>_visual_idNN_geom` ↔ MJCF geom
   `<name>_visual`(去 .stl)。列出對應成功清單與剩餘者。
2. `Mesh_None_*` 與其他無法名稱對應者:在 **GLB rest pose**(靜態節點
   transform)下,指給最近的已對應手臂末端 geom(限制:腕/前臂/上臂
   geoms;距離必須 < 0.45m,否則指給最近任意已對應 geom 並記 warning)。
3. 校準:設 MuJoCo rest = qpos0(全零),GLB rest = 節點靜態 transform。
   解 per-geom 常數 `D_i = T_mj_rest_i^{-1} · C^{-1} · T_glb_rest_i`,其中
   C 為全域轉換(含 Z-up→Y-up 與 root 縮放/旋轉),由多 geom 最小平方
   求出;驗證所有已對應 geom 的殘差 < 2cm/3°。殘差超標 → 嘗試
   「GLB rest = 現有動畫 frame 1 取樣」重解;仍失敗 → abort。
4. 輸出 `mapping.json`:{node_name → {geom, D_i(4x4), parent_attach}} + C。

## 烘焙(bake_glb.py)

1. 備份原檔為 `kbot_traffic_director.orig.glb`(若備份已存在則從備份讀,
   保證可重跑)。
2. 每節點新軌:`T_glb_i(f) = C · T_mj_geom(f) · D_i`,分解為
   translation+rotation(quaternion,注意連續性/符號翻轉)+原 scale。
3. 取樣密度:全程每影格(1067 keys);時間軸 = frame/24(沿用原 GLB
   慣例 frame1→0.0417s)。
4. 保持 89 clips/名稱/結構不變,只換 sampler 資料(新 accessors 附加到
   新 buffer 段)。GLB 檔案大小增加 < 15MB。
5. 烘焙後自我驗證+`verify_motion.py`:重新解析 GLB,抽 6 個代表節點
   (右前臂、左前臂、雙腳、torso、一個 ORCA 手件)在 5 個相位代表影格
   的位置,與 npz 中 `C·T_mj·D` 預期值比對(<1mm);腳部全程位移
   <2mm;quaternion 無跳變(相鄰影格 dot>0.99)。

## Viewer 補丁(最小改動)

1. `traffic_simulation_core.mjs` — `kbotMotionSample` 改為:所有相位
   `frame = start_frame + (elapsedS·fps) 映射進 [start_frame, end_frame]`;
   進入相位先播完 transition(不循環),之後在
   `[start_frame + transition_frames, end_frame]` 內循環
   (transition_frames=12;lane90_release 維持既有 `cycleFrames` 語意也可,
   只要連續動作)。`reducedMotion` 時退回原本靜態行為。簽名保持
   相容(新增可選參數,舊呼叫不炸)。需要 end_frame 就從呼叫端傳入。
2. `traffic_director.js` — `updateKbotGestureAnimation` 對所有相位持續
   推進(不只 lane90_release);`syncKbotPose` 轉相位時重置 clock 即可,
   不再永久釘住。傳入該相位的 end_frame(來自 runtime.phases)。
3. 不改 fail-closed 載入、外觀驗證、安全閘門等任何其他邏輯。

## 端到端驗證(瀏覽器)

伺服器:http://localhost:8124/viewer/traffic_director.html(已在跑)。
用 CDP headless Chrome(port 9334,--remote-allow-origins='*',
--disable-background-timer-throttling;/json/new 要用 PUT)驅動:

1. 載入成功(modelStatus 無「失敗」)。
2. 取 `runtime` 不可得就用 DOM+screenshot:每 0.5s 記錄 KBot probe
   (scene 中 `visual_id25` mesh 的 world position,可 evaluate three 場景:
   由 window 找不到就在補丁時掛 `window.__kbotProbeWorldPos()` debug hook
   ——允許,只讀不寫)連續 30s:
   - 相位內連續變化(相鄰樣本距離 > 0 且 < 0.3m,無跳瞬)
   - 跨相位姿勢顯著不同(all_stop vs roosevelt_flow 的 probe 位置差 > 0.15m)
3. 三個相位各存 screenshot(KBot 視角),肉眼可辨手勢不同。
4. console 無新 error;collisionCount 維持 0;FPS 不低於改動前。

## 絕對規則

- 不碰任何 `.blend`、不碰 V54 環境/號誌 GLB。
- 所有被覆寫檔案先留 `.orig` 備份;可重跑(冪等)。
- 驗證失敗 → 還原備份並回報,不交付半成品。

## 追加:WALK_CYCLE 步行循環(2026-08-05)

- gesture_spec.json:total_frames 1067→1143;phases 追加
  `walk_cycle`(1068–1143;12 幀過渡+64 幀迴圈區=兩個 32 幀週期,
  overlay 於 loop_start 過零故取模無縫);`validation.foot_static_end_frame
  = 1067`(走路段豁免腳靜止閘門)。
- 關節符號:左右鏡像(左膝 [0,2.705]、右膝 [-2.705,0] 等),故左右用
  同幅同相 overlay 自然交替。基座 weld+微蹲(膝 0.5)使腳全程離地,
  無地面接觸;前進位移由 viewer root motion 提供。
- run_gesture_sim.py:foot 閘門讀 `foot_static_end_frame`。
  verify_motion.py:G1 keys 由 npz 幀數決定(1143),G3 分段:手勢段
  <2mm、走路段需 ≥50mm 擺幅。
- 重跑順序不變:run_gesture_sim → bake_glb → verify_motion(全部
  fail-closed、冪等)。最新結果:sim RMS 0.01178 rad、接縫 0.03 rad、
  bake growth 4.09MB、全閘門 PASS。
