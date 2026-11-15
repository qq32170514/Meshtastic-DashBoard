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

### 1.2 `TURSO_URL` 分支與本地 SQLite 分支架構對照及政策確認
- **重要聲明**：`bootstrapDatabaseSchema()`、`verifyDatabaseSchema()`、`isBootstrapReady()`、`executeWithStartupBarrier()`、`WriteQueue`（含 4.0.2 封包交易單位 `enqueuePacketTransaction`）、`ShutdownHandler` 以及 `BackupManager` **僅涵蓋本地 SQLite 執行路徑（未設定 `TURSO_URL` 時）**。
- 當環境變數設定 `TURSO_URL` 時，[`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L670-L819) 走 `@libsql/client` 相容包裝器分支，兩者能力差異如下表：

| 能力項目 | 本地 SQLite 分支（未設定 `TURSO_URL`） | `TURSO_URL` 遠端分支（設定 `TURSO_URL`） |
|---|---|---|
| 底層介面 | `initDatabaseSubsystemSync`（`SQLiteAdapter` + `sqlite3 ^5.1.6`） | `@libsql/client` 簡易包裝器（`run` / `get` / `all` / `serialize`） |
| 連線排程與交易控制 | 具備單一寫入佇列、專屬 Transaction Context、Retry Backoff | 無 `SQLiteAdapter` 排程器，逐筆呼叫 `turso.execute()` |
| 4.0.2 封包交易邊界 | 具備 `queuePacketTransaction` / `WriteQueue.enqueuePacketTransaction` 原子交易單位 | `queuePacketTransaction` 僅順序呼叫 `db.run`，無本地 SQLite 原子批次隔離 |
| Schema Bootstrap 屏障 | 具備 `bootstrapDatabaseSchema` + `verifySingleIndexDefinition` + `db.readyPromise` | 僅以 `db.serialize()` 非同步發送 `CREATE TABLE IF NOT EXISTS`，無 `readyPromise` 屏障 |
| 備份與還原管理 | 具備 `BackupManager`（`VACUUM INTO`、離線確認、三態清理驗證） | `db.backupManager` 為 `undefined`，不適用本地 SQLite 檔案備份 |
| 關機排空與 Checkpoint | 具備 `ShutdownHandler`（排空 `WriteQueue` + `wal_checkpoint(TRUNCATE)`） | 無本地 WAL 檔案或 `ShutdownHandler` |

### 1.3 備份排程政策確認（`BACKUP_PATH` 與 Cron 設定）
- **`BACKUP_PATH` 啟用條件**：在 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L4479-L4495) 中，`db.backupManager.startSchedule('0 0 * * 0', cron, ...)` 傳入 `shouldRun: () => Boolean(process.env.BACKUP_PATH) && db.isBootstrapReady()`：
  - 當未設定 `BACKUP_PATH` 時：排程器雖有註冊，但每次觸發時 `shouldRun()` 回傳 `false`（記錄 `SKIPPED_CONDITION_FALSE`），**不會在未授權路徑自動產生備份檔案**。
  - 當設定 `BACKUP_PATH` 且 `db.isBootstrapReady() === true` 時：排程器正常執行 `performBackup(process.env.BACKUP_PATH)`。
- **排程頻率差異說明**：
  - [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L4480) 實際呼叫 `startSchedule` 使用 `'0 0 * * 0'`（每週日 00:00 執行）。
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
---

## 5. 4.0.2 Packet Transaction Boundary（單一封包不可拆分交易邊界）

### 5.1 實際封包寫入流程盤點與分類
經盤點 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 與 [`src/database/packet-transaction.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js)，系統中所有資料庫寫入明確區分為「**同一邏輯封包事件（必須同一個原子交易）**」與「**獨立背景批次工作（保持各自獨立交易）**」：

