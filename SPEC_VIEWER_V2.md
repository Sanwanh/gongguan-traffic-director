# Viewer V2 — 動作可靠性/亮度/FPS/車種分道/防生成事故

對象:`output/robot_package/viewer/`(traffic_director.html/css/js、
traffic_simulation_core.mjs)。伺服器 http://localhost:8124(python http.server,
--directory output/robot_package)。

## 既有事實(已確診,勿重查)

- `traffic_director.js:105` `runtime.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches`
  → 系統「減少動態效果」開啟時:KBot 手勢凍結(kbotMotionSample legacy 路徑)、
  行人步態停擺(:876-885)。這是「機器人沒有動作」主因之一。
- python http.server 不送 Cache-Control → 瀏覽器 heuristic cache 可能沿用舊
  GLB/JS(MuJoCo 烘焙前的檔案)。主因之二。
- `LOW_LOAD_RENDER_PROFILE`(:29):targetFps 30、maxPixelRatio 1.25、
  shadows false;:1922 用 minimumFrameIntervalMs 節流;狀態列寫死
  「低負載 30 FPS」。
- 燈光(:1881-1888):Hemisphere(0xb8e1f2, 0x24302c, 1.2)+
  Directional(0xfff4d6, 2.7);toneMappingExposure 1.02(:1857)。
- `traffic_simulation_core.mjs:160` `MAIN_ROOSEVELT_LANES` 只有 6 條一般車道
  (NW t=-5.375/-8.325/-11.275 dir=+1;SE t=6.275/9.225/12.175 dir=-1),
  **無公車道**;公車與汽機車混道。
- 生成(:438-460):slot 制,`baseS = -68 + laneSlot*slotSpacing + (random()-0.5)*6`
  抖動 ±3m、slotSpacing=136/slotsPerLane,未考慮車長(公車 12m)→
  可能出生即重疊/追撞。
- MuJoCo 動作補丁已上(kbotMotionSample 有 endFrame/transitionFrames 參數、
  window.__kbotProbeWorldPos hook)。viewer 兩 JS 已有 `.orig` 備份
  (= zip 原始版,**絕不可覆寫**;本輪備份用 `.v1` 後綴)。

## 修改需求

### 1. 機器人動作可靠(最優先)

a. 移除 prefers-reduced-motion 自動凍結:`runtime.reducedMotion` 改由新 UI
   開關「動作效果」控制,**預設開啟**(無論系統設定);開關放在模擬控制區,
   說明文字註明「關閉後 KBot 與行人動作簡化」。
b. 快取破壞:html 中引用 app 資源與 JS 內的 GLB/rules URL 全部加
   `?v=<內容SHA前8碼>`(寫個小工具 `mujoco/stamp_versions.py` 自動計算並
   改寫,冪等可重跑);另新增 `serve.py`(取代裸 http.server,仍 8124,
   `--directory` 相同):.html/.js/.mjs/.css/.json 送 `Cache-Control: no-cache`,
   .glb 送 `Cache-Control: no-cache`(有 v= 查詢串就允許 immutable),.mjs
   MIME 必須 text/javascript。部署時:殺舊 server、以 serve.py 重啟 8124。

### 2. 亮度

Hemisphere intensity 1.2→1.6(天空色不變)、Directional 2.7→3.4、
toneMappingExposure 1.02→1.22。目標:路面柏油在俯瞰與街道視角明顯變亮
但白色建築不過曝(判準:路面區平均亮度比改前 +25% 以上;畫面 near-white
比例不暴增)。微調由驗證截圖回饋決定,允許 ±15% 出入。

### 3. FPS

- RENDER_PROFILE 改雙模式:`高效能`(targetFps 60、maxPixelRatio
  min(2, devicePixelRatio)、uiUpdateHz 8)與 `省電`(現行 30/1.25/4)。
  預設高效能;UI 開關放模擬控制區。狀態列文字隨模式顯示「60 FPS」/「30 FPS」。
- 節流邏輯沿用 minimumFrameIntervalMs,別的渲染路徑不動。

### 4. 車種分道(請設定清楚)+ 車流模式

a. `traffic_simulation_core.mjs` 新增車道定義(向後相容,舊常數保留):
   - `BUS_LANES`:NW t=-2.425 dir=+1、SE t=3.325 dir=-1(= 最內一般車道再
     內移一個車道寬 2.95;實作時請以 `MAIN_ROOSEVELT_LANES` 內側車道 t ±2.95
     推導,不要散落 magic number)。`allowed: ["bus"]`。
   - `MAIN_ROOSEVELT_LANES` 每條加 `allowed` 與偏好註記:
     內側車道(|t| 最小)= ["car","taxi"];中間 = ["car","taxi","motorcycle"];
     外側 = ["car","taxi","scooter","motorcycle","bicycle"](台灣慣例:
     機車/單車靠外)。
   - 巷 90 生成(SIDE_ACCESS_SPAWNS)不變。
b. 指派規則(純函式,可測):`laneForVehicle(type, random)`——bus→該方向
   BUS_LANE;bicycle→外側;scooter→外側優先(80%)否則中間;
   motorcycle→外/中 50/50;car/taxi→三條一般道均衡。生成與任何變道/
   跟車邏輯都必須尊重 `allowed`(公車道永不出現非公車;一般道永不出現公車)。
c. 車流模式 UI(模擬控制區,select):`稀疏`(主線 10–14)/`一般`
   (現行 22–28,預設)/`尖峰`(34–42)。行人數同步縮放(6–10/10–16/16–24)。
   換模式 = 以現行 seed 重生成(沿用 reseed 流程)。
d. `mode`、車道指派要進 spawnSummary 面板文字(各車種數+「公車專用道 2」)。

### 5. 生成防碰撞(不要一出生就車禍)

- 逐車道排序放置:同車道內依 s 排序,相鄰車距 ≥
  `(前車長+後車長)/2 + max(6, 速度*1.2)` 公尺;抖動只允許在不破壞最小
  車距的範圍內。車長:bus 12、car/taxi 4.7、motorcycle 2.2、scooter 1.9、
  bicycle 1.8(如 core 已有長度表就用既有的)。
- 生成後斷言:任兩同車道車輛間距皆 ≥ 最小車距,違反→該 seed 內重排
  (deterministic,不是丟骰子重試無上限;最多 3 輪,仍失敗就減車數並記
  在 spawnSummary)。
- 跟車邏輯若無最小安全距,補上(前車 bumper - 後車 bumper ≥ 2m 恆成立)。
- 驗證:固定 20 個 seed × 3 模式,模擬前 30s(可用 node 直接跑 core 的
  純函式快轉)碰撞計數恆 0;公車永遠在公車道;無任何車輛 t 偏離其
  車道中心 >0.5m(變道除外,若 core 本無變道就是恆成立)。

### 6. Debug hooks(驗證用,唯讀)

`window.__vehicleStates()` → [{id,type,lane_t,s,movement}];
`window.__renderStats()` → {measuredFps, drawCalls, mode}。

## 絕對規則

- `.orig` 是 zip 原始版,不可覆寫;本輪改動前把現行版備份為 `.v1`。
- 不碰 fail-closed 載入、安全閘門、KBot 校準/烘焙產物、規則 JSON 的
  法規語意(新增 UI 模式設定可放新 JSON 鍵或 JS 常數,不改既有鍵)。
- 全部改動走最小 diff;node --check 兩個 JS;冪等。

## 驗證(瀏覽器,CDP port 9335)

1. 用 serve.py 重啟 8124 後:fresh profile 載入——機器人在 all_stop 也有
   待機微擺(probe 位置 0.5s 取樣連續變化);**CDP Emulation.setEmulatedMedia
   模擬 prefers-reduced-motion: reduce 再載入一次,機器人仍要動**(預設開關
   優先於系統設定)。
2. warm-cache 測試:舊 profile(先載一次舊版才切新版)重整後拿到新版
   (檢查 __kbotProbeWorldPos 存在 + v= 查詢串生效)。
3. FPS:高效能模式 measuredFps ≥ 50(headless 需
   --disable-frame-rate-limit? 不加也行,以 __renderStats 讀值並輔以
   rAF 計時);省電模式 ≈30。
4. 亮度:同視角截圖 vs 改前基準,路面區平均亮度 +25%±15%,near-white
   比例增幅 < 5 個百分點。
5. 分道:__vehicleStates() 20 次 reseed × 3 模式:bus 全在 |t-公車道中心|<0.5;
   非 bus 不在公車道;車道 allowed 全符合;collisionCount 60s 內恆 0。
6. 三個相位截圖 + 各模式截圖,肉眼確認:手勢差異、車流密度差異、公車
   在中央公車道、亮度提升。

## §7 V3 標線校準與路口幾何(2026-08-05)

使用者回報四問題:車不按標線走、機器人站在路中間、車流卡在奇怪位置、
重置後「刪不掉」。根因全部量測自 `gongguan_v54_environment.glb` 的實畫
標線(節點局部包圍盒 → 世界矩陣 → 模擬座標;中心值精確):

1. **座標系旋轉誤差 1.7°**:`simulationRoot.rotation.y` 由 `0.75π` 改為
   `0.75π + atan(-0.02957)`(對全部車道線做最小平方擬合)。
2. **車道真值**(s=0,由 LaneArrow 內插;三車道平行殘差 0.005 m):
   西北向 -6.22/-9.02/-11.82,東南向 7.18/9.98/12.78,車道寬 2.8。
   **公車道實測** -0.44 / 2.97(取代舊推導值 -2.425/3.325——舊值壓在
   槽化緩衝帶上)。一般車行帶隨真實道路微彎:`ROAD_CURVE_OFFSETS`
   每方向 6 點折線(視覺套用於 mesh z 與 yaw;邏輯仍直線)。公車道與
   巷90 為直線,不套折線。
3. **三條斑馬線帶** `CROSSWALK_BANDS`(直行 s∈[10.59,16.30] 全寬;交錯式
   正t半 s∈[-19.25,-14.80]、負t半 s∈[-11.88,-7.54],各含 t 範圍,閘門
   檢查具 t 感知)。**實畫停止線序列** `STOP_SEQUENCES`(一般/公車 ×
   方向,各兩道,附 exit 點):車輛以「前保桿漸進逼近下一道停止線」
   (target = 距離×0.65)取代舊的 18 m 窗硬煞——舊行為讓車停在停止線前
   10–14 m,即路口正中央(「卡在奇怪位置」主因之一);另一主因是舊
   CROSSWALK_S_MAX=13.6 比實際斑馬線窄 2.7 m,東南向車直接停在斑馬線上,
   reseed 後同位置重現(=「重置刪不掉」的觀感;環境 GLB 並無烘焙車輛)。
4. **巷90 改到正確側**:水源市場巷實際在 +t 側(欄杆/巷口號誌/市場走廊
   皆 +t)。側向車流 spawn (-9.5,33)/(-6.0,36.5),向 -t 行駛,
   `SIDE_STOP_T=17.2` 停等、`SIDE_END_T=14.5` 併入回收;followingBlocked
   加 |Δx|>1.5 橫向過濾(舊版兩柱互擋)。
5. **KBot 指揮位置**:分向島鼻端 chevron 區 `(0.45, 0.28, 1.275)`(島面
   高 0.16 m;舊位置=模擬原點,在西北向公車道正中央——blend 原作者
   即放錯)。robot 相機、rim/fill 燈隨動;`controller_yaw_deg` 首次落實
   (45°=GLB 內建朝向;鏡射父節點故取負;1.8 rad/s 緩轉)。
6. **回收與跟車**:wrap 改方向感知並落在同車道最後車之後(舊版乒乓瞬移,
   平均 6 s、最壞 37 s);followingBlocked 門檻加入煞車距離 v²/7.6
   (消除一幀急停);生成 keep-out 掃描(不得生成於停止線–exit 區間或
   斑馬線帶,溢出者計入 spawnReductions)。
7. **行人相位尾端**:WALK 剩餘時間 < 全程 45% 不再放行新進入者(已進入
   者走完);lane90_release 的行人閘門改為巷口區域檢查(穿越者在
   s∈[11,16] 與巷口 x∈[-11,-3] 不相交)——消除相位間 20 s+ 的 HOLD。
8. 兩個 reseed 入口同時歸零 throughput 與 collisions。

