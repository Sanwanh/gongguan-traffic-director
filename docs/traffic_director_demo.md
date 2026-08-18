# 公館 KBot 交通指揮數位孿生 Demo

這份 demo 以使用者指定的
`/Users/wangshangan/Documents/pycharm/Gongguan_Business_District_digital_twin/blender/gongguan_v54_traffic_director_demo.blend`
作為唯一 canonical 場景，並將
`/Users/wangshangan/Documents/github/ksim/examples/kbot/robot/kbot-headless/preview_fingers.py`
所使用的完整 KBot／ORCA 雙手模型整合在其中。網頁背景也直接由這個
V54 匯出，不再用程式臨時畫一個相似路口。

> 使用邊界：這是封閉場域與數位孿生展示，不是公共道路實際交通指揮
> 系統。私人 KBot 並未因為此 demo 取得法定交通指揮權。

## 直接查看

### 網頁控制台

必須從專案根目錄啟動 HTTP server：

```bash
cd /Users/wangshangan/Documents/pycharm/Gongguan_Business_District_digital_twin
python3 -m http.server 8765 --bind 127.0.0.1
```

開啟：

```text
http://127.0.0.1:8765/viewer/traffic_director.html
```

網頁提供：

- 真實 V54 場景匯出：4,525 個環境物件、1,684,331 個來源 polygons；
  排除 654 個動態 demo 物件與 63 個動畫號誌燈面後約 18.0 MiB。
- fail-closed 載入：V54 場景或 KBot GLB 失敗時停止模擬，不顯示
  假場景或替代機器人。
- 自動循環：全向停止 → 羅斯福路放行 → 路口清空 → 行人穿越 →
  路口清空 → 巷 90 單向放行。
- 手動切換：除「全向停止」外，切換前固定先進入 2 秒路口清空。
- 隨機人車：每個 seed 產生 22–28 輛主線車、2 輛巷 90 機車與
  10–16 位行人；每次都保證至少有汽車、速克達、重機、公車與單車，
  並在面板列出各類數量。
- 擬真辨識：汽車、公車、速克達、重機、單車使用不同車體輪廓、車窗、
  燈具與輪組；騎士具頭盔、四肢與騎姿，行人具服裝差異與步態。
- 合規行人路徑：行人從兩側人行道走到路緣，禁止在 `DON'T WALK`
  新進入車道，只在 `WALK` 進入標線行人穿越道；已進入者會完成穿越。
- 安全閘門：行人占用衝突區、下游堵塞或路口清空時，放行指令也不能
  讓車輛新進入。
- 三個視角：鳥瞰、街道、KBot。

### Blender

```bash
/opt/homebrew/bin/blender \
  /Users/wangshangan/Documents/pycharm/Gongguan_Business_District_digital_twin/blender/gongguan_v54_traffic_director_demo.blend
```

Blender timeline 使用 24 fps，共 1,067 frames。`TrafficDirector_Demo`
collection 內含：

- `TrafficDirector_KBot_ORCA`：KBot 本體與可動 ORCA 雙手。
- `TrafficDirector_Vehicles`：seeded 汽車、機車、公車與自行車。
- `TrafficDirector_Pedestrians`：只從穿越道端點生成的行人。
- `TrafficDirector_Indicators`：攝影機、補光與實際號誌動畫；不再建立可能
  與真實號誌衝突的球形替代指示燈。

場景範圍是約 254 m 的羅斯福路核心走廊與主路口，不代表完整 2.3 km
公館商圈數位孿生。

## 重新生成與驗證

```bash
cd /Users/wangshangan/Documents/pycharm/Gongguan_Business_District_digital_twin
./scripts/run_traffic_director_demo.sh
```

預設流程不修改或重存 V54，依序執行：

1. 執行 19 項 Python 規則／builder contract 與 10 項 Node 模擬測試。
2. 用 Blender `--factory-startup` 在記憶體建立人車並逐幀驗證 1–1,067
   幀的速度、行穿線淨空、狀態機與鞋／肢體 transform。
3. 排除 `TrafficDirector_Demo` 動態集合與動畫號誌燈面，將 V54 原始靜態環境輸出為
   Draco GLB。
4. 比對來源 `.blend` SHA-256、環境 GLB SHA-256、場景物件量、實際號誌
   相位與 Blender 內部 demo 物件，全部符合才讓 QA 通過。

網頁生成與行人狀態機可獨立驗證：

```bash
node --test --experimental-test-coverage \
  tests/traffic_simulation_core.test.mjs
```

只有確定要從 frozen V53 重新建立 V54 時，才明確執行：

```bash
REBUILD_V54=1 ./scripts/run_traffic_director_demo.sh
```

環境匯出證據位於
`blender/reports/gongguan_v54_web_environment_export.json`。目前 canonical
V54 的 SHA-256 是
`848f0dc367e9952596ca8125f43584f52aa039cfa93815a4bcd3342353e399ba`。

## 規則來源與實作

規則檔：

```text
traffic_rules/taiwan_traffic_director_rules.json
```

官方來源：

- [道路交通管理處罰條例第 4 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040012&flno=4)
- [道路交通安全規則第 102 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040013&flno=102)
- [道路交通安全規則第 103 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040013&flno=103)
- [道路交通安全規則第 133 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040013&flno=133)
- [道路交通安全規則第 134 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040013&flno=134)
- [道路交通標誌標線號誌設置規則第 206 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040014&flno=206)
- [道路交通標誌標線號誌設置規則第 207 條](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=K0040014&flno=207)
- [交通部公路局《駕駛人手冊更新二版》](https://www.thb.gov.tw/News_eBook_Content.aspx?n=190&s=2467&sms=13078)

本 demo 將正式規則轉成下列優先序：

```text
行人／下游堵塞／路口清空安全閘門
→ 封閉模擬中的授權指揮者
→ 燈光號誌
→ 無控制路口優先規則
→ 標誌、標線與車道限制
```

「速行」手勢在程式中只代表該方向可以通過，不代表可以超速。一般 NPC
法規遵循率固定為 100%；違規測試模式預設關閉。

行人狀態機將第 133 條的「在人行道行走」、第 134 條的「使用行人
穿越設施並遵守號誌」，以及第 207 條的 WALK／閃光／紅燈規則分別轉為
`sidewalk_approach`、`waiting_at_curb`、`crossing` 與
`sidewalk_departure`。第 103 條的行人優先則是車輛不可繞過的硬性閘門。

## 已知限制

- 網頁人車是 deterministic seeded rule simulation，不是 SUMO 或車輛動力學
  認證。本機目前沒有可執行的 SUMO，專案亦缺少
  `gongguan.net.xml` 與 `trips.xml`。
- 網頁中的人、車與 KBot 是疊在 V54 實景上的互動層，使用和 Blender
  builder 相同的座標轉換；V54 內建的 timeline 仍可直接在 Blender
  中播放。
- Blender KBot 是姿態展示；來源 `preview_fingers.mjcf` 使用零重力與
  freejoint，未證明機器人能在真實物理環境維持平衡。
- 網頁載入 Three.js 與 Draco decoder CDN，需要網路；Blender
  `.blend` 可離線開啟。V54 環境目前仍有數千個 draw calls，低階手機
  可能較慢。
- ORCA hand 原始 STL 的第三方公開散布授權尚未在來源資料夾中確認。
  目前交付限本機整合與檢視，公開發布 GLB／Blend 前應先確認資產授權。
