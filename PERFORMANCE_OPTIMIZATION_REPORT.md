# Meshtastic-DashBoard 4.0.3 — Performance Optimization Report

> **基線版本**：Meshtastic-DashBoard 4.0.2 (`READY FOR PRODUCTION REVIEW`)  
> **優化版本**：Meshtastic-DashBoard 4.0.3 Performance Optimization  
> **測試環境**：Windows 11 / Node.js `v24.16.0` / Headless Microsoft Edge (CDP) / 本地隔離臨時 SQLite WAL 資料庫 + Named Pipe Mock MQTT Broker（全程零接觸正式環境 `D:\meshtastic\Meshtastic-DashBoard-Prod`）  
> **測試樣本**：每組規模（`100`、`500`、`1,000`、`5,000` 合成節點）分別執行 **5 次冷快取（Cold Cache）** 與 **5 次熱快取（Warm Cache）** 量測，統計 **Median（中位數）** 與 **P95**。

---

## 1. 第一階段診斷：4.0.2 已確認瓶頸

在修改程式碼前，先以真實 Headless Edge（CDP）量測 4.0.2 基線，確認以下六大瓶頸：

1. **全頁阻塞遮罩 (`appLoading`)**：`App.tsx` 在 5 個初始 API（`/api/node-status`、`/api/neighbors`、`/api/gateways/leaderboard`、`/api/sys-status`、`/api/nodes/activity`、`/api/packets`、`/api/packets/count`）全部完成前，以全螢幕 `appLoading` 遮罩阻擋整個 Dashboard Shell 顯示。
2. **重複初始化與重複 API 請求（15 筆初始請求含 3 筆重複）**：
   - `App.tsx` 核心初始化 `useEffect` 誤將 `globalPacketsCurrentPage`、`globalFilter`、`favPacketsCurrentPage`、`favLogFilter` 列入依賴陣列，導致換頁或改篩選條件時重新初始化整個 Dashboard 與重複綁定 Socket.IO。
   - `/api/packets?limit=20&page=1` 與 `/api/packets/count?limit=20&page=1` 在啟動時被重複呼叫 2 次；`/api/coverage/itm-info` 亦被呼叫 2 次。
   - `/api/coverage/griddata`、`/api/traceroute/paths`、`/api/traceroute/latest` 於首頁啟動時即提前執行，即使用戶尚未開啟地圖或拓撲分頁。
3. **Node List 無虛擬化渲染與非法 `<tr>` 結構**：
   - `filteredNodes.map()` 一次將所有節點渲染進 DOM：1,000 節點產生 **1,000 列 `<tr>` / 23,198 個 DOM 節點**；5,000 節點產生 **5,000 列 `<tr>` / 115,198 個 DOM 節點**，切換分頁造成 **1,216.1 ms（P95 1,693.7 ms）** 卡頓與 **1,339 ms Long Tasks**。
   - `filteredNodes` 每次計算皆以 `nodes.map(n => ({ ...n, is_favorite: ... }))` 複製全體節點物件，5,000 節點搜尋延遲達 **168.6 ms（P95 200.8 ms）**。
   - 原 Role `<span>` 直接置於 `<tr>` 內而未包覆 `<td>`。
4. **每秒全域重繪 (`displayedUptime`) 與 `favInterval` 重建**：
   - `displayedUptime` 位於根元件 `App.tsx`，每秒觸發 `setDisplayedUptime` 造成整頁每秒重繪一次。
   - `favInterval` `useEffect` 依賴 `nodes`，每次 WebSocket 更新節點皆拆毀並重建 60 秒計時器。
5. **WebSocket `setNodes()` 重複重建陣列**：
   - 單一 1.5 秒 Flush 週期內同時對 `pendingNodeUpdates` 與 `pendingPackets` 呼叫兩次 `setNodes()`，且無淺層比對，導致未變更欄位亦重建節點參考。
6. **Vite Bundle 單一肥大 Chunk**：
   - 4.0.2 打包產出 `vendor-BxCC-GJd.js` 達 **1,568.36 kB（gzip 464.74 kB）**，`App.tsx` 靜態匯入 `leaflet`、`react-leaflet`、`lodash`、`SolarForecastCard`、`RFCoverageCard`、`PacketTypePieChart`、`NodeRecoveryQR`，冷載入 JS 傳輸達 **532,601 bytes**。

---

## 2. 4.0.2 vs. 4.0.3 實測效能對照表

### 2.1 首頁載入、API 請求與 Bundle 對照（5,000 節點規模，5 次實測）