檔案:`traffic_simulation_core.mjs` + `traffic_director.js`(改前版本備份
`.v2`;`.orig`/`.v1` 不動)、`traffic_director.html`(v= 戳)。

測試:`node mujoco/test_lane_rules.mjs`(60 plans 仍 PASS)、
`node mujoco/test_viewer_v3_geometry.mjs`(新增:keep-out、停止線收斂、
帶 t 感知、折線邊界、巷90 幾何)。CDP headless 驗證:紅燈零車壓斑馬線、
6 s 內無單車重複 wrap、reseed 全量換車、lane90_release 即時 active、
holder yaw 達 -π/2、頁面零例外。

## §8 綠色 KBot、人行道走入指揮、手勢連續性(2026-08-05)

1. **綠色塗裝 v2**:GLB 黑色外觀 metadata 驗證照舊,通過後依
   `kbot_material_role` 執行期改色(殼 #2e7d52 玉綠、關節 #232e28 槍鐵、
   ORCA 手 #2e7d52/#1e5038);輪廓/補光燈由青藍改中性色(青光打綠身
   會色偏)。UI 字串與圖例同步;`kbotAppearance.runtimeTint="green-v1"`。
2. **人行道站位與走入**:站位 `KBOT_STAND (1.5, 0.34, 16.6)`——巷90口
   與直行斑馬線之間的人行道轉角(避開號誌桿/車阻);進場沿
   `KBOT_WALK_PATH` 從市場走廊走過去(root motion 由 holder 提供,速度
   0.85 m/s 與步態同步)。朝向:holder 0 = 面向車道(推導自 blend 45°
   朝向經座標橋換算);`KBOT_PHASE_YAW_RAD` 僅 lane90_release=+π/2
   (轉向巷口),取代 rules 的 controller_yaw_deg(路中站位語意)。
3. **步行循環(MuJoCo 烘焙)**:gesture_spec.json 新增 WALK_CYCLE
   (微蹲抬腳離地、髖 ±0.40 交替、膝 0.35@+π/2、踝雙頻保持腳掌水平、
   臂反擺 0.22),相位視窗 1068–1143(12 幀過渡 + 兩個 32 幀週期),
   total_frames 1143。閘門:foot_static 限 1..1067(spec
   `validation.foot_static_end_frame`),verify_motion G3 加走路段
   ≥50mm 擺幅檢查。sim PASS(RMS 0.012 rad、0 自碰撞、腳擺 312mm)。
   viewer 於步行期間取模播放迴圈區 [1079,1143](`KBOT_WALK_CLIP`)。
4. **手勢連續性**:①`kbotMotionSample` hold 視窗改 ping-pong 三角波
   (wrap 不再跳變,新增連續性測試);②`setKbotMixerTime`:取樣時間
   跳躍 >0.2s 先全節點姿勢快照,0.4s smoothstep crossfade
   (`applyKbotPoseBlend`),涵蓋相位切換/步行起止;CDP 實測相位切換
   探針步長 ≤0.24 m/50ms。
5. **網狀線淨空(runtime keep-clear)**:紅燈長隊伍不再停在斑馬線帶上
   ——前方隊伍未讓出帶後完整車位(車長+2.3m)前,跟車停在帶前 0.4m
   (`keepClearHoldDistance`);修復 lane90_release 被
   intersection_not_clear 卡死的問題。
6. 驗證:test_lane_rules / test_viewer_v3_geometry(含 ping-pong)全過;
   bake self-check 0.00005mm;CDP:步行取樣時間落在烘焙視窗、到站
   (1.5,0.34,16.6)、lane90 25s 內 active、yaw=+π/2、零頁面例外。

## §9 KBot 勤務狀態機(斑馬線站位+可見走路)(2026-08-05)

san 回饋:看不到機器人走路、站位也不在斑馬線。§8 的一次性走入在頁面
載入期間就走完了。改為勤務狀態機(`updateKbotWalk`):

1. **站位改斑馬線旁路肩** `KBOT_STAND (9.4, 0.12, 15.4)`——直行斑馬線
   上游邊、實畫停止線旁、SE 外側車道邊線(14.83)與路緣(16.2)之間,
   不佔車道。
2. **可見進場**:場景就緒後延遲 2.5 s 才起步,沿 `KBOT_ENTRY_PATH`
   (市場走廊 → 騎樓前人行道 → 緣石坡道 → 路肩)走約 20 s。
3. **行人相位護送巡走**:每個 pedestrian_crossing 相位,自站位沿斑馬線
   上游邊走到 `KBOT_ESCORT (9.8, 0.12, 8.0)`(SE 車道帶中段),站立
   全停手勢護送;相位剩餘 < 回程+4s 或相位切換即走回。走路=常態行為,
   每個自動循環都看得到。
4. **車道安全閘門**:`robotOnRoadway()`(holder t<15.3)併入
   pedestrianConflict——機器人還在車道上時任何車流放行維持 blocked
   (CDP 驗證:escort 中請求 roosevelt_flow → pedestrian_conflict,
   回到路肩後才 active);安全鎖 UI 顯示「KBot 於車道護送中」。
5. **KBot 視角跟隨**:robot 相機啟用時 controls.target 平滑跟隨 holder
   (`updateKbotCameraFollow`)。
6. 走動(entry/patrol/return)一律播放步行循環 + 面向行進方向;
   reducedMotion 直接就位、不巡走。debug snapshot 增
   walkKind/walkEntryDone/robotOnRoadway。

## §10 快取根因、斑馬線入口崗位、停止線通過語意(2026-08-05)

san 回饋:腳沒動像瞬移、應在人行道斑馬線邊指揮、過停止線的車別卡路中。

1. **「沒在走路」根因=immutable 快取**:serve.py 對帶 ?v= 的 .glb 送
   `immutable, max-age=1y`,而 §8 重烘焙 GLB(加走路影格)後未換
   kbot 的 ?v= 戳 → 瀏覽器用舊 GLB(無 1068+ 影格,mixer LoopRepeat
   繞回 all_stop 姿勢)→ 滑行「瞬移」。修:跑 mujoco/stamp_versions.py
   (內容雜湊蓋章,kbot → ?v=9b71e177);loadKbot 加防呆——時間軸
   < 1143/24 s 即 fail-closed 並提示強制重新整理。**日後凡改 GLB/JS
   必跑 stamp_versions.py。**
2. **行人相位崗位改人行道斑馬線入口** `KBOT_PED_POST (10.3, 0.30,
   16.8)`(行人走廊外、車阻旁):取代 §9 的路中護送點——比較像真的
   指揮交通的人。行人相位走過去、其餘相位走回停止線旁站位;
   robotOnRoadway 安全閘門保留為安全網(崗位皆在 t≥15.3,不觸發)。
3. **停止線通過語意(過了就讓它走)**:`nextStopLine` 只攔第一道
   停止線;越過即視為進入路口盒,後續停止線/行穿線一路放行,不再
   於路口中間二次攔停。`vehicleOccupiesTransitionConflict` 改為整盒
   佔用(第一道停止線→最後出口+runout),清空/WALK 閘門對盒中行進
   車輛仍安全;生成禁區同步改整盒。實測 all_stop 長停:四類隊伍
   領頭保桿全部精準壓在實畫停止線(-15.26/18.67/-20.29/17.61),
   盒內零滯留。
4. 驗證腳本教訓:車長要按車種取(scooter 2.3/motorcycle 2.5),
   別一律當 4.8 的汽車,否則會把「保桿正好壓線」誤判為突出。

### §10a 側走修正(2026-08-05)

san 回饋機器人「側著走」。根因:simulationRoot 的 z 鏡射把 holder 的
+yaw 共軛成模擬座標的 -α 旋轉,先前朝向公式 atan2(-dx,-dz) 在 ±x 向
路段會差 90°~180°(側走/倒走)。正確關係:facing(α) = (sin α, -cos α)
⇒ 行進朝向 α = atan2(dx, -dz);巷90 面向 -x ⇒ α = -π/2(原 +π/2 反了)。
已以 CDP 截圖驗證:+x 向路段跨步軸=行進軸、巷90 放行面向巷口。
凡在 holder 層做朝向計算,一律用此公式。

## §11 號誌循環/雙斑馬線/月台避讓/秒數設定(2026-08-05)

san 四項需求:紅綠燈要變化、行人別走進公車站、兩邊斑馬線都能走、
秒數可修改。

1. **紅綠燈恢復變化**:「不變化」根因=手勢按鈕進入手動 HOLD(999s)
   後永久鎖定。手動指令改為「插入一個自然時長的相位」——套用設定
   秒數、結束後自動循環繼續(badge 顯示「手動插入」);自動循環開關
   關閉時才維持 HOLD。新增 `__signalStates()` hook;CDP 驗證 90s 內
   五相位齊、flow 有車輛綠燈、ped 有 WALK、all_stop 全紅。
2. **行人穿越重寫(waypoint 制)**:`buildPedestrianCrossing` 50% 直行
   /50% 交錯式。直行走廊內縮 [11.2,14.6] 避開中央公車月台(BusStop_1
   x≥15.3,月台在 t 4.3..7.0/-5.8..-2.1——「行人走進公車站」即穿越
   走廊掃到月台尾端)。交錯式:近側半段(畫線帶內縮)→分向島庇護帶
   t=1.28 沿走→遠側半段;WALK 結束時在島上 `waiting_at_refuge` 等下
   一輪;safeZone(島上腿段+等待)不構成 pedestrianConflict,不擋
   車流放行。lane90 行人閘門改巷口區域(x∈[-13,-1] 且 z>12)。
   回收改 `rollPedestrianCrossing`(重擲路線、沿人行道走去新路緣)。
3. **秒數設定 UI**:模擬控制新增三個輸入(羅斯福路/行人穿越/巷90,
   3–120s),存 `runtime.phaseSeconds`,下一次該相位生效(自動與手動
   插入皆套用);行人尾端進入閘門改按「各自路線到下一安全點所需時間」
   與設定秒數自動調整(min(needS*0.45, duration*0.6))。
4. CDP 第六輪:上述全部+staggered 實際被使用(島上等待+連接段)、
   90s 月台侵入 0 次、秒數 20s 覆蓋生效(倒數 19.6)、手動插入後循環
   43s 內恢復(含淨空排空)。測試新增 6b(交錯式行為:紅燈島上停等
   →下輪走完)。

## §12 月台候車行為/三崗位勤務/高度校正(2026-08-06)

san 三項需求:行人要去公車站等車、機器人要在多個指揮點間移動、
站立高度踩太低。

1. **月台候車**:實測月台面高 0.15、入口動線(BusStop_1 候車帶 t≈5.2
   於直行斑馬線東緣;BusStop_0 候車帶 t≈-3.4 經交錯式行穿線旁的
   SharedCrossingRamp x≈-15.2)。`buildPedestrianCrossing` 機率改
   35% 直行/30% 交錯/20% 東南月台/15% 西北月台;月台路線=斑馬線過去
   →上月台 `waiting_for_bus`(busWaitS 12–37s)→月台入口 refuge 等
   WALK→續行對側。waypoint 新增 y(月台 0.15),行人 `groundY` 漸變、
   mesh y 隨之(月台上不再沉入地板)。月台腿段 safeLeg=不擋車流。
2. **KBot 三崗位勤務**:stand(9.0,0.24,16.35 人行道路緣停止線後)/
   crosswalk(9.8,0.02,8.0 斑馬線護送,行人相位,尾端自動返回)/
   lane90(-0.5,0.24,16.6 巷口)。`kbotDesiredPost()` 依相位決定,
   崗位間以 stand 為樞紐路由,走動中相位變更即改道;lane90 預設 5s
   走不到巷口(走 4m 折返也算移動),秒數調 ≥15s 可到位指揮。
3. **高度校正**:實測人行道 0.215、路面 0、月台 0.15 → 崗位 y=面+0.02
   (原 stand 0.12 浮於路面且低於路緣=「踩到太低」)。
4. CDP 第七輪:120s 內月台出現 waiting_for_bus(22.6,5.2)、非法侵入
   月台 0、機器人 ped 相位到護送點(閘門作動)+返回、lane90 25s 設定
   下到巷口崗位、高度 0.24/0.02 驗證。測試更新:bus_se/bus_nw 路線
   形狀斷言(候車點在月台盒內、危險段前必有 refuge 閘)。

