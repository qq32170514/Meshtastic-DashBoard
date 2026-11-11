# Meshtastic-DashBoard 4.1.0 — SQLite Reliability Refactoring 技術實施說明書 (v2.7.7 — Final Closure)

> **文件版本**：`v2.7.7 — Final Closure` (`READY FOR REVIEW` $\neq$ `READY FOR PRODUCTION`)
> **更新時間**：2026-11-11
> **適用環境**：`d:\meshtastic\Meshtastic-DashBoard-Dev` (嚴格隔離於開發環境)
> **執行狀態**：已完成 SQLite Reliability v2.7.7 最終收尾修正（P1 `emergencyClose()` 強制要求有效 Deadline、P2 Test 46 Delayed Native Close Callback Error Injection Simulation 測試邊界澄清、P2 Test 42 / 45 / 46 實測時間明細完整記錄），全套 46 項獨立臨時資料庫測試全數通過（**46 passed, 0 failed, 0 skipped**，總耗時 3435.33ms）。Prod 環境與正式約 4.5GB 資料庫維持絕對零接觸。

---

## 目錄
1. [任務目標與不可違反限制](#1-任務目標與不可違反限制)
2. [v2.7.6 審查發現問題與 v2.7.7 修改摘要](#2-v276-審查發現問題與-v277-修改摘要)
3. [核心可靠性設計與 v2.7.7 修正詳解](#3-核心可靠性設計與-v277-修正詳解)
   - 3.1 Graceful Close 共用單一絕對 Deadline 與單次 Native Close 保證
   - 3.2 P1: `emergencyClose()` 強制要求有效 Deadline 與安全檢查保留
   - 3.3 Close Timeout 後四類競態場景（Case A ~ Case D）狀態保護
   - 3.4 P2: Test 42 與 Test 46 模擬測試邊界澄清
4. [Native Close 狀態機與三態嚴格區分](#4-native-close-狀態機與三態嚴格區分)
5. [修改檔案清單與實際程式碼位置](#5-修改檔案清單與實際程式碼位置)
6. [46 項測試場景真實執行驗收報告與時間明細](#6-46-項測試場景真實執行驗收報告與時間明細)
   - 6.1 Test 42 / Test 45 / Test 46 時間紀錄與狀態快照拆解
   - 6.2 46 項回歸測試完整摘要
7. [未解決的物理限制與 Future Improvements](#7-未解決的物理限制與-future-improvements)
8. [最終驗收條件檢核表](#8-最終驗收條件檢核表)

---

## 1. 任務目標與不可違反限制

### 1.1 專案與環境紅線
1. **SQLite 驅動與 Schema 凍結**：維持 `sqlite3 ^5.1.6`，不新增、刪除或修改任何資料表、欄位、索引及約束。
2. **外部介面相容**：不改變現有 REST API、Socket.IO、MQTT、RF Tunnel、Turso 架構及前端介面。
3. **開發與正式環境嚴格隔離**：所有修改與測試僅在 `d:\meshtastic\Meshtastic-DashBoard-Dev` 執行；嚴禁修改正式環境目錄（`d:\meshtastic\Meshtastic-DashBoard-Prod`）、嚴禁執行 PM2 restart 或部署操作、嚴禁讀取或測試正式約 4.5GB SQLite 資料庫。
4. **獨立臨時資料庫測試**：所有 46 項測試均使用獨立臨時 SQLite 檔案（`meshtastic_test_*.db`），測試結束後安全釋放連線並清除暫存檔案。

### 1.2 核心工程可靠性原則
- **Caller Timeout $\neq$ Native Close Completed**：當呼叫端等待 `close()` 或 `emergencyClose()` 達到 Deadline 超時返回時，僅代表 JavaScript 呼叫端結束等待，**不等於**底層 SQLite `db.close(callback)` 已完成，亦**不能**取消已交給 SQLite C++ 層執行的工作。
- **Memory Queue cannot guarantee protection against sudden power loss or SIGKILL.**（記憶體佇列無法防止突發斷電、作業系統崩潰或 `SIGKILL` 造成的未提交資料遺失。）
- **READY FOR REVIEW $\neq$ READY FOR PRODUCTION**：開發環境通過全套自動化驗收不代表已完成生產環境變更窗口驗證與容量壓測。
- **三項關閉狀態嚴格獨立**：`closeTimedOut`、`nativeClosePending` 與 `adapterClosed` 絕對不可混用；`closeTimedOut === true` 時，若原生 callback 尚未返回，`adapterClosed` 必須維持 `false` 且 `nativeClosePending` 必須為 `true`。
- **Native `db.close(callback)` 單次呼叫保證**：一旦對底層 `sqlite3.Database` 實例呼叫過 `db.close(callback)`，無論後續是否發生呼叫端超時、重複呼叫 `close()` 或交錯呼叫 `emergencyClose()`，**絕對不得**再次呼叫第二次 `db.close()`。

---

## 2. v2.7.6 審查發現問題與 v2.7.7 修改摘要

1. **P1 — 修正 `SQLiteAdapter.emergencyClose()` 缺少強制 Deadline 的問題**：
   - **問題根因**：v2.7.6 中透過 `ShutdownHandler.handleEmergencyCrash()` 呼叫 `emergencyClose()` 時雖有傳入 `emergencyDeadlineAt`，但若外部直接呼叫 `adapter.emergencyClose()` 且未提供 `timeoutMs` 或 `deadlineAt`，`_resolveCloseDeadline()` 會回傳 `deadlineAt: null`，導致 `_awaitNativeCloseWithDeadline(null)` 可能無限等待 `#nativeClosePromise`。
   - **v2.7.7 修正**：於 [`SQLiteAdapter.emergencyClose()`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L808-L848) 強制驗證呼叫端必須提供有效的 `deadlineAt` 或可轉換為絕對時間的有限數值 `timeoutMs`；若兩者皆未提供，立即以 `[EMERGENCY_CLOSE_DEADLINE_REQUIRED]` 安全拒絕執行，絕不允許傳入 `null` 進入無界等待。
2. **P2 — 修正 Test 46 Part B 的 `SQLITE_BUSY` 模擬說明**：
   - **問題根因**：Test 46 Part B 先呼叫真實 `origErrDbClose()` 釋放檔案控制代碼，再透過 Deferred 延遲 callback 並由測試注入 `new Error('... SQLITE_BUSY ...')`，本質上是 **Delayed Native Close Callback Error Handling (Callback Error Injection Simulation)**，而非在 SQLite C++ 引擎內部留下未 finalize 的 `sqlite3_stmt` 觸發原生 `SQLITE_BUSY`。
   - **v2.7.7 修正**：更新 [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js#L1735-L1913) 的測試標題、註解、錯誤訊息與本文件說明，誠實標示其為 Callback Error Injection Simulation。
3. **P2 — 補齊 Test 42 / Test 45 / Test 46 的時間紀錄拆解**：
   - 於本文件第 6.1 節完整記錄並明確區分設定的 **Deadline**、**ShutdownHandler 實際等待耗時 (Shutdown elapsed)**、**Native Callback 延遲時間** 與 **整個測試案例總耗時 (Test case elapsed)**，並記錄 Timeout 當下的完整狀態快照。

---

## 3. 核心可靠性設計與 v2.7.7 修正詳解

### 3.1 Graceful Close 共用單一絕對 Deadline 與單次 Native Close 保證
- **檔案位置**：[`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L672-L806)、[`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L203-L299)
- `ShutdownHandler.handle()` 建立唯一 `shutdownDeadlineAt = startTime + totalShutdownBudget`，統籌約束 Drain、TRUNCATE Checkpoint、Scheduler Queue 等待與 Native `db.close(callback)` 等待。
- `_rawClose()` 將首次啟動的 `dbToClose.close(callback)` 封裝為單一 `#nativeClosePromise` 並設定 `#nativeClosePending = true`。在 callback 返回前，`this.db` 保持非 `null`、狀態維持 `CLOSING`，且 `_schedule()` 與 `_raw*` 全面拒絕新操作。

### 3.2 P1: `emergencyClose()` 強制要求有效 Deadline 與安全檢查保留
- **檔案位置**：[`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L808-L848)
- **強制 Deadline 驗證**：
  1. 呼叫端可透過 `emergencyClose(timeoutMs)`、`emergencyClose({ timeoutMs })`、`emergencyClose({ deadlineAt })` 或 `emergencyClose(queueSafetyState, { timeoutMs, deadlineAt })` 提供時限。
  2. `_resolveCloseDeadline()` 驗證 `Number.isFinite` 並將 `timeoutMs` 轉換為絕對時間 `deadlineAt = Date.now() + timeoutMs`。
  3. 若解析後 `deadlineAt === null || !Number.isFinite(deadlineAt)`，立即回傳 rejected Promise：`[EMERGENCY_CLOSE_DEADLINE_REQUIRED] emergencyClose() 必須由呼叫端提供有效的 deadlineAt 或 timeoutMs，禁止無限期等待`，不會呼叫 `_awaitNativeCloseWithDeadline(null)`，也不會改變 Adapter 狀態或呼叫 `db.close()`。
  4. 若傳入的 `deadlineAt` 已經過期（`deadlineAt <= Date.now()`）：
     - 若尚未啟動原生關閉（`!this.#nativeClosePending`），立即拋出 `[CLOSE_TIMEOUT]`，不啟動 `db.close()` 且不等待。
     - 若已有原生關閉進行中（`this.#nativeClosePending === true`），重用原本的 `#nativeClosePromise`（不重複呼叫 `db.close()`），並因 `remainingMs <= 0` 立即拋出 `[CLOSE_TIMEOUT] [NATIVE_CLOSE_TIMEOUT]` 結束呼叫端等待。
  5. 完整保留既有 Queue `inFlightCount`、`flushWorkerActive` 與 `this.isQuiescent()`（含 Scheduler、Active Transactions、Underlying Execution、Maintenance、Checkpoint）全部安全檢查，未做任何放寬。

### 3.3 Close Timeout 後四類競態場景（Case A ~ Case D）狀態保護
1. **Case A（Close Timeout 後再次呼叫 Close / EmergencyClose）**：重用既有 `#nativeClosePromise`，絕不第二次呼叫 `db.close()`。
2. **Case B（Close Timeout 後 Native Callback 稍後成功返回）**：透過 `settled` 單次鎖將狀態更新為 `ADAPTER_STATES.CLOSED`、`nativeClosePending = false`、`closeTimedOut = false`、`this.db = null`。
3. **Case C（Native Close Callback 回傳錯誤）**：記錄 `this.lastCloseError = err` 與 `this.lastError = err`，設定 `nativeClosePending = false`，將 Adapter 轉為 `ADAPTER_STATES.ERROR`（`adapterClosed: false`，絕不標記為 `CLOSED`），並封鎖後續所有資料庫操作。
4. **Case D（Graceful 與 Emergency Close 交錯）**：雙方共用同一個 `#nativeClosePromise`，不重複呼叫 `db.close()`，不提前清空 `this.db = null`，亦不發生 Promise 重複結算。

### 3.4 P2: Test 42 與 Test 46 模擬測試邊界澄清
1. **Test 42 (`Checkpoint Task Execution Delay Simulation`)**：透過攔截 `db.adapter._rawQueryOne` 在進入 `origRawQueryOne` 前等待 Deferred Promise，模擬 Checkpoint 任務在 Adapter 執行層等待超時，驗證共用 Deadline 與禁止 `_rawClose()` 保護，而非直接阻塞 SQLite C++ 原生執行緒。
2. **Test 46 Part B (`Delayed Native Close Callback Error Handling — Callback Error Injection Simulation`)**：先執行真實 `origErrDbClose()` 以確保測試結束後作業系統檔案鎖正常釋放，再透過 `errCloseDeferred` 延遲 callback 並由測試注入 `new Error('Simulated callback error: SQLITE_BUSY: unable to close due to unfinalized statements')`。此測試驗證的是 **Adapter 在收到延遲的 close callback error 時能否正確轉移至 `ERROR` 狀態並保留錯誤資訊**，而非宣稱在 SQLite C++ 引擎內部重現未 finalize statement 的原生 `SQLITE_BUSY`。

---

## 4. Native Close 狀態機與三態嚴格區分

| 狀態情境 | `adapter.state` | `closeTimedOut` | `nativeClosePending` | `adapterClosed` | `adapter.db` | 允許新 DB 操作 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **正常運行中** | `READY` | `false` | `false` | `false` | `Database` 實例 | 是 |
| **呼叫 `emergencyClose()` 未提供 Deadline** | 維持原狀態 | 維持原狀態 | 維持原狀態 | `false` | `Database` 實例 | 依原狀態 |
| **Scheduler 等待超時（未進入 `_rawClose`）** | `CLOSING` | `true` | `false` | `false` | `Database` 實例 | 否 |
| **已呼叫 `db.close(cb)`，等待 Callback 中** | `CLOSING` | `false` | `true` | `false` | `Database` 實例 | 否 |
| **已呼叫 `db.close(cb)`，呼叫端等待超時（Callback 未返回）** | `CLOSING` | `true` | `true` | `false` | `Database` 實例 | 否 |
| **Callback 稍後成功返回（`err === null`）** | `CLOSED` | `false` | `false` | `true` | `null` | 否 |
| **Callback 回傳錯誤（`err !== null`）** | `ERROR` | `true` / `false` | `false` | `false` | `Database` 實例 (封鎖) | 否 |

---

## 5. 修改檔案清單與實際程式碼位置

| 檔案路徑 | 修改位置 (行號範圍) | 修正項目與職責說明 |
| :--- | :--- | :--- |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L672-L897) | `#L672-L690`, `#L808-L848` | **v2.7.7 P1**：`_resolveCloseDeadline()` 強化 `Number.isFinite` 檢查；`emergencyClose()` 強制要求有效 `deadlineAt` 或 `timeoutMs`，缺失時拋出 `[EMERGENCY_CLOSE_DEADLINE_REQUIRED]`，過期時立即拋出超時，絕不無限等待 |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L203-L468) | `#L203-L299`, `#L306-L468` | `handle()` 與 `handleEmergencyCrash()` 全程傳遞共用絕對 `deadlineAt` 至 `adapter.close()` 與 `adapter.emergencyClose()`，並回傳完整 `nativeClosePending` / `closeTimedOut` 診斷 |
| [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js#L1364-L1913) | `#L46`, `#L84`, `#L98-L105`, `#L1298`, `#L1444`, `#L1532`, `#L1617-L1913` | **v2.7.7 P1 & P2**：擴充 Test 46 Part A 驗證 `emergencyClose()` 五項 Deadline 規則；修正 Test 46 Part B 名稱與註解標明 Callback Error Injection Simulation；保留 Test 42 的 `200ms ~ 255ms` 斷言與全套 46 項測試 |
| [`DEV_PROGRESS.md`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/DEV_PROGRESS.md#L79-L103) | `#L79-L103` | 同步更新至 SQLite Reliability v2.7.7 Final Closure 狀態 |

---

## 6. 46 項測試場景真實執行驗收報告與時間明細

### 6.1 Test 42 / Test 45 / Test 46 時間紀錄與狀態快照拆解

> **重要區分說明**：
> - **Shutdown Elapsed (`durationMs`)**：指 `ShutdownHandler.handle()` 或 `ShutdownHandler.handleEmergencyCrash()` 內部從啟動至因共用 Deadline 到期返回的**實際關機等待耗時**。
> - **Native Callback Delay**：測試透過 `Deferred Promise` 人為扣住 callback 的時間區間（跨越關機超時點，直到後續二次呼叫測試完成後才手動 `release()`）。
> - **Test Case Elapsed**：`node:test` 執行整個 `it(...)` 測試函式的總時間（包含建立臨時 DB、建表、寫入測試資料、Shutdown 等待耗時、超時後的二次呼叫斷言、釋放 Deferred callback 收斂、以及刪除暫存檔的總和）。**絕不可將 Test Case Elapsed 誤認為 Shutdown Elapsed。**

| 測試項目 | 設定之 Deadline 預算 | ShutdownHandler 實際等待耗時 (`Shutdown Elapsed`) | 進入阻塞階段時剩餘預算 | Native Callback / Task 延遲控制方式 | 整個測試案例總耗時 (`Test Case Elapsed`) | Timeout 返回當下之狀態快照 (`getActiveStatus()` / `shutResult`) |
| :--- | :---: | :---: | :---: | :--- | :---: | :--- |
| **Test 42**<br>*(Checkpoint Task Execution Delay Simulation)* | `pm2KillTimeoutMs: 220ms`<br>(`drainTimeoutMs: 120ms`, `drainWaitBufferMs: 80ms`)<br>斷言範圍：`200ms ~ 255ms` | **`221ms`** | `219ms`<br>*(Drain 耗時約 `2ms`)* | 以 `checkpointDeferred` 攔截 `_rawQueryOne` 延遲任務完成，待 Shutdown 超時返回並驗證斷言後才手動釋放 | `247.00ms` | `success: false`, `checkpointTimedOut: true`, `checkpointCompleted: false`, `deadlineExpired: true`, `adapterClosed: false`, `checkpointInProgress: true`, `underlyingExecuting: true`, `schedulerActive: 1`, `isQuiescent: false`, `state: 'READY'` |
| **Test 45**<br>*(Graceful Native Close Callback Delay Simulation)* | `pm2KillTimeoutMs: 220ms`<br>(`drainTimeoutMs: 120ms`, `drainWaitBufferMs: 80ms`)<br>斷言範圍：`200ms ~ 255ms` | **`222ms`** | `218ms`<br>*(Drain + Checkpoint 耗時約 `4ms`)* | 以 `nativeCloseDeferred` 延遲 `db.close(cb)` 回呼，歷經 Shutdown 超時（`222ms`）及二次 `close(25)` / `emergencyClose(null, 25)` 測試（共約 `272ms`）後手動釋放 | `294.92ms` | `success: false`, `checkpointCompleted: true`, `adapterClosed: false`, `nativeClosePending: true`, `closeTimedOut: true`, `deadlineExpired: true`, `isQuiescent: false`, `state: 'CLOSING'`, `db !== null` |
| **Test 46 Part A**<br>*(Emergency Native Close Callback Delay Simulation)* | `emergencyWaitMs: 120ms`<br>斷言範圍：`100ms ~ 165ms` | **`121ms`**<br>*(剩餘預算 `120ms` 進入 `emergencyClose`)* | `120ms`<br>*(已處於靜止，0ms 進入 `emergencyClose`)* | 以 `emergencyCloseDeferred` 延遲 `db.close(cb)` 回呼，歷經 `handleEmergencyCrash` 超時（`121ms`）與 4 次後續呼叫驗證（約 `60ms`）後手動釋放 | `278.88ms`<br>*(含 Part A + Part B 兩座臨時 DB 完整生命週期)* | `success: false`, `adapterClosed: false`, `nativeClosePending: true`, `closeTimedOut: true`, `forcedExit: false`, `isQuiescent: false`, `state: 'CLOSING'`, `db !== null` |
| **Test 46 Part B**<br>*(Callback Error Injection Simulation)* | 直接呼叫 `emergencyClose(null, 30)`：`timeoutMs: 30ms` | **`31ms`** *(Adapter `emergencyClose` 等待耗時)* | `30ms` | 以 `errCloseDeferred` 延遲 `db.close(cb)` 超過 `30ms` 觸發 `NATIVE_CLOSE_TIMEOUT` 後，手動釋放並注入模擬 `SQLITE_BUSY` 錯誤 | *(計入上方 Test 46 總耗時 `278.88ms`)* | **超時當下**：`state: 'CLOSING'`, `nativeClosePending: true`, `closeTimedOut: true`, `adapterClosed: false`<br>**錯誤注入返回後**：`state: 'ERROR'`, `nativeClosePending: false`, `adapterClosed: false`, `lastCloseError: 'Simulated callback error: SQLITE_BUSY...'` |

### 6.2 46 項回歸測試完整摘要
- **語法靜態檢查 (`node --check`)**：於 `src/database/shutdown-handler.js`、`src/database/sqlite.adapter.js`、`src/database/write-queue.js`、`tests/database/sqlite_reliability.test.js` 全數通過（Exit Code 0）。
- **自動化測試指令**：`npm run test:database` (`node --test tests/database/*.test.js`)
- **執行結果**：**46 tests, 46 passed, 0 failed, 0 cancelled, 0 skipped, 總耗時 3435.33ms**。
- **資源與穩定性檢核**：0 個未處理之 Promise rejection、0 次重複 native `db.close()`、0 個遺留之 SQLite handle 或 Timer。

---

## 7. 未解決的物理限制與 Future Improvements

### 7.1 物理與架構限制（Honest Engineering Boundaries）
1. **Caller Timeout $\neq$ Native Close Completed**：JavaScript 計時器超時僅能結束呼叫端等待並保護 Adapter 狀態機，無法強制取消已在 Node.js `sqlite3` C++ addon / libuv 執行緒池中執行的原生 SQLite 操作。
2. **Memory Queue cannot guarantee protection against sudden power loss or SIGKILL**：`WriteQueue` 為純記憶體佇列，若遭遇硬體斷電、OS 崩潰或 `kill -9`，尚未完成 SQLite `COMMIT` 的資料無法保證不遺失。
3. **Callback Error Injection 測試邊界**：Test 46 Part B 透過 Callback Error Injection Simulation 驗證 Adapter 的 `ERROR` 狀態轉移，並未在 C++ 層直接構造未 finalize `sqlite3_stmt` 的原生鎖定。
4. **正式環境 4.5GB 資料庫未實測**：受嚴格安全隔離限制，未對正式環境約 4.5GB 資料庫進行實際壓測。

### 7.2 Future Improvements（非阻斷性後續改善建議，不納入本次修改）
- 若未來升級或替換底層驅動（例如評估同步或具備 statement 枚舉能力之綁定），可考慮在開發環境增設獨立的原生 unfinalized statement 診斷工具。
- 若未來業務對斷電零遺失有硬性需求，可評估在寫入佇列前端引入獨立的本地磁碟預寫佇列（Durable Outbox）。

---

## 8. 最終驗收條件檢核表

| 驗收條件 | 檢核結果 |
| :--- | :---: |
| `emergencyClose()` 強制要求有效 `deadlineAt` 或 `timeoutMs`，缺失時明確拒絕 | **PASS** |
| `emergencyClose()` 在 Deadline 已過期時立即返回超時，不會無限等待 | **PASS** |
| `nativeClosePending` 期間重用 `#nativeClosePromise`，絕不重複呼叫 `db.close()` | **PASS** |
| Test 46 Part B 明確標示為 Callback Error Injection Simulation | **PASS** |
| Test 42、45、46 的實際耗時與狀態快照清楚區分且記錄一致 | **PASS** |
| 全套 46 項測試 100% 通過（46 PASS, 0 FAIL, 0 SKIPPED） | **PASS** |
| 沒有修改 Schema、外部 API 或碰觸正式環境 | **PASS** |

**最終簽核狀態：`v2.7.7 — Final Closure (READY FOR REVIEW)`**
*(註：`READY FOR REVIEW` $\neq$ `READY FOR PRODUCTION`。至此 SQLite Reliability Refactoring 正式收尾結束。)*
