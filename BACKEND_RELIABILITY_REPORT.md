# Meshtastic-DashBoard 4.0.3.2 — Backend Reliability & Safety Report

**Status**: `READY FOR PRODUCTION REVIEW`  
**Baseline**: `Meshtastic-DashBoard 4.0.3.1` (`develop` @ `7afa727`)  
**Environment**: `D:\meshtastic\Meshtastic-DashBoard-Dev` (Node `v24.16.0`, npm `11.13.0`, Production untouched)

---

## 1. Executive Summary

Meshtastic-DashBoard **4.0.3.2** resolves the four reliability, output consistency, information-disclosure, and analytics staleness issues identified in the 4.0.3.1 review, along with Hop Analysis SQL error handling and API Cache repeated-parameter ordering semantics:

1. **P1 — Coverage Job Cross-Process Locking & Crash Recovery** (`src/utils/coverage-lock.js`, `src/utils/coverage-runner.js`, `src/utils/coverage-controller.js`)
2. **P1 — Coverage PNG / JSON Generation & Manifest Atomic Consistency** (`src/utils/coverage-storage.js`, `rf-engine/bake.mjs`, `index.js`)
3. **P2 — Coverage Status API Information Isolation** (`src/utils/coverage-controller.js`, `index.js`)
4. **P2 — Analytics Bundle Maximum Stale Age & Hop Analysis SQL Error Handling** (`src/utils/analytics-bundle.js`, `src/utils/hop-analysis.js`, `index.js`)
5. **P3 — API Cache Repeated Query Parameter Ordering Semantics** (`src/utils/api-cache.js`)

**Explicitly Excluded**: RF Tunnel TCP (`setupRFListener`), SQLite Reliability v2.7.7 core, 4.0.2 Packet Transaction, 4.0.3 Frontend Virtualization / Leaflet Lazy Loading.

---

## 2. Architecture & Design Details

### 2.1 Coverage Cross-Process Lock & Dedicated Runner
- **Atomic Lock Directory**: Uses `fs.mkdirSync(lockDirPath)` (atomic on Windows NTFS & POSIX) containing `owner.json` (`jobId`, `ownerToken`, `hostname`, `serverPid`, `runnerPid`, `bakePid`, `trigger`, `limit`, `state`, `createdAt`, `startedAt`, `heartbeatAt`, `maxDurationMs`).
- **Dedicated Runner Supervision**: `CoverageJobController` spawns [coverage-runner.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/coverage-runner.js) (`detached: true`, `stdio: 'ignore'`), which spawns `rf-engine/bake.mjs`, records `runnerPid` and `bakePid`, and updates `heartbeatAt` on interval.
  - **Scenario A (Server killed while Runner+Bake alive)**: Runner continues updating `heartbeatAt`; any restarted Server inspects `heartbeatAt`, `runnerPid`, and `bakePid` and refuses to steal the lock.
  - **Scenario B/E (Dead processes & concurrent stale recovery)**: `acquireCoverageLock` atomically renames the stale directory (`fs.renameSync(lockDirPath, reclaimPath)`) so at most one racing process can win recovery.
  - **Scenario D (Corrupted metadata)**: Fail-closed (`lock_corrupted`); never unlinks `owner.json` automatically.
  - **Owner-verified release**: `releaseCoverageLock` verifies both `jobId` and constant-time `ownerToken` before removing the lock.
  - **Process tree cleanup**: `killProcessTree` uses `taskkill /PID <pid> /T /F` (with `SIGKILL` fallback) on Windows and process-group `-pid` `SIGTERM`/`SIGKILL` on POSIX, verifying `!isPidAlive(bakePid)` before releasing the lock.