| 指標 | 4.0.2 冷快取 (Median / P95) | 4.0.3 冷快取 (Median / P95) | 改善幅度 | 4.0.2 熱快取 (Median / P95) | 4.0.3 熱快取 (Median / P95) | 改善幅度 |
|---|---:|---:|---:|---:|---:|---:|
| **首頁 FCP (ms)** | 268.0 / 332.0 | **108.0 / 308.0** | **-59.7%** | 180.0 / 192.0 | **100.0 / 124.0** | **-44.4%** |
| **首頁 LCP (ms)** | 524.0 / 816.0 | **148.0 / 420.0** | **-71.8%** | 404.0 / 416.0 | **140.0 / 172.0** | **-65.3%** |
| **Dashboard Interactive (ms)** | 248.9 / 317.3 | **120.6 / 294.3** | **-51.5%** | 180.2 / 193.0 | **97.2 / 123.4** | **-46.1%** |
| **DOM Content Loaded (ms)** | 233.9 / 260.9 | **48.9 / 94.7** | **-79.1%** | 135.2 / 144.5 | **35.8 / 57.3** | **-73.5%** |
| **Initial Data Ready (ms)** | 485.9 / 765.5 | **260.9 / 444.5** | **-46.3%** | 369.1 / 384.8 | **227.7 / 248.1** | **-38.3%** |
| **冷載入 JS 傳輸量 (bytes)** | 532,601 | **251,253** | **-52.8%** | 1,200 | 1,800 | (304快取) |
| **首頁初始 API 請求數** | 15 | **9** | **-40.0%** | 15 | **9** | **-40.0%** |
| **首頁重複 API 請求數** | 3 | **0** | **-100.0%** | 3 | **0** | **-100.0%** |

### 2.2 Node List 切換、DOM 規模與搜尋效能對照（各規模 5 次實測）

| 節點規模 | 指標 | 4.0.2 (Cold / Warm Median) | 4.0.3 (Cold / Warm Median) | 4.0.2 P95 (Cold / Warm) | 4.0.3 P95 (Cold / Warm) | 改善幅度 (Cold Median) |
|---|---|---:|---:|---:|---:|---:|
| **100 Nodes** | 切換耗時 (ms) | 45.6 / 45.9 | **30.9 / 25.2** | 66.4 / 52.4 | **38.0 / 31.8** | **-32.2%** |
| **100 Nodes** | `<tr>` 列數 / 總 DOM | 100 / 2,498 | **15 / 625** | - | - | **-85.0% `<tr>`** |
| **500 Nodes** | 切換耗時 (ms) | 143.8 / 137.0* | **35.9 / 29.6** | 179.0 / 160.0* | **48.6 / 37.1** | **-75.0%** |
| **500 Nodes** | 切換 Long Task (ms) | 99.0 | **0.0** | 121.0 | **0.0** | **-100.0%** |
| **500 Nodes** | `<tr>` 列數 / 總 DOM | 500 / 11,698 | **15 / 1,025** | - | - | **-97.0% `<tr>`** |
| **1,000 Nodes** | 切換耗時 (ms) | 260.3 / 258.2 | **36.8 / 36.4** | 401.7 / 283.2 | **68.7 / 41.6** | **-85.9%** |
| **1,000 Nodes** | 切換 Long Task (ms) | 240.0 / 223.0 | **0.0 / 0.0** | 364.0 / 259.0 | **56.0 / 0.0** | **-100.0%** |
| **1,000 Nodes** | `<tr>` 列數 / 總 DOM | 1,000 / 23,198 | **15 / 1,525** | - | - | **-98.5% `<tr>`** |
| **5,000 Nodes** | 切換耗時 (ms) | 1,216.1 / 1,285.9 | **45.2 / 35.7** | 1,693.7 / 1,648.0 | **64.8 / 50.2** | **-96.3% (26.9x)** |
| **5,000 Nodes** | 切換 Long Task (ms) | 1,339.0 / 1,400.0 | **0.0 / 0.0** | 1,817.0 / 1,768.0 | **50.0 / 0.0** | **-100.0%** |
| **5,000 Nodes** | `<tr>` 列數 / 總 DOM | 5,000 / 115,198 | **15 / 5,525** | - | - | **-99.7% `<tr>`** |
| **5,000 Nodes** | 搜尋過濾耗時 (ms) | 168.6 / 165.8 | **31.6 / 27.8** | 200.8 / 182.1 | **40.2 / 31.0** | **-81.3%** |

---

## 3. 核心實作摘要

