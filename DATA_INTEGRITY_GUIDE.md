# Meshtastic-DashBoard 4.0.1 — Database Bootstrap & Backup Integrity

> **版本定位**：4.0.1 Data Integrity Round 1（資料完整性強固：啟動初始化屏障與線上備份完整性）
> **基線依賴**：建立於已結案之 SQLite Reliability v2.7.7 架構之上（保留 `sqlite3 ^5.1.6`、Adapter Scheduler、WriteQueue、Transaction、Retry Backoff、Checkpoint、Graceful/Emergency Shutdown 與 Native Close Deadline）。

---

## 1. Database Bootstrap 流程

在 4.0.1 中，SQLite 資料庫的啟動初始化由原本 `index.js` 分散、不等待回傳（Fire-and-Forget）的 `db.serialize()` 呼叫，收斂為受 `readyPromise` 嚴格管控的五階段序列流程（實作於 [`src/database/schema-bootstrap.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js) 與 [`src/database/index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js)）：

```text
[Step 0] SQLiteAdapter.initialize(dbPath)
   ├── 開啟 SQLite 連線
   ├── 設定並強驗證核心 PRAGMA (journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout, wal_autocheckpoint)
   └── 若失敗：執行 awaited _cleanupFailedInit() 並拋出致命錯誤

[Step 1] Core Table Creation (CREATE TABLE IF NOT EXISTS)
   └── 依序建立 8 張核心資料表 (telemetry_data, nodes, packet_logs, neighbors, chat_messages, packets, daily_analytics_summary, cwa_weather_stations)

[Step 2] Column Migrations (PRAGMA table_info 預檢 + ALTER TABLE ADD COLUMN)
   └── 依序檢查並套用 26 項既有欄位遷移，嚴格區分「欄位已存在且型別相容」與「SQL/磁碟/權限/型別衝突錯誤」

[Step 3] Obsolete Index Cleanup (DROP INDEX IF EXISTS)
   └── 清理 5 個舊版冗餘索引 (idx_packet_logs_rawhex_ts 等)

[Step 4] Required Index Creation (CREATE INDEX IF NOT EXISTS)
   └── 在欄位 Migration 完成後，依序建立 11 個必要索引（包含依賴遷移欄位 gateway_id 與 hops_away 的索引）

[Step 5] Final Schema Verification (verifyDatabaseSchema)
   └── 查詢 sqlite_master 與各表 PRAGMA table_info，確認 8 張表、全部必要欄位與 11 個索引均已完整就緒

[Step 6] Mark Subsystem Bootstrap Ready
   └── 設定 db.isSchemaReady = true，db.isBootstrapReady() 回傳 true，解除啟動屏障
```

---

## 2. Schema Initialization Barrier

為防止資料庫尚未完成建表、Migration 或索引建立前就開始接收業務讀寫流量，4.0.1 建立了雙重 **Schema Initialization Barrier**：