### 2.2 Coverage Generation / Manifest Output Consistency
- Implemented in [coverage-storage.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/coverage-storage.js) and integrated into [bake.mjs](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/rf-engine/bake.mjs) and [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js):
  - Layout: `generations/<generationId>/taiwan_coverage.{png,json}` + `current.json` manifest.
  - Staging directory `.staging-<generationId>` validates PNG signature (`\x89PNG\r\n\x1a\n`) and JSON `generationId` match before renaming to `generations/<generationId>` and atomically replacing `current.json`.
  - Both `public/coverage` and `frontend/public/coverage` receive the same `generationId`.
  - Express `GET /coverage/taiwan_coverage.png`, `GET /coverage/taiwan_coverage.json`, and `GET /api/coverage/itm-info` resolve through `resolveCurrentCoverage()` so partial/mismatched generations are never served.

### 2.3 Coverage Status API Isolation
- **Public (`GET /api/coverage/status`)**:
  ```json
  {
    "running": false,
    "status": "COMPLETED",
    "startedAt": "2026-11-19T06:00:00.000Z",
    "finishedAt": "2026-11-19T06:01:12.000Z",
    "durationMs": 72000,
    "activeJob": null,
    "lastJob": { "jobId": "...", "trigger": "manual", "limit": 500, "status": "completed", "startedAt": "...", "finishedAt": "...", "durationMs": 72000 }
  }
  ```
  Strictly excludes `stdout`, `stderr`, stack traces, local DB/lock file paths, tokens, and PIDs.
- **Admin (`GET /api/coverage/diagnostics`)**: Protected by `requireCoverageAdmin` (`Authorization: Bearer` / `X-Admin-Token`) and redacts local filesystem paths & Bearer tokens.

### 2.4 Analytics Maximum Stale Age & Hop Analysis SQL Error Handling
- **Analytics Bundle** ([analytics-bundle.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/analytics-bundle.js)):
  - `DEFAULT_TTL_MS = 10 * 60 * 1000` (10 min), `DEFAULT_PARTIAL_TTL_MS = 15 * 1000` (15 sec), `DEFAULT_MAX_STALE_AGE_MS = 30 * 60 * 1000` (30 min).
  - If all sub-endpoints fail within `maxStaleAgeMs`: returns HTTP `200` with `X-Bundle-Stale: 1`, `X-Bundle-Stale-Age-Ms`, and a cloned payload with `_meta.staleFallback = true` (never mutating the cached object).
  - If all sub-endpoints fail beyond `maxStaleAgeMs` (e.g. 24h): evicts stale entry and returns HTTP `503` (`staleExpired: true`).
  - Partial failure results never overwrite a valid complete cache within `maxStaleAgeMs`.
- **Hop Analysis** ([hop-analysis.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/hop-analysis.js)):
  - Checks both `sqlActual` and `sqlConfigured` errors with a single-callback guard; any SQL failure returns HTTP `500` instead of a false `"✅ 網路診斷良好"` payload.

### 2.5 API Cache Repeated Query Parameter Semantics
- `normalizeCacheKey(req)` in [api-cache.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/api-cache.js) preserves repeated-parameter value order by default (`?sort=timestamp&sort=snr` !== `?sort=snr&sort=timestamp`), only sorting values for confirmed set-type parameters (`node_ids`).

---

## 3. Verification Summary

Full log: [4.0.3.2-test.log](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/artifacts/test-results/4.0.3.2-test.log)

| Suite | Command | PASS | FAIL | BLOCKED | NOT TESTED | SKIPPED |
| --- | --- | --- | --- | --- | --- | --- |
| API, Cross-Process Lock, Storage, Analytics & Cache | `node --test tests/api/*.test.js` | 22 | 0 | 0 | 0 | 0 |
| Database Reliability (4.0.2 / 4.0.3.1) | `npm run test:database` | 108 | 0 | 0 | 0 | 0 |
| Backend Syntax & Frontend Build | `node -c index.js` & `npm --prefix frontend run build` | 2 | 0 | 0 | 0 | 0 |
| **Total** | | **132** | **0** | **0** | **0** | **0** |

**Known Residual Notes**:
- Pre-existing `current.json` will be generated on the first `bake.mjs` run; until then `resolveCurrentCoverage()` safely serves existing legacy `public/coverage/taiwan_coverage.{png,json}` files.