1. **修改與新增檔案清單**：
   - 新增 [`frontend/src/apiCache.ts`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/apiCache.ts)：輕量級 TTL + 同 URL In-Flight 去重 + `AbortSignal` 支援快取層。
   - 新增 [`frontend/src/components/SystemUptime.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/components/SystemUptime.tsx)：獨立每秒運行時間計時器（消除根元件 `App` 每秒全域重繪）。
   - 新增 [`frontend/src/components/NodeList.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/components/NodeList.tsx) 與 [`frontend/src/components/NodeListRow.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/components/NodeListRow.tsx)：Windowed 虛擬化表格（固定 `57px` 列高 + `overscan=8` + `requestAnimationFrame` 滾動節流 + `ResizeObserver`）、`React.memo` 單列隔離、修正 Role `<td>` 表格結構、移除全陣列物件複製。
   - 新增 [`frontend/src/components/PacketPositionMap.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/components/PacketPositionMap.tsx)：將 `leaflet` / `react-leaflet` 從 `App.tsx` 靜態匯入抽離為動態懶加載。
   - 修改 [`frontend/src/App.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/App.tsx)：
     - 移除 `appLoading` 全螢幕遮罩改為 Progressive Loading（Shell 立即渲染）。
     - 拆分 `useEffect` 責任並加入 `AbortController`，消除 `/api/packets` 與 `/api/coverage/itm-info` 重複請求；`/api/coverage/griddata`、`/api/traceroute/*` 延遲至開啟 `map` / `topology` 分頁才載入；`favInterval` 改用 `nodesRef` 不再因 WebSocket 更新而重建。
     - 合併 WebSocket 1.5s Batch Flush 至單次 `setNodes()`，對每筆更新執行淺層比對，無實質異動時保留原陣列與未變動節點物件參考。
     - 懶加載 `SolarForecastCard`、`RFCoverageCard`、`PacketTypePieChart`、`NodeRecoveryQR`、`PacketPositionMap`，移除未使用的 `lodash` 匯入。
   - 修改 [`frontend/src/NodeMap.tsx`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/NodeMap.tsx)：共用 `fetchJsonCached('/api/coverage/itm-info')`。
   - 修改 [`frontend/vite.config.ts`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/vite.config.ts)：切分 `vendor-react`、`vendor-socket`、`vendor-leaflet`，消除 `Circular chunk` 警告與 `500 kB+` 大塊警告。
   - 修改 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：新增非敏感 `[API_PERF]` 計時診斷（`>=50ms` 或 `API_PERF_LOG=1` 記錄，不記錄敏感資料），並將開機 `warmCache` 調整為優先預熱 `'7d'`，減少啟動瞬間 SQLite 併發壓力。

---

## 4. Vite Build 與回歸測試結果

1. **Vite Production Build (`npm --prefix frontend run build`)**：
   - 建置時間：`9.86s`，**0 個 Circular Chunk 警告、0 個 >500kB Chunk 警告**。
   - `index.html` 預載入核心降至 `index` (`44.17 kB gz`) + `vendor-react` (`45.73 kB gz`) + `vendor-socket` (`13.02 kB gz`) + `vendor-leaflet` (`57.54 kB gz`)；圖表 (`CartesianChart 107.67 kB gz`)、地圖 (`NodeMap 85.15 kB gz`)、拓撲 (`TopologyGraph 59.45 kB gz`) 與分析 (`NetworkAnalytics 29.90 kB gz`) 全數按需載入。
2. **前端功能回歸測試 (`verify_4_0_3_functional.mjs`)**：
   - `uptimeTicked: true`、`nodeListCountText: true`、`initialTrCount: 15`、虛擬化滾動至 `FuncNode-0430`、`ROUTER` 篩選 (`共 334 筆節點`)、點擊列開啟詳情分頁並載入懶加載卡片、`最愛節點`/`地圖監控`/`封包觀察`/`閘道監控`/`頻道對話`/`全網分析` 全分頁切換，**`PAGE_ERRORS: []`（0 執行期錯誤）**。
3. **4.0.2 資料庫核心測試回歸 (`npm run test:database`)**：
   - **108 / 108 `it()` 測試全數通過（108 PASS, 0 FAIL, 0 CANCELLED, 0 SKIPPED, 17.23s）**，4.0.2 所有架構與保證 100% 保留未退化。

---

## 5. 已知限制與後續建議

1. **5,000 節點下的其他隱藏 `<select>` DOM 節點**：`totalDomNodes` 在 5,000 節點時為 `5,525`（相較 4.0.2 的 `115,198` 已下降 **95.2%**），其中多出的 ~4,900 個節點來自 `App.tsx` 其他分頁或篩選下拉選單中的選項，不影響 `NodeList` 虛擬化效能。
2. **冷快取首頁 `homeLongTasks`**：5,000 節點時冷載入偶發 1 次 ~84ms Long Task（主要來自 `/api/node-status` 5,000 筆 JSON 解析與 `nodeMap` 建立），未來若節點超過 10,000 筆可考慮後端分頁或精簡 `/api/node-status` 回傳欄位。
3. **版本狀態**：**`READY FOR PRODUCTION REVIEW`**（僅於 Dev 環境完成驗證，未對 Production 進行任何修改、重啟或部署）。