## §13 指揮動線合理化 / 機車轉彎 / 公車靠站 / 黃燈 / 錄影流程(2026-08-06)

san 的需求:①好好檢查機器人指揮交通的動作是否合理;②設計一套可以照著
錄影的流程;③有人要去公車站;④路要能讓機車轉彎;⑤機器人不只在人行道
指揮,也會到行穿線中間,但號誌要換時要躲到公車站或兩側人行道。

備份:`.v3` 後綴(`.orig`/`.v1`/`.v2` 不動)。

### 13.0 稽核結果(全部以 CDP 實測數據佐證,不是讀碼推論)

以改版前的建置連續觀測 96 秒(兩個完整循環),用
`__trafficDirectorDebug.snapshot()` 每 0.5 秒取樣:

| 現象 | 實測 | 判定 |
| --- | --- | --- |
| 全紅空轉 `crosswalk_not_clear` | 19.8s / 96s | **不合理**,佔 21% |
| `intersection_not_clear` | 3.0s / 96s | 同上加總 24% 純空轉 |
| 幹道綠燈 `roosevelt_flow` | 15.9s / 96s(每輪 8s) | **不合理**,幹道綠燈比行人相位短 3 倍 |
| 巷90 放行 | 5.0s / 96s | **不合理**,機器人走到巷口要 11s,永遠走不到 |
| 行人相位機器人動線 | 走 9.9s → 站 3.7s → 走回 9.9s | **不合理**,85% 的時間在走路 |
| 巷90 車輛 | 行駛到 t=14.5 後**原地消失** | **不合理**,車子在路口中間憑空不見 |
| 轉向動線 | 完全沒有 | **不合理**,沒有任何車輛會轉彎 |
| 公車靠站 | 從不停靠 | **不合理**,行人在月台等 12–37 秒等不到車 |
| amber 號誌 | GLB 內有 9 組 amber aspect,`syncSignalAspects` 從未點亮 | **不合理**,資產閒置且無黃燈行為 |
| 碰撞計數 | `runtime.collisions` 全域只被指派 0,從未 +1 | **裝飾用數字**,不具驗證意義 |
| `robotOnRoadway()` | `holder.z < 15.3` | 把中央分向島、公車月台都當成車道,而機器人退場只退回單一站位 |
| 車輛停讓行人 | 規則 JSON 宣告 `vehicle_yield_is_hard_gate: true`,但只做在相位閘門 | 個體層級沒有停讓行為 |

另外用實測標線重新確認:機器人的「行人相位護送點」在 (9.8, 8.0),
直行行穿線畫線帶是 s∈[10.59,16.30] —— **他站在斑馬線外面的車道上**,
並不在斑馬線上。

### 13.1 指揮崗位與避車處(需求 ⑤)

- 崗位 `KBOT_POSTS`:`stand` 人行道 (12.0, 17.15)、`crosswalk`
  **行穿線中央** (15.60, 1.28)、`lane90` 巷口 (-0.5, 17.00)。
  crosswalk 崗位落在實畫行穿線帶內、且刻意避開行人走廊
  (`STRAIGHT_CROSS_CORRIDOR` s∈[11.2,14.6]),行人不會穿過他身體。
- 新增實測路緣線模型 `kerbT(side, s)`(由 `CurbPaint_±1_*` 內插,
  殘差 < 0.1 m)與 `controllerSafeZone(s, t)`:安全區 = 兩側人行道
  (路緣外 0.3 m)或中央公車站月台。**中央分向緩衝帶不算安全區**
  (只有 0.9 m 寬且夾在兩條公車道之間),所以機器人一定得離開。
- `CONTROLLER_REFUGES` 五個避車處:中央公車站月台(東南/西北)、
  兩側人行道、巷口人行道。`nearestControllerRefuge()` 取最近者。
- `robotOnRoadway()` 改用 `controllerSafeZone()` 判定,不再用單一 t 門檻。
- `kbotDutyTarget()` 三條規則:
  1. 崗位只有「走得到 + 站得住 + 回得了避車處」才去
     (去程 + 回程 + `KBOT_POST_MIN_DWELL_S` 4s 必須塞得進相位剩餘秒數),
     否則就在安全處把手勢做完 —— 不再出現「走兩步就折返」。
  2. 車流相位只要人還在車道上,立刻退到**最近**的避車處;已在安全處
     就留守,不再每輪長途折返回固定站位。
  3. 判斷式在移動途中保持成立(去程時間與剩餘時間同步遞減),不會中途掉頭。
- 路線 `kbotRouteTo()`:同側直走;要換邊一律沿行穿線中線 s=15.60 南北向
  穿越,絕不斜切路口。
- 速度:勤務轉移 `KBOT_DUTY_SPEED` 1.35 m/s(進場仍 0.85),
  步態播放速率 `kbotGaitRate()` 依實際速度等比縮放,腳掌不打滑。
- 朝向改為「注視點」制:巷90 相位看巷口 (-7.5, 21.0)、行人相位面向東南
  向來車、其餘面向路面中心線(身體與羅斯福路垂直,兩臂平伸才落在
  「前後停、左右行」的正確方位)。`updateKbotYaw` 加最短角度正規化。
- 輪廓燈/補光燈跟著 holder 移動(舊版釘在固定站位,人一走就變黑)。

實測結果(標準節奏):站位序列
`行穿線旁人行道 → 移動中 → 行穿線中央 → 中央公車站月台`。

#### 13.1a 手勢方位驗證(實測,不是推論)

新增唯讀 hook `__kbotArmOffsets()`,回傳兩支前臂節點
(`visual_id60` = 左前臂、`visual_id25` = 右前臂)相對於 holder 的模擬
座標偏移量。用它驗證 §10a 的鏡射結論與手勢方位:

- `roosevelt_flow`(yaw 0,面向 −t):左前臂在 Δs=−0.38、右前臂在
  Δs=+0.38 ⇒ 兩臂沿 ±s 平伸 = 沿羅斯福路。frame-right = (f_t, −f_s)
  = −s 落在「左」前臂上 ⇒ **z 鏡射確實把模型左右對調**,模型的左手
  在畫面上是右手。兩臂平伸 ⟂ 身體朝向 ⟹ 前後(巷90)被攔、左右
  (羅斯福路)通行,語意正確。
- `lane90_release`(yaw −2.09,面向巷口):招車手(右前臂,y=1.73 抬高)
  偏移 (−0.31, 0.00),與巷口方向 (−0.87, +0.50) 的內積 **+0.87**;
  平伸的攔阻手(左前臂,y=1.41)偏移 (+0.40, −0.21),與巷口方向內積
  **−1.00**。⇒ 招車手朝巷口、攔阻手朝路口,而且因為鏡射,招車那一側
  在畫面上正是機器人的**左側** —— 與規則 JSON 的
  `GO_FROM_LEFT`「左方來車通行」一致。**本輪確認朝向不需要修正。**

### 13.2 巷90 轉向與機車兩段式左轉(需求 ④)

巷90 是單向駛出,出巷後只有兩條合法動線,兩條都刻意避開三條實畫行穿線帶:

- **右轉**:併入東南向最外側車道 (t=12.78)。併入點 = 縱列 s − 2.2,
  必須留在交錯式行穿線正半段之外(車尾 s > −14.0)。
- **兩段式左轉(hook)**:機慢車直行穿越路口進入 `HOOK_BOX` 機車待轉區
  (中心 s=−4.05, t=−11.82,4 個格位),等羅斯福路西北向放行再併入
  最外側車道 (t=−11.82)。直行走廊 `LANE90_HOOK_CORRIDOR_S = −4.6`
  ——硬約束是車尾 s 必須 > −6.74,才不會侵入 stag_neg 行穿線帶。
- 待轉區標線是**執行期加畫**的 runtime 疊加物件(白框 +「機車待轉」
  canvas 貼圖 + 起步箭頭),canonical GLB 不含此標線;UI 有開關可關閉,
  關閉時所有巷90 車輛只右轉。
- 待轉中的車**不**計入 `intersection_not_clear`(那是畫設的停等區);
  正在轉向中的車**計入**(人在路口裡)。
- 併入後的車輛跑到場景盡頭會 `returnToLane90()` 回到自己巷內縱列尾端,
  巷口車流量恆定;不再出現「車子開到一半消失」。
- 巷內改成縱列排隊(每列 2/3/4 台依車流模式),間距 `SIDE_COLUMN_HEADWAY_M`。
- 待轉區滿了的機車會退回巷口停止線續等,不會卡在路口裡。

### 13.3 公車靠站與上車(需求 ③)

- `BUS_DWELL_STOPS`:西北向 s=−36.0(BusStop_0)、東南向 s=21.0
  (BusStop_1),都落在實測候車帶內。公車漸進減速停妥,停留 6–12 秒。
- `advancePedestrian` 新增 `busAtPlatform`:月台候車者只有在**同月台真的
  有公車停靠且就在 9 m 內**時才轉入 `boarding`(藏起來=上車);
  公車開走後回收成新的行人從人行道出現,`busBoardings` 計數。
  等不到車(`busWaitS` 20–48s 逾時)則放棄候車、沿原計畫走完對側。
- 每趟 wrap 之後 `busDwellDone` 重置,下一圈會再靠站一次。

### 13.4 黃燈尾段與空轉時間

- `AMBER_TAIL_S = 3.0`:車流綠燈最後 3 秒,**尚未越過第一道實畫停止線**
  的車開始停等,已進入路口者照 §10 語意走完。
  新增 `vehicleMovementAllowed()` 供車輛運動使用;
  `movementAllowed()`(相位決策與安全閘門)語意完全不變。
- `syncSignalAspects` 點亮 GLB 內既有但從未使用的 amber aspect,
  並改為每個 UI tick 重算(黃燈發生在相位中途)。
- 效果實測:全紅空轉由 23.8s / 96s(24%)降到 19.0s / 100s(19%),
  其中幹道綠燈由 8s/輪 提高到 24–32s/輪。**剩餘空轉的成因已查明且屬
  幾何本質**:這個路口兩條行穿線相距約 32 m,一輛剛過第一道停止線的車
  必須橫越整個 40 m 路口盒才會讓三條行穿線同時淨空,約需 6 s;
  要再壓低只能讓車停在兩條行穿線之間(=san 先前反映的「卡在路口中央」),
  因此保留現況並記錄之。

### 13.5 車輛個體停讓行人

`pedestrianYieldDistance()`:已在路口內行進的車遇到自己車道前方 24 m
內、橫向 2.2 m 內的穿越行人,依距離漸進煞停(留 1.8 m)。這才真的落實
規則 JSON 的 `pedestrian_behavior.vehicle_yield_is_hard_gate`。
轉向中的巷90 車輛則由 `turnPathBlocked()` 對 4.5 m 內的行人停讓。

### 13.6 碰撞計數改成真的

`detectCollisions()`:同車道保桿重疊、以及車輛掃到站在車道上的機器人,
同一組只在事件開始時計一次(`activeCollisionKeys`)。reseed / 換車流模式
會歸零。實測 100 秒三種模式恆為 0。

### 13.7 呈現與錄影支援

- 相機新增 `crosswalk` / `hook` / `busstop` 三個預設;`robot` 預設改為
  以 holder 現在位置推算(機器人會移動)。
- 新增 **錄影模式** 開關(隱藏右側面板、畫面滿版,並重算 renderer 尺寸)。
- 新增 **相位節奏** 預設 `PACING_PRESETS`:快速 16/14/10、
  標準 24/24/16(預設)、錄影 32/30/22。Blender demo_timeline 的原始秒數
  (8/25.5/5)保留為 fallback。
- 面板新增「待轉中」「上車人次」與 KBot 目前站位標籤。
- 驗證 hook 新增 `__lane90States()`、`__busStates()`,
  snapshot 增 `kbotMotion.safeZone / station / dutyTarget`、
  `busBoardings`、`pedestrianStates`。
- 錄影分鏡與操作流程另見 `RECORDING_PLAN.md`。

### 13.8 已知限制

- 「標準」節奏下巷90 只有 16 秒,機器人從中央公車站月台走到巷口約需
  20 秒 → 他會留在月台做招車手勢(這是刻意的:走不到就不假裝走)。
  要拍他站在巷口指揮請用「錄影」節奏或把巷90 秒數調到 ≥22。
