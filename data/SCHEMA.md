# `gongguan.intersection.state.v1` — 路口即時狀態資料契約

這份檔案定義「羅斯福路四段 × 羅斯福路四段90巷這個路口,某一刻的真實狀態」
長什麼樣。**viewer 只認這個 schema,不管資料哪來。**

- 產生者:`data/ingest.py`(四種來源)、CV 影像管線、或使用者自架的服務
- 消費者:`viewer/traffic_director.js` 的 §24 資料層
- 範例:`data/live/*.json`、`data/examples/cv_pipeline_example.json`
- 驗證:`python3 data/ingest.py --validate <檔案>`

---

## 0. 設計原則

1. **只有聚合量。** 計數、密度、佇列長度、流率、速率、方向分佈、車種組成。
   任何個體識別欄位(人臉、車牌、追蹤 id、embedding、bounding box、影像)
   **一律禁止**,`validate_state()` 會直接擋下來(見第 6 節白名單)。
2. **誠實優先於好看。** 每一份輸出都必須帶 `confidence` 與 `staleAfterS`,
   讓 UI 有辦法區分「路口實測」「643 公尺外的走廊代理值」「2024 年的歷史快照」
   「合成」。**絕不可讓人誤以為畫面是即時的。**
3. **失敗不是例外,是一種狀態。** 任何來源掛掉都回一份合法 JSON,
   `degraded: true` + `warnings[]`,viewer 自動退回 synthetic。
   永遠不拋錯、永遠不讓場景空掉。
4. **三種部署都能用**(硬規則 2):(a) 本機 ingest 寫檔、
   (b) GitHub Action 定期抓取後 commit JSON、(c) 使用者自架 HTTP 端點。
   三者輸出同一個 schema,viewer 端只換 URL。

---

## 1. 最外層

| 欄位 | 型別 | 必填 | 說明 |
|---|---|:--:|---|
| `schema` | string | ✔ | 固定 `"gongguan.intersection.state.v1"`。不符的一律拒收。 |
| `generatedAt` | ISO-8601 | ✔ | 這份 JSON **被產生**的時刻。 |
| `observedAt` | ISO-8601 | ✔ | 資料**被量到**的時刻。這兩個不一樣 —— 新鮮度看的是這個。 |
| `ageAtGenerationS` | int | | `generatedAt − observedAt`,秒。 |
| `staleAfterS` | int | ✔ | 超過這個秒數就算過期。`0` = **永遠標示為非即時**(歷史/合成)。 |
| `source` | object | ✔ | 資料哪來的,見 §2。 |
| `site` | object | ✔ | 路口識別與座標。 |
| `confidence` | object | ✔ | 這份資料有多接近「路口真值」,見 §3。 |
| `detectors` | array | | 逐偵測器、逐車道的原始量測,見 §4。 |
| `measurement` | object\|null | | 換算後的中間量(流率/密度/速度區間),見 §5。 |
| `simulation` | object\|null | ✔ | 直接餵給模擬的參數,見 §5。 |
| `pedestrians` | object | | 行人數與來源。 |
| `bus` | object | | 公車進站 ETA(秒),依月台方向分組。 |
| `signal` | object\|null | | 號誌相位。臺北市**沒有**公開時制 API,只能自己量。 |
| `privacy` | object | ✔ | 隱私聲明,見 §6。 |
| `degraded` | bool | | true = 這一份沒拿到真資料,viewer 應退回 synthetic。 |
| `warnings` | string[] | | 給 UI 直接顯示的中文警告。 |

---

## 2. `source` — 來源與新鮮度

```json
{
  "id": "replay",
  "kind": "synthetic | replay | tdx | file",
  "labelZhTw": "歷史快照 · 偵測器輪播",
  "realtime": false,
  "origin": "臺北市政府交通局 GetVDDATA.xml(已凍結於 2024-11-14)",
  "originUrl": "https://tcgbusfs.blob.core.windows.net/blobtisv/GetVDDATA.xml",
  "license": "臺北市政府資料開放平臺",
  "updateIntervalS": 60,
  "frameKind": "detector-rotation | temporal",
  "frameIndex": 0, "frameCount": 3, "frameSeconds": 20,
  "note": "……"
}
```

