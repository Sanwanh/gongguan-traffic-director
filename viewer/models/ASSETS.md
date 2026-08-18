# viewer/models — 第三方資產來源與授權

本檔案記錄 `viewer/models/` 底下**外部引入**資產的來源 URL、授權、SHA256 與
我方的修改內容。專案硬規則:零 CDN、完全離線;任何外部資產必須 vendor 進 repo
並在此登錄。授權不明的一律不得引入。

專案自製資產(`gongguan_v54_environment.glb`、`gongguan_v54_signal_aspects.glb`、
`kbot_traffic_director.glb`)不在本檔案範圍內。

---

## 1. `pedestrian_walker.glb` — 行人擬物化模型

| 項目 | 值 |
| --- | --- |
| 檔案 | `viewer/models/pedestrian_walker.glb` |
| 大小 | 294,756 bytes (287.8 KB) |
| SHA256 | `5df69332f55f6d03100b6b8a266fd14c8730a777a351de123d23fa5d479da75e` |
| 三角形 | 4,672 |
| 頂點 | 3,419 |
| 骨架 | 19 joints,單一 skin |
| 動畫 | `Walk` (2.000 s)、`Idle` (3.200 s) |
| 材質 | 5 個,無貼圖 |
| glTF 驗證 | Khronos gltf-validator 2.0.0-dev.3.10:**0 errors** |

### 1.1 上游來源

| 項目 | 值 |
| --- | --- |
| 名稱 | Cesium Man (`CesiumMan`) |
| 來源 URL | <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan> |
| 下載 URL | <https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CesiumMan/glTF-Binary/CesiumMan.glb> |
| 上游 commit | `723ffc6706725b618b8c14ceb82e3e6904b08a76` (2026-08-14) |
| 下載檔 SHA256 | `b7001eaeea8254bd44773bcd247e78696d94169388fbb2a1800fc69434e777d9` (438,044 bytes) |
| 原作者 / 版權人 | Cesium (2017) |
| 授權 | **CC-BY-4.0** (SPDX: `CC-BY-4.0`) |
| 授權全文 | <https://creativecommons.org/licenses/by/4.0/legalcode>,已 vendor 為 `LICENSE-CC-BY-4.0.txt` |
| 上游授權檔 | 已 vendor 為 `UPSTREAM-CesiumMan-LICENSE.md` |

上游 `metadata.json` 的 `legal` 欄位原文(決定性依據):

```json
"legal": [
  { "license": "CC-BY-4.0", "artist": "Cesium", "year": "2017", "owner": "Cesium",
    "what": "Everything", "spdx": "CC-BY-4.0" },
  { "license": "LicenseRef-LegalMark-Cesium", "artist": "Non-copyrightable logo",
    "year": "2015", "owner": "Cesium", "what": "Cesium logo",
    "text": "Cesium Trademark or Logo" }
]
```

上游 `LICENSE.md` 原文重點:

> * All files directly associated with the model including all text, image and binary files:
>   * [Creative Commons Attribution 4.0 International] [SPDX license identifier: "CC-BY-4.0"]
>   * [Cesium Trademark or Logo](../../LICENSES/LicenseRef-LegalMark-Cesium.txt)
>
> This license excludes logos and associated trademarks.

### 1.2 ⚠️ 商標問題與處理(必讀)

上游 `CesiumMan.glb` 內含一張 1024×1024 JPEG,內容是**整片 Cesium 商標 logo**
包覆在人體上(不是衣服、不是皮膚貼圖)。上游授權明文把 logo/商標**排除在
CC-BY 授權之外**,`metadata.json` 的 `summary` 也標註
`[Issues: non-Khronos mark]`。

因此:**幾何 / 骨架 / 動畫是乾淨的 CC-BY-4.0,但貼圖不是。**

處理方式:本專案的衍生檔**完整移除**該貼圖與其 image / sampler / texture /
原始 TEXCOORD_0,只使用 CC-BY-4.0 的幾何、骨架與動畫。成品中**不含任何
Cesium 商標**。這同時也解決了「行人要能換色」的需求。

### 1.3 我方修改內容(CC-BY-4.0 §3(a)(1)(B) 要求標示修改)

