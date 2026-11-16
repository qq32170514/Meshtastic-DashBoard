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

### 7. Meshtastic-DashBoard 4.0.1 / 4.0.1.1 / 4.0.1.2 / 4.0.1.3 / 4.0.1.4 — Database Bootstrap, Backup Isolation, Restore Offline & Cleanup State Verification (READY FOR REVIEW)
- **核心目標**：在不更動 SQLite Reliability v2.7.7 核心架構與不碰觸 Production 的前提下，完成啟動階段 Schema Initialization Barrier（P0）、WAL 模式線上備份完整性整合（P1）、Backup Scheduler 隔離（4.0.1.1 P1）、Restore 活躍 DB 防護與可回復 Rollback（4.0.1.1 P1）、Schema Index 完整定義驗證（4.0.1.1 P2）、Backup Path Containment（4.0.1.1 P2）、Restore 離線保證三層契約（4.0.1.2 P1）、Restore 無既有目標時之安裝後失敗清理與 Rollback 狀態（4.0.1.2 P1）、Backup Rotation `maxBackups` 最新備份精確計數修正（4.0.1.2 P2）、Restore Cleanup Assurance（4.0.1.3 P2），以及 **4.0.1.4 Cleanup State Verification**（P2：`_cleanupFileAndSidecars` 基於 `fs.lstatSync` 三態存在性判斷、`preservedRollbackPaths` 磁碟殘留確認修正、以及 `performBackup` 全 5 處清理呼叫點結構化結果完整保存）。
- **新增與修改模組**：
  - [schema-bootstrap.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js)（新增與強化）：
    - 嚴格定義並依序執行：**Step 1 核心資料表建立（8 張表）** $\rightarrow$ **Step 2 欄位擴充 Migration（26 個欄位，`PRAGMA table_info` 預檢 + 型別相容性檢查 + 錯誤分類，禁止以空回呼吞錯）** $\rightarrow$ **Step 3 清理廢棄索引（5 個）** $\rightarrow$ **Step 4 建立必要索引（11 個，位於 Migration 後確保 `gateway_id` 與 `hops_away` 已存在）** $\rightarrow$ **Step 5 最終 Schema & Index Definition Verification（`verifyDatabaseSchema` + `verifySingleIndexDefinition`，透過 `PRAGMA index_list`、`PRAGMA index_xinfo` 與 `sqlite_master.sql` 檢驗索引所屬表、欄位順序、ASC/DESC、UNIQUE 與 Partial WHERE 條件）**。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：
    - **Backup Scheduler Isolation (4.0.1.1 P1)**：`performBackup()` 僅將 `VACUUM INTO`（寫入唯一 `.staging-*` 暫存檔）放入 `adapter.maintenanceTask()`，完成後立即釋放 Scheduler；後續 `verifyIntegrity()`、可回復式 `.prev-*` rename 安裝與 `_rotateOldBackups()` 均於 Scheduler 外以獨立唯讀連線執行，且全流程受 `#backupInProgress` 與 `#inProgressBackupPaths` 保護。
    - **Restore Offline Assurance & Safety Hardening (4.0.1.1 P1 / 4.0.1.2 P1)**：`restoreFromBackup()` 實施三層離線保護：(1) **Adapter Path Protection**（`_findActiveAdapterUsingPath` 拒絕覆蓋程序內活躍或等待 native close 之 Adapter DB）；(2) **Offline Confirmation**（預設強制要求 `options.offlineConfirmed === true`，未提供或為 `false` 時立即以 `BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED` 拒絕，防止 WAL 模式下外部閒置或唯讀連線繞過鎖探測）；(3) **Lock Contention Probe**（`BEGIN EXCLUSIVE` with `busy_timeout=0` 輔助偵測外部寫入鎖競爭）。
    - **Restore Rollback for Existing & New Target (4.0.1.1 P1 / 4.0.1.2 P1)**：完整追蹤還原 `lifecycle` 狀態；若原始目標已存在，替換前移至 `.rollback-*` 並於失敗時自動還原；若原始目標不存在且已安裝新目標後驗證失敗，自動清除剛安裝之無效目標 DB 與新產生的 `-wal`/`-shm` sidecars 回到不存在狀態，並精確區分 `RESTORE_COMPLETED`、`RESTORE_REJECTED_PRECONDITION`、`RESTORE_FAILED_INSTALL_ABORTED`、`RESTORE_FAILED_ROLLED_BACK` 與 `RESTORE_FAILED_ROLLBACK_INCOMPLETE`。
    - **Restore Staging Cleanup Assurance & Cleanup State Verification (4.0.1.3 & 4.0.1.4 P2)**：以 `_inspectPathExistence(filePath, lstatFn)`（`fs.lstatSync`）取代布林 `fs.existsSync()`，明確區分 `ENOENT`（`'ABSENT'` -> `alreadyAbsent` / `removed`）、檔案存在（`'PRESENT'` -> 執行 `unlink` 並再次 `lstat` 確認）與權限/檔案系統錯誤（`EPERM`/`EACCES` 等 `'UNKNOWN'` -> 寫入 `failures` 與 `unverifiablePaths`，絕不誤判為 `alreadyAbsent` 或回報 `complete: true`）。同時 `performBackup()` 中全部 5 處 `_cleanupFileAndSidecars()` 呼叫點皆透過 `_attachBackupCleanupDiagnostics()` 記錄結構化清理結果於錯誤物件與 `lastBackupResult`。
    - **Restore Rollback Cleanup Diagnostics & `preservedRollbackPaths` Verification (4.0.1.3 & 4.0.1.4 P2)**：當新目標 DB 安裝並驗證成功後清理舊 `.rollback-*` 失敗時，維持 `RESTORE_COMPLETED` 不破壞新 DB，將 `cleanupComplete` 設為 `false`，並於 `cleanupWarnings`（含 `{ path, code, message, stage: 'ROLLBACK_FILE_CLEANUP', existenceState }`）記錄完整診斷；且**僅當 `lstat` 確認檔案仍存在於磁碟（`postStat.state === 'PRESENT'`）時才將路徑加入 `preservedRollbackPaths`**（已不存在 `'ABSENT'` 或無法確認 `'UNKNOWN'` 時僅記錄 `cleanupWarnings`，不誤加入 `preservedRollbackPaths`）。
    - **Backup Rotation `maxBackups` Exact Count (4.0.1.2 P2)**：修正 `_rotateOldBackups(targetDir, latestVerifiedPath)`，將本輪剛通過驗證並安裝完成的 `latestVerifiedPath` 明確納入 `verifiedCandidates` 計數一次並標記 `protectedFromDeletion: true`，同時保留 `#inProgressBackupPaths` 對其他進行中/暫存路徑的保護，消除最新備份被漏算導致保留 `maxBackups + 1` 份的問題。
    - **Backup Path Containment (4.0.1.1 P2)**：`validateBackupFilePath()` 嚴格拒絕 NUL 字元、`../`、POSIX/Windows 絕對路徑、磁碟機路徑、UNC 路徑與子目錄斜線。
  - [src/database/index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) & [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：
    - 新增 `isSchemaReady`、`bootstrapError`、`schemaReport`、`isBootstrapReady()` 與 `executeWithStartupBarrier()`，並註冊 `adapter.dbPath` 至 `BackupManager.registerAdapter()`。
    - 移除 `index.js` 頂層未等待的 `db.serialize()` DDL 與 `(err) => {}` 空回呼，以及頂層過早執行的 `cleanupOldData()`；統一由 `startServer()` 等待 `db.readyPromise` 與 `db.isBootstrapReady()` 後才啟動 HTTP/API、Socket.IO、MQTT 與背景清理工作者。
    - 移除 `index.js` 中 WAL 模式下不安全的 `fs.copyFileSync(sourceDbPath, targetBackupPath)`，正式串接 `db.backupManager.startSchedule('0 0 * * 0', ...)`，並於 `handleShutdown()` 停止備份排程。
- **4.0.1.4 修改檔案與測試結果**：
  - 修改檔案：`src/database/backup-manager.js`、`tests/database/data_integrity_4_0_1.test.js`、`DATA_INTEGRITY_GUIDE.md`、`DEV_PROGRESS.md`。
  - 新增測試：4 項（Test X — Cleanup State Verification & Backup Cleanup Call Sites、Test Y — Rollback Path Verification、Test Z — Backup Replacement `.prev-*` Cleanup & Rollback Error Diagnostics、Test AA — Pre-Cleanup Verification Before VACUUM INTO & Restore Staging）。
  - 實際測試結果：於 [data_integrity_4_0_1.test.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（Tests A – AA 共 27 項）加上 [sqlite_reliability.test.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js)（46 項），實際執行 `npm run test:database` 共 **73 項測試全數通過（73 passed, 0 failed, 0 skipped, 0 cancelled）**。
  - 尚未完成/未涵蓋項目：4.0.2 Packet Transaction Boundary 已於後續 4.0.2 節完成。
  - 當前版本狀態：**`READY FOR REVIEW`**（注意：`READY FOR REVIEW` $\neq$ `READY FOR PRODUCTION`）。

---

### 8. Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary, Error Classification, Turso Fallback, Post-Commit Protection & Cross-Process Integration Tests (READY FOR REVIEW)
- **核心目標**：在不更動 SQLite Reliability v2.7.7 核心架構與不碰觸 Production 的前提下，完成並強化 4.0.2 資料庫封包交易可靠性與全套實證測試：
  1. **Packet Transaction Boundary**：將單一邏輯封包的跨表 SQLite 寫入合併為不可拆分的原子交易單位，確保全部成功才 `COMMIT`、任一失敗整包 `ROLLBACK`、二元隔離不拆開單一封包語句，且外部副作用僅於 `COMMIT` 成功後執行。
  2. **P1 — 修正 `UNKNOWN` 錯誤被誤送入 Binary Isolation**：嚴格規定僅 `ERROR_TYPES.DATA_CONSTRAINT` 可進入 `_binaryIsolateBatch()`；`ERROR_TYPES.UNKNOWN`（如 SQL 語法錯誤、欄位或資料表不存在等 `SQLITE_ERROR`）絕不進入 Binary Isolation 或被標記為 `QUARANTINED`，而是觸發 `handleAdapterFatalError(err)`、將 `WriteQueue` 轉入 `PAUSED_ERROR`、將該批次未提交項目設為 `UNCOMMITTED_ERROR`，並完整保留 `failedStatementIndex`、`failedStatementSql`、`errorType` 與 `transactionLabel` 診斷資訊。
  3. **P1 — 修正 Turso 分支 Packet Transaction Fallback 與共用佇列調度器**：當 `db.queuePacketTransaction` 與 `db.queueDbOp` 皆不存在時（如設定 `TURSO_URL` 之分支），`index.js` 與測試透過共用的 `createTursoDbWrapper()` 及 `createSequentialFallbackQueueController()` 執行完整鏈路 `queuePacketTransaction() / queueDbOp() -> dbQueue -> flushDbQueue() -> executeSequentialFallbackItem()`，辨識 `isTransactionUnit` 並依陣列順序逐一執行全部 `statements`（絕不將 `options.label` 當作 SQL，亦不在第一筆 SQL 完成後就提前回報成功）；任一筆失敗時立即停止後續語句、跳過全部 Post-commit 副作用並僅回報一次錯誤；支援同一佇列混合一般 `queueDbOp` 與多語句封包交易並嚴格保持 FIFO 順序（誠實區分本地 SQLite 具備單一連線原子 `ROLLBACK` 保證，而 Turso fallback 為依序多語句執行、不具備本地 SQLite 之原子回滾保證）。
  4. **P2 — 修正 Post-Commit Hook 例外導致呼叫端 Callback 遺失**：於 `executePacketTransactionPlan()` 中將 `logger.log`、`recordLivePacketAnalytics` 與每筆 `batchEmit` 呼叫分別獨立包覆 `try/catch`（`reportPostCommitHookError`）及單次保護 `invokeCallerCallbackOnce`，確保任一 Hook 拋出例外時記錄 `[POST_COMMIT_HOOK_ERROR]` 並附加於 `result.postCommitErrors`，絕不阻斷其他副作用、絕不把已提交成功的交易覆蓋為交易失敗（`err === null`），且保證呼叫端 `callback` 具備 `exactly-once` 語意。
  5. **共用 Backup Scheduler Policy、MQTT Mock Broker Stream Parser 與版本 Metadata 同步（共 24 項 4.0.2 專屬 `it()` 測試）**：
     - 抽取 `index.js` 與測試共用的 `createAppBackupSchedulePolicy()` 與 `registerAppBackupSchedule()`（維持 `'0 0 * * 0'`），驗證情境 A/B/C/D。
     - 為本機測試 MQTT Broker 實作每個 Socket 獨立的 `receiveBuffer`、MQTT 多位元組 Remaining Length 解碼、拆包/黏包重組、關閉清理與超限記憶體保護，並新增 7 項 Stream Parser 專屬測試（`Test 4.0.2-18` 至 `Test 4.0.2-24`，對應 Tests A–G）。
     - 同步 `package.json` / `package-lock.json`（及 `frontend/package-lock.json`）根套件版本 metadata 為 `3.1.0`。
- **新增與修改模組**：
  - [write-queue.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)：
    - 新增 `enqueuePacketTransaction(statements, callback, options)` 並擴充 `enqueue()` 支援多語句封包交易單位（`isTransactionUnit: true`、`statements: [...]`）。
    - 於 `_commitOrIsolate(batch)` 中在同一個 `adapter.transaction(async (tx) => ...)` 內依序執行封包單位之全部語句；失敗時區分 `ERROR_TYPES.DATA_CONSTRAINT`（進入 `_binaryIsolateBatch` 整包隔離）與 `ERROR_TYPES.UNKNOWN`（呼叫 `handleAdapterFatalError` 並轉入 `PAUSED_ERROR`，標記 `UNCOMMITTED_ERROR`）。
  - [packet-transaction.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js)：
    - 實作 `buildMqttPacketTransactionPlan(context)`、`buildRfTunnelPacketTransactionPlan(context)`、`executePacketTransactionPlan(plan, hooks, callback)`、`executeSequentialFallbackItem(dbTarget, item, onItemDone)`、`createTursoDbWrapper(client)` 與 `createSequentialFallbackQueueController(options)`。
    - 內建 `reportPostCommitHookError()` 與 `invokeCallerCallbackOnce()`，保護交易 `COMMIT` 後的 `logger.log`、`recordLivePacketAnalytics` 與 `batchEmit`（事件名稱為 `'node_seen'`、`'raw_packet'`、`'telemetry_update'`）。
  - [backup-manager.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)、[src/database/index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) & [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js)：
    - 公開 `createTursoDbWrapper`、`createSequentialFallbackQueueController`、`APP_BACKUP_CRON_EXPRESSION`、`createAppBackupSchedulePolicy` 與 `registerAppBackupSchedule`；`index.js` 直接使用上述共用模組，並支援 `MQTT_PIPE_PATH` 與 `TEST_FLUSH_DB_QUEUE`。
  - [sigkill_tx_worker.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/helpers/sigkill_tx_worker.js) & [packet_transaction_4_0_2.test.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/packet_transaction_4_0_2.test.js)：
    - 擴充 `sigkill_tx_worker.js` 支援 `MID_TX`、`AFTER_COMMIT`、`APP_PACKET_TX_MID_FLIGHT` 與 `APP_PACKET_TX_AFTER_COMMIT` 四種模式；`packet_transaction_4_0_2.test.js` 擴充為 **24 項獨立 `it()` 測試案例（`Test 4.0.2-1` 至 `Test 4.0.2-24`）**。
- **4.0.2 修改檔案與測試結果**：
  - 新增與修改檔案：`src/database/write-queue.js`、`src/database/packet-transaction.js`、`src/database/backup-manager.js`、`src/database/index.js`、`index.js`、`package-lock.json`、`frontend/package-lock.json`、`tests/database/helpers/sigkill_tx_worker.js`、`tests/database/packet_transaction_4_0_2.test.js`、`DATA_INTEGRITY_GUIDE.md`、`DEV_PROGRESS.md`。
  - 實際測試結果（以 `it()` 測試案例 1 對 1 計算）：`sqlite_reliability.test.js`（46 項）+ `data_integrity_4_0_1.test.js`（27 項）+ `packet_transaction_4_0_2.test.js`（24 項），共 **97 項 `it()` 測試全數通過（97 PASS, 0 FAIL, 0 BLOCKED, 0 NOT TESTED）**。
  - 誠實測試邊界說明：`Test 4.0.2-14` 與 `Test 4.0.2-15` 為真實跨程序異常終止（`SIGKILL`）與 WAL 回滾恢復測試，不等同於實體主機斷電（Power Loss）、OS 核心崩潰或磁碟硬體損毀測試；Turso fallback 為依序多語句執行，不具備本地 SQLite 之單一連線原子回滾保證。
  - 當前版本狀態：**`READY FOR PRODUCTION REVIEW`**（注意：未授權前絕不部署或重啟 Production PM2）。

---

## 📋 待辦事項與後續擴充方向 (Backlog)

1. **單站與全台覆蓋圖層連動**：
   - 點擊地圖上的固定節點時，可選擇切換僅突顯該節點的專屬 ITM 覆蓋輪廓或切換回全台 180 站大聯播圖。
2. **多頻道 / 多跳躍模擬擴展**：
   - 結合拓撲邏輯連線與跳轉分析，將長距 LoRa 節點的多跳路徑直接套疊在 3D ITM 視距覆蓋上。
3. **生產環境部署流程規範**：
   - 目前完全於本地 Dev 隔離測試（不推送 Git、不改動 Prod）。未來若需上線時再統一部署至 `d:\meshtastic\Meshtastic-DashBoard-Prod`。