`realtime: false` 的來源,viewer **必須**在 UI 上標成非即時。

### 四種 `kind`

| kind | 需要金鑰 | 即時 | 說明 |
|---|:--:|:--:|---|
| `synthetic` | ✗ | ✗ | 目前的模擬行為。預設值,永遠可用,不連任何網路。 |
| `replay` | ✗ | ✗ | 凍結的 2024-11-14 臺北市 VD 快照。**真實資料,今天就能看。** |
| `tdx` | ✔ | ✔ | TDX Live VD,60 秒更新。金鑰要 san 自己註冊,見 `README.md`。 |
| `file` | ✗ | 視來源 | 讀本機 JSON 或 URL。給 CV 影像管線與使用者自架服務用。 |

---

## 3. `confidence` — 這份資料離「路口真值」有多遠

```json
{ "level": "corridor-proxy", "labelZhTw": "走廊代理值", "note": "……" }
```

| level | 意思 |
|---|---|
| `on-site` | 偵測器就在這個路口(只有 CV 影像管線做得到)。 |
| `corridor-proxy` | 幾百公尺外的走廊偵測器。**不是路口實測值。** |
| `synthetic` | 沒有接任何真實資料。 |
| `unavailable` | 抓不到資料,已退場。 |

**為什麼羅斯福路四段一定是 `corridor-proxy`:**
羅斯福路四段整條**沒有任何車輛偵測器**;而且全臺北 636 個 VD
**沒有一個是路口/停止線型**(TDX 靜態表 `DetectionType == 4` 的計數為 0)。
所以「停止線佇列長度」這件事 VD 永遠給不了,只能靠影像。

---

## 4. `detectors[]` — 逐偵測器、逐車道

```json
{
  "id": "VELJA00", "roadZhTw": "羅斯福路三段", "role": "upstream-proxy",
  "distanceM": 643, "laneCount": 6, "intervalS": 300, "status": "ok",
  "lanes": [
    { "laneNo": 0, "volume": 7.0, "speedKph": 36.86, "occupancy": 2.2,
      "classes": { "small": 0, "motorcycle": 0, "large": 7 },
      "lanePosition": "bus", "positionConfidence": "heuristic",
      "flowVph": 84.0, "speedUsedKph": 36.86,
      "densityVehPerKm": 2.278, "speedFloored": false } ]
}
```

- `volume` 一律換算成 **輛/5 分鐘**(凍結快照的原生單位)。TDX Live VD 的
  60 秒計數會先 `× 300 / SrcUpdateInterval` 換到同一基準,並保留 `volumeRaw`
  與 `volumeWindowS`。
- `classes` 的三類是 VD 原生欄位 `Svolume` / `Mvolume` / `Lvolume`,
  解讀依據見 §5.3。
- `lanePosition` ∈ `inner | middle | outer | bus`;`positionConfidence` ∈
  `calibrated`(影像單應性校正得到) | `heuristic`(由車種佔比推定)。
- `status` ∈ `ok | comm-error | disabled | fault | unknown`
  (對應 TDX `Status` enum 0/1/2/3)。

---

## 5. `simulation` — 映射到模擬的參數(**每個係數的來源都在這裡**)

```json
{
  "densityMode": "live",
  "mainVehicleMin": 3, "mainVehicleMax": 4,
  "pedestrianMin": null, "pedestrianMax": null,
  "sideVehiclesPerColumn": null,
  "speedRangeMps": [10.238, 13.889], "speedCapped": true,
  "mix": { "car": 0.5348, "scooter": 0.2084, "motorcycle": 0.0379,
           "bus": 0.1689, "bicycle": 0.05 },
  "mixSource": "vd-class-volumes",
  "directionSplit": 0.5, "directionSplitSource": "assumed-5050",
  "laneQuota": { "1": { "inner": 121, "middle": 354, "outer": 525 },
                 "-1": { "inner": 121, "middle": 354, "outer": 525 } },
  "laneQuotaUnit": "permille-weight",
  "laneQuotaMethod": "class-share-ranking",
  "laneQuotaConfidence": "heuristic"
}
```

