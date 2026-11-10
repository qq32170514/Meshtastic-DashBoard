# Meshtastic DashBoard 開發進度與架構備忘錄 (DEV_PROGRESS.md)

> 本文件記錄專案最新的功能實現、架構設計、核心模組與當前進度。每次啟動新對話或換環境時，AI 助手與開發者皆可直接查閱本文件快速同步上下文。

---

## 📌 當前開發環境與規則

1. **環境嚴格隔離**：
   - 開發環境路徑：`d:\meshtastic\Meshtastic-DashBoard-Dev`
   - 生產環境路徑：`d:\meshtastic\Meshtastic-DashBoard-Prod`
   - **重要守則**：所有修改、編譯、執行與測試一律在 `Dev` 目錄內進行。**嚴禁**擅自修改或重啟 `Prod` 環境的 PM2 服務，除非使用者明確下達發佈至生產的指令。
2. **本地開發服務運行配置**：
   - **後端 API 伺服器**：`npm start`（監聽 `http://localhost:3002`）
   - **前端 Vite 伺服器**：`npm run dev`（位於 `frontend/` 目錄，監聽 `http://localhost:5173`）
   - **本地資料庫**：`meshtastic.db`（SQLite 格式）

---

## 🚀 最新重大功能與模組架構

### 1. 全台 3D 地形電波覆蓋模擬 (Longley-Rice ITM 離線烘焙圖層)
- **架構目錄**：`rf-engine/`
  - `splat_driver.mjs` / `splat_driver.wasm`：移植自官方 Meshtastic Site Planner 的 C/C++ Longley-Rice ITM（不規則地形傳播模型）WASM 引擎。
  - `worker.mjs`：多線程 Worker，每個 Worker 獨立載入 WASM 實例，透過 Zero-copy Transferable ArrayBuffer 回傳訊號矩陣。
  - `terrain.mjs`：自動從 AWS S3 Open Data Skadi 下載台灣與澎湖覆蓋範圍的 SRTM 高程切片（`N21E120` 至 `N25E122`），重抽樣至 1200×1200 SDF 格式並快取於 `rf-engine/terrain_cache/`。
  - `png_encoder.mjs`：純 Node.js RGBA 轉 PNG 壓縮編碼器。
  - `bake.mjs`：採用多核心並行加速架構（預設 5 個 Worker 線程），自 `meshtastic.db` 撈取活躍之基站（優先固定中繼、路由器與基地台），聚類出全台唯一地理站點，每站以 35km 半徑計算中央山脈繞射衰減，並以 Max-RSSI 合成為 1160×1480 像素電波熱區圖。
  - **產出檔案**：
    - `public/coverage/taiwan_coverage.png` (約 425KB)
    - `public/coverage/taiwan_coverage.json` (包含即時站點座標、覆蓋邊界與時間戳記)
    - 自動同步至 `frontend/public/coverage/`
- **後端整合 (`index.js`)**：
  - 靜態託管：`/coverage` 目錄。
  - API：`GET /api/coverage/itm-info` 提供圖層狀態與站點數。
  - API：`POST /api/coverage/rebuild` 供手動或外部排程觸發重新計算。
  - 定時排程：每日凌晨 04:00 透過 `node-cron` 自動更新全台最新覆蓋。
- **前端介面 (`frontend/src/`)**：
  - [App.tsx](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/App.tsx)：頂部地圖標籤列整合「**全台電波覆蓋**」開關按鈕與即時站點數徽章，與 `節點地圖`、`覆蓋範圍`、`跳轉分析`、`拓撲邏輯連線` 並列。
  - [NodeMap.tsx](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/NodeMap.tsx)：使用 Leaflet `ImageOverlay` 疊加覆蓋圖層，具備平滑淡入淡出及右下角專屬 ITM 訊號圖例。

### 2. 官方 Site Planner 單站互動式分析模組
- **檔案**：`frontend/src/RFCoverageCard.tsx`
- **功能**：取代原本不精確的簡易平面雷達，改為將節點座標、海拔與天線高度動態傳遞給 Meshtastic 官方 Site Planner 進行精準地形模擬。

### 3. 太陽能發電預測與氣象署觀測比對模組
- **檔案**：`frontend/src/SolarForecastCard.tsx`
- **功能**：
  - 串接 Forecast.Solar 公開 API 預估當日太陽能發電瓦時與小時功率曲線。
  - 串接台灣中央氣象署 (CWA) 官方測站觀測日射量與日照時數，提供獨立太陽能供電節點之日照健康診斷。

### 4. 遙測接收成功率 (PRR) 分析
- **檔案**：`frontend/src/NodeMap.tsx`
- **功能**：支援 24h、7d、30d 時間範圍過濾，計算並視覺化各節點與閘道器之封包接收率。

### 5. 即時動態站長公告系統 (免重啟、免上 Git、支援 WebSocket 熱推播)
- **核心設計概念**：
  - 站長不需要每次修改通知都要改程式碼、push 到 git 再到正式機 pull 重啟。
  - 採用純文字 JSON 設定檔 `announcement.json`，並在 `.gitignore` 中忽略（僅追蹤範本 `announcement.example.json`），確保未來 Git pull 時不會覆蓋伺服器上的站務自定義內容。
- **後端架構 (`index.js`)**：
  - 開發檔路徑：`announcement.json`。首次啟動若不存在會自動複製 `announcement.example.json`。
  - API：`GET /api/announcement` 供前端初始渲染讀取。
  - 熱重載監聽：採用 `fs.watch` 結合 debounce，偵測到 `announcement.json` 存檔修改時，自動透過 `io.emit('announcement:update', data)` 即時推播給全體線上使用者。