- 待轉區標線非實景量測所得,屬模擬加畫。
- 規則 JSON 的 `controller_yaw_deg` 自 §8 起即未使用,本輪仍不動它
  (不改規則語意);朝向一律由注視點推算。

## §14 錄影分鏡實拍驗收(2026-08-06)

把 `RECORDING_PLAN.md` 的八個 Shot 逐個在瀏覽器裡真的操作一遍,檢查文件
宣稱的畫面內容是否真的會發生。驗收腳本 `mujoco/verify_recording_shots.mjs`
(headless Chrome + CDP,port 9335)走的是**使用者會按的路徑**——相機按鈕、
手勢按鈕、面板開關都用真的 DOM 事件觸發——斷言則讀唯讀驗證 hook。
產物:`mujoco/verify_shots/shot*.png`(八張分鏡截圖)與
`mujoco/recording_shots_report.json`。

    python3 serve.py --port 8124 --directory . &
    node mujoco/verify_recording_shots.mjs

### 14.1 巷90 待轉區死結(真的 bug,已修)

第一輪就撞到:按「左方來車速行」讓機車進待轉區,再按「兩臂左右平伸」,
相位**永遠停在「路口清空」**,決策面板顯示 `intersection_not_clear`,
待轉區永遠不會釋出。實測現場狀態:

    lane90-0  hook  hook_wait  slot 0  (-3.20, -11.10)  v=0
    lane90-1  hook  turning    slot 1  (-4.38,  -9.41)  v=0   ← 卡死
    lane90-3  hook  turning    slot 2  (-4.60,  -7.60)  v=0   ← 卡死

成因是 `turnPathBlocked()` 把「已停進待轉格的車」當成一般前車,沿用跟車
距離(半車長＋半車長＋1.6 m ≈ 4.1 m)當淨空門檻;但四個待轉格彼此只相距
1.5–1.7 m,所以**後到的騎士永遠到不了自己的空格**,停在路口中央、
`turnState` 一直是 `"turning"` → `intersectionConflict()` 恆真 →
清空相位永遠等不到淨空 → 羅斯福路永遠不會綠 → 待轉區永遠不釋出。
四項互鎖,是硬死結,不是暫時壅塞。

修法兩件:

1. `HOOK_BOX_FILL_ORDER = [1, 3, 0, 2]`:待轉格改「離巷口最遠的那排先填」。
   原本 0,1,2,3 的順序下,後到者前往自己格位的路徑最近會經過已停妥車輛
   **0.12 m**(等於直接輾過去);改成遠排優先後最近距離是 **1.50 m**。
2. `HOOK_PARKED_CLEARANCE_M = 1.2`:停在待轉格的車改用「車體淨空」判定,
   不用跟車距離。1.50 m > 1.2 m ⇒ 幾何上保證不會再互相擋死。

回歸測試加在 `mujoco/test_v4_direction_and_turns.mjs`(3b):對填格順序的
每個前綴,計算前往下一格的路徑與所有已佔用格位的最近距離,必須 ≥
`HOOK_PARKED_CLEARANCE_M`。把順序改回 0,1,2,3 這個測試會失敗(已實測)。

### 14.2 兩個相機機位重拍(實拍才看得出來)

- **行穿線**:舊機位 (25.5, 6.2, 19.5) 在水源市場側,視線要穿過東南向
  排隊車陣與中央公車站候車亭。行人相位時 KBot 站在行穿線中央,畫面上
  **幾乎總是被公車或排隊車擋住**——而 Shot 3 的主角就是他。改到對側
  (26.0, 8.0, -8.0),視線只跨過空路面,機器人穩定落在畫面中央。
- **公車站**:舊機位 (31.0, 6.8, 17.5) 左三分之一被建物擋掉、正中被燈桿
  切開,靠站公車只露一角。改成從路面上方俯看月台 (30.0, 11.0, 10.0)、
  注視點 t = 月台列的一半,車門側與候車者全部露出。

### 14.3 分鏡表本身要改的地方

- **Shot 4 要換相機**。退場終點是中央公車站月台,而新的行穿線機位看過去
  正好被停靠中的公車擋住(月台本來就是公車會停的地方)。改成相位剩約
  9 秒時切「公車站」相機,才拍得到「他站在月台上、車流這時才放行」。
- **Shot 2 的「煞停」要用尖峰模式**。一般模式 32 秒綠燈常常在黃燈尾段前
  就把隊伍排空,實測有時尾段畫面**一輛煞停的車都沒有**(amber 一定會亮,
  這點恆真)。
- **Shot 7 要先跑一輪行人相位**。月台候車者是「穿越到月台」才會出現;
  直接切到公車站等,月台是空的、公車靠站也不會有人上車。補一輪行人相位
  之後,實測 `busBoardings` 0 → 1。
- Shot 3 的「行人停在中央庇護帶等下一輪」是機率事件,四輪驗收裡都沒出現
  (`waiting_at_refuge` 恆為 0),不要寫成必然畫面。

### 14.4 驗收腳本自己踩到的兩個坑(留給後人)

- 面板數字與安全閘門文字是 `uiUpdateHz`(高效能 8 Hz)更新的,和
  `snapshot()` 同一個 JS turn 讀會差一拍。比對 DOM 與 runtime 前要先等
  一個 UI tick(400 ms),否則會得到「待轉中顯示 0、實際 1」這種假失敗。
- 手勢按鈕是**請求**不是命令。要驗證「按下去之後發生什麼」,必須先確認
  相位真的變成 active,否則量到的是安全閘門把請求擋掉(Shot 8 才是在
  示範這件事)。Shot 8 想示範的 `downstream_not_clear` 在決策優先序的
  最後一位,要等其他閘門(行人衝突、行穿線淨空、路口淨空)全部通過的
  空窗才送出請求。

### 14.5 新增診斷 hook

`window.__conflictVehicles()`:列出此刻讓 `intersectionConflict()` 為真的
車輛(id/型別/turnState/位置/速度)。「清空相位一直等不到淨空」時,這是
唯一能指認兇手的資料——14.1 的死結就是靠它一次定位的。

## §15 控制面板分組化 / 待轉區預設關閉 / 上車動線(2026-08-16)

san 的三點回饋:「參數調整地方請直觀一點」「為什麼有待轉格,刪除它」
「會有人上公車人會消失」。備份 `.v4`(html/css/js)。

### 15a 控制面板改成四組

原本「模擬控制」是十列平鋪的 `switch-row`,號誌秒數、車流、畫面、測試
開關全混在一起,而且三個相位秒數是裸 `type=number`,看不到 3–120 的
範圍也看不出目前落在哪。改成四個 `.param-group` 卡片:

| 群組 | 內容 |
| --- | --- |
| 號誌節奏 | 自動循環、節奏預設(分段按鈕)、三個秒數滑桿 |
| 車流 | 車流量(分段按鈕)、重新產生、人車組成 |
| 畫面與效能 | 高效能渲染、動作效果、錄影模式 |
| 進階／驗收用(`<details>`,預設收合) | 下游堵塞測試、機車待轉區 |

兩個 `<select>`(`#trafficDensity` / `#pacingPreset`)換成一眼看得到三個
選項的分段按鈕,但 **DOM 上的 `<select>` 保留**,只是用 `.mirror-select`
移到視覺外並由 `bindSegmented()` 雙向繫結:按鈕 → 寫 `select.value` 再送
`change`;`select` 被外部改值(驗收腳本的 `setSelect` 就是這樣做)→ 回頭
同步 `is-active`。三個秒數改 `type=range` + `<output>` 即時讀數,
`input`/`change` 兩個事件都 commit,`applyPacingPreset()` 改完值後呼叫
`syncDurationOutputs()`。因此 `verify_recording_shots.mjs` 與
`record_demo_video.mjs` 的 `setSwitch/setSelect/setNumber` 全部不用改。

### 15b 機車待轉區預設關閉

待轉區方框是 viewer 執行期加畫的標線(`buildHookTurnBox()`),實景 GLB
沒有這組標線,§13 加它是為了演示兩段式左轉。san 要求移除,改成:HTML
checkbox 預設 unchecked、`applyHookTurnSetting()` 統一收斂三件事(runtime
旗標、加畫標線可見性、「待轉中」計數 chip 的 hidden),巷90 機慢車一律
右轉。相機列的「待轉區」標籤改「巷90」(`data-camera="hook"` 保留)。

功能碼與 §14 的死結修正(`HOOK_BOX_FILL_ORDER` / `HOOK_PARKED_CLEARANCE_M`)
與 `test_v4` 3b 回歸測試都留著——`verify_recording_shots.mjs` 的 Shot 5/6
會自己 `setSwitch("hookTurn", true)` 把它打開驗收。要徹底刪掉整個功能,
得連同那兩個 Shot 與 `test_v4` 的 hook 段一起拿掉。

### 15c 上車不再原地消失

原本 `state === "boarding"` 一進去 viewer 就 `mesh.visible = false`,人是在
候車位置憑空不見的;nw 月台候車帶 x∈[-44,-28] 而停靠點 s=-36,最遠站位
離車門 8 m,看起來就是瞬間消失。

改法:`advancePedestrian` 多收一個 `busDoorS`(呼叫端從實際停靠的公車
mesh 量出來),進 `boarding` 時記下 `boardTarget = {s: busDoorS, t: 現在的 t}`
(沿月台走,不進車道),之後每格朝目標前進,距離 ≤ `BUS_BOARD_ARRIVE_M`
(0.35 m)才 `boarded = true`。viewer 只在 `boarded` 之後才隱藏 mesh;
`animatePedestrianMesh` 把「boarding 且未 boarded」也算 moving,所以那段是
走過去不是滑過去。走到一半公車開走 → 退回 `waiting_for_bus` 等下一班
(或逾時續行對側)。`recyclePedestrian()` 補清 `groundY / boarded /
boardTarget`——從月台回收的人還帶著 0.15 的月台面高,不清會浮在人行道上。

新 hook:`window.__pedestrianStates()`、`window.__hookBoxVisible()`。

### 15d 驗收

三套 node 測試(`test_lane_rules` / `test_viewer_v3_geometry` /
`test_v4_direction_and_turns`)全過。headless CDP 冒煙:待轉區預設關閉且
場上 0 台走待轉動線、分段按鈕與 `setSelect` 雙向同步、滑桿讀數同步、節奏
預設更新三個讀數(32/30/22)、有人成功上車且上車前確實有走到車門的過程、
零 console error。改完記得跑 `mujoco/stamp_versions.py`。

## §16 KBot 站位/走位/指揮修正:真的站在斑馬線上、不再躲進公車站(2026-08-17)

使用者原話三點:「機器人走路很奇怪都沒有在斑馬線上面」、「他也沒有去做
指揮交通」、「他指揮交通的位置很奇怪,應該是要在斑馬線中間去做,而不是
在公車站裡面」。三點都是同一個根因鏈。

### 16a 根因:舊崗位根本不在畫線上

用新 hook `window.__paintedNodeBounds()` 把實景 GLB 的 28 條
`GongguanV50_MainCrosswalk_Straight656_Stripe_*` 換算回模擬座標,實測:

- 條紋只存在 t∈[-14.27, -1.73] 與 t∈[2.52, 15.06];中間 4.25 m
  (t -1.73..2.52,BRT 中央分向島)**完全沒有畫線**。
- 舊 `KBOT_POSTS.crosswalk = (15.60, 1.28)` 正好落在這段空白帶正中央,
  離最近畫線邊緣 1.24 m ——他從來沒站在斑馬線上。
- 分向島依 `controllerSafeZone()` 定義不是安全區,所以每一輪都被安全閘門
  趕走;`nearestControllerRefuge` 又永遠選中 4.54 m 外的東南月台
  → 實測一輪 65.7% 的時間站在公車停靠格裡,而且被車廂完全遮住。
- 舊穿越中線 `KBOT_CROSS_S = 15.60` 太靠東:+t 半段 14 條條紋裡有 9 條的
  `sMax` 小於 15.60,走位有大半不在畫線上。
- `lane90` 崗位實測 300 s 內 0 秒到位:從月台走過去要 21.9 s,塞不進 16 s
  的相位,`remaining > budget` 恆假。