### 5.1 逐車道 Volume → 場景車數

模擬是**封閉迴圈、固定母體**:車子跑到場景邊界不會消失,而是被
`recycleMainVehicle()` 傳回上游(`traffic_director.js:3311`)。所以偵測器量到的
「流率」**不能**直接當生成率,必須先換成「同一時刻待在生成跨距內的車數」。

```
q = Volume × 12                                  ← 輛/5分鐘 → 輛/小時,純單位換算
k = q / max(speedFloorKph, AvgSpeed)             ← 交通流基本關係式 q = k·v 的定義式
k̄ = k / laneCount                                ← 平均到每車道
N = k̄ × (spanM / 1000) × generalLanes            ← 密度 × 跨距長度 × 場景車道數
mainVehicleMin = floor(N) ; mainVehicleMax = ceil(N)
```

| 符號 | 值 | 來源 |
|---|---|---|
| `12` | — | 5 分鐘 → 1 小時。純單位換算,不是係數。 |
| `q = k·v` | — | 交通流基本圖的**定義式**,不是任何擬合模型。 |
| `spanM` | 136 | `traffic_simulation_core.mjs` 的 `SPAWN_SPAN_M`。 |
| `generalLanes` | 6 | `MAIN_ROOSEVELT_LANES` 的長度(內/中/外 × 雙向)。 |
| `speedFloorKph` | 5 | `AvgSpeed` 可能是 `0`(全停)或 `-99`(TDX swagger 標註的資料異常旗標)。除以 0 會讓 k 爆炸。5 km/h ≈ 步行速度,是「車陣仍在動」的最低可信值;低於此值 VD 的速度估計本來就不可靠(該用占有率)。**這是整條管線唯一一個工程判斷常數。** |
| `floor/ceil` | — | 模擬的預算是一個區間,直接取 N 的整數包絡。**沒有額外的展開係數。** |

**band 為什麼不是 ±X%:** 因為任何百分比都會是我發明的。`[floor(N), ceil(N)]`
是 N 這個實數唯一無爭議的整數區間。

**沒有下限保護。** 如果真實量測就是 3 輛車,場景就顯示 3 輛車。
硬規則 2 的「不可讓場景空掉」指的是**抓不到資料**時的退場,
不是「量到的車真的很少」時去灌水。低就是低,UI 會把數字寫清楚。

#### 實測(2024-11-14 16:46 快照,`spanM=136`、`generalLanes=6`)

| 偵測器 | 路段 | 距離 | 車道 | 量測 | q | k | **N** | 場景車數 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `VELJA00` | 羅斯福路三段 | 643 m | 6 | 135 輛/5分 | 1620 輛/h | 27.04 輛/km | 3.68 | **3–4** |
| `VCCKW00` | 羅斯福路五段 | 1036 m | 2 | 88 輛/5分 | 1056 輛/h | 27.52 輛/km | 11.23 | **11–12** |
| `VF9KB00` | 新生南路三段 | 377 m | 6 | 155 輛/5分 | 1860 輛/h | 52.05 輛/km | 7.08 | **7–8** |

**一個必須誠實面對的發現:目前的模擬比 2024-11-14 那個時段的實測擁擠 2–7 倍。**
模擬的「一般」模式是 25 輛 / 136 m = 184 輛/km = 每車道 30.6 輛/km;
在 6.7 m/s 下等於每車道 738 輛/h ≒ 62 輛/5分。而實測是每車道 4–57 輛/5分,
而且平均車速高得多(36–72 km/h)。也就是說 —— 現行的合成車流是
「視覺上熱鬧」的設定,不是那一天那個時段的真實密度。

### 5.2 AvgSpeed → `desiredSpeed` 分佈

```
speedRangeKph = [ min(逐車道 AvgSpeed), max(逐車道 AvgSpeed) ]   ← 完全來自資料
speedRangeMps = clamp(speedRangeKph, 5, speedLimitKph + 10) / 3.6
```

