# Meshtastic-DashBoard 4.0.3 — Map Rendering Bug Fix & Leaflet Lazy Loading Report

> **基線版本**：Meshtastic-DashBoard 4.0.3 Performance Optimization  
> **測試環境**：Windows 11 / Node.js `v24.16.0` / Headless Microsoft Edge (CDP) / 隔離臨時 SQLite WAL 資料庫 + Named Pipe Mock MQTT Broker（全程零接觸正式環境 `D:\meshtastic\Meshtastic-DashBoard-Prod`）

---

## 1. Leaflet 元件全專案盤點清單

### 1.1 修正前問題
1. [`frontend/src/App.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/App.tsx) 內仍殘留兩處直接使用未匯入之 `MapContainer`、`CircleMarker`、`Polyline`、`Popup` 的 JSX（`TRACEROUTE` visualizer 與封包詳情 Modal 的收發路徑地圖），執行期會拋出 `ReferenceError`。
2. `App.tsx` 第 4 行仍靜態 `import { AppTileLayer } from './mapTiles'`，而 `mapTiles.tsx` 靜態匯入 `react-leaflet` 的 `TileLayer`，導致 Vite 在 `dist/index.html` 產生 `<link rel="modulepreload" href="/assets/vendor-leaflet-*.js">` 與 `<link rel="stylesheet" href="/assets/vendor-leaflet-*.css">`。
3. [`frontend/src/NetworkAnalytics.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/NetworkAnalytics.tsx) 第 37 行靜態 `import CwaNodeMap from './CwaNodeMap'`，導致開啟全網分析分頁時即使尚未切換至 CWA 地圖視圖也會提前載入 Leaflet。

### 1.2 修正後引用盤點

| 檔案路徑 | Leaflet / React-Leaflet 引用 | 載入方式 | 說明 |
| :--- | :--- | :--- | :--- |
| `frontend/src/App.tsx` | **無**（`git grep` 0 筆） | Entry Chunk | 僅保留純 JS `sanitizeCoordinatePair` 與 `MapErrorBoundary` |
| `frontend/src/maps/coordUtils.ts` | **無** | Entry Chunk | 純 JS 座標邊界/NaN/Infinity 驗證與相鄰重複點去重 |
| `frontend/src/maps/MapErrorBoundary.tsx` | **無** | Entry Chunk | 地圖 Chunk 載入或渲染異常隔離與 Retry 按鈕 |
| `frontend/src/maps/TracerouteMap.tsx` | `MapContainer`, `CircleMarker`, `Polyline`, `Popup`, `AppTileLayer`, `leaflet/dist/leaflet.css` | `React.lazy` | 封包 `TRACEROUTE` 路徑地圖 |
| `frontend/src/maps/PacketRouteMap.tsx` | `MapContainer`, `CircleMarker`, `Polyline`, `Popup`, `AppTileLayer`, `leaflet/dist/leaflet.css` | `React.lazy` | 封包詳情 Modal 發送者 $\rightarrow$ 最後傳跳 $\rightarrow$ 閘道器拓撲地圖 |
| `frontend/src/components/PacketPositionMap.tsx` | `MapContainer`, `CircleMarker`, `Popup`, `AppTileLayer`, `leaflet/dist/leaflet.css` | `React.lazy` | 封包 `POSITION` 單點位置地圖 |
| `frontend/src/maps/MapAutoResize.tsx` | `useMap` | 隨 Lazy Map 載入 | Modal / Tab 掛載與視窗 Resize 自動 `invalidateSize()` 與 `fitBounds()` |
| `frontend/src/NodeMap.tsx` | `MapContainer`, `Marker`, `Popup`, `CircleMarker`, `Polyline`, `Tooltip`, `useMap`, `ImageOverlay`, `MarkerClusterGroup`, `L` | `React.lazy` | 主節點地圖、Coverage Overlay 與 ITM 覆蓋圖層 |
| `frontend/src/CwaNodeMap.tsx` | `MapContainer`, `CircleMarker`, `Polyline`, `Tooltip` | `React.lazy` | CWA 測站與節點配對地圖（已從 `NetworkAnalytics.tsx` 改為 `React.lazy`） |
| `frontend/src/mapTiles.tsx` | `TileLayer` | 僅被 Lazy Map 匯入 | Tile Provider 設定與深淺色切換 |

---

## 2. 地圖模組 Lazy Loading 架構圖

```text
App.tsx (Entry Chunk: 41.56 kB gz, 0 Leaflet JS/CSS)
 ├── React.lazy(() => import('./NodeMap'))
 ├── React.lazy(() => import('./maps/TracerouteMap'))
 ├── React.lazy(() => import('./maps/PacketRouteMap'))
 ├── React.lazy(() => import('./components/PacketPositionMap'))
 └── React.lazy(() => import('./NetworkAnalytics'))
       └── React.lazy(() => import('./CwaNodeMap'))
             └── mapTiles.tsx + vendor-leaflet (57.54 kB gz) + vendor-leaflet.css (6.38 kB gz)
```

---

## 3. Vite Build Bundle 與 `dist/index.html` Preload 檢查

