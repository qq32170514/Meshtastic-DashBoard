# Meshtastic-DashBoard 4.0.1.1 — Backup Isolation & Verification Hardening

> **版本定位**：4.0.1.1 Backup Isolation & Verification Hardening（修正 4.0.1 的 Backup Scheduler 長時間占用、Restore 活躍資料庫安全防護、Schema Index Definition Verification、Backup Path Containment，以及測試邊界與文件精確度）
> **基線依賴**：建立於已結案之 SQLite Reliability v2.7.7 與 4.0.1 Data Integrity 基線之上（保留 `sqlite3 ^5.1.6`、Adapter Scheduler、WriteQueue、Transaction、Retry Backoff、Checkpoint、Graceful/Emergency Shutdown 與 Native Close Deadline 不變）。

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

### 1.2 `TURSO_URL` 分支保護範圍澄清（Out of Scope for 4.0.1 / 4.0.1.1）
- **重要聲明**：本次 4.0.1 / 4.0.1.1 的 `bootstrapDatabaseSchema()`、`verifyDatabaseSchema()`、`isBootstrapReady()`、`executeWithStartupBarrier()` 以及 `BackupManager` **僅涵蓋本地 SQLite 執行路徑（未設定 `TURSO_URL` 時）**。
- 當設定 `TURSO_URL` 時，[`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) 仍使用原有的 `@libsql/client` 相容包裝器與未等待回傳的 `db.serialize()` 建表邏輯，**並不具備與本地 SQLite 相同的 Schema Initialization Barrier、Index Definition Verification 或 BackupManager 功能**。依專案規範，本次不修改 Turso 架構，特此明確區分保護邊界。

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
   │     ├── 若 rename 成功：清理 .prev-* 暫存檔，將 targetPath 加入 #verifiedBackups
   │     └── 若 rename 失敗：立即將 .prev-* 還原回 targetPath（確保既有有效備份絕不損毀），清理 stagingPath 並拋錯

[Phase 4] Backup Rotation (Outside Scheduler)
   ├── 執行 _rotateOldBackups()：忽略 .staging-* / .prev-* / 非 .db 檔案與未驗證檔案
   ├── 按 mtimeMs 由舊到新清理超過 retentionDays 或 maxBackups 之已驗證備份
   └── 強制保留至少 1 份最新有效備份（retainedCount >= 1，絕不刪除唯一可用備份）

[Phase 5] Final Convergence (finally block)
   └── 確保殘留 stagingPath 被清除，自 #inProgressBackupPaths 移除路徑，並將 #backupInProgress 設回 false
```

### 3.3 備份排程政策（Backup Scheduling Policy）現況與待確認事項
- 在 [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js#L4517-L4533) 中，定時備份排程之 `shouldRun()` 目前檢查 `process.env.BACKUP_PATH` 是否存在；若未設定 `BACKUP_PATH`，排程觸發時會回傳 `false` 而不執行自動備份（即使 `BackupManager` 建構子本身具備預設本地 `./backups` 目錄）。
- 此外，`index.js` 原始註解寫為「每 12 小時自動備份資料庫至雲端」，實際 Cron 表達式為 `'0 0 * * 0'`（每週日 00:00），而 [`src/database/sqlite.config.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js) 中的 `backup.cronSchedule` 則為 `'0 4 * * *'`（每日 04:00）。
- **處理原則**：在未獲明確指示變更排程政策前，4.0.1.1 嚴格保留 `index.js` 現有的 `BACKUP_PATH` 檢查與 `'0 0 * * 0'` 行為不變，並將上述兩項設定差異列為待確認事項。

---

## 4. Restore Safety 與可回復替換機制（4.0.1.1 P1）

[`BackupManager.restoreFromBackup(backupFilePath, targetRestoreDbPath, options)`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js#L510-L760) 針對還原作業實施嚴格的前置檢查與可回復（Rollback）替換流程：

### 4.1 Restore 前置檢查（Preconditions）
1. **參數與路徑正規化檢查**：拒絕空字串或含 NUL 字元之路徑；使用 `_normalizeComparablePath()`（結合 `path.resolve`、`fs.realpathSync.native` 與 Windows 不分大小寫正規化）確認來源備份路徑與目標還原路徑不相同。
2. **禁止覆蓋進行中備份**：若來源或目標路徑位於 `#inProgressBackupPaths` 中，拒絕執行。
3. **Active Adapter DB Path 防護（`_findActiveAdapterUsingPath`）**：
   - 比對目前 `BackupManager` 所屬 `adapter` 以及程序內所有已註冊 `SQLiteAdapter` 實例的資料庫路徑（`adapter.dbPath` / `adapter.db.filename`）。
   - 只要目標路徑對應的 `SQLiteAdapter` 尚未完全關閉（`state !== ADAPTER_STATES.CLOSED`、`db !== null` 或 `nativeClosePending === true`），立即以 `[BACKUP_RESTORE_ACTIVE_DB_FORBIDDEN]` 拒絕還原，**絕不在資料庫仍被 Adapter 使用時刪除或替換其 DB / WAL / SHM 檔案**。
4. **Offline Restore 鎖定探測（`_assertTargetDbOffline`）**：
   - 若目標資料庫檔案已存在於磁碟，還原前會開啟短暫探測連線設定 `PRAGMA busy_timeout = 0` 並執行 `BEGIN EXCLUSIVE TRANSACTION; ROLLBACK;`。
   - 若目標資料庫正被其他程序或未關閉連線鎖定，立即以 `[BACKUP_RESTORE_TARGET_BUSY_ONLINE]` 拒絕執行。
5. **來源備份與 Staging 雙重完整性驗證**：
   - 先對 `backupFilePath` 執行 `verifyIntegrity()`。
   - 再於目標資料庫同一目錄下透過 `VACUUM INTO` 建立 `.restore-staging-<basename>-<suffix>`，並對該 staging DB 執行 `verifyIntegrity()`。
   - 替換前再次執行 `_assertTargetDbOffline()` 二次確認。

### 4.2 原始 DB 保留、WAL/SHM 處理與 Rollback 狀態定義
1. **移至可回復 Rollback 路徑（絕不直接先行刪除）**：
   - 將目標路徑既有的 `<db>`、`<db>-wal`、`<db>-shm` 依序 `fs.renameSync` 至同目錄下的 `.rollback-<suffix>` 路徑。
   - **不忽略任何 WAL / SHM 移動錯誤**：若移動過程中任何一個檔案失敗，立即按反序將已移動的 `.rollback-*` 檔案復原回原位，清理 staging DB 並報錯。
2. **安裝 Staging DB 與自動 Rollback**：
   - 將已驗證的 `stagingRestorePath` rename 至 `resolvedTarget`，並對安裝後的 `resolvedTarget` 再次執行 `verifyIntegrity()`。
   - 若安裝 rename 或安裝後驗證失敗：
     - 自動移除不完整的目標檔，並按反序將 `<db>.rollback-*`、`<db>-wal.rollback-*`、`<db>-shm.rollback-*` 移回原始路徑。
     - 清理 `stagingRestorePath`。
   - 唯有在安裝與驗證完全成功後，才刪除 `.rollback-*` 備份檔。
3. **明確的還原結果狀態（`RESTORE_STATUS`）**：
   - `RESTORE_COMPLETED`：還原成功且安裝後通過 `verifyIntegrity()`，原始 `.rollback-*` 已清理。
   - `RESTORE_REJECTED_PRECONDITION`：於替換原始檔案前因前置條件（如目標為活躍 Adapter DB、外部鎖定、來源備份損壞或 staging 驗證失敗）被安全攔截，原始目標資料庫完全未動。
   - `RESTORE_FAILED_ROLLED_BACK`：替換過程中發生錯誤，且原始目標 DB 與 WAL/SHM 已自動從 `.rollback-*` 完整復原（`err.rollbackSucceeded === true`）。
   - `RESTORE_FAILED_ROLLBACK_INCOMPLETE`：替換失敗且自動復原過程中遭遇檔案系統錯誤（`err.rollbackSucceeded === false`），此時保留磁碟上的 `.rollback-*` 檔案並於 `err.preservedRollbackPaths` 與 `err.rollbackErrors` 提供完整救援路徑與診斷資訊。

---

## 5. 測試覆蓋與測試性質分類（Test Coverage Classification）

所有測試均於開發環境透過 `npm run test:database` 實際執行，並使用 `os.tmpdir()` 下的獨立臨時 SQLite 資料庫檔案，測試後完整關閉連線與清除暫存檔。

為確保技術審查透明度，以下明確區分各項測試的**實際測試類型**（真實 SQLite 整合測試 vs. Coordinator 單元測試 vs. 錯誤注入模擬測試）：

### 5.1 [`tests/database/data_integrity_4_0_1.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/data_integrity_4_0_1.test.js)（17 項測試）

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
| **Test L — Backup Restore Verification** | 真實 SQLite End-to-End Backup & Restore Test | 對真實臨時 DB 備份後，呼叫 `restoreFromBackup()` 還原至第二個獨立臨時 DB，並以新 `createDatabaseSubsystem` 開啟驗證資料一致性與後續讀寫。 |
| **Test M — Backup Scheduler Non-Overlap & Shutdown Race** | 真實 SQLite + `ShutdownHandler.handle()` Integration Test | 驗證重疊排程自動跳過；並測試在 `VACUUM INTO` 執行期間觸發真實 `ShutdownHandler.handle('SIGTERM')`（涵蓋「於 Deadline 內完成並安全關閉」與「超過 Deadline 時拒絕呼叫 `db.close()` 保護活動連線」兩種情境）。 |
| **Test N — P1 Backup Scheduler Isolation** | 真實 SQLite Integration + Rename Failure Injection | 在 `VACUUM INTO` 完成後、`verifyIntegrity` 開始前（`afterVacuumBeforeVerify` Gate），驗證 `maintenanceInProgress === false` 且 `WriteQueue` 可立即寫入主 DB；同時以 `renameImpl` 注入錯誤驗證同名舊有效備份不會因新備份安裝失敗而損毀。 |
| **Test O — P1 Restore Safety Hardening** | 真實 SQLite Active DB & Lock Detection + Rollback Injection | 驗證拒絕還原至當前活躍 Adapter DB、拒絕還原至另一活躍 Adapter DB、拒絕還原至被外部連線 `BEGIN IMMEDIATE` 鎖定之 DB；並以 `renameImpl` 注入錯誤驗證替換失敗時自動從 `.rollback-*` 完整復原原始離線 DB。 |
| **Test P — P2 Schema Index Definition Verification** | 真實 SQLite PRAGMA Verification Test | 在真實臨時 SQLite DB 中預先建立同名但欄位順序顛倒、`ASC`/`DESC` 相反、`UNIQUE` 不符、含 Partial `WHERE` 或掛錯資料表的索引，驗證 `verifyDatabaseSchema()` 全數檢出並阻擋啟動。 |
| **Test Q — P2 Backup Path Containment** | Unit & Integration Validation Test | 驗證 `validateBackupFilePath()` 與 `performBackup()` 接受合法檔名，並拒絕 `../`、`..\`、POSIX/Windows 絕對路徑、`C:` 磁碟機路徑、UNC 路徑、子目錄斜線與 NUL 字元。 |

### 5.2 [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js)（46 項既有基線測試）
- 完整保留 v2.7.7 結案之 46 項測試（包含真实 SQLite 交易/鎖定測試，以及針對罕見底層情境如 Delayed Native Close Callback / Callback Error Injection 的模擬測試），**0 刪除、0 跳過、0 修改**。

### 5.3 尚未驗證或受限於環境之項目
- **跨程序 OS 突發斷電 / SIGKILL 實體崩潰測試**：目前半成品與 Rollback 測試係透過受控錯誤注入模擬中斷，並未在測試中對真實 4.5GB 資料庫執行實體斷電。
- **整支 `index.js` 含外部 MQTT Broker / 網路埠口之端到端程序啟動測試**：因 `index.js` 頂層要求真實外部 `MQTT_BROKER` 連線環境，啟動屏障係透過 `executeWithStartupBarrier` 協調器與真實臨時 SQLite 子系統驗證。