- **前端介面 (`frontend/src/App.tsx`)**：
  - **頂部常駐橫幅 (`banner`)**：
    - 位於頂部功能選單正下方，採用現代毛玻璃 (Glassmorphism) 設計與動態微動畫。
    - 支援 4 種等級色彩風格：`info` (青藍)、`warning` (琥珀黃)、`alert` (玫瑰紅)、`success` (翡翠綠)。
    - 支援自定義外部超連結 (`link` & `linkText`) 與快速關閉按鈕 (`✕`)。
    - 當後端推播新公告內容時，會自動清除使用者的關閉記錄，保證最新消息能即時傳達。
  - **重大版本彈跳視窗 (`modal`)**：
    - 支援版本識別 (`version`)、標題、Markdown-like 多行換行內容。
    - 具有「不再顯示此公告」核取方塊，記住該版本的略過狀態。
- **本地端驗證狀態**：
  - 已於 `http://localhost:5173/` 本地開發環境完整測試通過。
  - 即時熱更新已實測成功：修改 `announcement.json` 存檔後，前端無須手動重新整理頁面，橫幅內容與顏色即刻於 0.5 秒內動態切換。

---

### 6. SQLite Reliability Refactoring v2.7.3 缺陷修正與全量獨立驗證完成 (READY FOR REVIEW)
- **架構目錄**：`src/database/`
  - [sqlite.config.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js)：集中式 PRAGMA、Queue、Backup、Shutdown 與 PM2 緩衝配置。統一 busy_timeout=10000、foreign_keys=OFF 等核心設定。
  - [retry-policy.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/retry-policy.js)：8 大 SQLite 錯誤分類與指數退避抖動計算。
  - [sqlite.adapter.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js)：
    - **P1-2 PRAGMA 動態比對與硬性驗證**：初始化時執行 PRAGMA 並動態讀回實際值嚴格比對，不符時拋出 HARD_FAIL 阻止 Adapter 進入 READY。
    - **靜止狀態追蹤與停機工作閘門**：追蹤 5 大底層計數，提供 `isQuiescent()` 供關閉前強驗證；關閉閘門阻止 GENERAL 任務進入排程。
    - **私有封裝與 Checkpoint 模式分離**：WeakMap 私有憑證與 TRUNCATE 模式強檢查。
  - [write-queue.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)：
    - **P0-1 Drain 指標健全性修復**：`getMetrics()` 擴充 `uncommittedErrorCount`、`totalPending`、`totalUncommitted`，UNCOMMITTED_ERROR 絕不誤判為成功排空。
    - **P0-2 Deadline 交易阻絕**：統一交易准入檢查；Binary Isolation 遞迴切分前瞻性檢查 Deadline，超時後嚴格阻止 Right 啟動新交易，未提交資料按原始 seq 保持 FIFO 回退。
    - **P0-3 SQLITE_FULL 即刻中止**：Drain Worker 遇 `PAUSED_DISK_FULL` 立即 break 退出，杜絕無限重試。
    - **P1-1 磁碟滿額拒絕新寫入**：`enqueue()` 攔截 `PAUSED_DISK_FULL`，即刻拒絕並累計 `totalRejected`，不虛增 `totalAccepted`，守恆公式恆成立。
  - [shutdown-handler.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js)：
    - **P0-1 審核強化**：`drainClean` 要求 `totalUncommitted === 0` 且無錯誤、無滿額；未完全排空時跳過 TRUNCATE Checkpoint 保護 WAL。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：
    - 完整性檢驗異常防護，`tempDb.close` 異常歸類為 `VERIFY_ERROR`，嚴格禁止刪除候選備份檔。
  - [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js)：
    - **P1-3 Callback Exactly-Once**：相容層改用 `p.then(onFulfilled, onRejected)` 分離，Callback 拋出自定義例外絕不重複調用，Promise Rejection 不被吞掉。
    - **P1-4 Factory 啟動前置保護**：`initDatabaseSubsystemSync` 掛載 `readyPromise`，失敗時自動轉移至 `ADAPTER_STATES.ERROR`。
  - [index.js (主程式)](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：
    - **P1-2 移除冗餘 PRAGMA**：徹底移除原本零散執行的 raw PRAGMA 語句。
    - **P1-4 伺服器啟動強等待**：`startServer()` 封裝，強等待 `db.readyPromise`，初始化失敗立即 `process.exit(1)` 終止 HTTP 與 MQTT 啟動。
- **測試驗證 (`tests/database/sqlite_reliability.test.js`)**：
  - 全套 37 項極限場景已實際使用獨立臨時資料庫執行完畢：**37 tests passed, 0 failed, 總耗時 2709ms**。
  - 技術說明書：已建立 [SQLITE_REFACTORING_GUIDE_v2.7.3.md](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/SQLITE_REFACTORING_GUIDE_v2.7.3.md)。
  - 封裝包：已產出 `Meshtastic-DashBoard_SQLite_Reliability_v2.7.3.zip` 供人工審查。

---

## 📋 待辦事項與後續擴充方向 (Backlog)

1. **單站與全台覆蓋圖層連動**：
   - 點擊地圖上的固定節點時，可選擇切換僅突顯該節點的專屬 ITM 覆蓋輪廓或切換回全台 180 站大聯播圖。
2. **多頻道 / 多跳躍模擬擴展**：
   - 結合拓撲邏輯連線與跳轉分析，將長距 LoRa 節點的多跳路徑直接套疊在 3D ITM 視距覆蓋上。
3. **生產環境部署流程規範**：
   - 目前完全於本地 Dev 隔離測試（不推送 Git、不改動 Prod）。未來若需上線時再統一部署至 `d:\meshtastic\Meshtastic-DashBoard-Prod`。


