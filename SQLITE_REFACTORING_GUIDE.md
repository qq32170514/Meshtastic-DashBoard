# Meshtastic-DashBoard 4.1.0 — SQLite Reliability Refactoring 技術實施說明書 (v2.7.4 強固修正與全量獨立驗證版)

> **文件版本**：v2.7.4 (Comprehensive Hardening & Independent Verification Edition)  
> **更新時間**：2026-11-11  
> **適用環境**：`d:\meshtastic\Meshtastic-DashBoard-Dev` (嚴格隔離於開發環境)  
> **執行狀態**：全套核心程式碼已於 `src/database/` 實作並完成 v2.7.1 ~ v2.7.4 歷次審查缺陷修正，41 項獨立場景單元/整合測試全數真實執行通過（**41 passed, 0 failed**，總耗時約 2.85 秒）。Prod 環境與正式 4.5GB 資料庫維持絕對零接觸。

---

## 目錄
1. [架構重構願景與不可違反之環境限制](#1-架構重構願景與不可違反之環境限制)
2. [v2.7.3 -> v2.7.4 深度強固問題診斷](#2-v273---v274-深度強固問題診斷)
3. [v2.7.4 修正內容詳解 (P0 / P1)](#3-v274-修正內容詳解-p0--p1)
   - 3.1 P0-1: Drain 階段嚴格遵守 BUSY Retry Backoff 與定時器清理
   - 3.2 P0-2: Graceful Shutdown 有界等待預算分配與未靜止拒絕 rawClose
   - 3.3 P0-3: Emergency Shutdown 未提交資料審計與誠實成功語意
   - 3.4 P1-1: 入列拒絕回呼異常隔離 (_safeRejectCallback)
   - 3.5 P1-2: Adapter 初始化 PRAGMA 驗證失敗時安全關閉底層連線防洩漏
4. [v2.7.3 既有核心修正回顧 (P0-1 ~ P1-4)](#4-v273-既有核心修正回顧-p0-1--p1-4)
5. [實際修改的程式碼檔案清單](#5-實際修改的程式碼檔案清單)
6. [各模組職責邊界與架構設計](#6-各模組職責邊界與架構設計)
7. [Data Conservation 完整守恆公式與容器狀態](#7-data-conservation-完整守恆公式與容器狀態)
8. [Shutdown 與 Deadline 行為規範](#8-shutdown-與-deadline-行為規範)
9. [PRAGMA 最終設定表與設計依據](#9-pragma-最終設定表與設計依據)
10. [Callback Exactly-Once 適用範圍與契約](#10-callback-exactly-once-適用範圍與契約)
11. [41 項測試場景真實執行驗收報告](#11-41-項測試場景真實執行驗收報告)
12. [已知限制與未驗證項目](#12-已知限制與未驗證項目)
13. [最終自我審查結論與交付狀態](#13-最終自我審查結論與交付狀態)

---

## 1. 架構重構願景與不可違反之環境限制

### 1.1 絕對紅線與環境隔離約束
1. **開發環境隔離**：所有程式碼變更、編譯、單元測試與排程檢驗嚴格限制在 `d:\meshtastic\Meshtastic-DashBoard-Dev`。**嚴禁**修改、寫入、發布至 Prod 目錄（`d:\meshtastic\Meshtastic-DashBoard-Prod`），嚴格禁止重啟或操作生產環境 PM2 服務。
2. **Schema 絕對凍結**：不新增、修改、更動或刪除任何既有 SQLite 資料庫表結構、欄位、型態或約束。
3. **套件依賴凍結**：維持現有 `sqlite3 ^5.1.6`，不得引進 Redis、Kafka 或其他額外外部基礎設施。
4. **外部協定零破壞**：保持現有 RESTful API、Socket.IO 事件、MQTT 解碼流程、RF 隧道、React 前端與 Turso 雲端鏡像協定完全相容。
5. **正式資料庫零接觸**：嚴格禁止直接讀取、修改、VACUUM 或重建正式的約 4.5GB 資料庫（`meshtastic.db`），所有單元測試與故障注入測試一律使用獨立臨時資料庫（`meshtastic_test_*.db`），並在測試結束後徹底清理檔案與 WAL。
6. **物理特性誠實宣告**：未經 `COMMIT` 的記憶體暫存資料絕不宣稱安全保存；記憶體隊列無法抵禦突發斷電或 `kill -9` 強制終止。所有測試結果必須有真實執行紀錄，不得虛報 PASS。
7. **設計優先準則**：
   $$\text{資料完整性} > \text{資料可追溯性} > \text{故障不丟失} > \text{Shutdown安全} > \text{Backup安全} > \text{穩定性} > \text{效能}$$

---

## 2. v2.7.3 -> v2.7.4 深度強固問題診斷

在完成 v2.7.3 的 37 項測試後，進一步針對關機時序邊界、重試退避與資源清理進行深度審查，識別並修正以下五項強固議題：

1. **P0-1（Drain 階段忽略 BUSY Retry Backoff 立即重試）**：在 v2.7.3 中，`drain()` 迴圈看到 `retryPendingItems.size > 0` 時直接將所有項目立即移回 `queue` 頂部，忽略了 `_scheduleRetry()` 計算的 `retryAt` 指數退避時間，導致關機排空遭遇 `SQLITE_BUSY` 時退化為無退避的緊密重試迴圈，且未追蹤並清理殘留的 `#retryTimers`。
2. **P0-2（Graceful Shutdown 呼叫 `adapter.close()` 缺乏有界超時保護）**：在 `ShutdownHandler.handle()` 中，當 `drain()` 因底層慢操作逾時返回後，第四步直接呼叫無參數 `await this.#adapter.close()`，而 `close()` 內部無條件 `await this._schedulerQueue`，若底層任務一直懸掛將導致 Graceful Shutdown 永久卡死且無法輸出關閉診斷報告。
3. **P0-3（Emergency Shutdown 在有未提交資料時仍可能回報 `success: true`）**：`handleEmergencyCrash()` 只要 `adapter.isQuiescent()` 為真且 `emergencyClose()` 成功，便回傳 `success: true`，未檢查 `writeQueue` 中是否仍有尚未提交的 `queuedCount` / `totalUncommitted` 資料，違反「未 COMMIT 資料絕不宣稱安全保存」的誠實語意。
4. **P1-1（`enqueue()` 拒絕分支直接呼叫使用者 Callback 未隔離例外）**：當隊列處於 `PAUSED_DISK_FULL`、`PAUSED_ERROR`、`CLOSING` 或 `BACKPRESSURE` 時，`enqueue()` 同步呼叫使用者傳入的 `callback(err)`；若使用者回呼內部拋出例外，會直接炸穿 `enqueue()` 呼叫堆疊。
5. **P1-2（`SQLiteAdapter.initialize()` 在 PRAGMA 驗證失敗時未關閉已開啟的底層連線）**：當 `new sqlite3.Database(dbPath)` 開啟檔案成功，但隨後的 `_applyAndVerifyPragmas()` 觸發 `HARD_FAIL` 拋錯時，`this.db` 尚未關閉即拒絕 Promise，在 Windows 下可能殘留檔案控制代碼（File Handle Leak）。

---

## 3. v2.7.4 修正內容詳解 (P0 / P1)

### 3.1 P0-1: Drain 階段嚴格遵守 BUSY Retry Backoff 與定時器清理
- **修改檔案**：[`src/database/write-queue.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)
- **實施細節**：
  1. 在 `_scheduleRetry(batch, delayMs, deadlineAt)` 中為每個項目寫入 `item.retryAt = Date.now() + delayMs`，並將建立的 `timerId` 加入私有集合 `this.#retryTimers`。
  2. 在 `drain()` 迴圈中檢查 `retryPendingItems` 時：
     - 僅當 `item.retryAt <= now` 時才將項目移入 `readyToRequeue` 並排回隊列頭部。
     - 若 `item.retryAt > deadlineAt`（退避時間已超過關機截止期限），立即將該項目轉移至 `UNCOMMITTED_ERROR` 並觸發失敗回呼，絕不無效等待或盲目重試。
     - 若 `this.queue.length === 0` 但仍有尚未到期的 `retryPendingItems`，計算距離最近一次 `nextRetryAt` 的等待時間，執行有界睡眠（`Math.min(waitMs, 50)`），嚴格禁止 Busy-spin 或提前暴力重試。
  3. 在 `drain()` 結束與 `close()` 時調用 `_clearAllRetryTimers()` 徹底清理所有重試定時器。

### 3.2 P0-2: Graceful Shutdown 有界等待預算分配與未靜止拒絕 rawClose
- **修改檔案**：[`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js)、[`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js)
- **實施細節**：
  1. `ShutdownHandler.handle()` 根據 `pm2KillTimeoutMs` (預設 10000ms)、`drainWaitBufferMs` (預設 1500ms) 與 `drainTimeoutMs` (預設 8000ms) 精確計算排空時間與剩餘連線關閉預算 `remainingCloseBudget`。
  2. `SQLiteAdapter.close(timeoutMs)` 支援傳入有界等待毫秒數，透過 `Promise.race([this._schedulerQueue, timeoutPromise])` 等待排程器收斂。
  3. 等待結束後嚴格檢查 `if (!this.isQuiescent())`，若仍有底層操作或排程任務未完成，重置 `this._closePromise = null` 並拋出 `[CLOSE_REJECTED]`，**絕不呼叫 `_rawClose()` 摧毀活動連線**。

### 3.3 P0-3: Emergency Shutdown 未提交資料審計與誠實成功語意
- **修改檔案**：[`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js)
- **實施細節**：
  1. 在 `handleEmergencyCrash()` 與 `handle()` 中同時核算 `qMetrics = this.#writeQueue.getMetrics()` 之 `hasUncommittedData = (qMetrics.totalUncommitted > 0)` 與 `dataClean = !hasUncommittedData`。
  2. 即使 Adapter 已達 `isQuiescent()` 並成功執行 `emergencyClose()` 釋放連線（`adapterClosed: true`），只要 `hasUncommittedData === true`，整體回傳之 `success` 必定為 `false`、`dataClean` 必定為 `false`，並附帶完整 `diagnostics` 結構。

### 3.4 P1-1: 入列拒絕回呼異常隔離 (`_safeRejectCallback`)
- **修改檔案**：[`src/database/write-queue.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js)
- **實施細節**：
  新增 `_safeRejectCallback(callback, err)`，以 `try / catch` 包覆所有入列拒絕路徑（`PAUSED_DISK_FULL`、`PAUSED_ERROR`、`CLOSING`、`BACKPRESSURE`）的使用者回呼調用，確保使用者 callback 拋出異常時被安全捕獲記錄，不影響佇列狀態與計數守恆。

### 3.5 P1-2: Adapter 初始化 PRAGMA 驗證失敗時安全關閉底層連線防洩漏
- **修改檔案**：[`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js)
- **實施細節**：
  在 `initialize(dbPath)` 中，當 `_applyAndVerifyPragmas()` 拋出異常時，立即將已開啟的 `this.db` 取出並設為 `null`，呼叫 `dbToClose.close()` 安全釋放底層 SQLite 檔案控制代碼，再將狀態設為 `ADAPTER_STATES.ERROR`。

---

## 4. v2.7.3 既有核心修正回顧 (P0-1 ~ P1-4)

1. **P0-1（Drain 不將 UNCOMMITTED_ERROR 誤判為成功）**：`getMetrics()` 完整納入 `uncommittedErrorCount`、`totalPending` 與 `totalUncommitted`。當 `totalUncommitted > 0` 時，`drain()` 回傳 `isClean: false`，`ShutdownHandler` 跳過 `TRUNCATE` Checkpoint 保護 WAL。
2. **P0-2（Deadline 到期後禁止 Binary Isolation 啟動新交易）**：在 `_commitOrIsolate()` 與 `_binaryIsolateBatch()` 的 Left / Right 子批次啟動前強制檢查 `deadlineAt`。一旦超時立即拋出 `DEADLINE_EXPIRED`，由最外層 `_executeTopLevelBatch()` 捕獲並將尚未提交的剩餘子批次透過 `_requeueRemainingBatchAtHead(remaining)` 按原始 `seq` 原子退回隊列頭部。
3. **P0-3（SQLITE_FULL 發生時 Drain 立即中止）**：遭遇 `SQLITE_FULL` 時隊列轉為 `PAUSED_DISK_FULL`，Drain Worker 迴圈立即 `break` 退出，杜絕無限重試。
4. **P1-1（PAUSED_DISK_FULL 狀態下嚴格拒絕新寫入）**：`enqueue()` 攔截 `PAUSED_DISK_FULL`，僅遞增 `totalRejected`，不增加 `totalAccepted`。
5. **P1-2（統一 PRAGMA 設定、執行與動態讀回驗證）**：以 `src/database/sqlite.config.js` 為唯一設定來源，初始化時讀回比對 8 項 PRAGMA（5 項硬性、3 項軟性），並移除主程式 `index.js` 中的冗餘 raw PRAGMA。
6. **P1-3（相容層 Callback Exactly-Once 防重與例外隔離）**：`src/database/index.js` 的 `run` / `get` / `all` / `close` 採用 `.then(onFulfilled, onRejected)` 雙參數分離模式，防止使用者 callback 拋錯時觸發二次呼叫。
7. **P1-4（Database Factory 啟動前置保護）**：`initDatabaseSubsystemSync` 掛載 `readyPromise`，主程式 `index.js` 在 `startServer()` 與 `startMqttClient()` 前強等待 `await db.readyPromise`，初始化失敗時終止啟動。

---

## 5. 實際修改的程式碼檔案清單

| 檔案相對路徑 | 模組 | v2.7.1 ~ v2.7.4 累計核心實作與修正內容 |
| :--- | :--- | :--- |
| [`src/database/sqlite.config.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.config.js) | Config | 集中定義 8 項 PRAGMA、WriteQueue、Backup 與 Shutdown 時間預算設定 |
| [`src/database/retry-policy.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/retry-policy.js) | RetryPolicy | 8 大 SQLite 錯誤分類（含 `DATA_CONSTRAINT`, `RETRYABLE_BUSY`, `DISK_FULL`, `FATAL_CORRUPT`, `UNKNOWN` 等）與指數退避抖動計算 |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js) | SQLiteAdapter | WeakMap 私有 `DrainCapability` 授權、PRAGMA 動態讀回驗證、初始化失敗連線清理（v2.7.4 P1-2）、`isQuiescent()` 追蹤、有界 `close(timeoutMs)`（v2.7.4 P0-2）與 9 項 TRUNCATE 前置安全檢查 |
| [`src/database/write-queue.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js) | WriteQueue | 6 大互斥容器資料守恆、FIFO 二分拆分隔離、Deadline 交易阻絕、Drain BUSY Backoff 嚴格等待與定時器清理（v2.7.4 P0-1）、`_safeRejectCallback`（v2.7.4 P1-1） |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js) | ShutdownHandler | 時間預算分配與有界關閉等待（v2.7.4 P0-2）、未提交資料誠實審計（v2.7.4 P0-3）、未排空跳過 TRUNCATE、Emergency Shutdown 靜止檢查與診斷轉儲 |
| [`src/database/backup-manager.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/backup-manager.js) | BackupManager | `VACUUM INTO` 線上快照、三態完整性檢驗（`VALID`, `CORRUPTED`, `VERIFY_ERROR`）、`VERIFY_ERROR` 100% 保留候選檔案 |
| [`src/database/index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/index.js) | Facade / Factory | 相容層 Exactly-Once 回呼防重、`createDatabaseSubsystem` 與 `initDatabaseSubsystemSync` (`readyPromise`) |
| [`index.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js) | 主程式 | 移除冗餘 raw PRAGMA；`startServer()` 與 MQTT 啟動強等待 `db.readyPromise` |
| [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js) | 測試套件 | Group A ~ Group G 共 **41 項**獨立臨時庫單元與整合驗證測試 |

---

## 6. 各模組職責邊界與架構設計

```mermaid
flowchart TD
    subgraph Ingestion["寫入准入層 (Ingestion)"]
        API[業務呼叫 / MQTT] --> Compat["相容層 dbCompat"]
        Compat --> WQ["WriteQueue.enqueue()"]
        WQ --"PAUSED_DISK_FULL / PAUSED_ERROR / GATE_CLOSED / BACKPRESSURE"--> Rej["拒絕寫入 (totalRejected++)\n_safeRejectCallback 隔離異常"]
        WQ --"准入通過"--> Acc["接受寫入 (totalAccepted++)"]
    end

    subgraph QueueMgmt["隊列管理與容器 (Queue Management)"]
        Acc --> Q["this.queue (FIFO)"]
        Q --> FlushWorker["Flush / Drain Worker"]
        FlushWorker --"開始批次"--> InFlight["inFlightItems"]
        InFlight --"SQLITE_BUSY (遵守 retryAt 退避)"--> RetrySet["retryPendingItems"]
        InFlight --"SQLITE_CONSTRAINT"--> Quarantine["quarantinedItems"]
        InFlight --"SQLITE_UNKNOWN / 超出預算"--> Uncommitted["uncommittedErrors"]
    end

    subgraph AdmissionControl["交易准入與執行 (Admission Control)"]
        FlushWorker --> AdmissionCheck{"交易准入檢查\n1. Deadline 到期?\n2. Gate 關閉?\n3. Disk Full?"}
        AdmissionCheck --"拒絕 (拋出異常)"--> RequeueHead["_requeueRemainingBatchAtHead\n按 seq 保持原始序退回隊列前端"]
        AdmissionCheck --"通過"--> Sched["SQLiteAdapter.transaction() / drainTransaction()"]
        Sched --> SQLiteEngine[("底層 SQLite3 Engine\n(WAL Mode)")]
        SQLiteEngine --"COMMIT 成功"--> Committed["totalCommitted++"]
    end

    subgraph LifeCycle["生命週期協調 (Lifecycle & Shutdown)"]
        Shutdown["ShutdownHandler"] --> Drain["WriteQueue.drain(drainCap, drainTimeoutMs)"]
        Drain --> Audit{"健全性審核\ntotalUncommitted == 0?\n!hasUncommittedErrors?\n!isDiskFull & isQuiescent?"}
        Audit --"全部成立"--> Clean["markDrainCompleted\n執行 wal_checkpoint(TRUNCATE)"]
        Audit --"任一不成立"--> Dirty["跳過 TRUNCATE Checkpoint\n保護 WAL 資料"]
        Clean --> BoundedClose["adapter.close(remainingCloseBudget)"]
        Dirty --> BoundedClose
    end
```

---

## 7. Data Conservation 完整守恆公式與容器狀態

在 SQLite Reliability v2.7.4 中，所有進入系統的寫入請求皆遵循嚴格的兩層物理守恆定律：

### 7.1 第一層：准入請求分離
$$\text{totalSubmitted} = \text{totalAccepted} + \text{totalRejected}$$
$$\text{totalRejected} \cap \text{totalAccepted} = \emptyset$$

### 7.2 第二層：已接受資料狀態守恆公式
$$\text{totalAccepted} = \text{totalCommitted} + \text{totalQuarantined} + \text{totalUncommitted}$$

其中未提交資料展開為：
$$\text{totalUncommitted} = \text{totalPending} + \text{uncommittedErrorCount}$$
$$\text{totalPending} = \text{queuedCount} + \text{retryPendingCount} + \text{inFlightCount}$$

- **`queuedCount`**：`this.queue.length`（等待批次排程）。
- **`retryPendingCount`**：`this.retryPendingItems.size`（等待退避重試時間 `retryAt` 到期）。
- **`inFlightCount`**：`this.#inFlightItems.size`（正在執行 SQLite 交易）。
- **`uncommittedErrorCount`**：`this.uncommittedErrors.length`（遭遇致命/未知錯誤或退避超出關機預算而實體留存於記憶體中的項目）。
- **`conservationCheck`**：`getMetrics()` 即時計算 `this.totalAccepted === (this.totalCommitted + totalPending + this.totalQuarantined + uncommittedErrorCount)`，在所有正常與異常路徑下恆為 `true`。

---

## 8. Shutdown 與 Deadline 行為規範

| 階段 / 情境 | 觸發條件 | 執行行為 | 交易與連線防護 |
| :--- | :--- | :--- | :--- |
| **Normal Shutdown** | SIGTERM, SIGINT, 手動關閉 | 關閉停機閘門，拒絕新寫入；依時間預算啟動 `drain()` | 若 `totalUncommitted === 0` 且 `isQuiescent`，執行 `wal_checkpoint(TRUNCATE)`，再以剩餘預算呼叫 `adapter.close(remainingCloseBudget)` |
| **Drain BUSY Backoff** | 排空期間遭遇 `SQLITE_BUSY` | 記錄 `retryAt = now + delayMs`，排入 `retryPendingItems` | 嚴格等待至 `retryAt` 到期才重新排回隊列；若 `retryAt > deadlineAt` 則轉入 `UNCOMMITTED_ERROR` |
| **Deadline 逾時** | Drain 耗時超過 `drainTimeoutMs` | 獨立 Observer 準時返回，標記 `deadlineExpired: true, isClean: false` | **立即阻止所有新 Transaction 啟動**；Binary Isolation 遞迴在啟動 Right 前中斷，未提交子批次按 `seq` 原子退回隊列前端 |
| **Close 逾時未靜止** | `adapter.close(timeoutMs)` 到期時仍有在途任務 | 拋出 `[CLOSE_REJECTED]`，`adapterClosed: false` | **嚴禁呼叫 `_rawClose()`** 摧毀活動連線，回報 `success: false` 並附帶 `diagnostics` |
| **Emergency Crash** | 未捕獲例外、嚴重崩潰 | 呼叫 `handleEmergencyCrash()`，給予最多 1000ms 有界等待 | 未達 `isQuiescent()` 嚴禁呼叫 `emergencyClose()` 並輸出 Crash Dump；若已靜止則釋放連線，但若 `totalUncommitted > 0` 仍誠實回報 `success: false, dataClean: false` |

---

## 9. PRAGMA 最終設定表與設計依據

| PRAGMA 參數 | 設定值 | 實際讀回驗證 | 判定等級 | 設計理由與歷史相容性分析 |
| :--- | :---: | :---: | :---: | :--- |
| **`journal_mode`** | `WAL` | `'wal'` | **硬性 (HARD)** | 支援高並發讀寫分離，避免讀取操作阻塞批次寫入隊列。 |
| **`synchronous`** | `NORMAL` | `1` | **硬性 (HARD)** | 在 WAL 模式下具備崩潰一致性，兼顧高頻封包入列之磁碟 I/O 效能。 |
| **`busy_timeout`** | `10000` | `10000` | **硬性 (HARD)** | 設定為 10 秒（10000ms），吸收短暫鎖爭用並避免 HTTP 請求無限懸掛。 |
| **`foreign_keys`** | `OFF` | `0` | **硬性 (HARD)** | 歷史 Schema 無 FOREIGN KEY 約束，且遙測封包可能早於節點資訊到達，維持 `OFF` 確保相容。 |
| **`wal_autocheckpoint`**| `1000` | `1000` | **硬性 (HARD)** | 當 WAL 達到 1000 頁（約 4MB）時自動觸發 Passive Checkpoint。 |
| **`cache_size`** | `-64000` | `-64000` | **軟性 (SOFT)** | 配置約 64MB Page Cache 加速熱點查詢。 |
| **`temp_store`** | `MEMORY` | `2` | **軟性 (SOFT)** | 暫存表與索引置於記憶體，減少磁碟暫存 I/O。 |
| **`mmap_size`** | `268435456` | $\ge 0$ | **軟性 (SOFT)** | 256MB Memory-Mapped I/O，若受作業系統截斷則記錄軟性警告。 |

---

## 10. Callback Exactly-Once 適用範圍與契約

| 介面 | 正常執行 Callback 調用次數 | 異常/失敗調用次數 | Callback 內部拋出例外時的行為 |
| :--- | :---: | :---: | :--- |
| **`db.run(sql, [params], cb)`** | 恰好 1 次 (`cb.call(res, null)`) | 恰好 1 次 (`cb(err)`) | 透過 `.then(onFulfilled, onRejected)` 分離，**絕不重複調用**；例外向上冒泡導致 Promise 拒絕。 |
| **`db.get(sql, [params], cb)`** | 恰好 1 次 (`cb(null, row)`) | 恰好 1 次 (`cb(err)`) | 絕不重複調用；保證 Exactly-Once。 |
| **`db.all(sql, [params], cb)`** | 恰好 1 次 (`cb(null, rows)`) | 恰好 1 次 (`cb(err)`) | 絕不重複調用；保證 Exactly-Once。 |
| **`db.close(cb)`** | 恰好 1 次 (`cb(null)`) | 恰好 1 次 (`cb(err)`) | 絕不重複調用；關閉流程正常完成。 |
| **`writeQueue.enqueue(op, cb)`** | 成功提交時 1 次 | 遭拒絕、隔離或放棄時 1 次 | 入列拒絕由 `_safeRejectCallback` try/catch 隔離保護；隊列處理中由 `_invokeCallback` (`callbackInvoked` 旗標) 保證單次執行。 |

---

## 11. 41 項測試場景真實執行驗收報告

測試指令：`node --test tests/database/sqlite_reliability.test.js`  
測試環境：Node.js (Windows NT)  
執行結果：**41 passed, 0 failed, 0 skipped, 總耗時 2852.38ms**。

### Group A: Scheduler / Shutdown / Quiescence (7 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 1 | Scheduler Pending/Active 時觸發 Emergency Shutdown (v2.7.4) | 真實 Deferred 任務執行中拒絕 rawClose 並產生結構化診斷轉儲 | **PASS** |
| 2 | Scheduler Active 時觸發 Emergency Shutdown | 檢驗 `isQuiescent` 並安全拒絕連線強制釋放 | **PASS** |
| 3 | Transaction 執行中觸發 Shutdown | 禁止關閉並保護在途資料 | **PASS** |
| 4 | Shutdown Gate 關閉後嘗試新增工作 | 即刻拒絕並累計 `totalRejected`，不影響守恆計數 | **PASS** |
| 5 | Deadline 到達後 Scheduler 不得啟動新交易 (v2.7.4) | 真實底層交易阻塞下，獨立 Observer 於 100ms 準時返回快照 | **PASS** |
| 6 | 重複 Shutdown 冪等性 | 同時多次呼叫回傳同一個 Promise 且僅關閉連線一次 | **PASS** |
| 7 | Maintenance 與 Drain 競爭 | 維護任務執行中禁止執行 TRUNCATE Checkpoint | **PASS** |

### Group B: FIFO & Binary Isolation (6 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 8 | 正常 Binary Isolation | 自動拆分壞資料，好資料成功提交 | **PASS** |
| 9 | 左側 SQLITE_FULL 保持 FIFO (P0-1 核心驗證) | 剩餘批次按原始序排回隊列前端，無倒置 | **PASS** |
| 10 | 右側 SQLITE_FULL 保持 FIFO | Left 提交成功，Right 按原始順序退回隊列前端 | **PASS** |
| 11 | UNKNOWN 中止 Binary Isolation (P1-01) | 立即熔斷且所有未提交資料完整保留於錯誤容器 | **PASS** |
| 12 | Retry Queue 與一般 Queue 容器互斥無重複 (P0-2) | 單一歸屬保證，定時器重複觸發不重入 | **PASS** |
| 13 | 多批次連續失敗仍維持 FIFO | 排序以原始 `seq` 為準，多批次提交順序完全一致 | **PASS** |

### Group C: Data Conservation & Lifecycles (9 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 14 | 正常 COMMIT 與守恆 | `totalAccepted == totalCommitted` 且公式成立 | **PASS** |
| 15 | BUSY Retry 守恆 | 重試過程中資料守恆公式恆成立 | **PASS** |
| 16 | SQLITE_FULL 守恆 | 磁碟滿額暫停時所有未提交資料皆計入 queued | **PASS** |
| 17 | CONSTRAINT Quarantine 守恆 | 隔離項目轉入 quarantined 容器並精準計帳 | **PASS** |
| 18 | UNKNOWN 熔斷保留與守恆 | 轉移至 `uncommittedErrors` 實體保留 SQL 與參數 | **PASS** |
| 19 | Adapter ERROR 拒絕與計數分離 | 故障時拒絕新入列，`totalAccepted` 不虛增 | **PASS** |
| 20 | Shutdown Deadline 守恆 | 逾時未提交資料依舊受嚴格守恆追蹤 | **PASS** |
| 21 | 非法 Item 狀態轉換防護 | 違規轉移被攔截且不破壞原有狀態 | **PASS** |
| 22 | Callback Exactly-Once 集中防重 (P1-02) | 使用者回呼保證僅被執行一次 | **PASS** |

### Group D: Backup Integrity & Error Handling (4 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 23 | Backup Integrity VALID | 正常資料庫完整性驗證通過 | **PASS** |
| 24 | Backup Integrity CORRUPTED | 毀損檔案標記 CORRUPTED 並安全移除壞檔 | **PASS** |
| 25 | Backup Integrity VERIFY_ERROR | 檔案不存在或權限異常時回傳 VERIFY_ERROR | **PASS** |
| 26 | Backup close 失敗處置 (P1-03) | close 異常歸類為 VERIFY_ERROR 且保留候選檔 | **PASS** |

### Group E: Checkpoint Modes & Preconditions (4 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 27 | Checkpoint PASSIVE | 輕負載下執行並回傳 busy/log 狀態 | **PASS** |
| 28 | Checkpoint FULL | 嚴格檢查在途交易與 Scheduler Pending | **PASS** |
| 29 | Checkpoint BUSY 拒絕 | TRUNCATE/FULL 遇 `busy === 1` 拋出 `CHECKPOINT_BUSY_BLOCKED` | **PASS** |
| 30 | TRUNCATE 安全條件嚴格檢查 (P1-2) | 缺少 `queueMetricsProvider` 或未排空時拒絕 | **PASS** |

### Group F: v2.7.3 缺陷修正與獨立驗證 (7 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 31 | Drain 不將 UNCOMMITTED_ERROR 誤判為成功 (v2.7.3 P0-1) | 驗證 `uncommittedErrorCount > 0` 時 Drain 回報 `isClean = false`，Shutdown 不標記成功 | **PASS** |
| 32 | Binary Isolation 部分失敗與剩餘批次原子回退 (v2.7.4 P0-2 / P0-1) | 驗證整批觸發拆分且 Left 提交後若 Deadline 到期，Right 交易絕不啟動，剩餘項目原子排回佇列前端並保持守恆 | **PASS** |
| 33 | 故障注入測試: 模擬 SQLITE_FULL 時 Drain 立即中止 (v2.7.3 P0-3) | 驗證首次遭遇滿額後 Worker 立即 break 退出，耗時遠低於超時時限 | **PASS** |
| 34 | PAUSED_DISK_FULL 狀態下拒絕新寫入 (v2.7.3 P1-1) | 驗證磁碟滿額暫停期間 `enqueue` 即刻拒絕，`totalRejected` 增加，`totalAccepted` 不虛增 | **PASS** |
| 35 | PRAGMA 動態比對與硬性驗證 (v2.7.3 P1-2) | 驗證 PRAGMA 實際讀回值符合配置；設定衝突時拋出 `HARD_FAIL` 阻止啟動 | **PASS** |
| 36 | Callback Exactly-Once 相容層與入列拒絕防重調用 (v2.7.3 P1-3 / v2.7.4 P1-1) | 驗證 run/get/all/error 與 4 種入列拒絕回呼內部拋出例外時被安全保護且絕不二次調用 | **PASS** |
| 37 | Database Factory 初始化與啟動前置保護 (v2.7.3 P1-4 / v2.7.4) | 驗證初始化失敗時拒絕回傳 READY Adapter，並攔截 HTTP Server 與 MQTT 啟動 | **PASS** |

### Group G: v2.7.4 深度強固驗證 (4 Scenarios)
| 編號 | 測試案例名稱 | 驗證項目 | 實際執行結果 |
| :---: | :--- | :--- | :---: |
| 38 | Drain 階段嚴格遵守 BUSY Retry Backoff 與守恆 (v2.7.4 P0-1) | 驗證 Drain 遭遇 `SQLITE_BUSY` 時嚴格等待至少 80ms 退避延遲後才執行第 2 次交易並滿足資料守恆 | **PASS** |
| 39 | Graceful Shutdown 有界等待與未靜止時拒絕 rawClose (v2.7.4 P0-2) | 驗證排程器有未完成任務時 `adapter.close(timeout)` 與 `shutdownHandler.handle()` 有界超時返回 `adapterClosed: false`，絕不摧毀活動連線 | **PASS** |
| 40 | Emergency Shutdown 檢查未提交資料與誠實成功語意 (v2.7.4 P0-3) | 驗證佇列有 20 筆未提交資料時，即使 `emergencyClose()` 釋放連線成功，仍誠實回報 `success: false, dataClean: false` | **PASS** |
| 41 | 初始化失敗時安全清理 SQLite 連線防洩漏 (v2.7.4 P1-2) | 驗證 PRAGMA `HARD_FAIL` 後底層 `badAdapter.db` 被安全關閉並清空為 `null` | **PASS** |

---

## 12. 已知限制與未驗證項目

依據誠實宣告原則，本版本仍具有以下物理邊界與未驗證項目：
1. **未提交記憶體資料物理限制**：本實作未引入外部持久化預寫日誌（如 Outbox Pattern 或持久化 Ingestion Log）。若主機遭遇硬體突發斷電或作業系統層級 `kill -9`，記憶體隊列中尚未 COMMIT 的資料將無法恢復。
2. **自動磁碟空間探測 Worker**：目前系統在遭遇 `SQLITE_FULL` 後保持 `PAUSED_DISK_FULL` 並安全拒絕寫入，需透過 `resumeDiskFull()` 恢復；本版本未包含背景自動磁碟空間定時輪詢探測器。
3. **4.5GB 生產歷史資料庫實體基準測試**：因嚴格遵守「禁止碰觸正式 4.5GB 資料庫」之安全禁令，所有測試皆於獨立臨時資料庫執行；正式庫首次 `VACUUM INTO` 之實際 I/O 耗時留待受控維護視窗驗證。

---

## 13. 最終自我審查結論與交付狀態

| 審查項目 | 檢查標準 | 審查結論 |
| :--- | :--- | :---: |
| **v2.7.4 P0-1 Drain BUSY Backoff** | Drain 嚴格遵守 `retryAt` 退避延遲與剩餘預算，結束時清理 `#retryTimers` | **PASS** |
| **v2.7.4 P0-2 Shutdown 有界等待** | `close(timeoutMs)` 有界等待，未達 `isQuiescent()` 嚴禁呼叫 `_rawClose()` | **PASS** |
| **v2.7.4 P0-3 誠實成功語意** | Emergency / Graceful Shutdown 只要 `totalUncommitted > 0` 必回報 `success: false` | **PASS** |
| **v2.7.4 P1-1 拒絕回呼異常隔離** | `_safeRejectCallback` 確保入列拒絕回呼拋錯不炸穿呼叫端 | **PASS** |
| **v2.7.4 P1-2 初始化失敗連線清理** | PRAGMA 驗證失敗時自動 `close()` 並清空 `this.db` 防止 Handle 洩漏 | **PASS** |
| **v2.7.3 P0/P1 全項回歸** | UNCOMMITTED_ERROR 審核、Deadline 二分阻絕、Disk Full 中止、PRAGMA 動態驗證全數維持 | **PASS** |
| **Data Conservation** | 守恆公式在全部 41 項正常與故障注入路徑均 100% 成立 | **PASS** |
| **測試真實性** | 41 項測試全部在獨立臨時庫實際執行通過 (41 pass, 0 fail) | **PASS** |
| **Production 隔離** | 生產目錄、PM2、正式 4.5GB 資料庫維持絕對零碰觸 | **PASS** |

### 最終驗收結論
**狀態：`READY FOR REVIEW`**

所有修改均已通過本地獨立測試，並產出交付封裝包：`Meshtastic-DashBoard_SQLite_Reliability_v2.7.4.zip`。