- 手勢幅度太小:`gesture_spec.json` 的 cycles 幅度只有 0.0349 rad(2°),
  行人相位左手位移 p-p 僅 24.6 mm ≈ 身高的 1.6%,看起來就是一尊雕像。

### 16b 改法

1. **崗位**(`traffic_director.js`):
   `crosswalk` (15.60, 0.02, 1.28) → **(15.00, 0.02, 8.33)**
   = Stripe_20 中心(t∈[8.06,8.60])上、s 在該條紋 [10.78,15.64] 內,
   東緣裕度 0.64 m;`stand` x 12.0 → **15.0**,與 crosswalk 同一條 s,
   於是 `KBOT_CROSS_S` 自動變 15.00(t≥6 的每條條紋都覆蓋 s≤15.45),
   而且整段退避是沿畫線正北直走 8.82 m,不再橫切任何公車道。
2. **避車處**(`traffic_simulation_core.mjs`):`CONTROLLER_REFUGES` 移除
   `platform_se` / `platform_nw`(月台仍是 `controllerSafeZone` 認定的安全
   區,只是不再是主動退避目標);`sidewalk_pos` 移到 (15.0, 17.15) 與
   `stand` 崗位重合,退避與崗位變同一點。
3. **勤務狀態機** `kbotDutyTarget()`:
   - 其餘相位由 `return null`(原地不動)改成 `return KBOT_POSTS.stand`
     ——這是「他永遠停在第一次退避的地方」的直接原因。
   - `lane90_release` 加 `|| kbotNear(post, 1.0)`:到崗後留守到相位結束
     (巷口人行道本來就是安全區),回程留給下一個相位,否則只站得住 0.5 s。
   - `KBOT_POST_MIN_DWELL_S` 4.0 → 3.0(巷90 預算 11.5+3.0=14.5 < 16 s)。
   - `kbotTravelTimeS()` 改成沿 `kbotRouteFrom()` 折線累加(舊版用直線距離,
     對要換邊的路線最多低估 6.2 s);`kbotRouteTo()` 改成它的薄包裝。
4. **手勢幅度**(`mujoco/gesture_spec.json` → 重跑 MuJoCo 管線):
   實測手部靈敏度是 肩 ≈400 mm/rad、肘 ≈131 mm/rad、腕 ≈0(手掌 geom 就在
   腕軸上),所以主擺動一律搬到肩關節,幅度 0.30–0.40 rad、週期 2.0–2.4 s;
   少數 base 角度微調(如右肩 pitch -3.1416 → -3.05、肘 0.2 → 0.55)讓對稱
   擺動留在行程內。`run_gesture_sim.py` 仍 PASS(rms 0.0122 rad、自碰撞 0、
   腳位移 0.054 mm),`bake_glb.py` + `verify_motion.py` 全過。
5. **相機**:`crosswalk` 機位 (26.0, 8.0, -8.0)/target z 寫死 1.28 →
   **(12.0, 6.0, -4.0)**、target 直接讀崗位座標。視線在 s≈13.7 跨過公車道
   (月台起點 s=16.2 以西),不再被停靠中的公車擋住。
6. **行人走廊**:`STRAIGHT_CROSS_CORRIDOR` sMax 14.6 → `{11.44, 13.15}`
   ——實測被月台切短的三條條紋只畫到 s≈13.15,舊值讓行人走出畫線 1.4 m;
   收斂後也與 KBot 的 s=15.0 留出 1.85 m,行人不會穿過指揮者身體。

### 16c 實測(CDP headless,標準節奏,148.5 s 有效模擬時間)

| 指標 | 改版前(§15 診斷) | 改版後 |
| --- | --- | --- |
| 站在公車站月台 | 66.3–106.5 s(43–66%) | **0.0 s(0%)** |
| 站定(非移動中) | 22.8 s(14.1%,其餘在月台罰站) | **78.1 s(52.6%)** |
| 行穿線崗位單次駐留 | 2.0 s | **7.9 s** |
| 巷90 崗位 | 0.0 s(0%) | **8.9 s(6.0%,兩輪都到位)** |
| 在車道上時 s 落在該 t 的畫線帶內 | 崗位本身就不在畫線上 | **90.1%**(其餘 16 筆是 t 15.6–16.8,亦即最後一條條紋 t=15.06 與路緣 t=16.63 之間那段本來就沒畫線的路面) |
| 站定窗手掌位移 p-p | 左 24.6 mm / 右 90.6 mm | **左 195–263 mm / 右 192–262 mm**(GLB 端 275–360 mm) |
| 走位中線 s | 15.60(9/14 條踩不到) | **15.00,實測在車道上的每一筆 s 都是 15.000** |

安全閘門未放寬:`robotOnRoadway()` / `pedestrianConflict()` 照舊,
`verify_recording_shots.mjs` Shot4 仍量到「KBot 於車道護送中」且
`pedestrianConflict === true`,退避完成後才解鎖。

### 16d 驗收

三套 node 測試全過(`test_v4` 的 POSTS 鏡像與 1d 斷言同步更新,新增
「月台不得出現在 CONTROLLER_REFUGES」與「退避是沿同一條 s 的軸向退場」
兩條);`verify_recording_shots.mjs` 8 個 Shot 全過(Shot3 station=行穿線
中央 @ (15, 0.02, 8.33)、Shot4 退避到 行穿線旁人行道 @ (15, 0.24, 17.15));
`run_gesture_sim.py` / `bake_glb.py` / `verify_motion.py` 全過;
改完跑 `mujoco/stamp_versions.py`。新增唯讀 hook:
`window.__paintedNodeBounds(pattern)`(畫線帶換算回模擬座標)、
`window.__kbotHandOffsets()`(手掌偏移;`__kbotArmOffsets` 讀的是前臂 mesh
原點=手肘樞紐,量手勢幅度會嚴重低估)。

---

## 17. 人與車的擬物化(V54 viewer · 本節)

需求(san):「這個裡面人有沒有辦法擬物化一點」「我汽機車以及公車也需要
擬物化」。行人的程度由 san 指定為「導入外部 rigged 人物 GLB」。

### 17a 設計前提:限制在 draw call,不在三角形

§15 的效能稽核實測(Apple M4 / 1920×1080 / pixelRatio 1 / 尖峰 63 個 actor):
每多一個 draw call 約 1.36 µs(共用材質)/ 1.85 µs(獨立材質);三角形
在這個規模下 ≤ 0.7 µs/千面,幾乎免費。改版前 987 個 actor mesh 只畫出
49 k 三角形,等於「零件多、細節少」——最差的組合。

所以擬物化的做法是**面數放開、零件數收斂**:

* 每台車的靜態零件在 module 內依 `(type, bodyVariant, riderVariant)` 先
  合併成最多 4 份 `BufferGeometry` —— `body`(車身色,逐車換材質)、
  `trim`(金屬/塑件/騎士)、`glass`(玻璃)、`lamp`(燈)。同型同版的車
  完全共用同一份幾何。
* `trim` / `glass` / `lamp` / `wheel` 一律用**頂點色**,全域各只有一份材質。
* 只有車輪維持獨立 mesh(要繞軸轉),幾何依 `(kind, radius, width)` 快取;
  公車後軸用 `kind="dual"`,雙輪合併在同一份幾何裡,仍是 1 個 draw call。
* 接地陰影共用一份 `CircleGeometry` + 一份材質(改版前是每個 actor 各 new)。
* 合併後的幾何一律標 `userData.sharedRuntimeResource = true`,`clearActors()`
  reseed 時不得 dispose。

### 17b 行人:外部 rigged GLB

`viewer/models/pedestrian_walker.glb`(CC-BY-4.0,改作自 Khronos
glTF-Sample-Assets 的 Cesium Man;上游商標貼圖已移除)。授權/來源/修改
清單在 `viewer/models/ASSETS.md`,CC-BY 要求的姓名標示顯示在面板的
「台灣規則與來源」區塊(`.asset-credit`)。

* 複製用 vendored `SkeletonUtils.clone()`(`Object3D.clone()` 不會重新綁骨架)。
* **5 個 primitive 併成 1 個 SkinnedMesh**:GLB 的 5 個 primitive 共用同一
  組 accessor(POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0 完全相同),
  只有 index 不同,所以接上同樣的屬性、把 5 段 index 串起來即可,頂點數
  與三角形數完全不變(3419 verts / 4672 tris),draw call 由 5 降為 1。
* 換色走**調色盤貼圖**:`TEXCOORD_0` 已被烘成 8 格調色盤座標
  (`u=(區塊序號+0.5)/8`,順序 skin=0 / hair=1 / shirt=2 / pants=3 /
  shoes=4),逐人建一張 8×1 `DataTexture`(**必須 NearestFilter**,否則
  相鄰格會內插出髒色)。整套穿搭(`PEDESTRIAN_OUTFITS`)而非各部位獨立
  亂數,膚色/髮色另外解耦。
* 身高 1.58–1.78 m 隨機(原模型 1.5066 m,腳底恰在 y=0,不需墊高偏移)。
  身形亂數走 `pedestrianVariantHash(index, salt)`,**不動** runtime 的
  mulberry32 串流——動了會讓既有驗收腳本裡的車輛/行人配置整批位移。
* 步態:`Walk` / `Idle` 兩支 clip 同時 play,用權重交叉淡入(0.25 s)切換;
  硬切會因為 Idle 站姿比 Walk 平均高 3.5 cm 而跳動。
  **`walk.timeScale = pedestrian.speed / 0.754`**(0.754 m/s 是實測踩地腳
  相對根部的後退速度),腳才不會打滑;起始相位逐人隨機,否則會踢正步。
* `runtime.reducedMotion`(關掉「動作效果」)時 `mixer.update(0)`,凍在 Idle。
* **Fallback**:GLB 載入失敗或缺動畫時 `console.warn` 並退回原本的程序化
  積木人(`proceduralPedestrianMesh()`),模擬不中斷 —— 只有 KBot 是
  fail-closed,行人不是。

### 17c 車輛輪廓

* **car**:引擎蓋斜度 + 行李廂蓋、上收的車室(A/C 柱傾角)、後傾擋風玻璃 +
  後窗、前後各一片側窗(中間留 B 柱)、四個有輪圈與五爪輻條的輪子、
  輪拱襯、後視鏡(支架 + 鏡殼)、前後保險桿、水箱罩、車牌、頭燈(暖白)/
  尾燈(紅)。四種車體版型(hatch / sedan / wagon)。
* **bus**:車身分四節(深色裙板 → 車身色下段 → 腰線飾帶 → 淺色上段 + 頂蓋
  收邊)、每側 8 片車窗 + 前擋 + 後窗、**兩道車門一律開在 local −z 側**
  —— NW 車道(direction +1、rotation.y 0)對到 t=−3.4 的月台,SE 車道
  (direction −1、rotation.y π)對到 t=+5.2,兩者的月台都落在 local −z;
  車頂空調、長臂後視鏡、前單後雙的六輪配置。車高 3.24 m(汽車約 1.5 m)。
  路線牌是**空白琥珀色面板**,沒有號碼也沒有商標(§14 成品清場規則)。
* **scooter**:踏板穿越式車架、前護腿板(最好認的輪廓)、平座墊、尾箱、
  前叉、龍頭與握把、後照鏡、排氣管。
* **motorcycle**:外露引擎與汽缸、油箱、倒立前叉、後搖臂、排氣管與尾管、
  圓形頭燈、後照鏡;軸距與輪徑都比速克達大,騎士前傾角 0.30 rad。
* **bicycle**:主三角(上管/下管/立管)+ 後三角、鋼絲輻條輪(10 根)、
  大盤/曲柄/踏板、後貨架,騎士前傾 0.42 rad。
* 騎士是程序化的(合併進 `trim` 桶,**不增加任何 draw call**):有肘/膝
  分節、全罩安全帽(機車/速克達)或通風帽(自行車)、依車種調整前傾角。
* 顏色沿用既有 10 色車身 palette(不鮮豔),trim/glass/lamp 走頂點色。

### 17d 實測(CDP headless,Apple M4 ANGLE Metal,1920×1080,尖峰車流 +
高效能渲染,63 個 actor:car 14 / scooter 17 / motorcycle 5 / bus 3 /
bicycle 4 / 行人 20)