| 寫入來源 / 封包類型 | 交易內包含之 SQL 順序（`statements` 原子單位） | 筆數 | COMMIT 成功後執行之外部副作用（`postCommit`） |
|---|---|---|---|
| **MQTT 加密封包 (`ENCRYPTED`)** | 1. `nodes` 節點發現 Upsert (`NODE_DISCOVERY_UPSERT_SQL`)<br>2. `packet_logs` (`ENCRYPTED`) Insert | 2 | `recordLivePacketAnalytics(...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 文字訊息 (`TEXT_MESSAGE_APP`, Port 1)** | 1. `nodes` 節點發現 Upsert<br>2. `chat_messages` Insert<br>3. `packet_logs` (`TEXT`) Insert | 3 | `recordLivePacketAnalytics(...)`、`batchEmit('chat_message', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 座標封包 (`POSITION_APP`, Port 3)** | 1. `nodes` 節點發現 Upsert<br>2. `nodes` 經緯度更新 (`UPDATE nodes SET latitude = ?, longitude = ?`)<br>3. `packet_logs` (`POSITION`) Insert | 3 | `recordLivePacketAnalytics(...)`、`batchEmit('node_updated', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 節點資訊 (`NODEINFO_APP`, Port 4)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` (`NODEINFO`) Insert<br>3. `nodes` 身分與硬體韌體更新 (`long_name`, `short_name`, `role`, `hw_model`, `firmware_version`, `firmware_build_num`) | 3 | `recordLivePacketAnalytics(...)`、`batchEmit('node_updated', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 路由 / 追蹤 / 其他 (`ROUTING_APP` Port 5, `TRACEROUTE_APP` Port 70 等)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` Insert | 2 | `recordLivePacketAnalytics(...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 遙測封包 (`TELEMETRY_APP`, Port 67)** | 1. `nodes` 節點發現 Upsert<br>2. `packet_logs` (`TELEMETRY`) Insert<br>3. `nodes` 遙測欄位 `COALESCE` 更新<br>4. `telemetry_data` Insert | 4 | `recordLivePacketAnalytics(..., temp, hum)`、`batchEmit('telemetry_updated', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 鄰居資訊 (`NEIGHBORINFO_APP`, Port 71)** | 1. `nodes` 節點發現 Upsert<br>2..K+1. 每筆有效鄰居之 `neighbors` Upsert<br>K+2. `packet_logs` (`NEIGHBORINFO`) Insert | $2 + K$ | `recordLivePacketAnalytics(...)`、`batchEmit('neighbors_updated', ...)`、`batchEmit('raw_packet', ...)` |
| **MQTT 地圖回報 (`MAP_REPORT_APP`, Port 73)** | 1. `nodes` 節點發現 Upsert<br>2. `nodes` 經緯度更新（若有有效座標）<br>3. `packet_logs` (`MAP_REPORT`) Insert<br>4. `nodes` 地圖回報 `COALESCE` 更新 | 3–4 | `recordLivePacketAnalytics(...)`、`batchEmit('node_updated', ...)`、`batchEmit('raw_packet', ...)` |
| **RF TCP Tunnel 座標封包 (`setupRFListener`)** | 1. `packet_logs` (`POSITION`, `source`) Insert<br>2. `nodes` (`last_seen`, `last_gateway`) Update | 2 | `batchEmit('raw_packet', packetData)` |
| **獨立背景工作（不與單一封包合併）** | `flushLiveAnalytics()` (`daily_analytics_summary`)、`computeAndSaveDaySummary()`、`fetchAndSaveCWAData()` (`cwa_weather_stations`)、`cleanupOldData()` (90 天定期清理) | 各自獨立 | 由定時器獨立排入 `WriteQueue`，不阻塞或干擾即時封包交易 |

### 5.2 交易邊界與 WriteQueue 二元隔離保證
1. **不可拆分之封包交易單位 (`isTransactionUnit: true`)**：
   - [`WriteQueue.enqueuePacketTransaction(statements, callback, options)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L168-L194) 與 `db.queuePacketTransaction(...)` 將單一封包的所有 SQL 語句封裝為單一佇列項目（`item.isTransactionUnit = true`、`item.statements = [...]`）。
   - 在 `_commitOrIsolate(batch)` 中，同一個 `batch` 內的所有佇列項目在同一個 `adapter.transaction(async (tx) => ...)` 內依序執行；若任一封包單位內任一語句拋錯，整個 `adapter.transaction` 立即 `ROLLBACK`，絕不留下半套寫入。
2. **二元隔離（Binary Isolation）以「封包交易單位」為最小粒度**：
   - 當批次交易因某筆損壞封包失敗時，[`_binaryIsolateBatch(batch)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L326-L407) 對 `batch` 陣列進行二分遞迴重試（最小切分單位為 `batch.length === 1`，即單一封包項目 `item`）。
   - **絕不拆開 `item.statements` 內部語句個別提交**：失敗的封包單位整筆回滾並隔離至 `quarantinedItems`（完整記錄 `failedStatementIndex`、`failedStatementSql`、`packetUnitId` 與錯誤原因），而同批次內其他正常封包則在各自子批次交易中成功 `COMMIT`。
3. **交易內 SQL 與 COMMIT 後副作用嚴格分離**：
   - 交易進行中（`COMMIT` 完成前）僅執行 SQLite 寫入語句，**絕不**在交易內提前觸發 Socket.IO `batchEmit`、即時統計 `recordLivePacketAnalytics` 或成功回呼。
   - 僅當該封包所屬交易 `COMMIT` 成功後，[`executePacketTransactionPlan()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/packet-transaction.js#L262-L315) 才在回呼中執行 `batchEmit` 與 `recordLivePacketAnalytics`。若交易回滾或隔離，外部副作用保證 **0 次觸發**。

---

## 6. 測試驗證矩陣（共 83 項測試）

### 6.1 [`tests/database/packet_transaction_4_0_2.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/packet_transaction_4_0_2.test.js)（10 項 4.0.2 新增整合與跨程序測試）

| 測試編號與名稱 | 測試性質 | 驗證重點 |
|---|---|---|
| **Test 4.0.2-1 — Single Packet Multi-Table Success** | 真實 SQLite 多表交易整合測試 | 驗證 `TELEMETRY_APP`（跨 `nodes`、`packet_logs`、`telemetry_data` 共 4 筆 SQL）、`TEXT_MESSAGE_APP`（3 筆 SQL）、`NEIGHBORINFO_APP`（4 筆 SQL）在單一交易中全部寫入成功，且 `COMMIT` 後精確觸發 `batchEmit` 與 `recordLivePacketAnalytics`。 |
| **Test 4.0.2-2 — Middle SQL Failure Rollback** | 真實 SQLite 中途失敗回滾測試 | 在 4 筆語句的第 3 筆注入 SQL 錯誤，驗證前 2 筆已執行的 `nodes` 與 `packet_logs` 寫入被完整 `ROLLBACK`（0 筆殘留），且 `COMMIT` 後副作用 0 次觸發。 |
| **Test 4.0.2-3 — Final SQL Failure Rollback** | 真實 SQLite 末筆失敗回滾測試 | 在 `TELEMETRY_APP` 第 4 筆（最後一筆 `telemetry_data`）注入 `NOT NULL` 約束失敗與 RF Tunnel 第 2 筆失敗，驗證前面所有 `nodes` 與 `packet_logs` 寫入全數回滾，且 `batchEmit` / `recordLivePacketAnalytics` 0 次觸發。 |
| **Test 4.0.2-4 — Multi-Packet Isolation** | 真實 SQLite 同批次二元隔離測試 | 將 3 個封包（Packet 1 正常、Packet 2 第 3 筆語句損壞、Packet 3 正常）排入同一個 `WriteQueue` 批次，驗證二元隔離以封包為單位隔離 Packet 2（內部語句不拆開、0 筆殘留、寫入 `quarantinedItems`），同時 Packet 1 與 Packet 3 完整 `COMMIT` 成功。 |
| **Test 4.0.2-5 — Concurrent Write + Read + Backup Contention** | 真實 SQLite 高併發壓力整合測試 | 同時進行 25 個跨表封包交易寫入、併發讀取查詢與 `BackupManager.performBackup()`（`VACUUM INTO`），驗證主 DB 與備份 DB 皆無「僅有 `packet_logs` 卻無 `nodes`/`telemetry_data`」之半成品狀態，且 `PRAGMA integrity_check === 'ok'`。 |
| **Test 4.0.2-6 — Shutdown During Active Packet Transaction** | 真實 SQLite 關機排空整合測試 | 在多筆封包交易執行與排隊期間觸發 `ShutdownHandler.handle('SIGTERM')`，驗證進行中與佇列中的封包交易完整 `COMMIT` 後才執行 `wal_checkpoint(TRUNCATE)` 並關閉連線，不產生半套交易。 |
| **Test 4.0.2-7 — Post-Commit Side Effects Ordering** | 真實 SQLite + 受控 `COMMIT` 攔截時序測試 | 攔截底層 `COMMIT` 執行時點，驗證在 `COMMIT` 完成前 `emittedEvents.length === 0` 且 `analyticsCalls.length === 0`，僅於 `COMMIT` 完成後才觸發，並驗證失敗封包永不觸發。 |
| **Test 4.0.2-Policy — Turso & Backup Scheduling Policy Confirmation** | 真實 SQLite + `index.js` 分支與排程政策驗證 | 驗證 `index.js` 中 `TURSO_URL` 分支與本地 SQLite 分支邊界、`BACKUP_PATH` 未設定時 `shouldRun()` 回傳 `false` 不自動執行備份、設定 `BACKUP_PATH` 時正常備份、`index.js` `'0 0 * * 0'` 與 `sqlite.config.js` `'0 4 * * *'` 現況，以及關機時 `stopSchedule()` 停止排程。 |
| **Test 4.0.2-SIGKILL — Cross-Process Abnormal Termination (`SIGKILL`)** | **真實獨立子程序 (`child_process.spawn` + `process.kill(pid, 'SIGKILL')`) 測試** | 透過 [`sigkill_tx_worker.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/helpers/sigkill_tx_worker.js) 雙向 IPC 同步，分別測試：(Case A) 交易開始前 `SIGKILL`；(Case B) 單一封包交易已寫入 `nodes`、`packet_logs`、`telemetry_data` 但**尚未 `COMMIT` 時強制 `SIGKILL`**；(Case C) `COMMIT` 剛完成後立即 `SIGKILL`。重開臨時 SQLite DB 驗證 `PRAGMA integrity_check === 'ok'`、Case B 未提交封包在 4 張表皆為 **0 筆殘留**、已提交封包完整保留，且重開後可正常讀寫。 |
| **Test 4.0.2-IndexStartup — Full `index.js` Child-Process Startup, Protobuf Ingestion, Shutdown & Bootstrap Failure** | **真實 `index.js` 子程序啟動 + Protobuf 封包寫入 + 啟動屏障失敗中止測試** | 以獨立子程序真實啟動 `index.js`（搭配臨時 `DB_PATH`、`EVENT_LOG_PATH` 與動態 `PORT`）：(Part 1) 驗證 `SQLite Schema Bootstrap 與結構驗證完成` 早於 HTTP 伺服器與 MQTT 監聽啟動，注入真實 Protobuf 編碼之 `ServiceEnvelope` (`TEXT_MESSAGE_APP`) 驗證 `nodes`、`packet_logs`、`chat_messages` 原子寫入，並觸發優雅關機驗證 `stopSchedule`、`wal_checkpoint` 與 `SQLite 連線已安全關閉` (`code === 0`)；(Part 2) 預先植入欄位順序錯誤之索引，驗證 `index.js` 啟動時因 `[SCHEMA_VERIFICATION_FAILED]` 以非 0 狀態碼 (`code === 1`) 立即中止，且絕不啟動 HTTP 伺服器或進入服務狀態。 |

### 6.2 [`tests/database/data_integrity_4_0_1.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（27 項 4.0.1 – 4.0.1.4 測試，Tests A – AA）
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

### 6.3 [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js)（46 項既有基線測試）
- 完整保留 v2.7.7 結案之 46 項測試（包含真實 SQLite 交易/鎖定測試，以及針對罕見底層情境如 Delayed Native Close Callback / Callback Error Injection 的模擬測試），**0 刪除、0 跳過、0 修改**。

### 6.4 測試邊界與環境限制誠實聲明
- **跨程序異常終止 (`SIGKILL`) vs. 實體斷電 / OS 崩潰**：`Test 4.0.2-SIGKILL` 係透過真實 OS 子程序強制終止（`process.kill(pid, 'SIGKILL')`）驗證程序非預期死亡後的 SQLite WAL 自動回滾與資料表原子性；**此測試屬於跨程序異常終止測試，並不等同於主機實體斷電（Power Loss）、作業系統核心崩潰（Kernel Panic）或磁碟硬體扇區損毀測試**。
- **正式環境零接觸**：所有 83 項測試均於 `os.tmpdir()` 下的獨立臨時 SQLite 資料庫執行，並於測試結束後完整清除，完全不讀取、不修改、不壓測正式環境 `d:\meshtastic\Meshtastic-DashBoard-Prod`。
