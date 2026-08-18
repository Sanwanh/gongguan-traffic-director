# KBot 交通指揮 — 展示影片素材(給 Remotion)

底片不是動畫,是 viewer 實機跑出來的畫面:headless Chrome 開
`viewer/traffic_director.html`,用 CDP screencast 逐格錄下來,再用 ffmpeg
壓成 1920×1080 / 30fps 的 H.264。所以影片裡的車流、號誌、機器人步態,
跟你自己開 8124 看到的是同一套模擬。

## 產物

| 檔案 | 說明 |
| --- | --- |
| `kbot_traffic_30s.mp4` | 主素材,1920×1080 / 30fps / yuv420p / faststart |
| `kbot_traffic_30s_poster.jpg` | 第 12 秒的靜態海報圖 |
| `kbot_traffic_30s.beats.json` | **分鏡時間軸**:每個動作實際發生在第幾秒/第幾格 |
| `remotion/KbotTrafficDemo.tsx` | Remotion 合成元件(底片 + 字卡) |
| `remotion/Root.tsx` | Remotion 進入點,字卡內容與時機都在這裡 |

`beats.json` 的秒數是錄影當下量到的,不是估的。改字卡時機請以它為準。

## 重錄

```bash
# 1. server 要開著
python3 serve.py --port 8124 --directory . &
# 2. 錄(預設 30 秒上限,分鏡是事件驅動的,會等動作真的做完)
node mujoco/record_demo_video.mjs --seconds 34
```

分鏡寫死在 `mujoco/record_demo_video.mjs` 的錄影段落,四個切點(這一版實測,
成片 34.07s / 1022 格):

| 秒 / 格 | 機位 | 內容 |
| --- | --- | --- |
| 0.00 / 0 | 鳥瞰 | 羅斯福路綠燈尾段,車輛停在實畫停止線 |
| 6.25 / 187 | **機器人跟拍** | 他從人行道走進路口(最長也最好看的一段,14.4s) |
| 20.63 / 619 | 行穿線 | 站上行穿線中央、舉手全停,行人穿越 |
| 28.92 / 868 | 公車站 | 相位要換了,他主動退離車道 |
| 31.02 / 931 | 公車站 | 退到中央公車站月台,安全閘門解除、車流才放行 |

第四段是整支片的論點:**指揮者自己也是被安全閘門管的對象**。

兩個經驗值,換分鏡時要照著排:

- 走路那段**一定要用 KBot 跟拍機位**。行穿線廣角框的是路口中央,他從
  人行道出發的 14 秒根本不在畫面裡(第一版錄出來就是這樣)。
- 實測動作長度:行人相位啟動 → 走到崗位 **14.4s**、站定 **6s**
  (行人相位設 30 秒才有;設 24 秒只剩 2 秒像走過場)、退到月台 **4.6s**。

`--target` 是**從片頭裁**到指定長度(結尾一定保留,機器人站上月台才是
句點)。這一版錄了 43.2s、`--target 34` 裁掉開頭 9.2s,鳥瞰留 6.2 秒。
想更短就 `--target 30`,鳥瞰會被壓到 2 秒多。

## 成品畫面的清場規則(錄影腳本自動處理,不用手動)

企劃書要求成品畫面只放「量得到的東西」,而且不得出現機型代號。錄影腳本
在開錄前會自動做三件事:

1. **關掉所有介面疊層** — 注入一層 CSS 把標題列、相機列、圖例、控制面板、
   數據面板全部 `display:none`,錄出來是乾淨的 3D 場景,不是工具截圖。
   (viewer 內建的「錄影模式」只藏控制面板與數據面板,不夠。)
2. **藏掉真實店招** — 店招字樣在場景裡是幾何不是貼圖,所以只藏「字」與
   商標,招牌板/建物/遮陽棚全部留著,天際線不會開洞。這一版命中 14 個
   節點(Timberland 字樣＋商標樹、兩組橘色看板字、Cosmed 字樣、巷90
   麵包店字樣),腳本會把命中清單印出來——藏掉什麼要看得見。
   **保留**道路名稱牌、捷運出口牌、水源市場招牌:那是這個路口的身分與
   公共設施,不是廣告。
3. **關掉機車待轉區** — 待轉區的白框與「機車待轉」字樣是模擬加畫的,
   不在實景量測的場景 GLB 裡,所以錄影時把 `hookTurn` 開關關掉。

字卡那一層也一樣:`Root.tsx` 的標題、字卡、免責聲明**一律不寫機型代號**,
統一用「機器人 / 指揮機器人」。檔名與元件名只是程式碼、不會進畫面。

場景換版後若店招節點一個都沒命中,腳本會直接報錯中止,不會默默錄出
帶著品牌的素材。

## 接到 Remotion