| 指標 | 改版前(.v6 備份) | 改版後 |
| --- | --- | --- |
| 場景 draw calls(中位數) | 3349 | **2849(−500,−15%)** |
| actor mesh 總數 | 987 | **371** |
| actor 三角形總數 | 49,472 | **185,216(3.7×)** |
| actor 專用材質數 | 1017 | **35** |
| car mesh / tris | 16 / 380 | **9 / 1,476–1,488** |
| bus mesh / tris | 28 / 524 | **9 / 1,852** |
| scooter mesh / tris | 17 / 1,156 | **7 / 2,352** |
| motorcycle mesh / tris | 17 / 1,332 | **7 / 2,792** |
| bicycle mesh / tris | 20 / 1,312 | **6 / 2,764** |
| pedestrian mesh / tris | 11–12 / 548–560 | **2 / 4,692** |
| measuredFps(min/中位/max) | 37.4 / 40.0 / 42.0 | **38.4 / 40.0 / 43.0** |
| console error | 0 | **0** |

FPS 不動是預期的:§15 已經指出 `measuredFps` 被 `animate()` 的
`minimumFrameIntervalMs = 1000/60 = 16.667 ms` 門檻對上 16.7 ms 的 rAF
間隔卡在 ~40,與負載無關。**這次沒有動那個門檻**(不在本次需求內),
所以要看的是 draw call:少了 500 個、依實測 1.36 µs/call 約回收 0.7 ms,
而多出來的 136 k 三角形依實測 ≤ 0.7 µs/千面約只花 0.1 ms。

步態驗收(`window.__pedestrianGait()`):20/20 `strideRatio == 1.000`
(不打滑)、20/20 動畫時間軸有推進、20 個相異起始相位(不踢正步);
穿越中(state=crossing)實測 `walkWeight` 淡入到 1.000、`walkTimeScale`
= 1.923 = 1.45 ÷ 0.754;關掉「動作效果」後 20/20 凍結且 `walkWeight == 0`
(Idle 站姿)。reseed ×3 + 密度切換 + 渲染模式切換各一輪,console error 0,
共用幾何沒有被 `clearActors()` dispose 掉。

### 17e 新增/變更的驗收 hook

* `window.__actorRenderAudit()`:逐 actor 的 mesh 數(= draw call)、三角形、
  共用幾何/材質數、行人走的是 `rigged-glb` 還是 `procedural-fallback`。
* `window.__pedestrianGait()`:每個行人的 `walkWeight` / `walkTimeScale` /
  `walkTime` / `strideRatio`(= timeScale × 0.754 ÷ 實際速度,偏離 1 就是打滑)。
* `window.__renderStats()` 加上 `triangles`(既有欄位不動)。
* 既有 hook 與 DOM 選擇器全部未動;`userData.wheels[].{pivot,radius}`、
  `userData.limbs`(fallback 才有)、`userData.visualParts`、
  `userData.actorType` 的契約都保留。

### 17f 收尾

新增可重跑的預算驗收腳本 `mujoco/verify_actor_budget.mjs`
(紅線:尖峰 63 個 actor 時 drawCalls 中位數 ≤ 2900、measuredFps 中位數
≥ 40、console error 0、行人 strideRatio == 1.000)。
`mujoco/stamp_versions.py` 的 `js_references` 新增
`models/pedestrian_walker.glb`(不加的話瀏覽器會吃到舊快取)。
備份:`traffic_director.js.v6` / `traffic_simulation_core.mjs.v6`
(`.orig` 與 `.v1..v5` 未觸碰;`traffic_simulation_core.mjs` 本次其實沒改)。
三套 node 測試與 `verify_recording_shots.mjs` 8 個 Shot 全過。

## §18 頁面內即時調 KBot 崗位(2026-08-17)

需求(san):「未來能在頁面裡直接調機器人位置」——控制面板裡即時調整,
拖了就看到 KBot 移動,調好的值可以匯出貼回原始碼。

### 18a 放在哪、怎麼操作

控制面板「模擬控制」區,新增第四張卡片
`<details class="param-group advanced-group" id="kbotPostGroup">`
「機器人崗位微調」,位置在「畫面與效能」之後、「進階／驗收用」之前,
**預設收合**。選這個形狀而不是塞進既有的「進階／驗收用」:它是一組會長
出六個控制項的獨立主題(開關 + 崗位選擇 + 三條滑桿 + 兩顆按鈕 + 判定列),
擠進既有的進階區會把「下游堵塞測試 / 待轉區」兩個開關淹掉;但它終究是
校正工具而非日常控制,所以用 `<details>` 收起來,展開才佔版面。

操作:
1. 開「崗位預覽」(`#kbotPostPreview`,預設關)。開啟後場上出現三個崗位
   標記(環 + 立柱;選中的崗位只留環,因為 KBot 本人就站在上面),
   並且 KBot 立刻被釘到選中的崗位。
2. 用分段按鈕挑崗位(`#kbotPostSegmented` / 隱藏鏡像 `#kbotPostTarget`,
   值 `stand` / `crosswalk` / `lane90`)。
3. 拖三條滑桿:`#kbotPostS`(縱向 s,−20..26)、`#kbotPostT`(橫向 t,
   −18..18)、`#kbotPostY`(站立面高度,0..0.4),step 一律 0.01
   ——step 0.05 會讓 `crosswalk.z = 8.33` 這種預設值被 range 元素對齊到
   8.35 而悄悄改掉。拖曳當幀 KBot 就移動(不等下一個相位、也不走路)。
4. `#kbotPostVerdict` 即時顯示四個 pill:安全區判定
   (`controllerSafeZone`;null → 紅色「在車道上 — 實跑會鎖住羅斯福路
   放行(HOLD)」)、是否在 `CROSSWALK_BANDS` 畫線帶上(落在 t −1.73..2.52
   會另外標成紅色「BRT 中央分向島」,§16 的無畫線空白帶)、是否擋在
   `STRAIGHT_CROSS_CORRIDOR` 行人走廊上、最近避車處與距離。
5. 「複製設定」(`#kbotPostCopy`)把三組座標輸出成可直接貼回
   `KBOT_POSTS_DEFAULT` 的字面量,走 `navigator.clipboard.writeText`;
   失敗(或無權限)就展開 `#kbotPostExport` textarea 並全選讓人自己複製。
6. 「還原預設」(`#kbotPostReset`)回到 `KBOT_POSTS_DEFAULT`。

**安全閘門刻意不放寬**:把崗位拖到車道上,`robotOnRoadway()` 就是 true,
羅斯福路放行照樣被鎖成 HOLD。需求寫的是「不要禁止,顯示出來讓他自己
判斷」,所以面板用紅 pill 明說後果,而不是在閘門開後門。預覽開啟時
`#safetyLocks` 另外掛一條「崗位預覽中:KBot 暫離勤務」,交代他為什麼
不跟著相位走。

### 18b KBOT_POSTS 由凍結常數改成執行期可調

原本 `KBOT_POSTS` 是 `Object.freeze`,而且被三種衍生值抄走過:
`KBOT_STAND`(別名)、`KBOT_CROSS_S`(純量)、`KBOT_ENTRY_PATH`(陣列)。
改法是「就地改欄位、永不換物件」:

* `KBOT_POSTS_DEFAULT` 仍然全凍結,當還原與匯出的對照基準。
* `KBOT_POSTS` 改成三個可變 post 物件,識別在整個生命週期固定,所以
  `const KBOT_STAND = KBOT_POSTS.stand` 這個別名讀到的永遠是最新值。
* 抄不動的兩個改成函式:`kbotCrossS()`(取代 `KBOT_CROSS_S`)、
  `kbotEntryPath()`(取代 `KBOT_ENTRY_PATH`)。
* 其餘 12 個引用點本來就是「呼叫當下才讀 `KBOT_POSTS.<id>.x/z`」
  (`kbotDutyTarget` / `kbotStationLabel` / `setCamera` 的 crosswalk 機位 /
  `initThree` 的 kbotRim・kbotFill 一次性快照),不必動。

`LANE90_MOUTH`(巷90 招車的注視點)維持常數:它是注視點,不是崗位。

### 18c 預覽的行為

`updateKbotWalk()` 開頭加一段:`runtime.kbotPostPreview` 為 true 時把
holder 直接 `position.set()` 到選中崗位、清掉 walk targets 並回傳
(拖曳中一步步走會抖,而且看不出座標)。關掉預覽後下一幀就回到
`kbotDutyTarget()` 的常規決策,他會自己「走」回去——實測關掉預覽後把
stand 崗位挪回 15.0,`walkKind` 變成 `duty` 並走到定位。

沒有預覽時改崗位也是有效的:`kbotDutyTarget()` 每幀讀最新座標,
`updateKbotWalk` 的 duty 改道邏輯會在下一幀重新規劃路線。

### 18d 新 hook 與腳本

* `window.__kbotPosts()` → `{ posts, defaults, selected, preview, verdict }`
* `window.__setKbotPost(id, { x, y, z })`、`window.__selectKbotPost(id)`
  (走隱藏 `<select>` 的 change,分段按鈕的 is-active 會一起對上)、
  `window.__setKbotPostPreview(bool)`、`window.__resetKbotPosts()`
* `window.__kbotPostExportCode()` → 匯出片段字串
* `snapshot().kbotMotion` 新增 `postPreview` / `postEditId` / `posts`
* 新增可重跑驗收 `mujoco/verify_kbot_post_tuner.mjs`(27 條斷言:預設
  三組座標未被動、預覽預設關、卡片預設收合、拖滑桿時 `__kbotProbeWorldPos`
  與 holderPosition 跟著變、三種判定文字、匯出片段能被 `node --check`
  解析、還原預設、關預覽後 duty 接手、既有 DOM id 與 hook 全在、
  console error 0)。

### 18e 收尾

改完 `traffic_director.js` / `.html` / `.css` 後跑
`python3 mujoco/stamp_versions.py`。備份 `traffic_director.js.v7` /
`.html.v6` / `.css.v6`。三套 node 測試與 `verify_recording_shots.mjs`
8 個 Shot 全過,console error 0。

**注意**:匯出片段只是文字,不會自動寫回原始碼。真的採用新座標時,
除了貼回 `KBOT_POSTS_DEFAULT`,還必須同步
`mujoco/test_v4_direction_and_turns.mjs` 的 `POSTS` 鏡像與本文件的座標表
(匯出片段的註解裡已經寫了這件事),否則 node 測試會綠著騙人。

## §20 3D Viewport 相機系統(2026-08-18)

被動的 3D 視圖升級成可操作的 Viewport:模式、平滑過渡、Focus/Frame、
防穿模護欄。**不換相機函式庫**——沿用已 vendor 的 three r170
`OrbitControls`,在它之上加一層 `cameraDirector`(約 550 行,零新依賴、
零新 vendor 檔、importmap 與 `stamp_versions.py` 都不用動)。

### 20a 互動方案:B(左鍵拖曳 = Orbit)

`controls.mouseButtons = { LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN }`,
另外在 `renderer.domElement` 的 **capture 階段** 掛 `pointerdown`,先寫
`controls.mouseButtons.LEFT = event.shiftKey ? PAN : ROTATE`(OrbitControls
自己的 `pointerdown` 是非 capture,所以它下一刻讀到的已經是改好的值)。

* 左鍵拖曳 = Orbit,Shift+左鍵 = Pan,中鍵 = Dolly,右鍵 = Pan,滾輪 = Zoom
* 左鍵「位移 < 5 px 且 < 400 ms」= 選取;雙擊或 `F` = Focus;`Home` = 重置
* 靈敏度:`rotateSpeed 0.7`(0.331 → 0.232 °/px)、`zoomSpeed 0.8`、
  `panSpeed 0.85`、`zoomToCursor true`

方案 A(右鍵 Orbit)被否決:macOS 觸控板的右鍵是雙指按住再拖,中鍵在筆電
上根本不存在,而且要對抗 contextmenu。方案 B 是 web 3D 的事實標準
(Google Earth / Mapbox / Sketchfab / three.js editor),左鍵單擊選取與
左鍵拖曳 Orbit 可以用位移門檻共存,不必犧牲任何一個。

### 20b 五種模式 + 投影切換

`CAMERA_MODES` 一張表定義互動權限、俯角範圍、距離範圍與預設機位:

