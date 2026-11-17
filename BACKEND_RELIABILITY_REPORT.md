# Meshtastic-DashBoard 4.0.3.1 — Backend Reliability & API Correctness Report

**Status**: `READY FOR PRODUCTION REVIEW`  
**Baseline**: `Meshtastic-DashBoard 4.0.3` (`develop` @ `a0c97a8`)  
**Environment**: `D:\meshtastic\Meshtastic-DashBoard-Dev` (Node `v24.16.0`, npm `11.13.0`, Production untouched)

---

## 1. Executive Summary

Meshtastic-DashBoard **4.0.3.1** addresses four backend/API reliability and correctness issues while preserving all **4.0.2** SQLite reliability/transaction/backup modules and **4.0.3** frontend performance & Leaflet lazy-loading optimizations:

1. **P1 — API Cache Key Correctness** (`src/utils/api-cache.js`, `index.js`)
2. **P1 — Coverage Rebuild Admin Authorization, Single-Flight Controller & Atomic Output** (`src/utils/coverage-controller.js`, `index.js`, `rf-engine/bake.mjs`, `.env.example`)
3. **P2 — Hop Distribution vs. Hop Analysis Route Conflict** (`index.js`, `frontend/src/NetworkAnalytics.tsx`)
4. **P2 / P3 — Analytics Bundle Bounded Concurrency & Frontend API Cache** (`src/utils/analytics-bundle.js`, `index.js`, `frontend/src/apiCache.ts`)

**Explicitly Excluded**: RF Tunnel TCP (`setupRFListener`) was left completely untouched per scope rules.

---

## 2. Detailed Changes

### 2.1 P1 — API Cache Key Correctness (`src/utils/api-cache.js`, `index.js`)
- **Problem**: `normalizeCacheKey(req)` previously filtered query parameters through a static 9-key whitelist (`limit`, `page`, `range`, `days`, `node_id`, `portnum`, `gateway_id`, `exclude_tunnel`, `cursor`), silently dropping `sender`, `node_ids`, `timeStart`, `timeEnd`, `minSnr`, `minRssi`, and any other query parameter, causing cross-query cache collisions.
- **Fix**:
  - Extracted `BoundedLRUCache`, `normalizeCacheKey(req)`, and `createWithCache(apiCache)` into [api-cache.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/api-cache.js).
  - Canonicalizes `<METHOD>:<normalizedPath>?<sortedQuery>` across **all** query parameters (preserving multi-value keys, URL-encoded values, empty values, and unknown parameters while canonicalizing parameter/value order and trailing slashes).
  - Updated `BoundedLRUCache.clearPrefix(prefix)` to strip any `METHOD:` prefix so `invalidatePacketCache()` continues to invalidate `/api/packets`, `/api/node/`, and `/api/coverage` entries.

### 2.2 P1 — Coverage Rebuild Authorization & Job Controller (`src/utils/coverage-controller.js`, `rf-engine/bake.mjs`, `index.js`)
- **Problem**: `POST /api/coverage/rebuild` had no admin authorization, used `child_process.exec` without concurrency control, could overlap with the `0 4 * * *` cron job, and wrote output files directly in place.
- **Fix**:
  - Added `createRequireCoverageAdmin()` in [coverage-controller.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/src/utils/coverage-controller.js): default-deny (`503`) when `COVERAGE_ADMIN_TOKEN` / `ADMIN_API_TOKEN` is unset, `401` when missing, `403` when invalid, using SHA-256 + `crypto.timingSafeEqual` on `Authorization: Bearer <token>` or `X-Admin-Token`.
  - Added `CoverageJobController` shared by `POST /api/coverage/rebuild` (`202 Accepted` / `409 Conflict` when busy), `GET /api/coverage/status`, and the `0 4 * * *` cron job.
  - Uses `spawn(process.execPath, [bakeScriptPath, String(safeLimit)], { shell: false })` with bounded limit validation (`1..1000`), cross-process lock file (`public/coverage/.coverage_bake.lock`) with stale-PID reclamation, stdout/stderr tail capture, and `SIGTERM`/`SIGKILL` timeout cleanup.
  - Updated [bake.mjs](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/rf-engine/bake.mjs) to write PNG/JSON to `.tmp.<pid>.<ts>` staging files and atomically `renameSync` into place, plus optional `COVERAGE_OUTPUT_DIR` override for isolated testing.

### 2.3 P2 — Hop Distribution & Hop Analysis Route Separation (`index.js`, `frontend/src/NetworkAnalytics.tsx`)
- **Problem**: Two `GET /api/analytics/hop-distribution` handlers existed in `index.js`, shadowing the Hop Analysis diagnostic endpoint.
- **Fix**:
  - Kept `GET /api/analytics/hop-distribution` for the range-filtered hop count distribution array.
  - Moved the hop diagnostic payload to `GET /api/analytics/hop-analysis` in [index.js](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/index.js).
  - Updated `/api/analytics/bundle` and [NetworkAnalytics.tsx](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/NetworkAnalytics.tsx) fallback to call `/api/analytics/hop-analysis`.

### 2.4 P2 / P3 — Analytics Bundle & Frontend API Cache (`src/utils/analytics-bundle.js`, `frontend/src/apiCache.ts`)
- **Analytics Bundle**: Replaced the 23-endpoint sequential `for...of` loop in `/api/analytics/bundle` with `buildAnalyticsBundle` (`concurrency = 4`), tracking `_meta.partialFailure` and `_meta.failedEndpoints`, using a 15-second TTL for partial bundles instead of 10 minutes, and returning `502` (or stale cache fallback) if all sub-endpoints fail.
- **Frontend API Cache**: Updated [apiCache.ts](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/frontend/src/apiCache.ts) with bounded `MAX_CACHE_ENTRIES = 100` LRU eviction, `pruneExpiredApiCache()`, and subscriber ref-counted `AbortController` passed to `fetch(url, { signal })` so one caller aborting does not cancel other active subscribers, while aborting all subscribers cancels the underlying `fetch`.

---

## 3. Verification Results

Full test output is archived at [4.0.3.1-test.log](file:///d:/meshtastic/Meshtastic-DashBoard-Dev/artifacts/test-results/4.0.3.1-test.log).

| Check | Command | Result |
| --- | --- | --- |
| Phase 1–4 API & Cache Suite | `node --test tests/api/*.test.js` | **11/11 passed** (`0` failed) |
| Database Reliability Suite | `npm run test:database` | **108/108 passed** across 3 suites (`0` failed) |
| Backend Syntax Check | `node -c index.js` | Passed (`exit 0`) |
| Frontend Production Build | `npm --prefix frontend run build` | Passed (`3403 modules`, `14.48s`) |