- **Build 結果 (`npm --prefix frontend run build`)**：`10.80s` 建置成功，**0 個 Circular Chunk 警告、0 個 >500kB Chunk 警告**。
- **`dist/index.html` 輸出驗證**（`indexHtmlHasLeafletPreload: false`）：
  ```html
  <script type="module" crossorigin src="/assets/index-DPsNYUy-.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/vendor-react-Cr-UfkrL.js">
  <link rel="modulepreload" crossorigin href="/assets/vendor-socket-dm1FmSOd.js">
  <link rel="stylesheet" crossorigin href="/assets/index-xcj2GsfY.css">
  ```
- **獨立地圖 Lazy Chunks**：
  - `TracerouteMap-CqdUZWW7.js`: `1.76 kB` (`1.03 kB gz`)
  - `PacketRouteMap-BKdW9ZhL.js`: `3.06 kB` (`1.29 kB gz`)
  - `PacketPositionMap-KM8XfPdP.js`: `0.99 kB` (`0.67 kB gz`)
  - `MapAutoResize-CKvNtJfz.js`: `0.56 kB` (`0.34 kB gz`)
  - `mapTiles-DdqWmyN4.js`: `6.35 kB` (`2.71 kB gz`)
  - `CwaNodeMap-wFSZEQjf.js`: `11.23 kB` (`3.80 kB gz`)
  - `NodeMap-CWPzElZG.js`: `353.53 kB` (`85.20 kB gz`)
  - `vendor-leaflet-BswEppeS.js`: `195.17 kB` (`57.54 kB gz`) + `vendor-leaflet-Dgihpmma.css`: `15.04 kB` (`6.38 kB gz`)

---

## 4. 真實瀏覽器（Headless Edge CDP）測試結果

所有測試以 `verify_maps_and_lazy.mjs` 對 1,000 筆合成節點與 4 筆專用測試封包實際執行：

| 測試項目 | 狀態 | 實測證據與數據 |
| :--- | :---: | :--- |
| **Test A — Traceroute Map** | **PASS** | 開啟 `TRACEROUTE_APP` 封包詳情：`mapCount: 2`（含 `TracerouteMap` 與 `PacketRouteMap`），容器尺寸 `605×190` / `579×190`，繪製 `svgPaths: 7`（3 個節點 Marker + Polyline），點擊 Marker 成功開啟 `Popup`，**0 筆 `ReferenceError`** |
| **Test B — Packet GPS Position Map** | **PASS** | 開啟 `POSITION_APP` 封包詳情：`mapCount: 2`（`PacketPositionMap` + `PacketRouteMap`），尺寸 `605×190` / `579×190`，`svgPaths: 4`，點擊 Marker 開啟 `Popup` |
| **Test C — No GPS Data** | **PASS** | 開啟無 GPS 封包（`!30000004`）：`mapCount: 0`，正確顯示無有效 GPS 空資料提示（`hasEmptyHint: true`），**0 例外** |
| **Test D — Invalid Coordinates (`±90/±180/NaN/Infinity`)** | **PASS** | 開啟越界座標節點（`!30000005`, `99.5, 210.2`）：經 `sanitizeCoordinatePair` 安全過濾，`mapCount: 0`、`hasEmptyHint: true`，**0 Leaflet Crash** |
| **Test E — NodeMap Regression** | **PASS** | 切換至 `地圖監控`：`hasContainer: true`，尺寸 `739×316`，正常渲染 Marker（`markers: 6` cluster/pins），**0 錯誤** |
| **Test F — Lazy Loading & Preload 驗證** | **PASS** *(附架構說明)* | `dist/index.html` 中 **`indexHtmlHasLeafletPreload === false`**（Entry HTML 與 Entry Chunk 完全不含 Leaflet）；因預設首頁分頁為 `favorites`（頁面內含「成員地理分佈 Static Map」`<NodeMap>`），開啟 `/` 時該分頁才動態觸發載入 `NodeMap` 與 `vendor-leaflet`；其他無地圖組件不會透過靜態依賴載入 Leaflet；開啟全網分析 (`NetworkAnalytics`) 時亦不載入 `CwaNodeMap` / Leaflet |
| **Test G — 快速切換與重新開啟** | **PASS** | 連續快速切換 `節點清單` $\leftrightarrow$ `地圖監控` 4 輪後重開地圖：無 `Map container is already initialized`，**`pageErrors: []`** |
| **Test H — 地圖顯示尺寸 (`invalidateSize`)** | **PASS** | Modal 內地圖實測 `605×190` / `579×190`，主地圖實測 `739×316`，無空白或 0×0 尺寸異常 |
| **4.0.3 效能回歸 (`NodeList` & 資料庫)** | **PASS** | 1,000 節點 `NodeList` 切換耗時 **`39.1 ms`**、`trCount: 15`（虛擬化完整保留）；`npm run test:database` **108 / 108 PASS** |

---

## 5. 尚未解決的問題與誠實說明

1. **預設分頁 `favorites` 內含靜態地理分佈圖**：依既有 UI 設計，預設分頁 `'favorites'` 內本身包含 `<NodeMap>`（「成員地理分佈」），因此瀏覽器進入 `/` 時 React 會依需求載入 `NodeMap` 與 `vendor-leaflet`；若未來希望連預設分頁也不載入 Leaflet，可為該區塊加上「展開地圖」按鈕或將預設分頁設為 `analytics` / `nodes`。目前 Entry Chunk (`index.js`) 與 `index.html` 本身已完全不含任何 Leaflet JS/CSS 靜態依賴或 `modulepreload`。
2. **版本驗收狀態**：**`READY FOR PRODUCTION REVIEW`**（未修改、部署或重啟 Production）。