| 模式 | rotate/pan/zoom | polar | distance | 預設機位 |
|---|---|---|---|---|
| orbit | ✓✓✓ | 1.1°–84.6° | 5–350 | overview |
| follow | ✓✓✓ | 4.6°–84.6° | 4–120 | robot |
| fixed | ✗✗✗ | — | — | fixedpost |
| top | ✓✓✓ | 0°–9.9° | 24–350 | topdown |
| street | ✓✓✓ | 50.4°–84.6° | 5–110 | street |

投影切換共用同一顆 `OrbitControls`:切 ortho 時建一台
`OrthographicCamera`(半高常數 `ORTHO_BASE_HALF_HEIGHT = 20`)、
`controls.object = camera`,並用 `zoom = 20 / (d·tan(fov/2))` 讓等效取景與
透視完全一致;切回來時反推 `d = (20/zoom) / tan(fov/2)`。實測往返後
distance 60.1233 → 60.1233(誤差 0)。`resizeRenderer()` 同時維護兩台
相機,`window.resize` 與 `#recordingMode` 兩個 handler 都走它。

### 20c 平滑過渡:球面座標插值

`cameraFlyTo(position, target, { durationMs = 620 })` 在**球面座標**插值:
target 線性、radius 取對數插值、方位角走最短弧、俯角線性,外層套
ease-in-out cubic。直接 lerp position 會讓 overview→street 那段 103.5° 的
轉向走一條穿過地面的直線,這正是 san 說的「突兀跳動」。過渡期間
`controls.enabled = false`,結束後恢復模式權限。

十個預設視角實測(取樣 8 幀,間隔 70 ms):中間幀 7–8 幀處於
transitioning、8 個取樣點座標互不相同、第一個取樣點不等於終點——過渡
確定是漸進的,不是瞬移。

### 20d 預設視角(舊六顆一顆不動)

`[data-camera]` 六顆(overview / street / robot / crosswalk / hook /
busstop)**選擇器、click、is-active 全部保留**,只是改走平滑過渡。
`verify_kbot_post_tuner.mjs:305` 斷言 `data-camera` 數量剛好 6,所以新增的
預設一律用 **`data-view`** 屬性:`isometric`(等角:模擬座標 45° 方位 +
54.7° 俯角,對齊羅斯福路軸而非世界軸)、`intersection`(路口聚焦)。
另有兩個只透過模式/hook 進入的機位:`topdown`、`fixedpost`。

### 20e Focus / Frame:混合式 picking

* **動態 actor 走 raycast**:只打 `runtime.simulationRoot`(392 mesh),
  由命中 mesh 往上走祖先鏈,取第一個 `userData.actorType`(車/人)或
  `runtime.kbotHolder`(KBot)。holder 補了
  `.name = "Runtime_KbotHolder"` 與 `userData.pickId = "kbot"`。
* **號誌只打「亮著的」**:three.js 的 `Raycaster` 不檢查 `visible`,
  87 顆 lens 有 79 顆是隱藏的紅燈,不過濾就會選到看不見的燈。命中後依
  `traffic_director_signal_head_id` 併成 13 組,取 Box3 聯集當 focus 目標。
* **公車站用名稱前綴**收集候車亭碎片,依世界座標歸到最近的月台
  (`busstop:se` / `busstop:nw`),不是硬編 BusStop_0/1 的方向。
* **命中地面則退回靜態登錄表**(路口 / 行穿線 / 待轉區 / 兩個月台),
  但只在目標自己的作用半徑 + 3 m 內才算,否則點空曠路面會誤選十幾公尺外
  的月台。

Frame 距離 `d = (r / sin(fov/2)) · 1.3`,夾在該模式的 min/max distance,
俯角夾在 24°–78°。實測 focus KBot:目標 NDC (0, 0)、距離 5.0 m。

### 20f 手感護欄(每幀 `controls.update()` 之後)

* **target 夾持**:y ∈ [0.35, 14] m、水平距路口中心 ≤ 130 m。
  舊版 `screenSpacePanning` + 無界 target 一次右鍵拖曳就能把支點抬到
  32 m 高的空中且無法回復;實測四次 300 px 下拖後 y 卡在 14.0。
* **防穿模**:環境 GLB 的 231 個建物節點各算一個 Box3(外擴 0.7 m),
  每幀做 O(231) 的 `containsPoint`,相機一旦落進去就沿視線往外推。
  **不是**每幀對 4860 個 mesh raycast——實測只有 43 fps,那樣會直接掉幀。
  另外相機離地至少 0.9 m。實測 street 機位滾 60 格滾輪到 minDistance:
  相機 y = 1.78 m、`__cameraInsideBlocker() === false`。
* **Follow 改成 offset-follow**:記住切入瞬間的世界座標相對位移,
  機位與注視點一起跟著機器人走(`alpha = 1 - exp(-Δt/0.28)`,不吃幀率)。
  舊版只 `controls.target.lerp(...)`,機器人走遠時距離會自己從 9.86 漂到
  8.70;實測新版 3 秒內 9.3808 → 9.3600。
* **使用者接管即退出 Follow**:`controls.addEventListener("start", ...)`,
  一按下就切回 orbit、模式按鈕的 is-active 跟著換,並在畫面下緣顯示
  「已退出跟隨:相機改為 Orbit 自由視角」2.6 秒。

### 20g 修掉的既有缺陷:`__setCamera` 會被跟隨迴圈拉走

`window.__setCamera(position, target)` 的契約完全不變(模擬座標進、
**同步瞬移**生效、回傳 `true`),但現在會先清掉進行中的過渡並關閉 Follow。
舊版只要按過 `[data-camera="robot"]`,之後每一次 `__setCamera` 的 target
都會在 1.2 秒內被跟隨迴圈拉走 17.9 m;現在實測 1.6 秒後位移 0.0000 m。

### 20h 新 hook 與 UI

* `window.__cameraState()` → `{ mode, projection, preset, transitioning,
  position, target, distance, azimuthDeg, polarDeg, zoom, selection,
  blockers }`
* `window.__pickAt(clientX, clientY)` → `{ id, kind, label, center, radius }`
  或 `null`(同時會設為目前選取)
* `window.__focusObject(id, opts)` / `window.__frameSelected(opts)`
* `window.__setCameraMode(mode, opts)` / `window.__setCameraPreset(name, opts)`
  / `window.__setCameraProjection(kind)`
* `window.__cameraInsideBlocker()` / `window.__projectPoint([x, y, z])`
  (驗收用)
* `window.__signalStates()` 每筆多一個 `head` 欄位(附加,舊消費者不受影響)
* UI:`.camera-toolbar` 尾端加 `data-view` 兩顆;左下新增 `.camera-tools`
  (五顆 `data-camera-mode` + Home / Persp↔Ortho / Focus 三顆
  `data-camera-action` + `#cameraSelectionLabel`);底部置中 `.viewport-hint`
  含 `#cameraNotice`。**新 chrome 全部吃 `body.is-recording`**——
  `record_demo_video.mjs` 第一件事就是 `setSwitch('recordingMode', true)`,
  這樣不用改那份寫死的隱藏清單,成品影片也不會有工具疊層入鏡。

### 20i 收尾

備份 `traffic_director.js.v9` / `.html.v9` / `.css.v9`。改完跑
`python3 mujoco/stamp_versions.py`。新增可重跑驗收
`mujoco/verify_camera_system.mjs`(60 條斷言,全過)。既有驗收
`verify_kbot_post_tuner.mjs` / `verify_recording_shots.mjs` /
`verify_san_complaints.mjs` / `verify_actor_budget.mjs` 與三套 node 測試
全過,console error 0。

**未做(留給後續兩棒)**:右上角 ViewCube / Navigation Gizmo(第二棒)、
Layers 選單與整體簡約化重排(第三棒)。目前相機模式與工具按鈕暫時擠在
左下角的 `.camera-toolbar` / `.camera-tools`,第三棒會收進 View 選單。

## §21 Viewport 操作 UI:ViewCube / View 選單 / Layers 選單(2026-08-18)

第二棒。做 san 規格第 2、3、6 點,樣式先往第 7 點(minimal / tool-like)靠。
相機行為本身全部沿用 §20 的 `cameraDirector`,這一節只加「操作介面」。

### 21a ViewCube 用 DOM CSS 3D,不畫進 WebGL canvas

先評估過 `@mlightcad/three-viewcube`(MIT,27 KB)與 three r170 的
`examples/jsm/helpers/ViewHelper.js`,兩個都排除:

* 兩者都是把 gizmo **畫進主 canvas**(`renderer.setViewport()` 角落渲染)。
  `record_demo_video.mjs` 是靠一份寫死的 CSS class 清單把 HUD 藏掉的,
  畫在 canvas 裡的東西 **CSS 藏不掉**,成品影片會有工具疊層入鏡——
  除非再改錄影腳本,那正是不能動的驗收路徑。
* `ViewHelper` 另外硬寫死右**下**角、`dim = 128` 不可調,`update()` 直接改寫
  `camera.position`,會跟 `cameraDirector` 的過渡打架,`handleClick` 也不吐出
  被點到的是哪個軸。
* `three-viewcube` 的六個面對齊**世界軸**,而世界 Front 偏離羅斯福路主軸
  43.3°(§20 已量過),要改成街道軸得餵它一顆假相機;它還在
  `renderer.domElement` 上自己掛 `click` 且不 `stopPropagation()`,
  會跟 §20 的左鍵 picking 撞車。

改成 DOM 實作:`.viewcube` 是 72 px 的 `perspective` 容器,`#viewCubeStage`
開 `transform-style: preserve-3d`,六個面是六顆 `<button>`(44 px + 14 px
margin,各自 `rotate* translateZ(22px)`)。好處是**整組吃 `body.is-recording`**、
樣式完全可控(深色、1 px 線、無 glow)、六個面天生是可 focus 的按鈕。

### 21b 方塊的朝向數學

* 基底 **對齊街道軸而非世界軸**:`buildViewCubeBasis()` 取
  `sHat = normalize(simulationPoint(1,0,0) − simulationPoint(0,0,0))`、
  `tHat` 同理,基底取右手系 `(X, Y, Z) = (sHat, up, −tHat)`。
  `simulationRoot` 的行列式是 **−1**(z 鏡射),直接拿 `(sHat, up, tHat)`
  會左右相反。
* 每幀 `M = R_cam⁻¹ · R_street`;three 是 Y 上、CSS 3D 是 Y 下,所以寫進
  `matrix3d()` 前要做 `S·M·S` 共軛(`S = diag(1, −1, 1)`),否則方塊上下顛倒。
  角度變化 < 0.2 rad·0.0035 就不重寫 style。
* 背向的面 `pointer-events: none` + 壓暗(CSS `backface-visibility` 不保證
  擋得住命中測試);最正對觀者的面加一條細亮邊表示朝向,不發光。
* 點面 = 換朝向不換注視點:保留 `controls.target` 與目前距離,只把球面座標的
  φ/θ 換成該面法線的值(φ 夾進當前模式的俯角範圍)。Top 面進 `top` 模式,
  其餘面一律回 `orbit`,免得在 Street / Fixed / Follow 的俯角鎖下按了沒反應。

### 21c 版位

| 位置 | 元件 |
|---|---|
| 右上 `.viewport-gizmo` | ViewCube 72 px + rail:Home / Isometric / Focus Selected / Persp↔Ortho |
| 左下 `.viewport-menus` | 「視角」popover(8 顆預設視角 + 5 個相機模式)、「圖層」popover、`#cameraSelectionLabel` |
| 底部置中 `.viewport-hint` | 拖曳旋轉 · Shift+拖曳平移 · 滾輪縮放 · 點選物件後按 F 或雙擊聚焦 |
| 左上 `.metrics-panel` | **從右上搬過來**(右上讓給 ViewCube) |

舊的六顆 `[data-camera]` **原封不動搬進「視角」popover**,class / id / `is-active`
邏輯一行沒改;`verify_kbot_post_tuner.mjs:305` 的「剛好 6 顆」照樣成立。
popover 用 `hidden` 屬性切換,驗收腳本的 `el.click()` 不受可見性影響。

### 21d Layers 選單

六個圖層,節點清單每次現查(reseed 會換掉整批 mesh):

