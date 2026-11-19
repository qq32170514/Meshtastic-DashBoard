# Meshtastic-DashBoard 4.1.0 — SQLite Reliability Refactoring 技術實施說明書 (v2.7.6 Native Close Deadline Hardening)

> **文件版本**：v2.7.6 — READY FOR REVIEW (`READY FOR REVIEW` 不等於 `READY FOR PRODUCTION`)
> **更新時間**：2026-11-11
> **適用環境**：`d:\meshtastic\Meshtastic-DashBoard-Dev` (嚴格隔離於開發環境)
> **執行狀態**：已完成 SQLite Reliability v2.7.6 原生關閉（Native Close）共用 Deadline 強固修正（P0-1 Graceful Close 共用單一絕對 Deadline、P0-2 Emergency Close 共用單一絕對 Deadline、P0-3 Close 超時後四類競態狀態保護、Test 42 驗證範圍與耗時誤差收斂、新增 Test 45 與 Test 46），全套 46 項獨立臨時資料庫測試全數通過（**46 passed, 0 failed, 0 skipped**，總耗時 3382.28ms）。Prod 環境與正式約 4.5GB 資料庫維持絕對零接觸。

---

## 目錄
1. [任務目標與不可違反限制](#1-任務目標與不可違反限制)
2. [v2.7.5 殘留問題根因分析](#2-v275-殘留問題根因分析)
3. [v2.7.6 強固修正實作詳解](#3-v276-強固修正實作詳解)
   - 3.1 P0-1: Graceful Close 共用單一絕對 Deadline 與單次 Native Close 保證
   - 3.2 P0-2: Emergency Close 共用單一絕對 Deadline 與安全檢查保留
   - 3.3 P0-3: Close Timeout 後四類競態場景（Case A ~ Case D）狀態保護
   - 3.4 Test 42 驗證範圍澄清與時間斷言收斂
4. [Native Close 狀態機與三態嚴格區分](#4-native-close-狀態機與三態嚴格區分)
5. [修改檔案清單與實際程式碼位置](#5-修改檔案清單與實際程式碼位置)
6. [46 項測試場景真實執行驗收報告](#6-46-項測試場景真實執行驗收報告)
7. [尚未解決的問題與物理限制](#7-尚未解決的問題與物理限制)
8. [最終驗收條件檢核表](#8-最終驗收條件檢核表)

---

## 1.任務目標與不可違反限制

### 1.1 專案與環境紅線
1. **SQLite 驅動與 Schema 凍結**：維持 `sqlite3 ^5.1.6`，不新增、刪除或修改任何資料表、欄位、索引及約束。
2. **外部介面相容**：不改變現有 REST API、Socket.IO、MQTT、RF Tunnel、Turso 架構及前端介面。
3. **開發與正式環境嚴格隔離**：所有修改與測試僅在 `d:\meshtastic\Meshtastic-DashBoard-Dev` 執行；嚴禁修改正式環境目錄（`d:\meshtastic\Meshtastic-DashBoard-Prod`）、嚴禁執行 PM2 restart 或部署操作、嚴禁讀取或測試正式約 4.5GB SQLite 資料庫。
4. **獨立臨時資料庫測試**：所有 46 項測試均使用獨立臨時 SQLite 檔案（`meshtastic_test_*.db`），完整保留 v2.7.5 原有 44 項測試並新增 Test 45、Test 46。

### 1.2 核心可靠性誠實原則
- **Caller Timeout $\neq$ Native Close Completed**：當呼叫端等待 `close()` 或 `emergencyClose()` 達到 Deadline 超時返回時，僅代表 JavaScript 呼叫端結束等待，**不等於**底層 SQLite `db.close(callback)` 已完成，亦**不能**取消已交給 SQLite C++ 層執行的工作。
- **三項關閉狀態嚴格獨立**：`closeTimedOut`、`nativeClosePending` 與 `adapterClosed` 絕對不可混用；特別是 `closeTimedOut === true` 時，若原生 callback 尚未返回，`adapterClosed` 必須維持 `false` 且 `nativeClosePending` 必須為 `true`。
- **Native `db.close(callback)` 單次呼叫保證**：一旦對底層 `sqlite3.Database` 實例呼叫過 `db.close(callback)`，無論後續是否發生呼叫端超時、重複呼叫 `close()` 或交錯呼叫 `emergencyClose()`，**絕對不得**再次呼叫第二次 `db.close()`。
- **未完成前禁止清除追蹤或重用連線**：在 `db.close(callback)` 真正返回前，不得提前將 Adapter 標記為 `CLOSED`、不得提前將 `this.db` 設為 `null`，且必須拒絕任何新 Query、Transaction 或直接 `_raw*` 操作重用該連線。

---

## 2. v2.7.5 殘留問題根因分析

### 2.1 Graceful Close 中 `_rawClose()` 缺乏 Deadline 約束
在 v2.7.5 中，`SQLiteAdapter.close(timeoutMs)` 僅將 `timeoutMs` 用於等待 `this._schedulerQueue` 清空；一旦 `this.isQuiescent()` 成立並進入 `await this._rawClose()`，便直接等待 `this.db.close(callback)`，沒有任何 Deadline 約束。若底層 `db.close(callback)` 的 callback 遲遲未返回，整個 Graceful Shutdown 仍會無限期卡住。

### 2.2 Emergency Close 缺乏 Native Close Deadline 約束
在 v2.7.5 中，`ShutdownHandler.handleEmergencyCrash()` 雖以 `waitDeadline` 限制等待 `_canSafelyEmergencyClose()` 的輪詢時間，但進入 `await this.#adapter.emergencyClose(...)` 後，底層 `_rawClose()` 同樣無時間上限，若 `db.close(callback)` 未返回仍會導致緊急關機流程無限等待。

### 2.3 重複呼叫可能觸發二次 `db.close()`
在 v2.7.5 中，`_rawClose()` 每次被呼叫都會直接執行 `this.db.close(...)`，未將進行中的原生關閉封裝為單一可重用的 `#nativeClosePromise`。若呼叫端在超時後再次呼叫 `close()` 或 `emergencyClose()`，可能對同一個 `sqlite3.Database` 實例重複呼叫 `db.close()`。

---

## 3. v2.7.6 強固修正實作詳解

### 3.1 P0-1: Graceful Close 共用單一絕對 Deadline 與單次 Native Close 保證
- **修改檔案**：
  - [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L672-L898)
  - [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L203-L299)
- **修正重點**：
  1. **統一解析絕對 `deadlineAt` (`_resolveCloseDeadline(options)`)**：
     - `close(options)` 支援傳入毫秒數 `timeoutMs` 或物件 `{ timeoutMs, deadlineAt }`。若僅傳入 `timeoutMs`，於入口立即轉換為單一絕對時間 `deadlineAt = Date.now() + timeoutMs`；若由 `ShutdownHandler.handle()` 呼叫，則直接傳入 `{ timeoutMs: remainingForClose, deadlineAt: shutdownDeadlineAt }`。
     - Scheduler 等待與 `_awaitNativeCloseWithDeadline(deadlineAt)` 全程共用同一個 `deadlineAt`，不重新分配時間預算。
  2. **單一 In-Flight `#nativeClosePromise` 管理 (`_rawClose()`)**：
     - 當 `_rawClose()` 首次通過底層無在途操作檢查並呼叫 `dbToClose.close(callback)` 時，立即設定 `this.#nativeClosePending = true`、`this.state = ADAPTER_STATES.CLOSING`、`this.#acceptingNewTasks = false`，並建立唯一的 `this.#nativeClosePromise`。
     - 在 callback 尚未返回期間，`this.db` 保持非 `null` 以維持底層 handle 追蹤，同時 `_schedule()`、`_rawExecute()`、`_rawQuery()`、`_rawQueryOne()` 均檢查 `this.#nativeClosePending`，立即拒絕任何新資料庫操作（`[ADAPTER_CLOSING_NATIVE_PENDING]` / `[DB_CLOSING_NATIVE_PENDING]`）。
  3. **有界等待原生 Callback (`_awaitNativeCloseWithDeadline(deadlineAt)`)**：
     - 以剩餘時間 `remainingMs = deadlineAt - Date.now()` 對 `this.#nativeClosePromise` 進行有界等待。
     - 若到達 `deadlineAt` 時 callback 尚未返回：設定 `this.#closeTimedOut = true`，拋出 `[CLOSE_TIMEOUT] [NATIVE_CLOSE_TIMEOUT]` 結束呼叫端等待；此時 Adapter 維持 `ADAPTER_STATES.CLOSING`、`#nativeClosePending === true`、`adapterClosed === false`。

### 3.2 P0-2: Emergency Close 共用單一絕對 Deadline 與安全檢查保留
- **修改檔案**：
  - [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L306-L468)
  - [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L809-L849)
- **修正重點**：
  1. **保留全部 7 項安全准入條件**：`_canSafelyEmergencyClose()` 完整保留對 Adapter Quiescent、Queue `inFlightCount === 0`、`!flushWorkerActive`、`schedulerPending === 0`、`schedulerActive === 0`、`activeTransactions === 0`、無底層執行與無 Maintenance / Checkpoint 的檢查。
  2. **全程共用 `emergencyDeadlineAt`**：`handleEmergencyCrash()` 於啟動時建立 `emergencyDeadlineAt = Date.now() + emergencyBudgetMs`，同時約束靜止等待迴圈與 `this.#adapter.emergencyClose(queueSafetyState, { timeoutMs: remainingForEmergencyClose, deadlineAt: emergencyDeadlineAt })`。
  3. **誠實回報超時與 Pending 狀態**：若 `db.close(callback)` 未在 `emergencyDeadlineAt` 內返回，回傳 `success: false`、`adapterClosed: false`、`nativeClosePending: true`、`closeTimedOut: true`，並於 `diagnostics` 保留完整狀態快照。

### 3.3 P0-3: Close Timeout 後四類競態場景（Case A ~ Case D）狀態保護
1. **Case A（Close Timeout 後再次呼叫 Close）**：
   - 第一次 `close()` 因 `NATIVE_CLOSE_TIMEOUT` 拋錯時，`finally` 區塊在 `this.state !== ADAPTER_STATES.CLOSED` 時清除 `this._closePromise = null`，但保留 `this.#nativeClosePromise` 與 `this.#nativeClosePending = true`。
   - 第二次呼叫 `close()` 或 `emergencyClose()` 時，偵測到 `this.#nativeClosePending === true`（且 `_rawClose()` 直接回傳既有的 `this.#nativeClosePromise`），因此**絕對不會呼叫第二次 `db.close()`**，而是直接重用既有 `#nativeClosePromise` 進行等待。
2. **Case B（Close Timeout 後 Native Callback 才成功返回）**：
   - 呼叫端超時後 Adapter 保持 `CLOSING` 與 `nativeClosePending: true`。
   - 當底層 `db.close(callback)` 稍後成功觸發（`err === null`）時，`settled` 保護鎖確保只結算一次，並將 `this.#nativeClosePending = false`、`this.#closeTimedOut = false`、`this.db = null`、`this.state = ADAPTER_STATES.CLOSED` 正確更新到位。
3. **Case C（Close Callback 回傳錯誤）**：
   - 若 `db.close(callback)` 回傳 `err`，將 `this.#nativeClosePending = false`、記錄 `this.lastCloseError = err` 與 `this.lastError = err`，並將狀態轉為 `ADAPTER_STATES.ERROR`（`adapterClosed` 為 `false`，絕不標記為 `CLOSED`），同時禁止任何後續資料庫操作。
4. **Case D（Graceful 與 Emergency Close 交錯）**：
   - 當 Graceful Close 已啟動原生 `db.close()`（`nativeClosePending === true`）而 Emergency Shutdown 隨後觸發時，`handleEmergencyCrash()` 透過 `safeToJoinExistingNativeClose` 與 `emergencyClose()` 共用同一個 `#nativeClosePromise`，不重複呼叫 `db.close()`、不提前清空 `this.db = null`，亦不會發生 Promise 重複結算。

### 3.4 Test 42 驗證範圍澄清與時間斷言收斂
- **驗證範圍說明**：Test 42 透過攔截 `db.adapter._rawQueryOne` 並在呼叫 `origRawQueryOne` 前等待 Deferred Promise，屬於 **Checkpoint Task Execution Delay Simulation**（模擬 Checkpoint 任務在 Adapter 執行層 / Scheduler 內的耗時等待，以驗證 `ShutdownHandler` 與 `SQLiteAdapter` 的共用 Deadline 及禁止 `_rawClose()` 保護），而非直接阻塞 SQLite C++ 原生 worker thread。
- **時間斷言收斂**：將 Test 42 對 `pm2KillTimeoutMs: 220` 的耗時斷言由原本過寬的 `170ms ~ 320ms` 收緊為合理的計時器誤差範圍 `200ms ~ 255ms`（`ShutdownHandler` 內部實測耗時約 `226ms`，`node:test` 包含前後建立與清理的測試案例總耗時約 `251ms`）。

---

## 4. Native Close 狀態機與三態嚴格區分

| 狀態情境 | `adapter.state` | `closeTimedOut` | `nativeClosePending` | `adapterClosed` | `adapter.db` | 允許新 DB 操作 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **正常運行中** | `READY` | `false` | `false` | `false` | `Database` 實例 | 是 |
| **Scheduler 等待超時（未進入 `_rawClose`）** | `CLOSING` | `true` | `false` | `false` | `Database` 實例 | 否 |
| **已呼叫 `db.close(cb)`，等待 Callback 中** | `CLOSING` | `false` | `true` | `false` | `Database` 實例 | 否 |
| **已呼叫 `db.close(cb)`，呼叫端等待超時（Callback 未返回）** | `CLOSING` | `true` | `true` | `false` | `Database` 實例 | 否 |
| **Callback 稍後成功返回（`err === null`）** | `CLOSED` | `false` | `false` | `true` | `null` | 否 |
| **Callback 回傳錯誤（`err !== null`）** | `ERROR` | `true` / `false` | `false` | `false` | `Database` 實例 (封鎖) | 否 |

---

## 5. 修改檔案清單與實際程式碼位置

| 檔案路徑 | 修改位置 (行號範圍) | 修正項目與職責說明 |
| :--- | :--- | :--- |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L47-L78) | `#L47-L78`, `#L131-L169` | 新增 `#nativeClosePromise`、`#nativeClosePending`、`#closeTimedOut`、`this.lastCloseError`；更新 `isQuiescent()` 與 `getActiveStatus()` 輸出 `nativeClosePending`、`closeTimedOut`、`adapterClosed`、`lastCloseError` |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L355-L470) | `#L355-L470` | 於 `_schedule()`、`_rawExecute()`、`_rawQuery()`、`_rawQueryOne()` 強制攔截 `#nativeClosePending`，禁止在原生關閉期間排入或執行任何操作 |
| [`src/database/sqlite.adapter.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/sqlite.adapter.js#L672-L898) | `#L672-L898` | 新增 `_resolveCloseDeadline()` 與 `_awaitNativeCloseWithDeadline()`；重構 `close()`、`emergencyClose()` 與 `_rawClose()`，確保單一絕對 Deadline 約束與 `db.close()` 單次呼叫保證 |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L84-L90) | `#L84-L90`, `#L203-L299` | `handle()` 將 `{ timeoutMs: remainingForClose, deadlineAt: shutdownDeadlineAt }` 傳入 `adapter.close()`，並於回傳結果與 `diagnostics` 明確區分 `adapterClosed`、`nativeClosePending` 與 `closeTimedOut` |
| [`src/database/shutdown-handler.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/database/shutdown-handler.js#L306-L468) | `#L306-L468` | `handleEmergencyCrash()` 建立單一 `emergencyDeadlineAt` 共用約束靜止等待與 `emergencyClose()`，支援 Case D 交錯安全等待並回傳完整 `nativeClosePending` / `closeTimedOut` 診斷 |
| [`tests/database/sqlite_reliability.test.js`](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/tests/database/sqlite_reliability.test.js#L1364-L1869) | `#L46`, `#L1364-L1415`, `#L1612-L1869` | 修正 Test 42 命名註解與耗時斷言（`200ms ~ 255ms`）；新增 Group I（Test 45、Test 46），共 **46 項測試** |

---

## 6. 46 項測試場景真實執行驗收報告

- **語法靜態檢查**：`node --check` 於 `src/database/shutdown-handler.js`、`src/database/sqlite.adapter.js`、`src/database/write-queue.js`、`tests/database/sqlite_reliability.test.js` 全數通過（Exit Code 0）。
- **自動化測試指令**：`npm run test:database` (`node --test tests/database/*.test.js`)
- **測試結果摘要**：**46 tests, 46 passed, 0 failed, 0 cancelled, 0 skipped, 總耗時 3382.28ms**。

### Group A ~ Group H (Tests 1 ~ 44 回歸驗證結果)
- **Test 1 ~ Test 44**：**44 / 44 全數 PASS**。其中 Test 42 以收斂後之 `200ms <= elapsed <= 255ms` 斷言通過（`ShutdownHandler` 實測耗時 `226ms`，測試案例總耗時 `251.28ms`）。

### Group I: v2.7.6 Native Close Deadline Hardening (Tests 45 ~ 46)
| 編號 | 測試案例名稱 | 驗證重點 | 耗時 | 結果 |
| :---: | :--- | :--- | :---: | :---: |
| **45** | **Native Close Callback Deadline — Native Close Callback Delay Simulation (v2.7.6 P0-1 & P0-3)** | 1. Graceful Shutdown 完成 Drain 與 Checkpoint 後進入 Close<br>2. 以 Deferred 延遲 `db.close(callback)`（Native Close Callback Delay Simulation）<br>3. 驗證 `db.close()` 僅被呼叫 1 次，且呼叫端等待於共用 Deadline（220ms，實測 227ms）內結束<br>4. 超時當下 `adapterClosed === false`、`nativeClosePending === true`、`closeTimedOut === true`、`db.adapter.db !== null`<br>5. 拒絕新 `execute`/`query`/`transaction`/`_rawQueryOne`<br>6. 再次呼叫 `close()` 與 `emergencyClose()`（Case A & D）不重複呼叫 `db.close()`<br>7. 釋放 Deferred callback 後（Case B），Adapter 轉為 `CLOSED`、`nativeClosePending === false`、`db === null`，且重複 callback 不造成二次結算 | 297.22ms | **PASS** |
| **46** | **Emergency Native Close Callback Deadline 與錯誤狀態轉移驗證 (v2.7.6 P0-2 & P0-3)** | **Part A**：<br>1. `handleEmergencyCrash` 在 `db.close(callback)` 延遲時受 `emergencyWaitMs: 120` 約束準時返回<br>2. `db.close()` 僅呼叫 1 次；超時回報 `adapterClosed === false`、`nativeClosePending === true`、`closeTimedOut === true`<br>3. 後續 `emergencyClose()` / `close()` 不重複呼叫 `db.close()`，且禁止重用連線<br>4. Callback 成功返回後轉為 `CLOSED`、`db === null`<br>**Part B (Case C)**：<br>5. 當延遲的 `db.close(callback)` 回傳 `SQLITE_BUSY` 錯誤時，Adapter 轉為 `ERROR`（絕不標記為 `CLOSED`），保留 `lastCloseError` 並拒絕後續操作 | 248.81ms | **PASS** |

---

## 7. 尚未解決的問題與物理限制

依據工程誠實原則，如實宣告以下物理限制與測試模擬邊界：
1. **JavaScript Timeout 無法取消已在執行的 SQLite Native 操作**：當 `close()`、`emergencyClose()`、`checkpoint()` 或 `drain()` 因 Deadline 到期返回超時錯誤時，僅代表 JS 呼叫端停止等待並保護狀態機；已經交給 Node.js `sqlite3` C++ addon / libuv worker thread 執行的底層 SQLite C API 操作無法由 JS 強制取消。
2. **測試採用 Callback / Task Delay Simulation 的工程邊界**：在單元測試環境中，無法在不損壞跨平台測試穩定性的前提下直接強制掛死 C++ 原生 `sqlite3_close()` 執行緒，因此 Test 42 採用 Adapter Task Execution Delay Simulation、Test 45 與 Test 46 採用 Native Close Callback Delay Simulation（攔截並延遲 `db.close` callback 回傳給 Adapter 的時機），精確驗證 Adapter 與 ShutdownHandler 的 Deadline 控制、單次呼叫保證與狀態機不變量。
3. **記憶體佇列無法抵禦斷電與 `SIGKILL`**：`WriteQueue` 為純記憶體佇列，若發生硬體斷電、OS 崩潰或 `kill -9`，所有尚未完成 SQLite `COMMIT` 的未提交資料將會遺失。
4. **正式環境 4.5GB 資料庫未實測**：受嚴格安全隔離限制，未對正式環境約 4.5GB 資料庫進行實際壓測。

---

## 8. 最終驗收條件檢核表

| 驗收條件 | 檢核結果 |
| :--- | :---: |
| Graceful `close()` 同時限制 Scheduler 等待與 Native `db.close(cb)` 等待時間 | **PASS** |
| Emergency `emergencyClose()` 受到共用 `emergencyDeadlineAt` 時間限制 | **PASS** |
| Native `db.close(callback)` 絕對不會被重複呼叫第二次 | **PASS** |
| 明確區分 `closeTimedOut`、`nativeClosePending`、`adapterClosed` 三種狀態 | **PASS** |
| Close Timeout 後正確處理 Case A / B / C / D 四類競態場景 | **PASS** |
| Test 42 命名註解與耗時斷言（`200ms ~ 255ms`）修正完成 | **PASS** |
| Test 45、Test 46 新增並真實執行通過 | **PASS** |
| v2.7.5 原有 44 項測試全部保留且通過（共 46 / 46 PASS） | **PASS** |
| 沒有修改 Schema、外部 API 或碰觸正式環境 | **PASS** |

**最終簽核狀態：`v2.7.6 — READY FOR REVIEW`**
*(註：`READY FOR REVIEW` 僅代表開發環境程式碼與隔離驗證完成，不等於 `READY FOR PRODUCTION`。)*