| 符號 | 值 | 來源 |
|---|---|---|
| 區間寬度 | — | **用偵測器自己的跨車道速度散布**,不是我發明的 ±X%。實測 CV:`VELJA00` 24%、`VCCKW00` 13%、`VF9KB00` 11%。 |
| 下限 5 km/h | 同 §5.1 | 同 `speedFloorKph`。 |
| 上限 `speedLimit + 10` | 50 km/h | `speed_limit_kph = 40` 出自 `traffic_rules/taiwan_traffic_director_rules.json`;`+10` 是道路交通管理處罰條例對市區道路科學儀器採證的容許誤差。 |

超過上限時輸出 `speedCapped: true` 並寫進 `warnings` —— **夾了速度就不再守恆流率**
(模擬流率會低於量測流率),這件事必須講出來。
`VELJA00` 的 71.8 km/h 就被夾到 50 km/h。

### 5.3 `Svolume` / `Mvolume` / `Lvolume` → 車種組成

```
bicycle     = 0.05                                  （VD 看不到自行車,沿用專案假設）
remaining   = 1 − bicycle
car         = remaining × S / (S+M+L)
motorTotal  = remaining × M / (S+M+L)
scooter     = motorTotal × 0.55/(0.55+0.10)
motorcycle  = motorTotal × 0.10/(0.55+0.10)
bus         = remaining × L / (S+M+L)   （上限 0.20,超出補回 car）
```

**`M = 機車` 的證據**(不是「中型車」):

1. `Volume == S + M + L` 在快照全部 **2195 條車道上完全成立(0 筆不符)**
   → 三者互斥且窮盡。
2. TDX Live VD 對**同一批感測器**的 `VehicleType` 列舉是 `S/L/T/M` =
   小客車 / 大車 / 聯結車 / **機車**。
3. 快照中有 **12 條車道(8 台裝置)** 的 `L/Volume > 0.9`,
   例如 `VELJA00` 的 `LaneNO=0` 是 7/7 全是 L —— 公車專用道的特徵,
   支持 `L = 大型車`。
4. `VELJA00` `LaneNO=5` 的 M 佔 **63.4%**。一條路面車道 63% 都是中型貨車
   不可能;台北外側車道 63% 是機車完全合理。

| 係數 | 值 | 來源 |
|---|---|---|
| 速克達:打檔車 = 0.55 : 0.10 | | `vehicle_mix_project_assumption`。**VD 無法區分速克達與打檔車,這是專案假設不是量測。** |
| 自行車 0.05 | | 同上。**VD 的線圈/雷達不計自行車。** |
| 公車上限 0.20 | | `L` 含貨車與聯結車,模擬沒有貨車型別所以全部映射成 `bus`,會高估公車;而場景只有 2 條公車專用道,超過 20% 會撞到 §5 的防碰撞減車。超出的部分補回 `car`,並寫進 `warnings`。 |

實測 `VELJA00` 的 `bus` 是 16.9% —— 明顯高於專案假設的 5%,
因為那台偵測器有一條 100% 大車的專用道。

### 5.4 `laneQuota` — 逐車道生成權重(千分比)

值是**權重**不是車數(`laneQuotaUnit: "permille-weight"`),
在 `laneForVehicleByQuota()` 裡當加權抽樣用。
`MAIN_ROOSEVELT_LANES[].allowed` 仍然是**最後的硬守門** ——
資料源永遠不能把速克達塞進內側車道。

推定規則(`class-share-ranking`,`confidence: heuristic`):

1. `L/Volume > 0.9` 且 `Volume ≥ 5` 的車道 → 公車專用道,不進一般車道配額。
2. 其餘車道依機車佔比 `M/Volume` 由高到低排序,平均切三份 → 外 / 中 / 內。
   依據是台灣「慢車靠右」,以及模擬 §4a 既有的 `allowed` 清單
   (只有外側車道允許速克達與自行車)。
3. 各位置的密度加總 → 千分比權重。

**這是推定不是量測。** 凍結快照與 TDX Live VD 都沒有直接說某條車道是內/中/外側。
真正可靠的逐車道歸屬只有影像單應性校正做得到(`positionConfidence: "calibrated"`)。

### 5.5 `directionSplit`