| id | 對象 | 節點數(標準密度) |
|---|---|---|
| `vehicles` | `runtime.vehicles[].mesh` | 34 |
| `pedestrians` | `runtime.pedestrians[].mesh` | 15 |
| `kbot` | `runtime.kbotHolder` | 1 |
| `signals` | `runtime.signalAspects`(整組) | 1 |
| `markings` | `runtime.hookTurnBox` + `runtime.kbotPostMarkers` | 2 |
| `buildings` | `runtime.buildingNodes`(`buildCameraBlockers()` 同一趟收集) | 231 |

`markings` 只是在既有開關(`#hookTurn` / 崗位預覽)上**再乘一層 AND**,兩個都開
才畫;`#hookTurn` 與 `#kbotPostPreview` 是同一個 element,沒有複製。
`spawnActors()` 尾端會重新套用 `vehicles` / `pedestrians` 兩層。

新 hook:`window.__layerState()`(每層 enabled / nodes / visibleNodes)、
`window.__setLayer(id, visible)`、`window.__viewCubeState()`、
`window.__cubeFaceDirection(faceId)`、`window.__applyViewCubeFace(faceId)`、
`window.__viewportMenuState()`。

### 21e 驗收

`mujoco/verify_viewport_ui.mjs`(48 條,全過)。ViewCube 六個面是用 **真滑鼠
座標**(`Input.dispatchMouseEvent`)點的,不是 `el.click()`:先在方塊 bbox 上
以 2 px 網格掃 `elementFromPoint`,取「離邊界最遠」的內部點再點——3D transform
之後的面互相重疊,取 bbox 中心或邊緣點會落到別的面上。點完斷言相機方位角/俯角
對得上該面法線(誤差 < 2.5°)。

`body.is-recording` 的隱藏清單擴充成 `.camera-tools, .camera-toolbar,
.viewport-hint, .viewport-gizmo, .viewport-menus`,`record_demo_video.mjs`
一行都不用改。截圖:`mujoco/verify_shots/v21_default.png` /
`v21_view_menu.png` / `v21_layers_menu.png`。

**未做(留給第三棒)**:全站簡約化統一(token / 圓角 / 陰影 / glassmorphism
清除)、右側 370 px 控制面板的分頁與摺疊、底部狀態列整併。

## §22 全站簡約化 / scene-first(2026-08-18)

目標是 san 規格的第 7、9 點:「網頁幫我改成簡約」、讓 3D 場景成為主角。
§20 給了相機系統、§21 給了操作 UI,但整體仍然像 Web Dashboard —— 一條佔場景
寬度 97.7% 的玻璃 topbar、四塊同款 blur 卡片、右側一條 2.64 螢幕高的長捲軸。
這一節把「視覺重量」整個降下來。

### 22a 量測基準(改之前 / 改之後)

用 `mujoco/measure_visual_weight.mjs <label>` 量,兩次都在 1920x1080 與
1440x900 各跑一輪。

| 指標 | 之前 | 之後 |
|---|---|---|
| 3D 場景佔視窗(1920) | 80.73 % | **83.33 %** |
| 疊層佔場景(1920) | 9.65 % | **4.15 %** |
| 疊層佔場景(1440) | 13.51 % | **6.26 %** |
| `.topbar` 佔場景 | 5.97 %(1514x66) | **0.20 %**(130x26) |
| 右側面板寬 | 370 px(19.27 %) | **320 px(16.67 %)** |
| 面板預設捲動高 | 2849 px = 2.64 螢幕 | **最長的分頁 1053 px = 0.97 螢幕** |
| `backdrop-filter` | 3 處 | **0** |
| 無位移彩色外發光(glow) | 7 處 | **0** |
| `border-radius` ≥ 8px | 26 處 | **0** |
| 字級種類 | 11 種(8–20px) | **4 種 token(10/11/12/14)** |
| 硬寫 `font-size: Npx` | 55 處 | **0(全部走 token)** |
| z-index 值 | 4 個裸數字 | **5 個具名 token** |

面板收合後場景是 1884 px = 視窗的 **98.1 %**。

### 22b 版面重排

**拆掉橫幅**:`.topbar` 1514x66 的玻璃卡改成左上角 130x26 的識別 chip
(20px mark + 12px 標題)。`.eyebrow`(GONGGUAN DIGITAL TWIN 等 5 處霓虹
小標)全部 `display: none` —— 留在 DOM,只用 CSS 藏。

**新增底部狀態列** `.status-strip`:24 px、無圓角、無 blur,只有一條上緣線。
把原本分散三處的狀態收成一條 ——
`#modelStatus`(原本在 topbar 右)、四個關鍵數字(原本是左上角 226x121 的
`.metrics-panel` 玻璃卡,改成一行內嵌讀數)、`#ruleSetLabel` / `#seedLabel`
(原本在 `.panel-footer`,位於 2849 px 捲軸的最底部,實務上永遠看不到)。
**所有 id 原封不動,只是換了掛載位置。**

`.metrics-panel` 從右上讓位之後(§21 已先搬到左上),這一節再搬進狀態列,
右上角完全留給 ViewCube;gizmo 也從 `top: 96px` 提到 `top: 14px`。

### 22c 控制面板:分頁 + 收合

原本是一條 2.64 螢幕(全展開 11.75 螢幕)、326 個控制項的無層級長捲軸。改成
三個分頁,一次只顯示一組:

| 分頁 | 內容 | 預設捲動高 |
|---|---|---|
| 指揮 | 目前指令 + 手勢/WALK 請求 | 992 px = **0.92 螢幕,不用捲** |
| 模擬 | 號誌節奏 / 車流 / 畫面與效能 / 崗位微調 | 1030 px = 0.95 螢幕 |
| 參數 | §19 全部參數 + 進階驗收 + 規則來源 | 1053 px = 0.97 螢幕 |

分頁**只切 CSS class,不 unmount 任何節點** —— §19 的 `#paramGroups`(94 列)
與 §18 的崗位微調必須永遠在 DOM 裡,驗收腳本用 `el.click()` / `.value` 直接
操作,那不需要可見性但需要元素存在。三個分頁下實測 `#paramGroups .param-row`
都是 94、`Object.keys(__params()).length` 都是 94。

收合(`body.is-panel-collapsed`,收合鈕或 **N 鍵**,Blender 側欄慣例):面板縮成
36 px 的垂直 rail,分頁名改直排(`writing-mode: vertical-rl`),點任一分頁 =
展開並切到那頁。收合會 `resizeRenderer()`,canvas 從 1600 → 1884 px。
**刻意不複用 `body.is-recording`** —— 那是驗收腳本的合約;而且錄影模式必須贏過
收合狀態(`body.is-recording.is-panel-collapsed .app-shell` 仍是滿版,實測
canvas 1920 px)。

法律聲明(封閉場域/數位孿生展示、私人 KBot 不具法定指揮權)**釘在面板頂端、
不隨分頁切換消失**,但從 82 px 的琥珀色大卡片壓成一條 ~40 px 的細列(左側
2px 色條 + 10px 字),內容一字未改。

### 22d 裝飾性 CSS 清除(逐條)

- `backdrop-filter: blur()` **3 處全刪**(`.topbar` / `.metrics-panel` /
  `.scene-legend`),改純半透明底。同時省掉 3 個全螢幕合成層。
- `.phase-signal` 四道 `0 0 18px` 彩色外發光全刪,16x42 的圓角光棒改成
  3px 實心色條(顏色仍是唯一狀態訊號,但不發光)。
- `.status-dot` 三態的 `0 0 0 4px` 光暈環全刪,9px → 6px 實心點;
  `animation: pulse` 只留 `is-loading` 一態(載入進度指示是有意義的)。
- `--radius` 14px → **3px**,並補 `--radius-sm` 2px / `--radius-lg` 4px /
  `--radius-pill` 999px。`border-radius ≥ 8px` 從 26 處降到 0。
- `--shadow` `0 18px 48px / 34%` → `0 1px 2px / 45%`;疊層的
  `0 12px 32px / 22%` 全部拿掉;popover 用 `--shadow-pop` `0 4px 12px / 38%`。
  全檔最大陰影模糊半徑 48px → **12px**。
- 霓虹色降飽和:`--green` `#40d69a` → `#4f9b78`、`--cyan` `#54c8e8` →
  `--accent` `#4a90a8`、`--focus` `#8adcf2` → `#6fa8bd`、`--red` `#ff554a` →
  `#d1574e`、`--amber` `#f3b94f` → `#c69a4a`。`--cyan` / `--cyan-dark` 保留
  為 `--accent` 的別名,避免任何漏改的規則變成無效色。
- 膠囊改方角:`.mode-badge` / `.decision-state` / `.lock-pill` 從 999px 改
  `--radius-sm`;`.switch` 46x26 → 32x18(仍是 pill,那是開關的正確語彙)。
- `.segmented button.is-active` 從「霓虹綠底 + 深色字」改成低調的
  `#24404e` 底 + 一般文字色。
- focus ring 3px → 2px。

### 22e token 體系

`:root` 從 21 個 token(色 13、radius 1、shadow 1)補成完整體系:
間距 `--sp-1..5`、字級 `--fs-micro/small/body/lead`、圓角
`--radius-sm/--radius/--radius-lg/--radius-pill`、陰影 `--shadow/--shadow-pop`、
z-index `--z-overlay(10)/--z-status(14)/--z-chrome(20)/--z-popover(30)/
--z-toast(100)`。§21 留下的裸數字 22 / 15 一併收編。

字級從 11 種(8/9/10/11/12/13/15/16/17/19/20px)收斂成 **4 級**:
10 / 11 / 12 / 14。密集的工具面板不需要更多層級;全檔 `font-size: Npx` 的
硬寫值 **0 處**,一律 `var(--fs-*)`。

### 22f 驗收

`mujoco/verify_minimal_shell.mjs`(43 條,全過):

- **A 版位**:場景佔比 ≥ 82 %、疊層 ≤ 5 %、topbar ≤ 260x32、狀態列貼底、
  metrics 在狀態列而非左上、gizmo 右上、選單左下、提示置中、面板 320 px。
- **B 分頁**:三頁逐一用**真滑鼠**點,`__panelState()` 斷言只有該頁 `display:
  block`;每一頁都斷言 `#paramGroups` 94 列 + `__params()` 94 項還在。
  指揮頁 `scrollHeight <= clientHeight`(單螢幕裝得下)。
- **C 收合**:面板 36 px、canvas 1600 → 1884、`#paramGroups` 仍在 DOM、展開復原。
- **D 紅線**:74 個 DOM id + 15 個 class + 26 個 `window.__*` hook 逐一 probe;
  `[data-camera]` 剛好 6 顆且逐顆 `click()` 仍切得動 `is-active`、
  `[data-command]` 4 顆、`#modelStatus .status-dot` 選擇器在、
  `__setCamera` 仍是同步瞬移且回傳 `true`、§18 崗位微調仍可驅動。
- **E 錄影模式**:`.control-panel` 0 px、canvas 1920 px、新舊 chrome 8 個
  選擇器全部 `display: none`(含新加的 `.status-strip`);收合 + 錄影同時開啟
  時錄影贏。
- **F 風格**:對 CSS 原始碼做文字分析,斷言 blur / glow / 大圓角 / 硬寫字級
  都是 0,陰影模糊半徑 ≤ 12px。
- **G**:1920x1080 與 1440x900 全頁截圖、console error 0。

既有驗收零回歸:`verify_camera_system.mjs` 60/60、`verify_viewport_ui.mjs`
49/49、`verify_kbot_post_tuner.mjs`、`verify_recording_shots.mjs`(8 個 Shot)、
`verify_san_complaints.mjs`、`verify_actor_budget.mjs`、三套 node 測試全過。

新 hook:`window.__panelState()`(tab / collapsed / 每個 pane 的 display /
scrollHeight)、`window.__setPanelTab(id)`、`window.__setPanelCollapsed(bool)`。
舊 hook 一個都沒動。

截圖:`mujoco/verify_shots/v22_before_1920.png` / `v22_before_1440.png`
(改之前)與 `v22_final_1920.png` / `v22_final_1440.png` / `v22_tab_sim.png` /
`v22_tab_params.png` / `v22_collapsed.png` / `v22_recording.png`(改之後)。
備份:`viewer/traffic_director.{js,html,css}.v11`。
