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

### 6. SQLite Reliability Refactoring v2.7.7 Final Closure 最終收尾與全量獨立驗證完成 (READY FOR REVIEW)
- **架構目錄**：`src/database/`
  - [sqlite.config.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js)：集中式 PRAGMA、Queue、Backup、Shutdown 與 PM2 緩衝配置。統一 busy_timeout=10000、foreign_keys=OFF 等核心設定。
  - [retry-policy.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/retry-policy.js)：8 大 SQLite 錯誤分類與指數退避抖動計算。
  - [sqlite.adapter.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js)：
    - **PRAGMA 動態比對與硬性驗證 (v2.7.3 P1-2)**：初始化時執行 PRAGMA 並動態讀回實際值嚴格比對，不符時拋出 HARD_FAIL 阻止 Adapter 進入 READY。
    - **初始化失敗等待原生 Close 完成與錯誤隔離 (v2.7.5 P1)**：PRAGMA 驗證失敗時立即清空 `this.db = null` 並真正等待原生 `db.close(callback)` 完成後才 reject 原始初始化錯誤；若清理過程報錯則獨立記錄於 `lastCleanupError`，絕不覆蓋原始錯誤。
    - **Checkpoint 共用 Deadline 保護與執行狀態追蹤 (v2.7.5 P0)**：`checkpoint()` 支援 `{ timeoutMs, deadlineAt }` 並追蹤 `#checkpointInProgress`；若超時返回仍保留底層在途狀態，防止後續 Close 誤判為 Quiescent 或呼叫 `_rawClose()`。
    - **Native Close 共用單一絕對 Deadline、單次呼叫保證與 `emergencyClose()` 強制 Deadline (v2.7.6 P0 / v2.7.7 P1)**：`close()` 與 `emergencyClose()` 透過 `_resolveCloseDeadline()` 及 `_awaitNativeCloseWithDeadline(deadlineAt)`，將 Scheduler 等待與原生 `db.close(callback)` 納入同一個絕對 Deadline 約束；`emergencyClose()` 強制要求呼叫端提供有效 `deadlineAt` 或 `timeoutMs`（缺失時以 `EMERGENCY_CLOSE_DEADLINE_REQUIRED` 安全拒絕）；`_rawClose()` 以 `#nativeClosePromise` 確保 `db.close()` 最多僅呼叫一次，嚴格區分 `closeTimedOut`、`nativeClosePending` 與 `adapterClosed`。
  - [write-queue.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)：
    - **Flush Worker 唯讀活動狀態查詢 (v2.7.5 P1)**：提供 `isFlushWorkerActive()` 與 `getMetrics().flushWorkerActive`，消除 `IN_FLIGHT` 轉移至 Scheduler 登記間的競態盲區。
    - **Drain BUSY Backoff 嚴格遵守與定時器清理 (v2.7.4 P0-1)**：`drain()` 期間嚴格遵循 `retryAt` 指數退避延遲與剩餘 Deadline 預算檢查，不提前暴力重試，結束時清理所有 `#retryTimers`。
    - **入列拒絕回呼異常隔離 (v2.7.4 P1-1)**：`_safeRejectCallback()` 隔離使用者 callback 例外，防止炸穿入列呼叫端。
  - [shutdown-handler.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js)：
    - **Graceful Shutdown 全流程共用單一絕對 Deadline (v2.7.5 P0 / v2.7.6 P0-1)**：`shutdownDeadlineAt = startTime + totalShutdownBudget` 統一約束 Drain、Checkpoint、Scheduler Wait 與 Native `db.close(callback)`，移除 Close 階段 100ms 保底，回傳並診斷 `nativeClosePending` 與 `closeTimedOut`。
    - **Emergency Shutdown 共用 Deadline 與 Queue In-Flight 競態保護 (v2.7.5 P1 / v2.7.6 P0-2)**：`_canSafelyEmergencyClose()` 同時檢查 7 項安全准入條件，並以單一 `emergencyDeadlineAt` 限制靜止等待與 `emergencyClose()` 原生關閉等待時間。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：
    - 完整性檢驗異常防護，`tempDb.close` 異常歸類為 `VERIFY_ERROR`，嚴格禁止刪除候選備份檔。
  - [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) & [index.js (主程式)](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：
    - 相容層改用 `p.then(onFulfilled, onRejected)` 分離保證 Callback Exactly-Once；主程式 `startServer()` 與 MQTT 啟動強等待 `db.readyPromise`。
- **測試驗證 (`tests/database/sqlite_reliability.test.js`)**：
  - 全套 **46 項**極限場景已實際使用獨立臨時資料庫執行完畢：**46 tests passed, 0 failed, 總耗時 3435.33ms**。
  - 技術說明書：已同步更新至 [SQLITE_REFACTORING_GUIDE.md](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/SQLITE_REFACTORING_GUIDE.md) (`v2.7.7 — Final Closure`)。
  - **已知物理限制**：Caller Timeout $\neq$ Native Close Completed；Memory Queue cannot guarantee protection against sudden power loss or SIGKILL；READY FOR REVIEW $\neq$ READY FOR PRODUCTION。

---

### 7. Meshtastic-DashBoard 4.0.1 — Database Bootstrap & Backup Integrity (Data Integrity Round 1)
- **核心目標**：在不更動 SQLite Reliability v2.7.7 核心架構與不碰觸 Production 的前提下，完成啟動階段 Schema Initialization Barrier（P0）與 WAL 模式線上備份完整性整合（P1）。
- **新增與修改模組**：
  - [schema-bootstrap.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js)（新增）：
    - 嚴格定義並依序執行：**Step 1 核心資料表建立（8 張表）** $\rightarrow$ **Step 2 欄位擴充 Migration（26 個欄位，`PRAGMA table_info` 預檢 + 型別相容性檢查 + 錯誤分類，禁止以空回呼吞錯）** $\rightarrow$ **Step 3 清理廢棄索引（5 個）** $\rightarrow$ **Step 4 建立必要索引（11 個，位於 Migration 後確保 `gateway_id` 與 `hops_away` 已存在）** $\rightarrow$ **Step 5 最終 Schema Verification（`verifyDatabaseSchema`）**。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：
    - 強化 `verifyIntegrity()`（檢查檔案存在、`stats.size > 0`、`OPEN_READONLY` 與 `PRAGMA integrity_check === 'ok'`）。
    - 強化 `performBackup()`（`#backupInProgress` 防重疊鎖、同名目標檔 `.staging` 保護、`VACUUM INTO` 半成品自動清理、`lastBackupError` / `lastBackupResult` 狀態追蹤）。
    - 強化 `_rotateOldBackups()`（僅計入與清理已驗證成功的備份、保護進行中備份、由舊到新依序清理、**絕不刪除唯一可用備份**）。
    - 新增 `restoreFromBackup(backupFilePath, targetRestoreDbPath)` 獨立還原與完整性驗證流程。
    - 新增 `triggerScheduledBackup()`、`startSchedule()`、`stopSchedule()` 防重疊排程管理。
  - [src/database/index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) & [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：
    - 新增 `isSchemaReady`、`bootstrapError`、`schemaReport`、`isBootstrapReady()` 與 `executeWithStartupBarrier()`。
    - 移除 `index.js` 頂層未等待的 `db.serialize()` DDL 與 `(err) => {}` 空回呼，以及頂層過早執行的 `cleanupOldData()`；統一由 `startServer()` 等待 `db.readyPromise` 與 `db.isBootstrapReady()` 後才啟動 HTTP/API、Socket.IO、MQTT 與背景清理工作者。
    - 移除 `index.js` 中 WAL 模式下不安全的 `fs.copyFileSync(sourceDbPath, targetBackupPath)`，正式串接 `db.backupManager.startSchedule('0 0 * * 0', ...)`，並於 `handleShutdown()` 停止備份排程。
- **測試與文件**：
  - 新增 [data_integrity_4_0_1.test.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（Test A 至 Test M 共 13 項測試），連同既有 46 項測試共 **59 項測試全數通過（59 passed, 0 failed）**。
  - 新增技術文件 [DATA_INTEGRITY_GUIDE.md](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/DATA_INTEGRITY_GUIDE.md)。

---

## 📋 待辦事項與後續擴充方向 (Backlog)

1. **單站與全台覆蓋圖層連動**：
   - 點擊地圖上的固定節點時，可選擇切換僅突顯該節點的專屬 ITM 覆蓋輪廓或切換回全台 180 站大聯播圖。
2. **多頻道 / 多跳躍模擬擴展**：
   - 結合拓撲邏輯連線與跳轉分析，將長距 LoRa 節點的多跳路徑直接套疊在 3D ITM 視距覆蓋上。
3. **生產環境部署流程規範**：
   - 目前完全於本地 Dev 隔離測試（不推送 Git、不改動 Prod）。未來若需上線時再統一部署至 `d:\meshtastic\Meshtastic-DashBoard-Prod`。