1. 移除 Cesium logo 貼圖及其 image / sampler / texture 與原始 TEXCOORD_0。
2. 把單一 primitive 依身體部位切成 5 個 primitive,各自帶一個**無貼圖**材質
   (`PedSkin` / `PedHair` / `PedShirt` / `PedPants` / `PedShoes`),
   以支援每人不同衣著顏色。跨區三角形用固定優先序(hair > shirt > pants > shoes > skin)
   指派而非多數決,讓每條分界線剛好落在模型自己的水平 edge loop 上、不會出現鋸齒下擺;
   分界處的頂點做了複製,讓調色盤 UV 不會跨區內插(3,273 → 3,419,+4.5%)。
3. 重寫 TEXCOORD_0 為 8 格調色盤座標(`u = (regionIndex + 0.5) / 8`, `v = 0.5`),
   供未來合併成單一 draw call 時使用。**目前 5 材質路徑用不到它**,
   所以 gltf-validator 會報 5 筆 `UNUSED_OBJECT` 資訊訊息,屬預期。
4. 原本未命名的走路動畫命名為 `Walk`,時間軸平移至 t=0 起算,
   並補上一格 wrap keyframe,成為精確的 2.000 s 循環。
5. 新增 `Idle` clip:取走路循環中所有 joint 旋轉的平均四元數(sign-aligned)
   作為中性站姿,加上 root 的呼吸起伏,並上抬 0.0654 m 讓腳底剛好踩在 y=0。

頂點座標、法線、蒙皮權重、joint 階層與 inverse bind matrices **完全沿用原檔數值**。

`NODE_SKINNED_MESH_NON_ROOT` 這筆 validator warning 是**上游原檔就有的**
(原檔驗證結果同樣是 0 errors / 1 warning,同一筆),非本次修改引入。

### 1.4 重製方式

`viewer/models/build_pedestrian_walker.mjs` 是自給自足的 node 腳本(無外部相依),
可從上游檔重現出**位元組完全相同**的成品:

```sh
curl -sL -o /tmp/CesiumMan.glb \
  https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CesiumMan/glTF-Binary/CesiumMan.glb
node viewer/models/build_pedestrian_walker.mjs /tmp/CesiumMan.glb viewer/models/pedestrian_walker.glb
# -> sha256 5df69332f55f6d03100b6b8a266fd14c8730a777a351de123d23fa5d479da75e
```

### 1.5 必須顯示的姓名標示(CC-BY-4.0 義務)

只要專案公開展示(demo、錄影、簡報、網頁),需在製作說明 / credits 保留:

> Pedestrian model derived from **"Cesium Man"** by **Cesium**, licensed under
> [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
> Source: <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan>
> Modified: trademark texture removed; mesh split into body-region materials;
> Idle clip synthesized.

同樣字串也已寫進 GLB 的 `asset.copyright` 與 `asset.extras`,不會隨檔案流失。

CC-BY-4.0 允許商業使用與改作,惟須保留上述姓名標示並標明修改。**不得**暗示
Cesium 為本專案背書。

---

## 2. `vendor/examples/jsm/utils/SkeletonUtils.js`

| 項目 | 值 |
| --- | --- |
| 檔案 | `viewer/vendor/examples/jsm/utils/SkeletonUtils.js` |
| 來源 URL | <https://github.com/mrdoob/three.js/blob/r170/examples/jsm/utils/SkeletonUtils.js> |
| 版本 | three.js **r170**,與 `vendor/VERSION.txt` (`three@0.170.0`) 一致 |
| 授權 | **MIT** (three.js,Copyright © 2010-2024 three.js authors) |
| 授權全文 | <https://github.com/mrdoob/three.js/blob/r170/LICENSE> |

引入原因:`THREE.Object3D.clone()` **不會**重新綁定骨架,複製 SkinnedMesh 必須用
`SkeletonUtils.clone()`。此檔只 `import ... from 'three'`,解析到既有 importmap
的 `./vendor/three.module.js`,**不含任何外部網路請求**,符合零 CDN 規則。

---

## 檢核紀錄

* Khronos gltf-validator 2.0.0-dev.3.10:`pedestrian_walker.glb` **0 errors**、
  1 warning(上游繼承)、5 infos(刻意保留的 palette UV)。
* 實機瀏覽器驗收(headless Chrome + 站上的 three r170 + 既有 importmap):
  載入 4.2 ms、**0 console errors**、5 SkinnedMesh、2 clips、bind box
  `y ∈ [0, 1.5066]`。
* 30 人壓測(SwiftShader 軟體算圖,1280×720):150 draw calls、140,160 triangles、
  **5** 個 geometry(完全共用)、0.42 ms/frame。
