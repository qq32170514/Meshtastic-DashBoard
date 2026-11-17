# Meshtastic-DashBoard 4.0.2 — Packet Transaction Boundary & Data Integrity Guide

> **版本定位**：4.0.2 Packet Transaction Boundary、Turso / Backup 排程政策確認與跨程序 `SIGKILL` / `index.js` 啟動整合測試（在 4.0.1.4 Cleanup State Verification 基礎上，建立單一邏輯封包事件的不可拆分資料庫交易邊界、確保 WriteQueue 二元隔離以封包交易單位為粒度、嚴格分離交易內 SQL 與 COMMIT 後外部副作用，並補齊跨程序 `SIGKILL` 終止與真實 `index.js` 子程序啟動整合測試）
> **基線依賴**：建立於已結案之 SQLite Reliability v2.7.7、4.0.1、4.0.1.1、4.0.1.2、4.0.1.3 與 4.0.1.4 基線之上（保留 `sqlite3 ^5.1.6`、Adapter Scheduler、WriteQueue、Transaction、Retry Backoff、Checkpoint、Graceful/Emergency Shutdown 與 Native Close Deadline 不變）。

---

## 1. Database Bootstrap 與保護範圍（含 `TURSO_URL` 分支澄清）

### 1.1 本地 SQLite 分支之五階段 Bootstrap 流程
當環境變數未設定 `TURSO_URL` 時，系統走本地 SQLite 分支，由 [`src/database/index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) 與 [`src/database/schema-bootstrap.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js) 透過 `readyPromise` 嚴格管控以下序列步驟：

```text
[Step 0] SQLiteAdapter.initialize(dbPath)
   ├── 開啟 SQLite 連線並綁定 adapter.dbPath 與活躍 Adapter 註冊表
   ├── 設定並強驗證核心 PRAGMA (journal_mode=WAL, synchronous=NORMAL, foreign_keys=OFF, busy_timeout=10000, wal_autocheckpoint)
   └── 若失敗：執行 awaited _cleanupFailedInitConnection() 並轉入 ADAPTER_STATES.ERROR

[Step 1] Core Table Creation (CREATE TABLE IF NOT EXISTS)
   └── 依序建立 8 張核心資料表 (telemetry_data, nodes, packet_logs, neighbors, chat_messages, packets, daily_analytics_summary, cwa_weather_stations)

[Step 2] Column Migrations (PRAGMA table_info 預檢 + ALTER TABLE ADD COLUMN)
   └── 依序檢查並套用 26 項既有欄位遷移，嚴格區分「欄位已存在且型別相容」與「SQL/磁碟/權限/型別衝突錯誤」

[Step 3] Obsolete Index Cleanup (DROP INDEX IF EXISTS)
   └── 清理 5 個舊版冗餘索引 (idx_packet_logs_rawhex_ts 等)

[Step 4] Required Index Creation (CREATE INDEX IF NOT EXISTS)
   └── 在欄位 Migration 完成後，依序建立 11 個必要索引（包含依賴遷移欄位 gateway_id 與 hops_away 的索引）

[Step 5] Final Schema & Index Definition Verification (verifyDatabaseSchema)
   └── 查詢 sqlite_master、PRAGMA table_info、PRAGMA index_list、PRAGMA index_xinfo，確認 8 張表、全部必要欄位與 11 個索引的定義（表名、欄位順序、ASC/DESC、UNIQUE、Partial WHERE）均完整正確

[Step 6] Mark Subsystem Bootstrap Ready
   └── 設定 db.isSchemaReady = true，db.isBootstrapReady() 回傳 true，解除啟動屏障
```