`1`(西北向)的比例。凍結快照**完全沒有方向資訊**(沒有 `Bearing` /
`RoadDirection` / `LinkID`),所以 replay 一律 `0.5` 並標
`directionSplitSource: "assumed-5050"`。

TDX Live VD 有 `LinkFlows[].LinkID`,靜態表
`/v2/Road/Traffic/VD` 的 `DetectionLinks[].Bearing` 可解出方向;
在 `detectors.json` 填好 `linkDirections` 對應後,`tdx` 來源會輸出
`directionSplitSource: "measured"` 的實際比例。

### 5.6 行人

**VD 不量行人。** 所以 `pedestrianMin/Max` 一律 `null`,模擬沿用目前模式的行人數,
UI 顯示「行人:無資料源」。有實測行人數的只有 CV 影像管線
(`pedestrians.count` + `pedestrians.source`)。
**絕不從車流量「推估」行人數再假裝是量測。**

---

## 6. `privacy` — 隱私契約(硬規則 3,不可退讓)

```json
{ "aggregateOnly": true, "personalData": "none",
  "faceRecognition": false, "reIdentification": false, "rawImagery": false }
```

`ingest.py --validate` 會**遞迴掃過整份 JSON**,只要出現下列任一 key 就判定失敗:

```
faces  plates  trackId  trackIds  personId  embedding  embeddings
image  imageUrl  frame  bbox  boundingBox  reid
```

這是白名單思維的反面守門:schema 只描述聚合量,任何個體識別欄位連
「不小心帶進來」的機會都不給。影像管線的 bounding box 必須在投影成
`(s, t)` 之後**立刻丟棄**,不得跨越信任邊界。

---

## 7. viewer 端行為

| 情況 | viewer 做什麼 |
|---|---|
| 抓不到 / 逾時 / JSON 壞掉 | 沿用上一份;連續失敗 3 次退回 synthetic;backoff 15s→300s |
| `schema` 不符 | 直接當失敗,不套用 |
| `degraded: true` | 退回 synthetic,UI 顯示 `warnings[0]` |
| `staleAfterS: 0` | **永遠**標「非即時」 |
| `now − observedAt > staleAfterS` | 標「已過期 · 非即時」(紅) |
| `now − observedAt > 600s` | 額外標「歷史資料」 |
| `simulation.mix` 缺席 | 沿用 rules JSON 的專案假設 |
| `simulation.laneQuota` 缺席 | 走既有的 `laneForVehicle()` 規則 |
| `pedestrianMin/Max` 為 null | 沿用目前模式的行人數,標「無資料源」 |

**任何情況都不得讓場景空掉或報錯。** feed 相關的例外一律 `console.warn`,
不進 `setFatalError`。

---

## 8. 檔案位置與三種部署

viewer 讀的 URL 依來源決定。網址列有兩個覆寫參數:

- `?source=synthetic|replay|tdx|file` — 開機時直接選定來源(方便分享連結與
  CDP 驗收)
- `?live=<url>` — 直接指定要讀哪個端點,優先於一切
  (另有 `localStorage["gongguan.liveFeedUrl"]` 存使用者在 UI 打的位址)

```
../data/live/synthetic.json
../data/live/replay.json
../data/live/tdx.json
../data/live/custom.json     ← file/url 來源的預設落點
```

| 部署 | 怎麼產生這些檔 |
|---|---|
| (a) 本機 | `python3 data/ingest.py --serve-loop --source replay --out data/live/replay.json --interval 20` |
| (b) GitHub Action | 排程跑 `python3 data/ingest.py --all` 然後 commit `data/live/*.json`。`TDX_CLIENT_ID` / `TDX_CLIENT_SECRET` 放 GitHub Secrets。 |
| (c) 自架端點 | 任何回傳這個 schema 的 HTTP 端點,用 `?live=https://…` 指過去。 |

`data/live/*.json` **不可**加進 `mujoco/stamp_versions.py` 的 `js_references` ——
那是「內容雜湊 → immutable」模型,把會變動的 feed 加進去正好害死輪詢。
本機由 `serve.py` 對 `.json` 送 `no-cache`;GitHub Pages 沒有這個 header,
所以 viewer 端一律加 `?t=<timestamp>`。
