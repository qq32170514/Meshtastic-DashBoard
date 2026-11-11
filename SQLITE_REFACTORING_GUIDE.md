# Meshtastic-DashBoard 4.1.0 — SQLite Reliability Refactoring 技術實施說明書 (v2.7.5 Final Hardening & Verification)

> **文件版本**：v2.7.5 — READY FOR REVIEW (`READY FOR REVIEW` 不等於 `READY FOR PRODUCTION`)  
> **更新時間**：2026-11-11  
> **適用環境**：`d:\meshtastic\Meshtastic-DashBoard-Dev` (嚴格隔離於開發環境)  
> **執行狀態**：全套核心程式碼已於 `src/database/` 完成 v2.7.5 最後一輪三項強固修正（P0 共用 Shutdown Deadline 與 Checkpoint 超時保護、P1 Emergency Shutdown Queue In-Flight 競態防護、P1 Initialization Failure 等待原生 close callback 完成），44 項獨立臨時資料庫測試全數通過（**44 passed, 0 failed, 0 skipped**，總耗時 2945.78ms）。Prod 環境與正式約 4.5GB 資料庫維持絕對零接觸。

---

## 目錄
1. [任務目標與不可違反限制](#1-任務目標與不可違反限制)
2. [v2.7.4 三項問題根因分析](#2-v274-三項問題根因分析)
3. [v2.7.5 強固修正實作詳解](#3-v275-強固修正實作詳解)
   - 3.1 P0: Graceful Shutdown 全流程共用單一絕對 Deadline 與 Checkpoint 超時保護
   - 3.2 P1: Emergency Shutdown 加入 Queue In-Flight 與 Flush Worker 競態保護
   - 3.3 P1: Initialization Failure 等待 Native Close Callback 完成與錯誤隔離
4. [Shutdown 全流程時間預算分析](#4-shutdown-全流程時間預算分析)
5. [修改檔案清單與實際程式碼位置](#5-修改檔案清單與實際程式碼位置)
6. [Data Conservation 與可靠性誠實契約](#6-data-conservation-與可靠性誠實契約)
7. [44 項測試場景真實執行驗收報告](#7-44-項測試場景真實執行驗收報告)
8. [尚未解決的問題與物理限制](#8-尚未解決的問題與物理限制)
9. [最終驗收條件檢核表](#9-最終驗收條件檢核表)

---

## 1. 任務目標與不可違反限制

### 1.1 專案與環境紅線
1. **SQLite 驅動與 Schema 凍結**：維持 `sqlite3 ^5.1.6`，不新增、刪除或修改任何資料表、欄位、索引及約束。
2. **外部介面相容**：不改變現有 REST API、Socket.IO、MQTT、RF Tunnel、Turso 架構及前端介面。
3. **開發與正式環境嚴格隔離**：所有修改與測試僅在 `d:\meshtastic\Meshtastic-DashBoard-Dev` 執行；嚴禁修改正式環境目錄（`d:\meshtastic\Meshtastic-DashBoard-Prod`）、嚴禁執行 PM2 restart 或部署操作、嚴禁讀取或測試正式約 4.5GB SQLite 資料庫。
4. **獨立臨時資料庫測試**：所有 44 項測試均使用獨立臨時 SQLite 檔案（`meshtastic_test_*.db`），測試結束後安全釋放連線並清除 DB、WAL 與 SHM 檔案。

### 1.2 核心可靠性誠實原則
- `COMMITTED` 僅代表 SQLite transaction 確實成功提交。
- `Adapter Quiescent` 不等於 `WriteQueue` 沒有未提交資料，也不等於 `Flush Worker` 沒有在途 `IN_FLIGHT` 項目。
- JavaScript 物件清空（`this.db = null`）僅代表 JS reference 已移除，**不等於** SQLite native handle 已釋放；唯有原生 `db.close(callback)` 完成後才代表底層資源釋放。
- `Promise.race` Timeout 僅代表呼叫端停止等待並返回超時診斷，**不等於**底層正在執行的 SQLite native C++ operation 已被取消。
- 嚴禁對仍有活動操作（包含逾時但尚未結束之 Checkpoint 或 Transaction）的 SQLite connection 執行 `_rawClose()`。
- Shutdown 任一階段超時絕不描述為正常完成（`success: false`）。
- 記憶體佇列（Memory Queue）無法防止突發斷電、`SIGKILL`（`kill -9`）或作業系統崩潰造成的未提交資料遺失。

---

## 2. v2.7.4 三項問題根因分析

### 2.1 P0 根因：Graceful Shutdown 的 Checkpoint 缺乏共用 Deadline 保護且 Close 具有 100ms 保底
1. **Checkpoint 無時間上限**：在 v2.7.4 中，`ShutdownHandler.handle()` 雖對 `writeQueue.drain()` 與 `adapter.close(timeoutMs)` 設有超時控制，但中間的 `await this.#adapter.checkpoint('TRUNCATE', ...)` 未傳入剩餘時間預算，且 `SQLiteAdapter.checkpoint()` 無超時保護。若 `wal_checkpoint(TRUNCATE)` 在排程器等待或底層執行時受阻，整個 Shutdown 流程將無限期卡在 Checkpoint 階段。
2. **Close 階段 100ms 保底突破總預算**：v2.7.4 在計算 Close 預算時使用了 `Math.max(100, Math.min(waitBufferMs, totalBudget - elapsed))`。當前面階段已耗盡 `totalBudget`（剩餘時間 $\le 0$）時，仍強制給予 100ms 等待，且 `SQLiteAdapter.close(timeoutMs)` 對 `timeoutMs <= 0` 未走立即超時分支，導致總關機時間可能超過 `pm2KillTimeoutMs`。

### 2.2 P1 根因：Emergency Shutdown 對 Queue In-Flight 與 Flush Worker 的競態窗口檢查不足
1. **Queue 與 Adapter 之間的微任務競態窗口**：當 `WriteQueue.flush()` 啟動時，會先將 `this.isFlushing` 設為 `true` 並將批次項目由 `QUEUED` 轉移至 `IN_FLIGHT`（`#inFlightItems`），隨後呼叫 `_executeTopLevelBatch()` $\to$ `_commitOrIsolate()` $\to$ `adapter.transaction()` $\to$ `adapter._schedule()`。在 `adapter._schedule()` 內部 `awaitInit.then(...)` 實際遞增 `#schedulerPendingCount` 之前的微任務窗口內，`adapter.isQuiescent()` 仍回報為 `true`。
2. **單看 Adapter Quiescent 導致誤關連線**：v2.7.4 的 `handleEmergencyCrash()` 僅以 `this.#adapter.isQuiescent()` 作為是否呼叫 `emergencyClose()` 的准入條件，未檢查 `writeQueue.inFlightCount === 0` 與 `!writeQueue.isFlushWorkerActive()`，在此競態窗口下可能誤判為可關閉資料庫。

### 2.3 P1 根因：SQLite Initialization Failure Cleanup 未等待原生 `db.close` Callback 完成
1. **過早 Reject 初始化 Promise**：在 v2.7.4 的 `SQLiteAdapter.initialize()` 中，當 `new sqlite3.Database(dbPath)` 成功開啟連線，但隨後的 `_applyAndVerifyPragmas()` 拋出驗證失敗（`HARD_FAIL`）時，catch 區塊呼叫了 `dbToClose.close((closeErr) => { ... })`，卻未 `await` 該非同步 callback 完成便立即執行 `reject(pErr)`。
2. **JS Reference 清空不等於 Native Handle 釋放**：在 `dbToClose.close()` 的 callback 觸發前，僅有 `this.db = null`（JS 引用清空），底層 C++ SQLite connection 與 Windows File Handle 尚未真正完成關閉釋放。

---

## 3. v2.7.5 強固修正實作詳解

### 3.1 P0: Graceful Shutdown 全流程共用單一絕對 Deadline 與 Checkpoint 超時保護
- **修改檔案**：
  - [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L49-L263)
  - [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L516-L652)
- **修正重點**：
  1. **單一絕對 Deadline**：於 `ShutdownHandler.handle()` 啟動時建立唯一基準：
     ```javascript
     const startTime = Date.now();
     const totalShutdownBudget = typeof this.#config.pm2KillTimeoutMs === 'number'
         ? this.#config.pm2KillTimeoutMs
         : 10000;
     const shutdownDeadlineAt = startTime + totalShutdownBudget;
     const getRemainingBudget = () => shutdownDeadlineAt - Date.now();
     ```
  2. **三階段全面受控**：
     - **階段一（Drain）**：計算 `remainingForDrain = getRemainingBudget()`。若 $\le 0$ 直接標記 `deadlineExpired = true` 跳過 Drain；否則以 `Math.min(configuredDrainTimeout, maxDrainBudget, remainingForDrain)` 執行排空。
     - **階段二（TRUNCATE Checkpoint）**：僅在 6 項資料安全前置條件（`drainClean`、有效完成憑證、`totalUncommitted === 0`、`uncommittedErrorCount === 0`、`inFlightCount === 0`、`activeTransactions === 0`、`isQuiescent`）全數成立時才評估 Checkpoint。進入前計算 `remainingForCheckpoint = getRemainingBudget()`；若 $\le 0$ 直接標記 `checkpointTimedOut = true`、`deadlineExpired = true`；否則將 `{ timeoutMs: remainingForCheckpoint, deadlineAt: shutdownDeadlineAt }` 傳入 `adapter.checkpoint()`。
     - **階段三（Adapter Close）**：計算 `remainingForClose = getRemainingBudget()`，**徹底移除 100ms 保底**。若 `remainingForClose <= 0` 或 `checkpointTimedOut === true`，直接進入 Timeout 處理（`adapterClosed = false`），**絕不啟動下一階段等待，更不對仍在執行 Checkpoint 的底層連線呼叫 `_rawClose()`**。
  3. **Adapter Checkpoint 內部執行追蹤與超時保護**：
     - `SQLiteAdapter` 新增私有狀態 `#checkpointInProgress`，納入 `isQuiescent()` 與 `getActiveStatus()`。
     - 若 `checkpoint()` 超時返回，僅代表等待逾時（拋出 `[CHECKPOINT_TIMEOUT]`），底層仍在執行的 `PRAGMA wal_checkpoint(TRUNCATE)` 會維持 `#checkpointInProgress = true`、`isExecutingUnderlying = true`、`#schedulerActiveCount = 1`，確保後續邏輯與診斷能精確得知底層操作尚未結束，且 `_rawClose()` 亦強制拒絕 `this.#checkpointInProgress === true` 的關閉請求。

### 3.2 P1: Emergency Shutdown 加入 Queue In-Flight 與 Flush Worker 競態保護
- **修改檔案**：
  - [`src/database/write-queue.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L68-L135)
  - [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L22-L44)
  - [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L654-L664)
- **修正重點**：
  1. **Flush Worker 唯讀狀態查詢**：在 `WriteQueue` 新增 `isFlushWorkerActive()` 方法（綜合檢查 `this.isFlushing`、`this.isDraining` 與 `this.#currentFlushPromise !== null`），並將 `flushWorkerActive` 納入 `getMetrics()`。
  2. **7 項 Emergency Close 准入條件 (`_canSafelyEmergencyClose()`)**：
     在 `ShutdownHandler` 中，唯有同時滿足以下 7 項條件才允許呼叫 `emergencyClose()`：
     - `this.#adapter.isQuiescent()` 為 `true`
     - `qMetrics.inFlightCount === 0`（Queue 無任何 In-Flight 項目）
     - `!flushWorkerActive`（Flush / Drain Worker 未在執行）
     - `status.schedulerPending === 0`
     - `status.schedulerActive === 0`
     - `status.activeTransactions === 0`
     - `!status.underlyingExecuting && !status.maintenanceInProgress && !status.checkpointInProgress`
  3. **三維語意嚴格分離**：
     - **連線是否可安全關閉 (`adapterClosed`)**：由上述 7 項在途執行條件決定。若佇列僅有 `queuedCount > 0` 或 `retryPendingCount > 0`（位於記憶體中、未進入 `IN_FLIGHT` 且無活動 Worker），SQLite 連線並未在使用中，因此允許安全釋放連線（`adapterClosed: true`）。
     - **是否存在未提交資料 (`hasUncommittedData`)**：由 `qMetrics.totalUncommitted > 0` 決定。
     - **是否達成資料完整性 (`dataClean` / `success`)**：只要 `hasUncommittedData === true`，`dataClean` 與 `success` 必定為 `false`，絕不因連線成功關閉而謊稱資料完整保存。

### 3.3 P1: Initialization Failure 等待 Native Close Callback 完成與錯誤隔離
- **修改檔案**：
  - [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L156-L259)
- **修正重點**：
  1. **區分連線開啟狀態 (`dbOpened`)**：
     - 若 `sqlite3.Database` 建構子 open callback 本身回傳 `err`（`dbOpened === false`），底層連線並未開啟成功：立即將 `this.db = null`、設定 `ADAPTER_STATES.ERROR` 並 reject，避免對未開啟連線重複呼叫 `close()`。
     - 若 `sqlite3.Database` 已成功開啟（`dbOpened === true`），但隨後的 `_applyAndVerifyPragmas()` 執行或讀回驗證失敗：
       1. 保存原始初始化錯誤 `pErr`，設定 `this.setFatalError(pErr)` 與 `this.state = ADAPTER_STATES.ERROR`。
       2. 立即將 `this.db = null` 抽離，避免外部在清理期間取得連線引用。
       3. 呼叫 `await this._cleanupFailedInitConnection(dbToClose, pErr)`，**真正等待原生 `dbToClose.close(callback)` 完成**。
       4. 若 `close(callback)` 發生錯誤，將其獨立記錄於 `this.lastCleanupError`（及 `pErr.cleanupError`），**絕不覆蓋原始 `pErr` 與 `this.lastError`**。
       5. 待 `close(callback)` 完成後，才執行 `reject(pErr)`。

---

## 4. Shutdown 全流程時間預算分析

```text
startTime                                                              shutdownDeadlineAt
    ├─────────────────────────────── totalShutdownBudget ───────────────────────────────┤
    │                                                                                   │
    ├── Stage 1: WriteQueue Drain ──┼── Stage 2: Checkpoint ──┼── Stage 3: Close ───────┤
         budget <= min(               budget =                  budget =
           drainTimeoutMs,            shutdownDeadlineAt        shutdownDeadlineAt
           totalBudget - waitBuffer,  - Date.now()              - Date.now()
           remainingBudget            (若 <= 0 直接 Timeout)     (無 100ms 保底，<= 0 直接跳過)
         )
```

| 情境 | Drain 階段耗時 | Checkpoint 階段預算與行為 | Close 階段預算與行為 | 總耗時與最終狀態 |
| :--- | :--- | :--- | :--- | :--- |
| **1. 正常排空關機** | $5\text{ms}$ (`drainClean: true`) | 取得剩餘預算 $\approx 9995\text{ms}$，實際約 $2\text{ms}$ 完成 `TRUNCATE` | 取得剩餘預算 $\approx 9993\text{ms}$，實際約 $1\text{ms}$ 完成 `close()` | $\approx 8\text{ms} \ll T_{\text{total}}$，`success: true` |
| **2. Drain 超時** | 耗盡 `drainTimeoutMs` (`drainClean: false`) | 因 `drainClean === false` 跳過 `TRUNCATE` | 取得剩餘預算 `shutdownDeadlineAt - now`，等待排程收斂；若仍未靜止則 `CLOSE_REJECTED` | $\le T_{\text{total}}$，`success: false, adapterClosed: false` |
| **3. Checkpoint 超時 (Test 42)** | $5\text{ms}$ (`drainClean: true`) | 取得剩餘預算 $T_{\text{rem}}$；到期時拋出 `CHECKPOINT_TIMEOUT` (`checkpointTimedOut: true`) | 因 `checkpointTimedOut` 且 `remainingBudget <= 0`，**0ms 立即跳過 Close**，不呼叫 `_rawClose()` | $\approx T_{\text{total}}$（無額外 100ms 溢出），`success: false, checkpointTimedOut: true, adapterClosed: false` |
| **4. 進入前預算已耗盡** | `remaining <= 0` 直接跳過 | `remaining <= 0` 直接跳過 | `remaining <= 0` 直接跳過 | $0\text{ms}$ 額外等待，`deadlineExpired: true, success: false` |

---

## 5. 修改檔案清單與實際程式碼位置

| 檔案路徑 | 修改位置 (行號範圍) | 修正項目與職責說明 |
| :--- | :--- | :--- |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L47-L78) | `#L47-L78`, `#L128-L154` | 新增 `#checkpointInProgress`、`lastCleanupError` 與 `#databaseFactory`，將 `checkpointInProgress` 納入 `isQuiescent()` 與 `getActiveStatus()` |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L156-L259) | `#L156-L259` | **v2.7.5 P1**：新增 `_createDatabase()` 與 `_cleanupFailedInitConnection()`，`initialize()` 在 PRAGMA 失敗時等待原生 `db.close(cb)` 完成後才 reject 原始錯誤，並隔離 Cleanup Error |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L516-L625) | `#L516-L625` | **v2.7.5 P0**：`checkpoint()` 支援 `{ timeoutMs, deadlineAt }` 共用 Deadline 檢查與有界等待，並在執行期間維護 `#checkpointInProgress` |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L636-L698) | `#L636-L698` | **v2.7.5 P0/P1**：`close(timeoutMs)` 對 `waitBudget <= 0` 不再落入無界等待；`emergencyClose(queueSafetyState)` 驗證 Queue In-Flight 與 Flush Worker；`_rawClose()` 拒絕 `#checkpointInProgress` 或 `maintenanceInProgress` |
| [`src/database/write-queue.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/write-queue.js#L68-L135) | `#L68-L135`, `#L622-L709` | **v2.7.5 P1**：新增 `this.isDraining` 與 `isFlushWorkerActive()` 唯讀狀態查詢，並輸出至 `getMetrics().flushWorkerActive` |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L22-L44) | `#L22-L44` | **v2.7.5 P1**：新增 `_canSafelyEmergencyClose()` 檢查 7 項安全准入條件 |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L49-L263) | `#L49-L263` | **v2.7.5 P0**：`handle()` 實作單一絕對 `shutdownDeadlineAt`，統籌 Drain、Checkpoint、Close 三階段剩餘預算，移除 100ms 保底並擴充 `checkpointTimedOut` 與 `diagnostics.checkpoint` |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L265-L361) | `#L265-L361` | **v2.7.5 P1**：`handleEmergencyCrash()` 整合 `_canSafelyEmergencyClose()`，回傳完整 `flushWorkerActive`、`schedulerPending`、`schedulerActive`、`queueMetrics` 與 `diagnostics` |
| [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js#L1360-L1603) | `#L46`, `#L1360-L1603` | 新增 Group H（Test 42、Test 43、Test 44），完整保留原有 41 項測試，總計 **44 項測試** |

---

## 6. Data Conservation 與可靠性誠實契約

1. **兩層資料守恆公式**：
   $$\text{totalSubmitted} = \text{totalAccepted} + \text{totalRejected}$$
   $$\text{totalAccepted} = \text{totalCommitted} + \text{totalQuarantined} + \text{queuedCount} + \text{retryPendingCount} + \text{inFlightCount} + \text{uncommittedErrorCount}$$
2. **三種關機狀態嚴格區分**：
   - `adapterClosed`：底層 SQLite 連線是否已在無在途操作的靜止狀態下安全執行 `db.close()`。
   - `hasUncommittedData`：`writeQueue.getMetrics().totalUncommitted > 0`（包含 `queued`、`retryPending`、`inFlight`、`uncommittedErrors`）。
   - `dataClean` / `success`：唯有所有已接受資料全數提交（`totalUncommitted === 0`）、Checkpoint（於 Graceful Shutdown 時）完成且 `adapterClosed === true` 時，`success` 才為 `true`。

---

## 7. 44 項測試場景真實執行驗收報告

- **語法靜態檢查**：`node --check` 於所有修改檔案全數通過（Exit Code 0）。
- **自動化測試指令**：`npm run test:database` (`node --test tests/database/*.test.js`)
- **測試結果摘要**：**44 tests, 44 passed, 0 failed, 0 cancelled, 0 skipped, 總耗時 2945.78ms**。

### Group A ~ Group G (Tests 1 ~ 41 回歸驗證結果)
- **Test 1 ~ Test 41**：**41 / 41 全數 PASS**（包含 Test 1 Scheduler Pending/Active、Test 5 Drain Deadline、Test 38 Drain BUSY Backoff、Test 39 Graceful Shutdown bounded close、Test 40 Emergency Shutdown 未提交資料審計、Test 41 Initialization Failure Cleanup）。

### Group H: v2.7.5 Final Hardening & Verification (Tests 42 ~ 44)
| 編號 | 測試案例名稱 | 驗證重點 | 耗時 | 結果 |
| :---: | :--- | :--- | :---: | :---: |
| **42** | **Checkpoint Timeout 與 Shutdown 共用 Deadline (v2.7.5 P0)** | 1. Drain 正常提交 2 筆資料完成<br>2. `wal_checkpoint(TRUNCATE)` 被 Deferred 阻塞<br>3. Shutdown 於共用預算（220ms，實測約 224ms）準時返回，無 100ms 額外溢出<br>4. `checkpointTimedOut: true`, `checkpointCompleted: false`, `success: false`<br>5. 未呼叫 `_rawClose()`（`adapterClosed: false`, `db !== null`）<br>6. `diagnostics.checkpoint` 與 `adapterStatus` 完整記錄在途狀態 | 248.91ms | **PASS** |
| **43** | **Emergency Shutdown Queue In-Flight Race 防護驗證 (v2.7.5 P1)** | 1. 透過真實 `enqueue` $\to$ `flush()` 進入 `inFlightCount === 1`、`flushWorkerActive === true` 但 Adapter 尚未註冊排程（`adapter.isQuiescent() === true`）之競態窗口<br>2. 觸發 `handleEmergencyCrash`，驗證即使 Adapter 暫時 Quiescent 仍拒絕呼叫 `emergencyClose`<br>3. `adapterClosed: false`, `forcedExit: true`, `flushWorkerActive: true`<br>4. 驗證 Queue 項目零遺失，`conservationCheck === true` | 78.36ms | **PASS** |
| **44** | **Initialization Failure Native Close Completion 與錯誤隔離驗證 (v2.7.5 P1)** | 1. 真實 `sqlite3.Database` 開啟後觸發 PRAGMA `HARD_FAIL`<br>2. 以 Deferred 控制原生 `db.close(cb)` 完成時點，驗證 `close(cb)` 完成前 `initialize()` Promise 絕不提前 reject，且 `this.db` 已立即清空為 `null`<br>3. 釋放 Deferred 並模擬 Cleanup Error 後，`initialize()` 才 reject 原始 `HARD_FAIL` 錯誤<br>4. `state === ERROR`、`lastError` 維持原始錯誤、`lastCleanupError` 獨立記錄清理錯誤 | 43.62ms | **PASS** |

---

## 8. 尚未解決的問題與物理限制

依據工程誠實原則，如實宣告以下物理限制與未涵蓋邊界：
1. **Node.js `sqlite3` 原生 C++ 操作不可中途強制取消**：當 `checkpoint()`、`drain()` 或 `close()` 因共用 Deadline 到期而透過 `Promise.race` 返回 Timeout 時，僅代表 JS 控制流不再等待並保護性地拒絕呼叫 `_rawClose()`；底層 libuv 執行緒池中正在運行的 SQLite C API 操作並未被取消，仍會繼續執行至底層完成或由作業系統在行程終止時回收，由 SQLite WAL 恢復機制確保檔案一致性。
2. **記憶體佇列無法抵禦斷電與 `SIGKILL`**：`WriteQueue` 為純記憶體佇列，未實作外部持久化預寫日誌（Durable Outbox / WAL Ingestion Log）。若發生硬體斷電、OS 崩潰或 `kill -9`，所有尚未完成 SQLite `COMMIT` 的在途與排隊資料將會遺失。
3. **磁碟滿額需外部介入恢復**：遭遇 `SQLITE_FULL` 時系統自動進入 `PAUSED_DISK_FULL` 並拒絕新寫入以保護現有佇列，需待磁碟空間清理後呼叫 `resumeDiskFull()` 恢復，未內建背景自動磁碟空間輪詢。
4. **正式環境 4.5GB 資料庫未實測**：受嚴格安全隔離限制，正式生產環境約 4.5GB 資料庫尚未執行實際 `VACUUM INTO` 與 `TRUNCATE` Checkpoint 耗時基準量測。

---

## 9. 最終驗收條件檢核表

| 驗收條件 | 檢核結果 |
| :--- | :---: |
| Checkpoint 受到共用 Shutdown Deadline 保護 | **PASS** |
| Drain、Checkpoint、Close 不會各自取得完整 Timeout，且移除 100ms 保底 | **PASS** |
| Emergency Shutdown 正確檢查 Queue In-Flight 與 Flush Worker | **PASS** |
| Initialization Failure 等待原生 `close(callback)` 完成且不覆蓋原始錯誤 | **PASS** |
| Test 42、Test 43、Test 44 全部真實執行通過 | **PASS** |
| v2.7.4 原有 41 項測試全部回歸通過（共 44 / 44 PASS） | **PASS** |
| 沒有修改 Schema 或既有外部 API | **PASS** |
| 沒有碰觸正式環境與正式 4.5GB 資料庫 | **PASS** |
| 完整測試紀錄及 Git diff 已交付 | **PASS** |

**最終簽核狀態：`v2.7.5 — READY FOR REVIEW`**  
*(註：`READY FOR REVIEW` 僅代表開發環境程式碼與隔離驗證完成，不等於 `READY FOR PRODUCTION`。)*