```bash
npx create-video@latest kbot-demo --blank
cd kbot-demo
cp <這個目錄>/remotion/KbotTrafficDemo.tsx src/
cp <這個目錄>/remotion/Root.tsx src/Root.tsx
cp <這個目錄>/kbot_traffic_30s.mp4 public/
cp <這個目錄>/kbot_traffic_30s_poster.jpg public/
npx remotion studio
```

`src/index.ts` 要指到 `./Root` 的 `RemotionRoot`(create-video 的空白樣板
預設就是這樣)。輸出:

```bash
npx remotion render KbotTrafficDemo out/kbot.mp4 --codec=h264
```

`Root.tsx` 的 `DURATION_IN_FRAMES` 要等於 `beats.json` 的 `durationFrames`,
不然片尾會被切掉或多出黑畫面。

## 要改的時候,可以直接丟給 AI 的提示詞

每一條都假設你人在 Remotion 專案裡,並且手上有 `kbot_traffic_30s.beats.json`。

**改字卡文案與時機**

> 我有一個 Remotion 專案,`src/Root.tsx` 裡的 `CAPTIONS` 陣列控制字卡。
> 附上 `kbot_traffic_30s.beats.json`,裡面每個 beat 有 `atFrame`。
> 請把字卡改成四段,分別對齊 `a_overview`、`b_walk`、`b_post`、`c_safe`
> 這四個 beat 的 `atFrame`,每段持續 4 秒,文案語氣改成「對外部客戶簡報」,
> 每段不超過 40 個字。只改 `CAPTIONS`,不要動元件本身。

**換視覺風格**

> 請把 `src/KbotTrafficDemo.tsx` 的字卡樣式從「左下角毛玻璃方塊」改成
> 「畫面下緣整條的漸層字幕條」,主色維持 `#38e6b0`,字體維持
> PingFang TC。保留現有的淡入淡出時序(進出各 12 格)與所有 props 介面。

**加片頭片尾**

> 請在 `src/Root.tsx` 加一個 3 秒的片頭 `<Series.Sequence>`:深色背景、
> 中央置中的標題「公館路口數位孿生」與副標,再接現有的影片合成,
> 最後加 2 秒片尾放免責聲明。`durationInFrames` 要一起加上片頭片尾的長度。

**做直式(社群)版本**

> 請新增一個 `KbotTrafficDemoVertical` 合成,1080×1920,沿用同一支影片:
> 用 `<AbsoluteFill>` 把 `OffthreadVideo` 以 `objectFit: 'cover'` 置中裁切,
> 字卡改成置中、字級放大 1.4 倍,上下各留 240px 安全區。

**加數據角標**

> 請在畫面右上角加一個常駐的數據角標,顯示「碰撞 0 件 / 60 FPS /
> 13 組號誌」,樣式跟現有字卡同一套(毛玻璃、`#38e6b0` 主色),
> 從第 0 格顯示到片尾,並在最後 1 秒淡出。

**改成有旁白配音的版本**

> 我會提供一個 `narration.mp3`。請在合成裡用 `<Audio>` 掛上它,
> 並把 `CAPTIONS` 每段的 `fromFrame` 改成對齊我給的旁白逐字稿時間碼,
> 同時把背景影片音量設為 0(這支影片本來就沒有聲軌)。

**把走路那段加速(它佔了半支片)**

> 走路那段從第 68 格到第 503 格,佔了 30 秒裡的 14.5 秒。請在
> `src/KbotTrafficDemo.tsx` 把這一段用 `<OffthreadVideo>` 的
> `playbackRate` 或分段 `<Sequence>` 做成 1.6 倍速,其餘維持原速,
> 並把後面所有 `CAPTIONS` 的 `fromFrame` 與 `durationInFrames` 一起換算,
> 最後更新 `Root.tsx` 的 `durationInFrames`。

**重錄底片(不是 Remotion,是回到模擬器)**

> 我要換分鏡:改成「鳥瞰 → 待轉區(機車兩段式左轉)→ 行穿線」。
> 請改 `mujoco/record_demo_video.mjs` 的錄影段落,維持事件驅動
> (等 `__trafficDirectorDebug.snapshot()` 的狀態變化才切鏡,不要用死時間),
> 待轉區那段要等到 `__lane90States()` 出現 `state === 'hook_wait'` 才算數,
> 並把新的 beat 寫進 `beats.json`。

## 已知限制

- 這支片沒有聲軌。
- 錄影是在 headless Chrome + SwiftShader 軟體渲染下跑的,平均約 40 fps
  取樣後重取樣成 30 fps;實機用 GPU 開會更順,但畫面內容一樣。
- 影片裡沒有機車待轉區(模擬加畫的標線,錄影時關掉了);想要有的話把
  `record_demo_video.mjs` 的 `setSwitch("hookTurn", ...)` 改回 `true`。
- 影片裡的路口是**封閉場域展示**,不是公共道路實際交通指揮系統。
