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

### 6. SQLite Reliability Refactoring v2.7.1 實作與全面驗證完成
- **架構目錄**：`src/database/`
  - [sqlite.config.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js)：集中式 PRAGMA、Queue、Backup、Shutdown 與 PM2 緩衝配置。
  - [retry-policy.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/retry-policy.js)：8 大 SQLite 錯誤分類 (`DATA_CONSTRAINT`, `RETRYABLE_BUSY`, `DISK_FULL`, `FATAL_CORRUPT`, `IOERR_TRANSIENT`, `IOERR_PERMANENT`, `ROLLBACK_FAILURE`, `UNKNOWN`) 與指數退避抖動計算。
  - [sqlite.adapter.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js)：
    - **P0-1 封裝**：採用模組私有 `WeakMap` 與一次性 `bindShutdownHandler()` 握手，對外零暴露權限物件。
    - **P0-2 安全追蹤**：追蹤 `isExecutingUnderlying`、`#schedulerPendingCount`、`#activeTransactions`。
    - **P0-3 Checkpoint 安全**：模式白名單，TRUNCATE/FULL/RESTART 強檢驗在途交易與排空憑證，遇 `busy === 1` 拋出 `[CHECKPOINT_BUSY_BLOCKED]`。
    - **P0-5 熔斷機制**：`setFatalError` 即刻通知監聽器，中斷已排程工作。
  - [write-queue.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)：
    - **P0-4 FIFO Binary Isolation**：批次失敗時遞迴切分 Left 與 Right，Left 優先執行；若遇中斷則使用 `_requeueBatchAtHead` 連同 Right 保持原始順序退回隊列頭部。
    - **P0-4 單一歸屬與資料守恆**：Item 具備互斥 6 大狀態，守恆公式 `totalAccepted = totalCommitted + queuedCount + retryPendingCount + inFlightCount + totalAbandoned` 恆成立。
    - **P0-5 錯誤連動**：Adapter 進入 `ERROR` 立即連動為 `PAUSED_ERROR`，拒絕新寫入並計入 `totalRejected`。
  - [shutdown-handler.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js)：
    - **P0-1 私有 Field**：`#authority` 完全私有。
    - **P0-2 安全緊急關閉**：`handleEmergencyCrash` 具備 1000ms 有界等待；超時底層仍在操作時**嚴禁呼叫 `_rawClose()`**，生成結構化診斷轉儲並 exit(1)。
    - **P0-6 停機排空**：受控簽發 `DrainCapability`，排空驗證乾淨後才執行 TRUNCATE checkpoint 與連線關閉。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：
    - 採用 `VACUUM INTO` 建立一致性熱快照。
    - 完整性三態分類 (`VALID`, `CORRUPTED`, `VERIFY_ERROR`)，遇 `VERIFY_ERROR` 嚴格禁止刪除檔案。
  - [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js)：子系統工廠 `createDatabaseSubsystem` (異步) 與 `initDatabaseSubsystemSync` (同步)，回傳完整向後相容之 `dbCompat` 介面 (`run`, `get`, `all`, `serialize`, `close`, `queueDbOp`, `flushDbQueue`)。
- **測試驗證 (`tests/database/sqlite_reliability.test.js`)**：
  - 全套 23 項核心場景已實際使用獨立臨時資料庫執行完畢：**23 tests passed, 0 failed**。

---

## 📋 待辦事項與後續擴充方向 (Backlog)

1. **單站與全台覆蓋圖層連動**：
   - 點擊地圖上的固定節點時，可選擇切換僅突顯該節點的專屬 ITM 覆蓋輪廓或切換回全台 180 站大聯播圖。
2. **多頻道 / 多跳躍模擬擴展**：
   - 結合拓撲邏輯連線與跳轉分析，將長距 LoRa 節點的多跳路徑直接套疊在 3D ITM 視距覆蓋上。
3. **生產環境部署流程規範**：
   - 目前完全於本地 Dev 隔離測試（不推送 Git、不改動 Prod）。未來若需上線時再統一部署至 `d:\meshtastic\Meshtastic-DashBoard-Prod`。