1. **Subsystem Promise Barrier (`db.readyPromise` & `executeWithStartupBarrier`)**：
   - `createDatabaseSubsystem({ dbPath, backupDir, bootstrapSchema: true })` 與 `initDatabaseSubsystemSync({ dbPath, backupDir, bootstrapSchema: true })` 將 `adapter.initialize(dbPath)` 與 `bootstrapDatabaseSchema(adapter)` 封裝於同一個 `readyPromise` 中。
   - [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 的 `startServer()` 必須 `await db.readyPromise` 並確認 `db.isBootstrapReady() === true` 後，才允許綁定 HTTP Server Port、接受 REST API 與 Socket.IO 連線，並啟動背景資料庫清理與日結壓縮排程（`startDatabaseMaintenanceWorkers()`）。
2. **Entry-Point Readiness Guard (`db.isBootstrapReady()`)**：
   - 在 Protobuf 載入完成回呼（`initProtobuf()`）準備啟動 `startMqtt()` 時，以及 CWA 氣象資料背景抓取與首次 `cleanupOldData()` 執行前，皆檢查 `db.isBootstrapReady()`，避免任何背景任務在 Schema 屏障完成前偷跑寫入。

---

## 3. Table / Column / Index 依賴順序

舊版 `index.js` 在執行 `ALTER TABLE` 之前就先嘗試建立部分索引，且在 `db.serialize()` 中未等待 Promise 完成。4.0.1 強制固定以下不可顛倒的依賴順序：

1. **先建立核心資料表 (`REQUIRED_TABLES`)**：確保 `nodes`、`packet_logs`、`telemetry_data` 等基礎表存在。
2. **再執行欄位遷移 (`COLUMN_MIGRATIONS`)**：確保舊版資料庫補齊 `packet_logs.gateway_id`、`packet_logs.hops_away`、`packet_logs.latitude`、`packet_logs.longitude`、`packet_logs.source`、`nodes.last_gateway`、`telemetry_data.adc_voltage` 等 26 個擴充欄位。
3. **接著清理廢棄索引 (`OBSOLETE_INDEXES`)**：移除不再使用的舊索引。
4. **最後建立必要索引 (`REQUIRED_INDEXES`)**：此時 `idx_packet_logs_gw_ts`（依賴 `gateway_id`）與 `idx_packet_logs_ts_hops`（依賴 `hops_away`）所需的欄位皆已確保存在，不會在舊版資料庫升級時因缺少欄位而建索引失敗。

---

## 4. Migration 相容性與失敗處理

舊版程式碼使用 `db.run('ALTER TABLE ...', (err) => {})` 空回呼忽略所有錯誤，導致語法錯誤、I/O 錯誤、唯讀權限或磁碟損壞也會被靜默吞掉。

4.0.1 在 [`bootstrapDatabaseSchema()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js) 中改採嚴格相容處理：

1. **識別字與定義安全檢查**：驗證表名与欄位名稱符合合法 SQL 識別字，拒絕無效欄位定義。
2. **`PRAGMA table_info` 前置檢查**：
   - 執行 `ALTER TABLE` 前先讀取目標表結構。若目標表不存在，立即拋出 `[SCHEMA_MIGRATION_FAILED]`。
   - 若欄位已存在，比對既有欄位的基礎型別與預期型別：
     - 型別相容：視為已遷移完成（記錄於 `migrationReport.columnsAlreadyExisted`），安全跳過 `ALTER TABLE`。
     - 型別衝突（例如預期 `INTEGER` 但既有為 `BLOB`）：立即拋出 `[SCHEMA_INCOMPATIBLE_COLUMN]`。
3. **錯誤分類與熔斷**：
   - 若 `ALTER TABLE` 執行失敗，僅在錯誤訊息為 `duplicate column name` 且二次查詢 `PRAGMA table_info` 確認欄位確實存在時視為冪等完成。
   - 任何其他 SQL 錯誤、磁碟滿載、權限不足或資料庫損壞，一律封裝診斷資訊（`step`、`table`、`column`、`code`、`cause`）拋出 `[SCHEMA_MIGRATION_FAILED]`，並呼叫 `adapter.setFatalError(err)` 將 Adapter 轉入 `ADAPTER_STATES.ERROR`，阻止系統進入 `READY`。

---

## 5. Schema Verification 機制

在所有 Table、Column Migration 與 Index 執行完畢後，[`verifyDatabaseSchema(adapter)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js) 會執行最終結構盤點：

- 查詢 `sqlite_master` 驗證 8 張核心資料表全數存在。
- 對每張表執行 `PRAGMA table_info(table)`，驗證所有基礎欄位與遷移欄位（例如 `nodes` 的 21 個欄位、`packet_logs` 的 16 個欄位、`telemetry_data` 的 15 個欄位等）全數齊備。
- 查詢 `sqlite_master` 驗證 11 個必要索引全數存在。
- 只要缺少任何一張表、一個欄位或一個索引，即拋出 `[SCHEMA_VERIFICATION_FAILED]`（附帶 `missingTables`、`missingColumns`、`missingIndexes` 診斷明細），系統拒絕進入正常服務。

---

## 6. 舊版 `fs.copyFileSync()` 備份問題說明

在 4.0.1 之前，`index.js` 的定期備份排程直接執行：

```js
fs.copyFileSync(sourceDbPath, targetBackupPath);
```

在 SQLite `journal_mode = WAL` 模式下，這種做法存在嚴重的資料完整性風險：

1. **遺漏 `-wal` 與 `-shm` 狀態**：WAL 模式下已提交的新交易可能仍位於 `meshtastic.db-wal` 中尚未回寫至主檔，單純複製 `.db` 主檔會遺失最近已提交的資料。
2. **頁面撕裂（Torn Pages）與不一致快照**：若複製期間正好發生寫入或自动 Checkpoint，`fs.copyFileSync` 無法與 SQLite 鎖機制協調，可能複製出前後不一致甚至損壞的資料庫檔案。
3. **缺乏完整性檢驗**：複製完成後未執行 `PRAGMA integrity_check`，即使產出損壞備份也會被當作成功備份，甚至觸發舊備份清理而刪掉真正可用的歷史備份。

---

## 7. 新版 BackupManager 備份流程

4.0.1 已移除 `index.js` 中的 `fs.copyFileSync()`，正式將排程整合至 [`BackupManager`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js)：

1. **防重疊檢查（Non-Overlapping Guard）**：
   - 若 `#backupInProgress === true`，排程觸發（`triggerScheduledBackup()`）會安全略過並回傳 `{ success: false, skipped: true, reason: 'BACKUP_ALREADY_IN_PROGRESS' }`；直接呼叫 `performBackup()` 則拋出 `[BACKUP_ALREADY_IN_PROGRESS]`，絕不同時啟動兩個備份任務。
2. **Scheduler 串行協調與線上快照（`VACUUM INTO`）**：
   - 透過 `adapter.maintenanceTask('ONLINE_BACKUP', ...)` 排入 SQLite Adapter Scheduler，與 `WriteQueue` 寫入交易及 `checkpoint` 妥善協調（備份期間 `maintenanceInProgress === true`，阻止 `emergencyClose` 與 `TRUNCATE` checkpoint 干擾）。
   - 若目標路徑已存在同名檔案，先寫入獨立 `.staging-<pid>-<timestamp>` 暫存檔，避免覆蓋既有完好備份。
   - 執行 `VACUUM INTO '<escaped_path>'`，由 SQLite 引擎將主資料庫與 WAL 中已提交的頁面整合輸出為單一、一致且緊湊的獨立 SQLite 資料庫檔案。
3. **不完整備份自動清理**：
   - 若 `VACUUM INTO` 執行失敗或中途異常，立即刪除未完成的半成品檔案，並記錄至 `lastBackupError` 與 `lastBackupResult`，絕不將半成品視為有效備份。

---

## 8. Backup Integrity Check

每次 `VACUUM INTO` 完成後，[`BackupManager.verifyIntegrity(backupFilePath)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js) 會對產出的備份檔執行四道驗證：

1. **檔案存在性檢查**：確認備份檔存在於磁碟。
2. **非空檔案大小檢查**：透過 `fs.statSync` 確認 `stats.isFile() && stats.size > 0`（防止 0-byte 空檔案在 SQLite 開啟時被誤判為 `'ok'`）。
3. **唯讀獨立連線開啟**：以 `sqlite3.OPEN_READONLY` 開啟備份檔，確認檔頭與結構可被 SQLite 讀取。
4. **`PRAGMA integrity_check` 檢驗**：確認回傳單列且結果為 `'ok'`，並等待唯讀連線完整 `close()`。

唯有通過上述全部檢查（`status === BACKUP_VERIFY_STATUS.VALID`），該備份才會被納入 `#verifiedBackups` 有效清單並標記為成功；否則立即報錯 `[BACKUP_VERIFY_FAILED]` 並清理損壞輸出。

---

## 9. Backup Retention 規則

[`BackupManager._rotateOldBackups()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js) 在每次新備份通過完整性驗證後執行，遵循以下安全保留原則：

1. **只計算與清理已驗證成功的備份**：未驗證、損壞或 0-byte 的檔案不會被計入有效備份數量，避免因壞檔佔用名額而誤刪舊的完好備份。
2. **保護進行中備份**：位於 `#inProgressBackupPaths` 中的檔案絕不被清理程序碰觸。
3. **由最舊往較新依序清理**：依 `mtimeMs` 由新到舊排序，從最舊的過期備份（超過 `retentionDays` 或超過選配之 `maxBackups`）開始清理。
4. **絕不刪除唯一可用備份**：若目前目錄中已驗證的有效備份數量 `<= 1`（即使該備份的修改時間已超過 `retentionDays`），系統強制保留該份備份（`retainedCount >= 1`），確保任何時刻至少保有最後一份可用備份。
5. **錯誤隔離**：清理舊檔時的檔案系統警告不會導致剛完成的備份或主服務失敗。

---

## 10. Backup Restore Verification 流程

[`BackupManager.restoreFromBackup(backupFilePath, targetRestoreDbPath)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js) 提供安全、可驗證的還原流程：

1. **拒絕原地覆蓋**：檢查來源備份路徑與目標還原路徑不得相同。
2. **來源備份驗證**：還原前先對來源備份執行 `verifyIntegrity()`，未通過則拒絕還原（`[BACKUP_RESTORE_REJECTED]`）。
3. **Staging 安全還原**：以唯讀模式開啟來源備份，透過 `VACUUM INTO` 輸出至目標目錄下的 `.restore-staging-<pid>-<timestamp>` 暫存檔。
4. **還原後完整性驗證**：對還原出的暫存檔再次執行 `verifyIntegrity()`（包含 `PRAGMA integrity_check === 'ok'`）。
5. **原子替換與清理舊 WAL/SHM**：驗證通過後，清除目標路徑可能殘留的 `-wal` / `-shm` 檔案，並將暫存檔 rename 為目標資料庫路徑。

---

## 11. 測試執行方式與測試項目列表

所有測試皆使用 `os.tmpdir()` 下的獨立臨時 SQLite 資料庫與臨時目錄，**完全不碰觸正式環境與任何正式資料庫**。

### 執行指令

```bash
npm run test:database
```

### 測試套件總覽（共 59 項測試全數通過）

1. **[`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js)（46 項既有測試）**：
   - 完整保留 v2.7.7 結案之 Scheduler、WriteQueue、Transaction、Retry、Checkpoint、Graceful/Emergency Shutdown 與 Native Close Deadline 測試（46 / 46 通過）。
2. **[`tests/database/data_integrity_4_0_1.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（13 項新增測試）**：
   - **Test A — Normal Initialization**：空臨時 DB 建立全部 8 張表、26 個遷移欄位与 11 個索引後通過驗證並進入 `READY`。
   - **Test B — Repeated Initialization**：對同一臨時 DB 連續執行兩次初始化，不產生重複欄位錯誤且完整保留既有資料。
   - **Test C — Migration Failure**：模擬 `ALTER TABLE` SQL 失敗與欄位型別衝突，驗證初始化失敗、不標記為 `READY`、Adapter 進入 `ERROR` 並保留診斷資訊。
   - **Test D — DDL Failure**：模擬 `CREATE TABLE` 與 `CREATE INDEX` 失敗，驗證啟動屏障阻擋服務啟動且不吞掉錯誤。
   - **Test E — Initialization Barrier**：人為延遲 Schema 初始化，驗證 HTTP API、Socket.IO、MQTT 與 Background Workers 在屏障完成前絕不提前啟動。
   - **Test F — Existing Database Compatibility**：建立舊版結構臨時 DB 並寫入既有測試資料，執行 Bootstrap 與 Migration 後驗證舊資料 100% 保留且新欄位與索引齊全。
   - **Test G — WAL Consistent Backup**：WAL 模式下寫入資料（含未截斷 WAL 幀）並執行備份，驗證備份檔包含所有已提交資料。
   - **Test H — Concurrent Writes During Backup**：備份期間持續透過 `WriteQueue` 併發寫入，驗證備份通過完整性檢查且原 DB 保持一致可讀寫。
   - **Test I — Backup Integrity Failure**：模擬備份損壞與 0-byte 空檔案，驗證不會標記成功、記錄錯誤且不影響原 DB。
   - **Test J — Incomplete Backup Cleanup**：模擬 `VACUUM INTO` 中途失敗留下半成品，驗證半成品立即被清除且後續備份可正常成功。
   - **Test K — Backup Retention**：驗證多份備份按時間順序清理、未驗證壞檔不計入有效備份名額、且唯一可用備份絕不被刪除。
   - **Test L — Backup Restore Verification**：備份後還原至第二個獨立臨時 DB，驗證資料一致、`PRAGMA integrity_check === 'ok'` 且可正常讀寫。
   - **Test M — Backup Scheduler Non-Overlap & Shutdown Coordination**：驗證排程重疊觸發會安全跳過、備份期間阻擋危險關閉、完成後下一輪排程正常運作。

---

## 12. 狀態區分：已實作功能、待確認事項與未來規劃

### 12.1 已實作並通過測試的功能（4.0.1 完成）
- SQLite Schema 結構化 Bootstrap（8 表、26 欄位 Migration、5 廢棄索引清理、11 必要索引建立）。
- `PRAGMA table_info` 欄位預檢、型別相容性檢查與 Migration/DDL 錯誤熔斷。
- `verifyDatabaseSchema` 最終結構完整性驗證。
- `readyPromise`、`isBootstrapReady()` 與 `executeWithStartupBarrier` 啟動初始化屏障。
- 移除 `index.js` 不安全的 `fs.copyFileSync()`，整合 `BackupManager` 線上 `VACUUM INTO` 一致性備份。
- 備份完整性驗證（含檔案大小 `> 0` 與 `PRAGMA integrity_check`）、半成品清理、保留策略（永不刪除唯一可用備份）、防重疊排程與獨立還原驗證（`restoreFromBackup`）。

### 12.2 待確認事項（Pending Confirmation）
- **定期備份排程頻率設定不一致**：
  - `index.js` 原始註解寫為「每 12 小時自動備份資料庫至雲端」，但原始程式碼實際排程為 `'0 0 * * 0'`（每週日 00:00），而 [`src/database/sqlite.config.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js) 中的 `backup.cronSchedule` 則為 `'0 4 * * *'`（每日 04:00）。
  - 本次 4.0.1 依規範保留 `index.js` 既有的 `'0 0 * * 0'` 排程行為不變，待使用者確認最終期望的備份頻率後再統一調整。

### 12.3 已知限制與尚未實作的未來規劃（Out of Scope for 4.0.1）
- **Turso Replication**：目前僅保留既有環境變數相容分支，尚未實作雙寫或遠端同步機制。
- **Durable Outbox**：`WriteQueue` 為記憶體佇列（Memory Queue），可防護 SQLite 暫時鎖競爭與優雅關機排空，但無法防止突發斷電、作業系統崩潰或 `SIGKILL` 導致的未提交記憶體資料遺失。
- **Off-host Backup（異地/雲端自動上傳與端到端驗證）**：目前 `BackupManager` 將一致性快照輸出至本地或掛載之 `BACKUP_PATH` 目錄，尚未內建獨立的雲端 API 異地傳輸與遠端雜湊校驗。
- **Backend Modularization**：`index.js` 的路由與業務邏輯模組化拆分不在 4.0.1 範圍內。