### 1.2 `TURSO_URL` 分支與本地 SQLite 分支架構對照及交易語意說明
- **重要聲明**：`bootstrapDatabaseSchema()`、`verifyDatabaseSchema()`、`isBootstrapReady()`、`executeWithStartupBarrier()`、`WriteQueue`（含 4.0.2 封包原子交易單位 `enqueuePacketTransaction`）、`ShutdownHandler` 以及 `BackupManager` **僅涵蓋本地 SQLite 執行路徑（未設定 `TURSO_URL` 時）**。
- 當環境變數設定 `TURSO_URL` 時，[`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L750-L917) 走 `@libsql/client` 相容包裝器分支，兩者能力與交易保證差異如下表：

| 能力項目 | 本地 SQLite 分支（未設定 `TURSO_URL`） | `TURSO_URL` 遠端分支（設定 `TURSO_URL`） |
|---|---|---|
| 底層介面 | `initDatabaseSubsystemSync`（`SQLiteAdapter` + `sqlite3 ^5.1.6`） | `@libsql/client` 簡易包裝器（`run` / `get` / `all` / `serialize`） |
| 連線排程與交易控制 | 具備單一寫入佇列、專屬 Transaction Context、Retry Backoff | 無 `SQLiteAdapter` 排程器，逐筆呼叫 `client.execute()` |
| 4.0.2 封包交易語意 | **單一連線原子交易保證**：由 `WriteQueue.enqueuePacketTransaction` 與 `SQLiteAdapter.transaction` (`BEGIN IMMEDIATE` ... `COMMIT`/`ROLLBACK`) 保證全部成功才提交、任一失敗整包回滾 | **順序執行多條 SQL（無原子回滾保證）**：由 `queuePacketTransaction` 與 `executeSequentialFallbackItem` 依 `statements` 原始順序逐一呼叫 `db.run`；中途失敗時立即中止後續 SQL 並回報錯誤，但**不具備 Local SQLite Adapter 的單連線原子交易回滾保證** |
| Schema Bootstrap 屏障 | 具備 `bootstrapDatabaseSchema` + `verifySingleIndexDefinition` + `db.readyPromise` | 僅以 `db.serialize()` 非同步發送 `CREATE TABLE IF NOT EXISTS`，無 `readyPromise` 屏障 |
| 備份與還原管理 | 具備 `BackupManager`（`VACUUM INTO`、離線確認、三態清理驗證） | `db.backupManager` 為 `undefined`，不適用本地 SQLite 檔案備份 |
| 關機排空與 Checkpoint | 具備 `ShutdownHandler`（排空 `WriteQueue` + `wal_checkpoint(TRUNCATE)`） | 無本地 WAL 檔案或 `ShutdownHandler` |

### 1.3 備份排程政策確認（`BACKUP_PATH` 與 Cron 設定）
- **`BACKUP_PATH` 與 Bootstrap Ready 啟用條件（嚴格 Fail-Closed）**：在 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 中，透過共用的 `registerAppBackupSchedule(db, cron, process.env)`（內部呼叫 `db.backupManager.startSchedule('0 0 * * 0', cron, policy)`），`policy.shouldRun()` 僅在「已設定 `BACKUP_PATH`」且「`db.isBootstrapReady` 為 function 並回傳嚴格 `true`」時才回傳 `true`（詳見第 6.2 節第 5 項）：
  - 當未設定 `BACKUP_PATH` 時：排程器雖有註冊，但每次觸發時 `shouldRun()` 回傳 `false`（記錄 `SKIPPED_CONDITION_FALSE`），**不會在未授權路徑自動產生備份檔案**。
  - 當設定 `BACKUP_PATH` 且 `db.isBootstrapReady() === true` 時：排程器正常執行 `performBackup(process.env.BACKUP_PATH)`。
- **排程頻率差異說明**：
  - [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L4520) 實際呼叫 `startSchedule` 使用 `'0 0 * * 0'`（每週日 00:00 執行）。
  - [`src/database/sqlite.config.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js#L69) 中的預設設定值 `backup.cronSchedule` 為 `'0 4 * * *'`（每日 04:00，當呼叫 `startSchedule(null, cron)` 未傳入 cron 字串時才會使用）。
  - 依架構凍結規範，目前**維持既有行為與排程設定不變**，並於優雅關機（`handleShutdown`）時呼叫 `db.backupManager.stopSchedule()` 確保排程安全停止。

---

## 2. Schema Verification 機制（4.0.1.1 P2 強化）

SQLite 的 `CREATE INDEX IF NOT EXISTS` 若遇到同名但定義錯誤的既有索引，不會自動替換。因此 4.0.1.1 在 [`verifyDatabaseSchema()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js#L438-L511) 與 [`verifySingleIndexDefinition()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/schema-bootstrap.js#L298-L433) 中，除了檢查資料表與欄位名稱外，更結合 `sqlite_master`、`PRAGMA index_list(table_name)` 與 `PRAGMA index_xinfo(index_name)`（及 `PRAGMA index_info` fallback）對全部 11 個必要索引執行完整定義驗證：

1. **Index Name Verification**：確認索引名稱存在於 `sqlite_master (type = 'index')`。
2. **Table Binding Verification (`TABLE_MISMATCH`)**：確認 `sqlite_master.tbl_name` 與預期所屬資料表完全一致，且存在於該表的 `PRAGMA index_list` 中。
3. **UNIQUE Attribute Verification (`UNIQUE_MISMATCH`)**：比對 `PRAGMA index_list.unique` 與預期 `unique` 屬性（目前 11 個索引皆為非 UNIQUE，`unique: false`）。
4. **Partial Index Verification (`PARTIAL_MISMATCH` / `WHERE_CLAUSE_MISMATCH`)**：比對 `PRAGMA index_list.partial` 及 `sqlite_master.sql` 中的 `WHERE` 子句，防止非預期的 Partial Index 導致查詢漏資料。
5. **Index Columns, Column Order & Sort Direction (`COLUMN_COUNT_MISMATCH` / `COLUMN_NAME_OR_ORDER_MISMATCH` / `SORT_ORDER_MISMATCH` / `COLLATION_MISMATCH`)**：
   - 透過 `PRAGMA index_xinfo(index_name)` 取出所有 `key = 1` 的索引鍵欄位並按 `seqno` 排序。
   - 逐一比對每個位置的**欄位名稱**、**欄位先後順序**（例如 `idx_packet_logs_ts_hops` 必須是 `timestamp` 在前、`hops_away` 在後）、**排序方向**（`desc === 1` 為 `DESC`，`desc === 0` 為 `ASC`）與 **Collation**（預設 `BINARY`）。
6. **Schema Mismatch 處理方式**：
   - 若發現任何缺失表、缺失欄位、缺失索引或索引定義不符，**絕不靜默修改或刪除既有資料庫結構**，而是立即拋出 `[SCHEMA_VERIFICATION_FAILED]`（附帶 `err.details = { missingTables, missingColumns, missingIndexes, invalidIndexes }`），並將 Adapter 轉入 `ADAPTER_STATES.ERROR`，阻止系統進入服務狀態。

---

## 3. Backup Lifecycle 與 Scheduler Isolation（4.0.1.1 P1 & P2）

### 3.1 修正問題背景
在 4.0.1 中，`performBackup()` 將 `VACUUM INTO`、`verifyIntegrity()`、檔案 rename 與 `_rotateOldBackups()` 全部包在 `adapter.maintenanceTask('ONLINE_BACKUP', ...)` 內。對於約 4.5GB 的大型資料庫，`PRAGMA integrity_check` 與舊備份掃描可能耗時數十秒，期間會使 SQLite Adapter Scheduler 持續處於 `maintenanceInProgress = true`，阻塞 `WriteQueue` 批次寫入與 API 查詢。

### 3.2 4.0.1.1 完整 Backup 生命週期
在 [`BackupManager.performBackup()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js#L247-L407) 中，Scheduler 佔用範圍已被嚴格隔離至**僅限 `VACUUM INTO` 建立快照階段**：

```text
[Phase 0] Pre-check & Path Containment
   ├── 檢查 #backupInProgress 防重疊鎖
   ├── 呼叫 validateBackupFilePath(filename, targetDir) 驗證檔名邊界
   │     (拒絕 NUL、../、/、\、POSIX/Windows 絕對路徑、磁碟機前綴 C:、UNC 路徑 \\server\share)
   ├── 產生唯一暫存檔名 .staging-<filename>-<pid>-<timestamp>-<rand> (不以 .db 結尾)
   └── 設定 #backupInProgress = true，並將 stagingPath 與 targetPath 加入 #inProgressBackupPaths

[Phase 1] VACUUM INTO Inside adapter.maintenanceTask('ONLINE_BACKUP')
   ├── 在 SQLite Adapter Scheduler 串行保護下執行 VACUUM INTO '<stagingPath>'
   ├── 若失敗：立即清理 stagingPath 及 sidecars，記錄 FAILED_VACUUM_INTO 並拋錯
   └── 若成功：確認 stagingPath 存在後立即結束 maintenanceTask，釋放 SQLite Adapter Scheduler！
       (此刻起 adapter.maintenanceInProgress === false，WriteQueue 與 API 可立即恢復正常讀寫)

[Phase 2] Independent Integrity Verification (Outside Scheduler)
   ├── 保持 #backupInProgress = true 與 #inProgressBackupPaths 保護
   ├── 使用獨立唯讀連線 (sqlite3.OPEN_READONLY) 對 stagingPath 執行 verifyIntegrity()
   │     (檢查檔案存在、stats.size > 0、可唯讀開啟、PRAGMA integrity_check === 'ok')
   └── 若未通過：清理 stagingPath (或於 retainFailedStaging: true 時改名為 .invalid 供調查)，
       絕不影響 targetPath 既有有效備份，記錄 FAILED_VERIFICATION 並拋錯

[Phase 3] Reversible Staging Install to Official Backup File
   ├── 若 targetPath 已存在舊的有效備份，先移至同目錄 .prev-<filename>-<suffix>
   ├── 將通過驗證的 stagingPath rename 為正式 targetPath
   │     ├── 若 rename 成功：清理 .prev-* 暫存檔，呼叫 _markBackupVerified(targetPath) 納入 #verifiedBackups（附單調序號）
   │     └── 若 rename 失敗：立即將 .prev-* 還原回 targetPath（確保既有有效備份絕不損毀），清理 stagingPath 並拋錯

[Phase 4] Backup Rotation (Outside Scheduler, 4.0.1.2 P2 修正)
   ├── 執行 _rotateOldBackups(resolvedTargetDir, targetPath)：
   │     ├── 將本輪剛通過驗證並安裝完成的 latestVerifiedPath (targetPath) 明確納入 verifiedCandidates 計數一次，
   │     │   並標記 protectedFromDeletion: true（本輪絕不刪除最新備份，亦不因仍位於 #inProgressBackupPaths 而漏算）
   │     ├── 其餘位於 #inProgressBackupPaths 的暫存檔或進行中路徑、.staging-* / .prev-* / 非 .db 檔案與未驗證檔案一律跳過保護
   │     ├── 按 mtimeMs 由新到舊排序（同毫秒時以驗證序號打破平手），由最舊候選開始檢查 retentionDays 與 remainingValidCount > maxBackups
   │     └── 強制保留至少 1 份最新有效備份（retainedCount >= 1，絕不刪除唯一可用備份）

[Phase 5] Final Convergence (finally block)
   └── 確保殘留 stagingPath 被清除，自 #inProgressBackupPaths 移除路徑，並將 #backupInProgress 設回 false
```

### 3.3 備份排程政策（Backup Scheduling Policy）現況與待確認事項
- 在 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L4517-L4533) 中，定時備份排程之 `shouldRun()` 目前檢查 `process.env.BACKUP_PATH` 是否存在；若未設定 `BACKUP_PATH`，排程觸發時會回傳 `false` 而不執行自動備份（即使 `BackupManager` 建構子本身具備預設本地 `./backups` 目錄）。
- 此外，`index.js` 原始註解寫為「每 12 小時自動備份資料庫至雲端」，實際 Cron 表達式為 `'0 0 * * 0'`（每週日 00:00），而 [`src/database/sqlite.config.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js) 中的 `backup.cronSchedule` 則為 `'0 4 * * *'`（每日 04:00）。
- **處理原則**：在未獲明確指示變更排程政策前，4.0.1.2 嚴格保留 `index.js` 現有的 `BACKUP_PATH` 檢查與 `'0 0 * * 0'` 行為不變，並將上述兩項設定差異列為待確認事項。

---

## 4. Restore Offline Assurance 與可回復替換機制（4.0.1.1 P1 & 4.0.1.2 P1）

[`BackupManager.restoreFromBackup(backupFilePath, targetRestoreDbPath, options)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js#L525-L895) 針對還原作業實施三層離線安全防護與完整生命週期可回復（Rollback）替換流程。

### 4.1 為什麼 WAL 模式下 `BEGIN EXCLUSIVE` 不能證明外部連線已關閉（4.0.1.2 P1）
- 在 SQLite **WAL（Write-Ahead Logging）模式**下，讀寫並發採快照隔離（Snapshot Isolation）：
  1. **外部閒置連線（Idle Connection）**：開啟資料庫檔案但未持有進行中交易時，不會持有寫入鎖，另一條連線執行 `BEGIN EXCLUSIVE TRANSACTION` 會直接成功。
  2. **外部唯讀或讀取交易連線（Read-Only / `BEGIN DEFERRED` + `SELECT`）**：在 WAL 模式下，Reader 僅讀取 WAL end mark 快照，不會阻擋 Writer 取得 `EXCLUSIVE` 寫入鎖。
- 若在此情況下直接對磁碟上的 `<db>`、`<db>-wal`、`<db>-shm` 進行檔案層級 `rename` / `unlink` 替換，外部仍開啟檔案描述符的連線會出現描述符與磁碟路徑脫鉤（Split-Brain）、WAL Shared-Memory Index (`-shm`) 不一致，甚至導致資料庫損毀。
- 因此，**SQLite Lock Probe（`BEGIN EXCLUSIVE`）只能作為「是否有活躍外部寫入鎖競爭」的輔助檢查，絕不能單獨作為目標資料庫已完全離線的充分證明**。`restoreFromBackup()` 預設強制要求呼叫端明確傳入 `options.offlineConfirmed === true`。

### 4.2 Restore 三層離線安全機制職責表

| 防護層級 | 實作方法 / 參數 | 職責與保護範圍 | 失敗時錯誤碼與狀態 |
| :--- | :--- | :--- | :--- |
| **Layer 1: Adapter Path Protection** | `_findActiveAdapterUsingPath(resolvedTarget)` | 檢查程序內所有已註冊之 `SQLiteAdapter`（含 `state !== CLOSED`、`db !== null` 或 `nativeClosePending === true`），禁止還原覆蓋本程序正在使用或尚在等待 native close 的資料庫路徑。 | `BACKUP_RESTORE_ACTIVE_DB_FORBIDDEN` (`RESTORE_REJECTED_PRECONDITION`) |
| **Layer 2: Offline Confirmation (預設強制)** | `options.offlineConfirmed === true` | 要求呼叫端明確聲明並確認目標資料庫已處於受控離線維護狀態（所有服務、背景工作與外部讀寫連線均已關閉）。未提供或為 `false` 時一律預設拒絕，絕不修改任何 DB / WAL / SHM 檔案。 | `BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED` (`RESTORE_REJECTED_PRECONDITION`) |
| **Layer 3: Lock Contention Probe (輔助探測)** | `PRAGMA busy_timeout = 0` + `BEGIN EXCLUSIVE TRANSACTION; ROLLBACK;` | 於目標檔案已存在時，在替換前與實際 rename 前二次探測是否有其他程序或外部連線正持有活躍 SQLite 寫入鎖（如 `BEGIN IMMEDIATE` / `EXCLUSIVE`）。 | `BACKUP_RESTORE_TARGET_BUSY_ONLINE` (`RESTORE_REJECTED_PRECONDITION`) |

### 4.3 Restore 生命週期與 Rollback 機制（含「既有目標 DB」與「全新目標 DB」）

`restoreFromBackup()` 以明確的 `lifecycle` 結構追蹤每個階段：
`{ stagingCreated, stagingVerified, hadExistingTargetDb, hadExistingSidecars, originalMovedToRollback, newTargetInstalled, postInstallVerified, newTargetCleanedUp, originalRestored }`。

1. **前置驗證與 Staging 建立**：
   - 驗證路徑正規化、禁止覆蓋 `#inProgressBackupPaths`、通過三層離線檢查（`_assertTargetDbOffline`）。
   - 對來源備份 `backupFilePath` 執行 `verifyIntegrity()`。
   - 在目標同目錄下透過 `VACUUM INTO` 建立 `.restore-staging-<basename>-<suffix>`（`stagingCreated = true`），並對 staging DB 執行 `verifyIntegrity()`（`stagingVerified = true`）。
2. **區分目標路徑初始狀態與四種完成/失敗情境（Cases A / B / C / D）**：
   - **Case A — 原始目標不存在，還原成功**：
     - 直接將已驗證之 `stagingRestorePath` rename 至 `resolvedTarget`（`newTargetInstalled = true`），並通過安裝後 `verifyIntegrity(resolvedTarget)`（`postInstallVerified = true`），回傳 `RESTORE_COMPLETED`。
   - **Case B — 原始目標不存在，於新目標檔安裝前失敗（例如 `rename` 失敗）**：
     - `newTargetInstalled === false`，目標路徑維持不存在，清理 `stagingRestorePath`。
     - 因未曾安裝新檔亦無舊檔可還原，**絕不偽報 Rollback 成功**，標記為 `RESTORE_FAILED_INSTALL_ABORTED`（`rollbackSucceeded: false`）。
   - **Case C — 原始目標不存在，新目標 DB 已安裝至目標路徑，但安裝後 `verifyIntegrity()` 失敗**：
     - `hadExistingTargetDb === false` 且 `newTargetInstalled === true`。
     - 立即移除剛安裝到目標路徑的無效 DB 以及本次還原新產生的 `<db>-wal` / `<db>-shm` sidecars（僅針對 `resolvedTarget` 及其 `-wal`/`-shm`，絕不觸碰同目錄其他無關檔案），使目標路徑回到「不存在」的乾淨初始狀態。
     - 若無效新目標與 sidecars 全數清除成功（確認目標路徑已不存在）：`newTargetCleanedUp = true`，標記為 `RESTORE_FAILED_ROLLED_BACK`（`rollbackSucceeded: true`）。
     - 若移除無效新目標檔時遭遇檔案系統錯誤導致殘留：`newTargetCleanedUp = false`，標記為 `RESTORE_FAILED_ROLLBACK_INCOMPLETE`（`rollbackSucceeded: false`），並於 `err.uncleanedTargetPaths` 與 `err.preservedRollbackPaths` 保留殘留路徑供人工處理。
   - **Case D — 原始目標已存在，替換或安裝後驗證失敗**：
     - 替換前先將既有 `<db>`、`<db>-wal`、`<db>-shm` 依序移至 `.rollback-<suffix>`（不忽略任何移動失敗）。
     - 若後續安裝 `rename` 或安裝後 `verifyIntegrity()` 失敗：先移除目標路徑上不完整的新檔案與 sidecars，再按反序將 `.rollback-*` 移回原始 `<db>`、`<db>-wal`、`<db>-shm`。
     - 若原始資料庫與 sidecars 全數復原成功：`originalRestored = true`，標記為 `RESTORE_FAILED_ROLLED_BACK`（`rollbackSucceeded: true`）。
     - 若復原失敗：保留 `.rollback-*` 檔案並標記為 `RESTORE_FAILED_ROLLBACK_INCOMPLETE`（`rollbackSucceeded: false`）。

### 4.4 Cleanup State Verification、Staging Cleanup Assurance 與舊 `.rollback-*` 清理診斷（4.0.1.3 & 4.0.1.4 P2）

1. **基於 `fs.lstatSync()` 的三態存在性驗證（[`_inspectPathExistence(filePath, lstatFn)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js#L516-L534) & [`_cleanupFileAndSidecars(filePath, options)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js#L539-L639)）**：
   - `fs.existsSync()` 僅回傳布林值，無法區分「檔案確實不存在（`ENOENT`）」與「因權限或 I/O 錯誤（`EACCES`、`EPERM` 等）無法確認檔案狀態」，可能將無法確認狀態的檔案誤判為 `alreadyAbsent` 並偽報 `complete: true`。
   - 4.0.1.4 改以 `fs.lstatSync()` 進行明確的三態判定：
     - **`ENOENT`（`state: 'ABSENT'`）**：確認檔案不存在，初始檢查時歸類為 `alreadyAbsent`；於 `unlink` 後再次檢查確認為 `'ABSENT'` 時歸類為 `removed`。
     - **成功取得檔案資訊（`state: 'PRESENT'`）**：確認檔案存在，執行 `unlinkFn(p)`，並在 `unlink` 完成後再次呼叫 `lstat` 驗證檔案是否確實已移除。
     - **`EPERM`、`EACCES` 或其他非 `ENOENT` 錯誤（`state: 'UNKNOWN'`）**：記錄至 `failures`（含 `{ path, code, message, stage }`）與 `unverifiablePaths`，**絕不歸類為 `alreadyAbsent`，且絕不回報 `complete: true`**。
   - 僅針對傳入之單一基底路徑及其 `-wal`、`-shm`（共 3 個明確路徑）執行清理，**絕不使用 wildcard 掃描**。
   - 回傳完整可檢查的結構化物件：
     ```js
     {
         complete: true,          // boolean: 僅當所有候選檔案均已確認不存在 (alreadyAbsent + removed === attempted) 且無任何錯誤時為 true
         attempted: [],           // 嘗試檢查與清理之完整路徑清單 [base, `${base}-wal`, `${base}-shm`]
         removed: [],             // 實際透過 unlink 移除且經 lstat 二次確認為 ABSENT 之路徑
         alreadyAbsent: [],       // 初始 lstat 即為 ENOENT，或 unlink 時 ENOENT 且經 lstat 確認為 ABSENT 之路徑
         failures: [],            // 每個失敗項目包含 { path, code, message, stage }
         remainingPaths: [],      // 清理流程結束後，經 lstat 確認仍存在於磁碟 (PRESENT) 之完整路徑
         unverifiablePaths: []    // 因 EACCES / EPERM 等非 ENOENT lstat 錯誤而無法確認存在狀態 (UNKNOWN) 之完整路徑
     }
     ```
2. **Backup 清理呼叫點結構化結果完整保存與 `.prev-*` 替換診斷（4.0.1.4 P2）**：
   - **前置 Cleanup 強制驗證（`performBackup` & `restoreFromBackup`）**：
     - 在 `performBackup()` 執行 `VACUUM INTO` 前，以及在 `restoreFromBackup()` 建立還原 staging DB 前，皆必須先呼叫 `_cleanupFileAndSidecars()` 並檢查 `cleanupResult.complete === true`。
     - 若清理失敗（`remainingPaths.length > 0`）或檔案狀態無法確認（`unverifiablePaths.length > 0`、`state === 'UNKNOWN'`），**立即中止並拋出 `BACKUP_PRE_CLEANUP_FAILED` / `BACKUP_RESTORE_PRE_CLEANUP_FAILED`**，絕不在 staging 路徑狀態不明時執行 `VACUUM INTO` 或還原，並完整保留 `cleanupResult`、`remainingPaths`、`unverifiablePaths` 及原始錯誤（`cause`、`originalError`、`originalCode`）。
   - **Backup 替換過程 `.prev-*` 清理與還原錯誤追蹤**：
     - 新備份安裝成功後，清理舊 `.prev-*` 檔案若發生 `unlink` 或 `lstat` 錯誤，**絕不吞掉錯誤，亦絕不破壞已安裝驗證的新備份**（仍回傳 `COMPLETED`，但標記 `cleanupComplete: false`、記錄完整 `{ path, code, message, stage: 'PREV_BACKUP_CLEANUP', existenceState }` 於 `cleanupWarnings` 與 `cleanupFailures`，且當確認檔案仍存在 `'PRESENT'` 時列入 `preservedPrevBackupPaths` 與 `remainingPaths`，狀態為 `'UNKNOWN'` 時列入 `unverifiablePaths`）。
     - 新備份安裝失敗後，若將舊 `.prev-*` 還原回 `targetPath` 時發生 `rename` 失敗，完整保留原始安裝錯誤（`err.cause`、`err.originalError`、`err.originalCode`），同時將還原失敗之完整路徑、錯誤碼、錯誤訊息與存在狀態記錄於 `err.previousBackupRestoreError`、`err.rollbackErrors` 與 `err.cleanupFailures`，並保留 `.prev-*` 舊有效備份於 `err.preservedPrevBackupPaths` / `err.remainingPaths` 絕不遺失。
   - `performBackup()` 中全部 `_cleanupFileAndSidecars()` 呼叫點皆透過 `_attachBackupCleanupDiagnostics()` 接收並保存結構化清理結果至拋出的錯誤物件（`this.lastBackupError`）與 `this.lastBackupResult`：
     0. `VACUUM INTO` 開始前之前置 staging 清理檢查（`FAILED_PRE_CLEANUP`）。
     1. `VACUUM INTO` 失敗後清理 `stagingPath`（`FAILED_VACUUM_INTO`）。
     2. `verifyIntegrity()` 失敗且 `retainFailedStaging` 改名失敗後 fallback 清理 `stagingPath`（`FAILED_VERIFICATION`）。
     3. `verifyIntegrity()` 失敗後清理 `stagingPath`（`FAILED_VERIFICATION`）。
     4. 備份安裝 `rename` 失敗後清理 `stagingPath`（`FAILED_RENAME_INSTALL`）。
     5. 備份安裝後 / `finally` 階段清理殘留 `stagingPath`（`COMPLETED` 或未預期例外收斂）。
3. **Restore Cleanup Failure 與原始 Restore Error 共存（不覆蓋原始錯誤）**：
   - `_cleanupFileAndSidecars()` 內部捕獲檔案系統例外並轉為結構化 `failures`，**絕不拋出例外覆蓋原始 Restore 錯誤**。
   - 當 Restore 在安裝階段（如 `rename` 失敗）與 staging cleanup 同時失敗（含殘留檔案 `remainingPaths` 或無法確認狀態 `unverifiablePaths`）時，拋出的錯誤完整保留原始錯誤（`err.cause`、`err.originalError`、`err.originalCode` 及原始錯誤訊息），並附加 `err.cleanupComplete = false`、`err.cleanupResult`、`err.cleanupFailures`、`err.remainingPaths` 與 `err.unverifiablePaths`。
   - 若原始目標資料庫不存在、安裝 `rename` 失敗且 staging 清理未完成（`cleanupComplete === false`），狀態將誠實歸類為 `RESTORE_FAILED_ROLLBACK_INCOMPLETE`，**絕不謊稱 `RESTORE_FAILED_INSTALL_ABORTED` 或宣稱清理完成**。
4. **Restore 成功後舊 `.rollback-*` 清理失敗之處理與 `preservedRollbackPaths` 精確語意（4.0.1.3 & 4.0.1.4 P2）**：
   - 只要新目標 DB 已完成安裝並通過安裝後 `verifyIntegrity()`，Restore 本身即判定為成功（`restoreStatus: RESTORE_STATUS.COMPLETED`），**絕不因舊 `.rollback-*` 刪除失敗而反向刪除或破壞已驗證成功的新資料庫**。
   - 針對每個舊 `.rollback-*` 檔案：
     - 先以 `_inspectPathExistence(moved.rollback, lstatFn)` 檢查狀態；若初始 `lstat` 即發生非 `ENOENT` 錯誤（`state === 'UNKNOWN'`），記錄至 `cleanupWarnings`（`existenceState: 'UNKNOWN'`）並將 `cleanupComplete` 設為 `false`，但**不加入 `preservedRollbackPaths`**。
     - 若檔案存在（`state === 'PRESENT'`）並執行 `unlink`：當 `unlink` 拋出非 `ENOENT` 錯誤後，再次以 `_inspectPathExistence(moved.rollback, lstatFn)` 確認磁碟狀態：
       - **僅當確認檔案仍存在於磁碟（`postStat.state === 'PRESENT'`）時**，才將該路徑加入 `preservedRollbackPaths`。
       - 若 `unlink` 報錯但檔案實際已不存在（`postStat.state === 'ABSENT'`），或因權限錯誤無法確認是否仍存在（`postStat.state === 'UNKNOWN'`），皆將該錯誤完整記錄於 `cleanupWarnings`（含 `{ path, code, message, stage: 'ROLLBACK_FILE_CLEANUP', existenceState: 'ABSENT' | 'UNKNOWN' }`）並設 `cleanupComplete = false`，**絕不將已不存在或狀態未知的路徑誤加入 `preservedRollbackPaths`**。

### 4.5 `RESTORE_STATUS` 狀態定義總表

| 狀態常數 (`RESTORE_STATUS`) | 狀態值 | 意義與觸發條件 |
| :--- | :--- | :--- |
| `COMPLETED` | `'RESTORE_COMPLETED'` | 新目標 DB 已成功安裝並通過安裝後 Integrity Verification。舊 `.rollback-*` 檔案可能因檔案系統錯誤而暫時保留，相關情況會透過 `cleanupComplete`、`cleanupWarnings` 與 `preservedRollbackPaths` 回報。 |
| `REJECTED_PRECONDITION` | `'RESTORE_REJECTED_PRECONDITION'` | 於觸碰目標檔案前因前置條件（未傳 `offlineConfirmed: true`、目標為活躍 Adapter DB、外部鎖競爭、來源備份無效或 staging 驗證失敗）被安全拒絕，目標 DB / WAL / SHM 毫髮無損。 |
| `FAILED_INSTALL_ABORTED` | `'RESTORE_FAILED_INSTALL_ABORTED'` | 原始目標資料庫不存在（`hadExistingTargetDb === false`），在將 staging 安裝至目標路徑前即失敗（`newTargetInstalled === false`），且 staging 暫存檔與 sidecars 已完全清理乾淨（`cleanupComplete === true`、`remainingPaths.length === 0`），目標維持不存在（`rollbackSucceeded: false`）。 |
| `FAILED_ROLLED_BACK` | `'RESTORE_FAILED_ROLLED_BACK'` | 安裝或安裝後驗證失敗，但系統已成功回退至還原前狀態且無殘留 staging 檔案（`cleanupComplete === true`、`rollbackSucceeded: true`）：(1) 既有目標 DB 已從 `.rollback-*` 完整復原，或 (2) 原先不存在之目標路徑已將新安裝之無效目標檔與 sidecars 徹底清除回不存在狀態。 |
| `FAILED_ROLLBACK_INCOMPLETE` | `'RESTORE_FAILED_ROLLBACK_INCOMPLETE'` | 安裝或安裝後驗證失敗，且在還原 `.rollback-*`、清除無效新目標檔或清理 `.restore-staging-*` 時發生檔案系統錯誤（`cleanupComplete === false`、`rollbackSucceeded: false`），保留現場檔案路徑於 `err.remainingPaths` / `err.preservedRollbackPaths` / `err.uncleanedTargetPaths`。 |

---

## 5. 測試覆蓋與測試性質分類（Test Coverage Classification）

所有測試均於開發環境透過 `npm run test:database` 實際執行，並使用 `os.tmpdir()` 下的獨立臨時 SQLite 資料庫檔案，測試後完整關閉連線與清除暫存檔。

### 5.1 [`tests/database/data_integrity_4_0_1.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（27 項測試：Tests A – AA）

| 測試編號與名稱 | 測試分類 | 實際驗證方式與邊界說明 |
| :--- | :--- | :--- |
| **Test A — Normal Initialization** | 真實 SQLite Integration Test | 對空臨時 SQLite DB 實際執行建表、26 欄位 Migration、11 索引建立與 `verifyDatabaseSchema`，並驗證讀寫。 |
| **Test B — Repeated Initialization** | 真實 SQLite Integration Test | 對寫有資料之同一臨時 SQLite DB 連續執行兩次完整初始化與重複 `bootstrapSchema()`，驗證冪等與資料保留。 |
| **Test C — Migration Failure** | 真實 SQLite Error Test | 在臨時 SQLite DB 上執行真實無效 SQL 語法之 `ALTER TABLE` 以及真實 `BLOB` vs `INTEGER` 欄位型別衝突，驗證轉入 `ERROR` 且不吞錯。 |
| **Test D — DDL Failure** | 真實 SQLite Error + Coordinator Test | 在臨時 SQLite DB 上觸發真實 `CREATE TABLE` 語法錯誤與 `CREATE INDEX` 無此欄位錯誤，驗證 `executeWithStartupBarrier` 阻擋啟動。 |
| **Test E — Initialization Barrier** | **Coordinator Unit Test (with Real SQLite Bootstrap & Service Stubs)** | 對臨時 SQLite DB 執行真實 `initDatabaseSubsystemSync` 與 `bootstrapDatabaseSchema`（透過 `beforeSchemaBootstrap` Gate 控制時序），驗證 `executeWithStartupBarrier()` 協調器不會提前呼叫 `startHttp`/`startSocketIo`/`startMqtt`/`startBackgroundWorkers` 測試樁（Stub Callbacks）。**註：此為協調器單元測試，並非直接啟動整支 `index.js` 實體伺服器程序。** |
| **Test F — Existing Database Compatibility** | 真實 SQLite Integration Test | 以原生 `sqlite3` 建立舊版無擴充欄位之資料表並寫入歷史資料，再執行完整 Bootstrap & Migration，驗證資料保留與新欄位可讀寫。 |
| **Test G — WAL Consistent Backup** | 真實 SQLite Integration Test | 在 WAL 模式下透過 `WriteQueue` 寫入 25 筆資料並執行 `performBackup()`（真實 `VACUUM INTO`），以獨立唯讀連線驗證備份檔內容。 |
| **Test H — Backup Snapshot Consistency** | 真實 SQLite Integration Test (Deterministic Gate) | 寫入 50 筆初始資料，於真實 `VACUUM INTO` 進入執行瞬間（透過確定性 Gate）排入 30 筆 `WriteQueue` 寫入，驗證備份檔精確為初始 **50 筆**、主 DB 完成寫入後為 **80 筆**，且兩者皆通過 `PRAGMA integrity_check`。 |
| **Test I — Backup Integrity Failure** | 真實 0-byte 檔案測試 + Verification Failure Injection | 1. 對真實 0-byte 空檔案執行 `verifyIntegrity()` 驗證回傳 `CORRUPTED`；2. 透過 stubbing `verifyIntegrity` 模擬損壞結果，驗證 `performBackup()` 拒絕標記成功並清理 staging。 |
| **Test J — Incomplete Backup Cleanup** | Mid-Backup I/O Failure Simulation + Real Retry | 攔截第一次 `VACUUM INTO` 寫入半成品 staging 檔案後拋出模擬 I/O 錯誤，驗證 `.staging-*` 被徹底清除，且第二次真實 `VACUUM INTO` 備份成功。 |
| **Test K — Backup Retention** | 真實 SQLite Backup + Filesystem mtime Test | 建立 3 份真實備份並調整 `utimesSync` 與置入未驗證壞檔，驗證按順序刪除最舊備份、忽略未驗證檔，且當僅剩 1 份有效備份時即使過期 365 天也絕不刪除。 |

> Tests L – AA 之測試矩陣詳見第 7.2 節。

---

## 6. 4.0.2 Packet Transaction Boundary（單一封包不可拆分交易邊界）

### 6.1 實際封包寫入流程盤點與分類
經盤點 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 與 [`src/database/packet-transaction.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js)，系統中所有資料庫寫入明確區分為「**同一邏輯封包事件（Local SQLite 下為同一個原子交易）**」與「**獨立背景批次工作（保持各自獨立交易）**」。

> **事件名稱核對說明**：`src/database/packet-transaction.js` 透過 `batchEmit` 發出的事件類型嚴格僅有 `'node_seen'`、`'raw_packet'` 與 `'telemetry_update'` 三種（於 `index.js` 的 `flushPendingBatch()` 彙整發送為 `'node_seen_batch'`、`'raw_packet_batch'`、`'telemetry_batch'`）。

| 寫入來源 / 封包類型 | 交易內包含之 SQL 順序（`statements` 原子單位） | 筆數 | COMMIT 成功後執行之外部副作用（`postCommitEffects`） |
|---|---|---|---|
| **MQTT 加密封包 (`ENCRYPTED`)** | 1. `nodes` 節點發現 Upsert (`NODE_DISCOVERY_UPSERT_SQL`)<br>2. `packet_logs` (`ENCRYPTED`) Insert | 2 | `batchEmit('node_seen', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 文字訊息 (`TEXT_MESSAGE_APP`, Port 1)** | 1. `nodes` 節點發現 Upsert<br>2. `chat_messages` Insert<br>3. `packet_logs` Insert | 3 | `recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 座標封包 (`POSITION_APP`, Port 3)** | 1. `nodes` 節點發現 Upsert<br>2. `nodes` 經緯度更新 (`UPDATE nodes SET latitude = ?, longitude = ?`)<br>3. `packet_logs` Insert | 3 | `recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`（基礎發現 + 座標更新）、`batchEmit('raw_packet', ...)` |
| **MQTT 節點資訊 (`NODEINFO_APP`, Port 4)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` Insert<br>3. `nodes` 身分與硬體韌體更新 (`long_name`, `short_name`, `role`, `hw_model`, `firmware_version`, `firmware_build_num`) | 3 | `logger.log('👤 [節點資訊] 更新: ...')`、`recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`（基礎發現 + 節點資訊）、`batchEmit('raw_packet', ...)` |
| **MQTT 路由 / 追蹤 / 其他 (`ROUTING_APP` Port 5, `TRACEROUTE_APP` Port 70 等)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` Insert | 2 | `recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 遙測封包 (`TELEMETRY_APP`, Port 67)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` Insert<br>3. `nodes` 遙測欄位 `COALESCE` 更新<br>4. `telemetry_data` Insert | 4 | `logger.log('💾 [寫入DB成功] 節點: ...')`、`recordLivePacketAnalytics(..., temp, hum)`、`batchEmit('node_seen', ...)`、`batchEmit('raw_packet', ...)`、`batchEmit('telemetry_update', ...)` |
| **MQTT 鄰居資訊 (`NEIGHBORINFO_APP`, Port 71)** | 1. `nodes` 節點發現 Upsert<br>2..K+1. 每筆有效鄰居之 `neighbors` Upsert<br>K+2. `packet_logs` Insert | $2 + K$ | `recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 地圖回報 (`MAP_REPORT_APP`, Port 73)** | 1. `nodes` 節點發現 Upsert<br>2. `nodes` 經緯度更新（若有有效座標）<br>3. `packet_logs` Insert<br>4. `nodes` 地圖回報 `COALESCE` 更新 | 3–4 | `logger.log('🗺️ [地圖報告] 節點: ...')`、`recordLivePacketAnalytics(...)`、`batchEmit('node_seen', ...)`（基礎發現 + 地圖報告）、`batchEmit('raw_packet', ...)` |
| **RF TCP Tunnel 座標封包 (`setupRFListener`)** | 1. `packet_logs` (`POSITION`, `source`) Insert<br>2. `nodes` (`last_seen`, `last_gateway`) Update | 2 | `batchEmit('raw_packet', packetData)` |
| **獨立背景工作（不與單一封包合併）** | `flushLiveAnalytics()` (`daily_analytics_summary`)、`computeAndSaveDaySummary()`、`fetchAndSaveCWAData()` (`cwa_weather_stations`)、`cleanupOldData()` (90 天定期清理) | 各自獨立 | 由定時器獨立排入 `WriteQueue`，不阻塞或干擾即時封包交易 |

### 6.2 交易邊界、錯誤分類、Post-Commit 保護與 Turso Fallback 保證
1. **不可拆分之封包交易單位 (`isTransactionUnit: true`)**：
   - [`WriteQueue.enqueuePacketTransaction(statements, callback, options)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L372-L379) 與 `db.queuePacketTransaction(...)` 將單一封包的所有 SQL 語句封裝為單一佇列項目（`item.isTransactionUnit = true`、`item.statements = [...]`）。
   - 在 `_commitOrIsolate(batch)` 中，同一個 `batch` 內的所有佇列項目在同一個 `adapter.transaction(async (tx) => ...)` 內依序執行；若任一封包單位內任一語句拋錯，整個 `adapter.transaction` 立即 `ROLLBACK`，絕不留下半套寫入。
2. **嚴格區分 `DATA_CONSTRAINT` 與 `UNKNOWN` 錯誤（P1 修正）**：
   - 在 [`WriteQueue._commitOrIsolate()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L644-L660) 中，**唯有 `classifyError(err) === ERROR_TYPES.DATA_CONSTRAINT` 的資料約束錯誤**才允許進入 [`_binaryIsolateBatch()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L665-L711)，以單一封包交易單位為粒度隔離至 `quarantinedItems`（絕不拆開 `item.statements` 內部語句）。
   - **`ERROR_TYPES.UNKNOWN`（例如 SQL 語法錯誤、資料表或欄位不存在、未知程式或驅動錯誤）絕不進入 Binary Isolation，也不標記為 `QUARANTINED`**：而是直接向上拋出至 `_executeTopLevelBatch()`，觸發 `handleAdapterFatalError(err)` 將佇列轉入 `QUEUE_STATES.PAUSED_ERROR` 並關閉寫入閘門，同時將未提交項目轉入 `ITEM_STATUS.UNCOMMITTED_ERROR`（保留 `failedStatementIndex`、`failedStatementSql`、`errorType`、`transactionLabel` 等診斷資訊）。
3. **交易內 SQL 與 COMMIT 後副作用嚴格分離 + Post-Commit Hook 獨立錯誤保護（P2 修正）**：
   - 交易進行中（`COMMIT` 完成前）僅執行 SQLite 寫入語句，**絕不**在交易內提前觸發 `batchEmit`、`recordLivePacketAnalytics` 或成功回呼。
   - 僅當該封包所屬交易 `COMMIT` 成功後，[`executePacketTransactionPlan()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js#L497-L611) 才依序執行 `logger.log`、`recordLivePacketAnalytics`、`batchEmit` 與 caller `callback`。
   - **每個 post-commit effect 皆具備獨立 `try/catch` 保護**：單一 `logger.log`、`recordLivePacketAnalytics` 或 `batchEmit` 拋出例外時，由 `reportPostCommitHookError()` 記錄 `[POST_COMMIT_HOOK_ERROR]` 並附掛於 `result.postCommitErrors`，不會阻止其他 post-commit effects 或 caller `callback` 執行；已 COMMIT 成功的交易不會被誤判為交易失敗，且 caller `callback` 透過 `invokeCallerCallbackOnce` 維持 `exactly-once`。
4. **Turso Fallback 實際隊列入口、多語句順序執行與限制說明（P1 修正）**：
   - 當系統處於 `TURSO_URL` 分支（無 Local SQLite 之 `db.queuePacketTransaction` 與 `db.queueDbOp`）時，[`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L502-L526) 與測試共同使用 [`src/database/packet-transaction.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js#L756-L993) 匯出的 `createTursoDbWrapper(client)` 與 `createSequentialFallbackQueueController(...)`。
   - 完整調度鏈路：`queuePacketTransaction() / queueDbOp() -> dbQueue -> flushDbQueue() -> executeSequentialFallbackItem()`。
   - `queuePacketTransaction()` 建立 `isTransactionUnit: true` 的交易單位進入實際 `dbQueue`；`flushDbQueue()` 辨識 `item.isTransactionUnit` 並按照 `item.statements` 陣列原始順序逐一執行每條 SQL（絕不把 `options.label` 當成 SQL 執行，也不會在第一條 SQL 後就提前回報成功）。
   - 當同一個 `dbQueue` 中混合一般單筆 `queueDbOp()` 與多語句 `queuePacketTransaction()` 時，嚴格維持 FIFO 執行順序與各自獨立的 `exactly-once` callback 行為。
   - 若中途任一條 SQL 失敗，立即停止該交易單位後續 SQL、透過 callback 回報錯誤一次（附帶 `failedStatementIndex`、`failedStatementSql`、`transactionLabel`），且不執行成功的 post-commit effects，同時不破壞佇列中後續獨立項目的執行。
   - **誠實語意限制**：Turso fallback 僅提供多語句順序執行與中斷回報，**不具備 Local SQLite Adapter 的單連線原子交易回滾保證**。
5. **Backup Scheduler Policy 共用政策函式與嚴格 Fail-Closed（4.0.2 收尾強化與最終驗收前修正 P2）**：
   - [`src/database/backup-manager.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js) 匯出 `APP_BACKUP_CRON_EXPRESSION ('0 0 * * 0')`、`createAppBackupSchedulePolicy(dbTarget, envSource, options)` 與 `registerAppBackupSchedule(dbTarget, cronLib, envSource)`，並由 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 與測試直接共用同一份實作。
   - **嚴格 Fail-Closed**：`shouldRun()` 僅在下列條件全部成立時回傳 `true`，其餘一律拒絕：(1) 已設定 `envSource.BACKUP_PATH`；(2) `dbTarget` 存在；(3) `dbTarget.isBootstrapReady` 為 function（缺少時視為無法確認 Schema Ready 而拒絕，不再預設放行）；(4) `isBootstrapReady()` 未拋出例外且回傳值嚴格等於 `true`。
   - `isBootstrapReady()` 拋出例外時安全拒絕並以 `[BACKUP_SCHEDULE_POLICY_ERROR]` 輸出診斷（可由 `options.logger` 注入；logger 自身失敗亦不影響拒絕結果），絕不將例外拋入 cron 排程回呼。
   - 每次排程觸發皆即時評估當下 `envSource.BACKUP_PATH` 與 `dbTarget.isBootstrapReady()`，不快取任何舊狀態，並保留既有 `'0 0 * * 0'` 排程、`BACKUP_PATH` 目的地與檔名政策不變。
6. **`package.json` 與 `package-lock.json` 版本 Metadata 同步**：
   - 根目錄 `package.json` 與 `package-lock.json`（含 `packages[""]`）統一對齊為 `3.1.0`；`frontend/package.json` 與 `frontend/package-lock.json`（含 `packages[""]`）亦統一對齊為 `3.1.0`，且保留 `sqlite3 ^5.1.6` 與既有依賴鎖定版本不變。
7. **測試專用 IPC Hooks 隔離（最終驗收前修正 P2）**：
   - [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 以集中式常數 `TEST_HOOKS_ENABLED = (process.env.MESHTASTIC_ENABLE_TEST_HOOKS === '1')` 控制 `TEST_FLUSH_DB_QUEUE` 與 `TEST_INJECT_MQTT_PACKET` 兩種測試 IPC 控制訊息，**預設關閉**。
   - 未啟用時：收到上述訊息一律不執行、不回覆，僅輸出 `[TEST_HOOKS_DISABLED]` 警示日誌；啟用時行為與先前完全一致。`'shutdown'` 等一般 IPC 訊息與 MQTT `message` handler、`WriteQueue` 路徑完全不受此開關影響。
   - 此開關**不得**寫入一般 `.env`、`.env.example`、PM2 設定或 Production 設定；整合測試子程序於 spawn 時明確注入 `MESHTASTIC_ENABLE_TEST_HOOKS=1`（其餘子程序明確移除該變數），並由 `Test 4.0.2-35` 驗證主測試程序與一般設定檔不含此開關。
   - **已知限制**：`MQTT_PIPE_PATH`（讓 `index.js` 以本機 Named Pipe / Unix Socket 取代網路 MQTT 連線）為另一個既有的測試用環境變數，預設不設定，**不在本輪「測試 IPC Hooks」收斂範圍內**，亦不受 `MESHTASTIC_ENABLE_TEST_HOOKS` 控制；Production 不得設定此變數。
8. **文件章節編號整理（最終驗收前修正 P3）**：
   - 將原本重複的 `## 5.`（測試覆蓋與分類 / 4.0.2 Packet Transaction Boundary）與 `## 6.`（測試驗證矩陣）重新編號為連續的 `## 5.`、`## 6.`、`## 7.`，各章子節同步更新（6.1、6.2、7.1 ～ 7.4）；原錯置於第 7.2 節且缺少表格標頭之 Tests L – AA 表格補上標頭並與第 5.1 節（Tests A – K）互相標註，未刪除任何既有內容。

---

## 7. 測試驗證矩陣（共 108 項 `it()` 測試案例）

### 7.1 [`tests/database/packet_transaction_4_0_2.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/packet_transaction_4_0_2.test.js)（35 項 4.0.2 `it()` 測試案例）

| 測試編號與名稱 | 測試性質 | 驗證重點 |
|---|---|---|
| **Test 4.0.2-1 — Multi-Table Packet Commit Success** | 真實 SQLite 多表交易整合測試 | 驗證 `TELEMETRY_APP`（4 筆 SQL）、`TEXT_MESSAGE_APP`（3 筆 SQL）、`NEIGHBORINFO_APP`（4 筆 SQL）在單一交易中全部寫入成功，且 `COMMIT` 後精確觸發 `node_seen`、`raw_packet`、`telemetry_update` 與 `recordLivePacketAnalytics`。 |
| **Test 4.0.2-2 — Middle SQL Failure & Atomic Rollback** | 真實 SQLite 中間步驟失敗回滾測試 | 在 4 筆語句的第 3 筆（中間步驟 `index=2`, `UPDATE nodes`）觸發失敗，驗證前 2 筆（`nodes`、`packet_logs`）完整 `ROLLBACK`、第 4 筆（`telemetry_data`）絕不繼續執行，且 `COMMIT` 後副作用 0 次觸發。 |
| **Test 4.0.2-3 — Final SQL Failure & Atomic Rollback** | 真實 SQLite 最終步驟失敗回滾測試 | 在 4 筆語句的第 4 筆（最終步驟 `index=3`, `INSERT INTO telemetry_data`）觸發失敗，驗證前 3 筆寫入全數 `ROLLBACK`，且 `batchEmit` / `recordLivePacketAnalytics` 0 次觸發。 |
| **Test 4.0.2-4 — RF Tunnel Packet Transaction Failure & Rollback** | 真實 SQLite RF Tunnel 交易回滾測試 | 模擬 RF Tunnel 封包第 2 條 SQL（`UPDATE nodes`）失敗，驗證第 1 條 `packet_logs` Insert 完整 `ROLLBACK`、`nodes.last_gateway` 保持原值，且不觸發 `raw_packet` 推播。 |
| **Test 4.0.2-5 — DATA_CONSTRAINT Binary Isolation (P1 Test A)** | 真實 SQLite 同批次資料約束隔離測試 | 5 個封包同批執行時第 3 個封包發生 `DATA_CONSTRAINT` 錯誤，驗證 Binary Isolation 以封包為最小單位隔離壞封包至 `QUARANTINED`（不拆開內部語句、0 殘留），其餘 4 個合法封包完整提交。 |
| **Test 4.0.2-6 — UNKNOWN Error Fatal Pause & No Binary Isolation (P1 Test B)** | 真實 SQLite `UNKNOWN` 致命錯誤熔斷測試 | 模擬封包交易發生 `SQLITE_ERROR`（`ERROR_TYPES.UNKNOWN`），驗證**不進入 `_binaryIsolateBatch`**、**不標記為 `QUARANTINED`**、觸發 `handleAdapterFatalError()` 進入 `PAUSED_ERROR` 拒絕後續寫入、未提交項目皆標記為 `UNCOMMITTED_ERROR`（保留 `failedStatementIndex`、`failedStatementSql`、`errorType`、`transactionLabel`）且無假成功。 |
| **Test 4.0.2-7 — Post-Commit Ordering & Exactly-Once Callback** | 真實 SQLite + `COMMIT` 時序攔截測試 | 驗證在 `TX_COMMIT_COMPLETED` 前無任何推播、戰情累加或回呼，所有外部副作用嚴格發生於 `COMMIT` 之後，且 callback 精確執行 1 次。 |
| **Test 4.0.2-8 — Post-Commit Hook Exception Isolation (P2)** | 真實 SQLite + Hook 例外注入測試 | 分別模擬 `logger.log`、`recordLivePacketAnalytics`、`batchEmit` 拋出例外，驗證 SQLite 交易維持已提交、其他 hook 正常繼續執行、caller callback 仍以 `err === null` 精確執行 1 次，且記錄 `[POST_COMMIT_HOOK_ERROR]` 與 `result.postCommitErrors`。 |
| **Test 4.0.2-9 — Concurrent Packet Transactions, Concurrent Reads & Online Backup** | 真實 SQLite 併發寫入 + 讀取 + `VACUUM INTO` 備份測試 | 32 個跨表封包交易併發執行期間，同時進行持續讀取查詢與 `BackupManager.performBackup()`，驗證併發讀取與產出的備份 DB 檔案皆可正常開啟、`PRAGMA integrity_check === 'ok'`，且 `nodes`、`packet_logs`、`telemetry_data` 筆數完全一致（無部分交易資料）。 |
| **Test 4.0.2-10 — Shutdown Active Packet Transaction Drain** | 真實 SQLite 交易進行中延遲 + `ShutdownHandler` 排空測試 | 讓第 1 筆封包交易在第 2 條 SQL 處延遲 120ms 保持 In-Flight 並排入第 2 筆交易，期間觸發 `ShutdownHandler.handle('SIGTERM')`，驗證系統等待進行中與排隊交易完成 `COMMIT` 與 callback 後才呼叫 `adapter.close()`，重開後兩筆交易完整存在。 |
| **Test 4.0.2-11 — Unknown Node Pre-NODEINFO Arrival & COALESCE / RF Tunnel Semantics** | 真實 SQLite 業務相容性回歸測試 | 驗證未知節點在收到 `NODEINFO` 前先收到 `POSITION` 與兩筆互補 `TELEMETRY` 時，`COALESCE` 更新、`NODEINFO` 補齊與 RF Tunnel 更新完全相容。 |
| **Test 4.0.2-12 — Turso Actual Queue Entry & Flush Path (`queuePacketTransaction -> dbQueue -> flushDbQueue -> executeSequentialFallbackItem`)** | 共用 Turso 佇列調度器與混合佇列整合測試 | 直接使用與 `index.js` 共用的 `createTursoDbWrapper` 與 `createSequentialFallbackQueueController`，驗證無 Local SQLite `queuePacketTransaction` 時進入實際 `dbQueue`、`flushDbQueue()` 辨識 `isTransactionUnit`、按陣列順序執行全部 4 條 SQL、不將 `label` 當成 SQL、中段失敗立即中止後續語句且不執行成功副作用、Callback 皆為 `exactly-once`，以及同一個 `dbQueue` 混合一般 `queueDbOp` 與多語句 `queuePacketTransaction` 時嚴格保持 FIFO 順序與各自 callback 行為。 |
| **Test 4.0.2-13 — Backup Scheduler Policy Shared Function Verification** | 共用排程政策函式 + 真實 SQLite 備份觸發測試 | 直接呼叫與 `index.js` 共用的 `registerAppBackupSchedule` / `createAppBackupSchedulePolicy`，完整驗證情境 A（無 `BACKUP_PATH` 不執行 `performBackup`）、情境 B（有 `BACKUP_PATH` 但 Schema 未就緒不執行備份）、情境 C（有 `BACKUP_PATH` 且 Bootstrap Ready 正常觸發產生 `.db` 備份檔）與情境 D（Bootstrap Ready 狀態動態變化時每次排程觸發皆使用當下最新狀態）。 |
| **Test 4.0.2-14 — SQLite WAL Process Death Recovery Test (SIGKILL)** | **原生 SQLite WAL 引擎跨程序 `SIGKILL` 測試** | 透過 `sigkill_tx_worker.js` 原生 `sqlite3` 模式驗證 `BEFORE_TX`、`MID_TX_UNCOMMITTED`（寫入 4 表未 `COMMIT`）、`AFTER_COMMIT` 遭遇 `SIGKILL` 後之 SQLite WAL 自動回滾與恢復。 |
| **Test 4.0.2-15 — Application Packet Transaction Process Death Test (SIGKILL)** | **專案 `WriteQueue` + `PacketTransaction` 跨程序 `SIGKILL` 測試** | 透過 `sigkill_tx_worker.js` 啟動真實 `createDatabaseSubsystem` + `WriteQueue` + `executePacketTransactionPlan`，在 `TELEMETRY_APP` 執行完前 3 條 SQL 但尚未執行第 4 條與 `COMMIT` 時發送 `SIGKILL`，驗證重開後未提交封包在 `nodes`、`packet_logs`、`telemetry_data` 皆為 0 殘留，而已 `COMMIT` 封包完整保留。 |
| **Test 4.0.2-16 — Full index.js Startup, Real Wire-Level MQTT Broker PUBLISH & Graceful Shutdown** | **真實 `index.js` 子程序 + 本機測試 Broker Wire-Level `PUBLISH` 測試** | 啟動真實 `index.js` 子程序連入本機測試 MQTT Broker（完成真實 `CONNECT -> CONNACK -> SUBSCRIBE -> SUBACK` 握手），由 Broker 發送真實 Wire-Level MQTT `PUBLISH (0x30)` 二進位 `ServiceEnvelope` 封包，驗證啟動屏障順序、封包跨表寫入與優雅關機。 |
| **Test 4.0.2-17 — Schema Bootstrap Failure Blocks Service Startup** | 真實 `index.js` 子程序啟動屏障失敗中止測試 | 預先植入定義錯誤的索引 `idx_packet_logs_timestamp`，驗證 `index.js` 檢出 `[FATAL_BOOTSTRAP_ERROR]` 後以 Exit Code `1` 終止，且絕不啟動 HTTP 或 MQTT 服務。 |
| **Test 4.0.2-18 — MQTT Mock Broker Stream Parser Test A (Complete Packet Single Arrival)** | 本機 Mock MQTT Broker 串流解析測試 | 驗證正常 MQTT `PUBLISH` 封包單次完整到達時正確解析 Topic 與 Payload，且解析後該 Socket `receiveBuffer` 歸零。 |
| **Test 4.0.2-19 — MQTT Mock Broker Stream Parser Test B (Split Fixed Header)** | 本機 Mock MQTT Broker 拆包解析測試 | 將 MQTT Fixed Header（`0x30` 與 Remaining Length）拆成不同 chunks 傳送，確認未收齊前不會提前解析，收齊後正確還原。 |
| **Test 4.0.2-20 — MQTT Mock Broker Stream Parser Test C (Split Multi-Byte Remaining Length)** | 本機 Mock MQTT Broker 多位元組長度拆包測試 | 使用 18KB Payload 產生 3-byte Remaining Length 並逐 byte 拆開傳送，確認 `receiveBuffer` 正確累積並解碼多位元組 Remaining Length。 |
| **Test 4.0.2-21 — MQTT Mock Broker Stream Parser Test D (Split Payload Across Chunks)** | 本機 Mock MQTT Broker Payload 分段到達測試 | 先傳送 Header 與部分 Topic/Payload，再分 3 個 chunks 傳送剩餘 Payload，確認完整到達後正確還原訊息。 |
| **Test 4.0.2-22 — MQTT Mock Broker Stream Parser Test E (Multiple Complete Packets Coalesced)** | 本機 Mock MQTT Broker 黏包解析測試 | 將 3 個完整 MQTT `PUBLISH` 封包合併為單一 chunk 一次寫入，確認依序完整解析全部 3 筆訊息。 |
| **Test 4.0.2-23 — MQTT Mock Broker Stream Parser Test F (Complete + Incomplete Packet, Multi-Socket Isolation & Close Cleanup)** | 本機 Mock MQTT Broker 複合緩衝與多連線隔離測試 | 一次傳送「完整第 1 包 + 未完成第 2 包前半段」，確認第 1 包立即解析、第 2 包保留於該 Socket 獨立 `receiveBuffer`、另一條並發 Socket 傳送不受干擾、補齊第 2 包後半段後正常解析，且連線關閉時徹底清除對應 Socket 緩衝狀態。 |
| **Test 4.0.2-24 — MQTT Mock Broker Stream Parser Test G (Abnormal Remaining Length & Buffer Size Limit Protection)** | 本機 Mock MQTT Broker 異常長度與記憶體上限保護測試 | 驗證 5-byte 非法 Remaining Length varint、超過 `maxRemainingLength` 的封包宣告，以及超過 `maxBufferSize` 的資料湧入均被立即攔截記錄於 `protocolErrors`、清空該 Socket 緩衝並關閉異常連線，不影響其他正常連線。 |
| **Test 4.0.2-25 — Backup Policy Fail-Closed Test A (No dbTarget)** | 共用排程政策函式單元測試 | 直接呼叫 `createAppBackupSchedulePolicy(null / undefined, env)`，即使已設定 `BACKUP_PATH` 仍必須 `shouldRun() === false`。 |
| **Test 4.0.2-26 — Backup Policy Fail-Closed Test B (Missing / Non-Function isBootstrapReady)** | 共用排程政策單元測試 + 真實 `BackupManager` 排程 tick 整合測試 | 驗證 `dbTarget` 缺少 `isBootstrapReady`、或其為布林/字串（非 function）時必須拒絕；並以真實 `BackupManager` 搭配缺少 `isBootstrapReady` 的 `dbTarget` 經 `registerAppBackupSchedule` 觸發排程 tick，確認回傳 `skipped`、`performBackup()` 呼叫 0 次、備份目錄 0 檔案。 |
| **Test 4.0.2-27 — Backup Policy Fail-Closed Test C (isBootstrapReady() Returns False / Non-True)** | 共用排程政策單元測試 | `isBootstrapReady()` 回傳 `false`、`undefined`、`null`、`0`、`1`、`'true'`、`{}` 等任何非嚴格 `true` 值皆必須拒絕。 |
| **Test 4.0.2-28 — Backup Policy Fail-Closed Test D (Ready + BACKUP_PATH Allows Run)** | 共用排程政策單元測試 | `BACKUP_PATH` 有效且 `isBootstrapReady() === true` 時允許執行；同時驗證 Cron 仍為 `'0 0 * * 0'`、`optionsProvider()` 仍使用 `BACKUP_PATH`、檔名格式不變，且未設定 / 空字串 `BACKUP_PATH` 或缺少 `envSource` 皆拒絕。 |
| **Test 4.0.2-29 — Backup Policy Fail-Closed Test E (isBootstrapReady() Throws)** | 共用排程政策單元測試（例外注入） | `isBootstrapReady()` 拋出例外時 `shouldRun()` 回傳 `false`、不向呼叫端拋出、並以 `[BACKUP_SCHEDULE_POLICY_ERROR]` 留下含原始錯誤訊息的診斷紀錄；`logger` 自身損壞時仍 Fail-Closed；未設定 `BACKUP_PATH` 時不會呼叫 `isBootstrapReady()`。 |
| **Test 4.0.2-30 — Backup Policy Fail-Closed Test F (Live State On Every Trigger)** | 共用排程政策單元測試（狀態切換） | 透過 `registerAppBackupSchedule` 取得實際傳入 `startSchedule` 的 `shouldRun`，連續切換 `BACKUP_PATH` 與 `isBootstrapReady()` 狀態 (`未Ready -> Ready -> 未Ready -> 移除路徑 -> 還原`)，驗證每次判斷皆使用即時狀態，且 `isBootstrapReady()` 實際被逐次呼叫 5 次（證明無快取）。 |
| **Test 4.0.2-31 — IPC Test Hooks Test A (Disabled By Default)** | 真實 `index.js` 子程序 + Mock Broker 整合測試 | 子程序環境明確移除 `MESHTASTIC_ENABLE_TEST_HOOKS`，送出 `TEST_FLUSH_DB_QUEUE` 後，驗證輸出 `[TEST_HOOKS_DISABLED]` 拒絕訊息且不回覆 `TEST_DB_QUEUE_FLUSHED`。 |
| **Test 4.0.2-32 — IPC Test Hooks Test B (Explicitly Enabled)** | 真實 `index.js` 子程序 + Mock Broker 整合測試 | 子程序明確設定 `MESHTASTIC_ENABLE_TEST_HOOKS=1`，`TEST_FLUSH_DB_QUEUE` 正常執行並回覆 `{ ok: true, requestId }`，且無拒絕訊息。 |
| **Test 4.0.2-33 — IPC Test Hooks Test C (TEST_INJECT_MQTT_PACKET Gated)** | 真實 `index.js` 子程序 + 優雅關機後 DB 驗證 | 未啟用時注入合法 `NODEINFO` 封包被拒絕、無回覆、優雅關機（會排空 `WriteQueue`）後 `nodes` 表仍無該節點；啟用時注入成功回覆 `ok: true`，且節點與 `packet_logs` 完整寫入。 |
| **Test 4.0.2-34 — IPC Test Hooks Test D (Normal MQTT Flow Regression)** | 真實 `index.js` 子程序 + 本機 Wire-Level Broker `PUBLISH` 回歸測試 | 測試 Hooks 未啟用時，由 Mock Broker 發送真實 `PUBLISH (0x30)` `NODEINFO` 封包，不使用任何 `TEST_*` IPC，仍由正常 `message` handler 與自然 `WriteQueue` Flush 寫入 `nodes` / `packet_logs`，且無任何 `TEST_*` IPC 回覆或拒絕訊息。 |
| **Test 4.0.2-35 — IPC Test Hooks Test E (Environment Isolation)** | 真實 `index.js` 雙子程序並行環境隔離測試 | 驗證主測試程序未持有 `MESHTASTIC_ENABLE_TEST_HOOKS`、`.env` / `.env.example` / `ecosystem.config.*` / `package.json` 皆不含該開關；同時啟動「明確啟用」與「預設」兩個子程序，確認僅前者執行 `TEST_FLUSH_DB_QUEUE`，後者拒絕；測試結束後主程序環境未被改變。 |

### 7.2 [`tests/database/data_integrity_4_0_1.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（27 項 4.0.1 – 4.0.1.4 `it()` 測試案例，Tests A – AA）

> Tests A – K 之測試分類與驗證方式詳見第 5.1 節表格；以下為 Tests L – AA 之測試矩陣。

| 測試編號與名稱 | 測試性質 | 驗證重點 |
|---|---|---|
| **Test L — Backup Restore Verification** | 真實 SQLite End-to-End Backup & Restore Test | 對真實臨時 DB 備份後，呼叫 `restoreFromBackup(..., { offlineConfirmed: true })` 還原至第二個獨立臨時 DB，並以新 `createDatabaseSubsystem` 開啟驗證資料一致性與後續讀寫。 |
| **Test M — Backup Scheduler Non-Overlap & Shutdown Race** | 真實 SQLite + `ShutdownHandler.handle()` Integration Test | 驗證重疊排程自動跳過；並測試在 `VACUUM INTO` 執行期間觸發真實 `ShutdownHandler.handle('SIGTERM')`（涵蓋「於 Deadline 內完成並安全關閉」與「超過 Deadline 時拒絕呼叫 `db.close()` 保護活動連線」兩種情境）。 |
| **Test N — P1 Backup Scheduler Isolation** | 真實 SQLite Integration + Rename Failure Injection | 在 `VACUUM INTO` 完成後、`verifyIntegrity` 開始前（`afterVacuumBeforeVerify` Gate），驗證 `maintenanceInProgress === false` 且 `WriteQueue` 可立即寫入主 DB；同時以 `renameImpl` 注入錯誤驗證同名舊有效備份不會因新備份安裝失敗而損毀。 |
| **Test O — P1 Restore Safety Hardening (Existing Target)** | 真實 SQLite Active DB & Lock Detection + Rollback Injection | 驗證拒絕還原至當前活躍 Adapter DB、拒絕還原至另一活躍 Adapter DB、拒絕還原至被外部連線 `BEGIN IMMEDIATE` 鎖定之 DB；並以 `renameImpl` 注入錯誤驗證替換既有離線 DB 失敗時自動從 `.rollback-*` 完整復原原始離線 DB。 |
| **Test P — P2 Schema Index Definition Verification** | 真實 SQLite PRAGMA Verification Test | 在真實臨時 SQLite DB 中預先建立同名但欄位順序顛倒、`ASC`/`DESC` 相反、`UNIQUE` 不符、含 Partial `WHERE` 或掛錯資料表的索引，驗證 `verifyDatabaseSchema()` 全數檢出並阻擋啟動。 |
| **Test Q — P2 Backup Path Containment** | Unit & Integration Validation Test | 驗證 `validateBackupFilePath()` 與 `performBackup()` 接受合法檔名，並拒絕 `../`、`..\`、POSIX/Windows 絕對路徑、`C:` 磁碟機路徑、UNC 路徑、子目錄斜線與 NUL 字元。 |
| **Test R — Restore Offline Confirmation (4.0.1.2 P1)** | 真實 SQLite WAL Read/Write Connection + Precondition Test | 驗證省略 `offlineConfirmed` 或傳入 `offlineConfirmed: false` 時皆以 `BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED` 拒絕且不更動目標 DB / `-wal` / `-shm`；驗證外部連線持有 WAL Read Transaction 時仍受 `offlineConfirmed` 保護；驗證外部寫入鎖受 Lock Probe 攔截；並驗證離線且 `offlineConfirmed: true` 時成功還原。 |
| **Test S — Restore Rollback Without Existing Target (4.0.1.2 P1)** | 真實 SQLite Restore + Post-Install Failure & Unlink Injection Test | 針對原始目標資料庫不存在之情境，驗證：(S-1) 安裝前 `rename` 失敗回傳 `RESTORE_FAILED_INSTALL_ABORTED` (`rollbackSucceeded: false`)；(S-2) 新目標已安裝但安裝後驗證失敗時，自動清除新目標 DB 與 `-wal`/`-shm` 回到不存在狀態且不傷及同目錄其他檔案，回傳 `RESTORE_FAILED_ROLLED_BACK` (`rollbackSucceeded: true`)；(S-3) 清除失敗時回傳 `RESTORE_FAILED_ROLLBACK_INCOMPLETE` (`rollbackSucceeded: false`)。 |
| **Test T — Backup Rotation maxBackups Exact Count (4.0.1.2 P2)** | 真實 SQLite `VACUUM INTO` Backup Rotation Test | 設定 `maxBackups: 2` 與 `retentionDays: 365`（排除過期天數干擾），連續建立 3 份真實備份並確認輪替時 `targetPath` 仍位於 `#inProgressBackupPaths`，驗證最新備份計入總數、第 3 份完成後精確保留最新 2 份並刪除最舊第 1 份，且忽略未驗證檔與 staging 檔。 |
| **Test U — Restore Staging Cleanup Failure Reporting (4.0.1.3 P2)** | **真實 SQLite Staging 建立與驗證 + 受控 Rename/Unlink 錯誤注入測試** | 真實執行 SQLite 備份、建立 `.restore-staging-*` 並通過 `verifyIntegrity()`；透過 `renameImpl` 注入 `EXDEV` 安裝失敗並透過 `unlinkImpl` 注入 `EPERM` 模擬 staging 刪除失敗（非真實 OS 檔案系統損毀）。驗證：原始目標仍不存在、原始 `EXDEV` 錯誤未被覆蓋、`cleanupComplete === false`、`remainingPaths` 包含該 staging 路徑、狀態歸類為 `RESTORE_FAILED_ROLLBACK_INCOMPLETE`、同目錄無關檔案完好，並於 teardown 恢復真實刪除清理暫存檔。 |
| **Test V — Restore Rollback Cleanup Warning (4.0.1.3 P2)** | **真實 SQLite Restore 流程 + 受控 Rollback Unlink 錯誤注入測試** | 真實執行原始目標 DB 建立、備份、staging 建立、新目標安裝與安裝後 `verifyIntegrity()`；僅在清理舊 `.rollback-*` 時透過 `unlinkImpl` 注入 `EBUSY` 失敗。驗證：`restoreStatus` 仍為 `RESTORE_COMPLETED`、`cleanupComplete === false`、`cleanupWarnings` 記錄 `{ path, code: 'EBUSY', message, stage: 'ROLLBACK_FILE_CLEANUP' }`、`preservedRollbackPaths` 包含舊 `.rollback-*` 完整路徑且檔案仍存在於磁碟、新安裝之有效 DB 不被誤刪且可正常開啟讀寫，並於 teardown 清理保留的 `.rollback-*`。 |
| **Test W — Restore Idle WAL Connection Confirmation (4.0.1.3 P2)** | **真實 SQLite WAL 資料庫 + 獨立外部閒置連線整合測試** | 建立真實 WAL 模式目標 DB 並開啟一條不執行任何 Transaction 或讀寫的純閒置 `sqlite3.Database` 連線；實測證明此時 `BEGIN EXCLUSIVE` Lock Probe 會成功，但省略 `offlineConfirmed` 呼叫 `restoreFromBackup()` 仍必以 `BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED` 阻擋且不修改目標 DB / WAL / SHM；待關閉外部閒置連線後，再以 `offlineConfirmed: true` 驗證正常還原成功。 |
| **Test X — Cleanup State Verification & Backup Cleanup Call Sites (4.0.1.4 P2)** | **Cleanup 三態單元測試 + 真實 SQLite Backup 全 5 處清理呼叫點錯誤注入整合測試** | (X-1/X-2) 以 `lstatFn` 注入 `EACCES` 驗證初始或 `unlink` 後無法確認檔案存在狀態時，`complete === false`、寫入 `failures` 與 `unverifiablePaths` 且絕不誤判為 `alreadyAbsent`；(X-3) 驗證真實 `ENOENT` 歸類為 `alreadyAbsent` 且 `complete === true`；(X-4) 針對 `performBackup()` 全部 5 個清理呼叫點（`VACUUM INTO` 失敗、`retainFailedStaging` 改名失敗、`verifyIntegrity` 失敗、安裝 `rename` 失敗、安裝成功後殘留 `-wal` 清理失敗）逐一驗證原始錯誤保留且 `cleanupComplete` / `cleanupResult` / `cleanupFailures` / `remainingPaths` / `unverifiablePaths` 完整記錄。 |
| **Test Y — Rollback Path Verification (4.0.1.4 P2)** | **真實 SQLite Restore + 受控 Rollback Unlink/Lstat 狀態注入測試** | 在真實 SQLite 資料庫還原成功後清理舊 `.rollback-*` 階段，驗證三種狀態：(Y-1) `unlink` 拋錯但檔案已不存在（`ABSENT`）時記錄 `cleanupWarnings` (`existenceState: 'ABSENT'`)、`cleanupComplete === false`，且**不加入 `preservedRollbackPaths`**；(Y-2) `unlink` 拋錯且檔案仍存在（`PRESENT`）時加入 `preservedRollbackPaths`；(Y-3) `unlink` 拋錯且後續 `lstat` 拋出 `EACCES`（`UNKNOWN`）時記錄 `cleanupWarnings` (`existenceState: 'UNKNOWN'`)、`cleanupComplete === false`，且**不加入 `preservedRollbackPaths`**。 |
| **Test Z — Backup Replacement `.prev-*` Cleanup & Rollback Error Diagnostics (4.0.1.4 P2)** | **真實 SQLite Backup 替換 + `.prev-*` Unlink/Lstat/Rename 錯誤注入測試** | (Z-1/Z-2) 新備份安裝成功後刪除舊 `.prev-*` 失敗時，驗證新備份維持有效且回傳 `COMPLETED`、`cleanupComplete === false`、`cleanupWarnings` / `cleanupFailures` 記錄完整路徑與錯誤碼，並依 `PRESENT` / `ABSENT` / `UNKNOWN` 精確更新 `preservedPrevBackupPaths`、`remainingPaths` 與 `unverifiablePaths`；(Z-3) 新備份安裝 `rename` 失敗且舊 `.prev-*` 還原 `rename` 亦失敗時，驗證保留原始安裝錯誤、記錄 `previousBackupRestoreError` 與 `rollbackErrors`、並將舊有效備份安全保留於 `preservedPrevBackupPaths`。 |
| **Test AA — Pre-Cleanup Verification Before VACUUM INTO & Restore Staging (4.0.1.4 P2)** | **真實 SQLite Backup & Restore 前置 Cleanup 阻斷與通過整合測試** | 驗證 `performBackup()`（`VACUUM INTO` 前）與 `restoreFromBackup()`（建立還原 staging 前）在前置 `_cleanupFileAndSidecars()` 回傳 `complete === false`（含 `unlink` 失敗殘留檔案與 `lstat` `EACCES` 狀態 `UNKNOWN`）時立即中止，絕不執行 `VACUUM INTO` 或建立還原 staging，且完整保留 `cleanupResult`、`remainingPaths`、`unverifiablePaths` 與原始錯誤；並在前置清理成功（`complete === true`）時正常完成備份與還原。 |

### 7.3 [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js)（46 項既有基線 `it()` 測試案例）
- 完整保留 v2.7.7 結案之 46 項測試（包含真實 SQLite 交易/鎖定測試，以及針對罕見底層情境如 Delayed Native Close Callback / Callback Error Injection 的模擬測試），**0 刪除、0 跳過、0 修改**。

### 7.4 測試邊界與環境限制誠實聲明
- **SQLite WAL Process Death Test (`Test 4.0.2-14`) vs. Application Packet Transaction Process Death Test (`Test 4.0.2-15`)**：`Test 4.0.2-14` 直接使用 `sqlite3` 驗證 SQLite WAL 引擎在程序被強制終止後的回滾能力；`Test 4.0.2-15` 則透過專案 `createDatabaseSubsystem` + `WriteQueue` + `executePacketTransactionPlan` 驗證應用程式封包交易在中段（已執行 3/4 條 SQL）與 `COMMIT` 後遭遇 `SIGKILL` 的恢復行為。兩者皆屬**跨程序異常終止 (`SIGKILL`) 測試，不等同於實體主機斷電（Power Loss）、作業系統核心崩潰（Kernel Panic）或磁碟硬體扇區損毀測試**。
- **本機測試 Broker Wire-Level MQTT 傳輸與 Stream Parser (`Test 4.0.2-16` & `Test 4.0.2-18 ~ 24`)**：使用本機 `net.Server` 測試 Broker（於 Windows 環境透過 Named Pipe 避免沙盒阻擋 Loopback TCP），為每個 Socket 維護獨立 `receiveBuffer`、多位元組 MQTT Remaining Length 解碼、拆包/黏包重組與超限記憶體保護，完成真實 MQTT `CONNECT -> CONNACK -> SUBSCRIBE -> SUBACK` 並發送 Wire-Level `PUBLISH (0x30)` 封包，不連接外部正式環境 MQTT Broker。
- **正式環境零接觸**：全部 **108 項 `it()` 測試**（`46 + 27 + 35 = 108`）均於 `os.tmpdir()` 下的獨立臨時 SQLite 資料庫執行，並於測試結束後完整清除，完全不讀取、不修改、不壓測正式環境 `d:\meshtastic\Meshtastic-DashBoard-Prod`。
- **測試 IPC Hooks 子程序整合測試 (`Test 4.0.2-31 ~ 35`)**：每個測試子程序均於 spawn 時由測試明確注入（或明確移除）`MESHTASTIC_ENABLE_TEST_HOOKS`，絕不修改主測試程序環境、`.env` 或任何 Production 設定；`index.js` 子程序使用獨立臨時 DB 與本機 Named Pipe Mock Broker。`MQTT_PIPE_PATH`（將 MQTT 傳輸改為本機 Pipe）仍為獨立之測試用環境變數，預設不設定、不受 `MESHTASTIC_ENABLE_TEST_HOOKS` 控制（詳見第 6.2 節第 7 項「已知限制」）。
