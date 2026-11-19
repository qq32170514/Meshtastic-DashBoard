const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
    safeTokenEqual,
    acquireCoverageLock,
    releaseCoverageLock,
    evaluateLockState
} = require('./coverage-lock');

/**
 * Extract admin token from Authorization: Bearer <token> or X-Admin-Token header.
 */
function extractAdminToken(req) {
    const authHeader = typeof req.get === 'function'
        ? req.get('authorization')
        : (req.headers && req.headers.authorization);
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    const headerToken = typeof req.get === 'function'
        ? req.get('x-admin-token')
        : (req.headers && req.headers['x-admin-token']);
    if (typeof headerToken === 'string') {
        return headerToken.trim();
    }
    return '';
}

/**
 * Express middleware enforcing real admin authorization for Coverage Rebuild & Diagnostics.
 * Default-deny: if no admin token is configured, returns 503 rather than allowing unauthenticated access.
 */
function createRequireCoverageAdmin(getExpectedToken = () => process.env.COVERAGE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '') {
    return function requireCoverageAdmin(req, res, next) {
        const expected = String(getExpectedToken() || '').trim();
        if (!expected) {
            return res.status(503).json({
                error: 'Coverage admin endpoint is disabled: admin token is not configured'
            });
        }

        const provided = extractAdminToken(req);
        if (!provided) {
            return res.status(401).json({
                error: 'Admin authorization required'
            });
        }

        if (!safeTokenEqual(provided, expected)) {
            return res.status(403).json({
                error: 'Invalid admin authorization'
            });
        }

        return next();
    };
}

function redactPathsAndSecrets(text) {
    if (!text) return '';
    return String(text)
        .replace(/[A-Za-z]:\\[^\s'"]+/g, '<REDACTED_PATH>')
        .replace(/\/(?:Users|home|var|tmp|opt|srv|etc|app)[^\s'"]+/g, '<REDACTED_PATH>')
        .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<REDACTED>');
}

function toPublicJobSummary(job) {
    if (!job) return null;
    return {
        jobId: job.jobId,
        trigger: job.trigger,
        limit: job.limit,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        durationMs: job.durationMs ?? null
    };
}

/**
 * Unified cross-process controller for manual and scheduled ITM coverage baking.
 */
class CoverageJobController {
    constructor(options = {}) {
        this.bakeScriptPath = options.bakeScriptPath || path.join(__dirname, '../../rf-engine/bake.mjs');
        this.runnerScriptPath = options.runnerScriptPath || path.join(__dirname, 'coverage-runner.js');
        this.lockDirPath = options.lockDirPath || options.lockFilePath || path.join(__dirname, '../../public/coverage/.coverage_bake.lockdir');
        this.defaultTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
        this.heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : 1000;
        this.heartbeatGraceMs = Number.isFinite(options.heartbeatGraceMs) ? options.heartbeatGraceMs : 15000;
        this.defaultLimit = Number.isFinite(options.defaultLimit) ? options.defaultLimit : 500;
        this.spawnFn = options.spawnFn || spawn;
        this.envOverrides = options.envOverrides || {};

        this.activeJob = null;
        this.activeChild = null;
        this.lastJob = null;
        this.lastDiagnostics = null;
    }

    _sanitizeLimit(rawLimit) {
        if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
            return this.defaultLimit;
        }
        const parsed = Number.parseInt(String(rawLimit), 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) {
            return null;
        }
        return parsed;
    }

    /**
     * Public status API payload — strictly excludes stdout, stderr, stack traces, paths, tokens, and PIDs.
     */
    getStatus() {
        const lockState = !this.activeJob ? evaluateLockState(this.lockDirPath, {
            heartbeatGraceMs: this.heartbeatGraceMs
        }) : { exists: false };

        const externalRunning = Boolean(
            !this.activeJob &&
            lockState.exists &&
            !lockState.reclaimable &&
            ['active_heartbeat', 'active_process', 'initializing', 'server_starting_runner', 'locked_on_other_host'].includes(lockState.reason)
        );

        const running = Boolean(this.activeJob) || externalRunning;
        const activeSummary = this.activeJob
            ? toPublicJobSummary(this.activeJob)
            : (externalRunning && lockState.meta ? {
                jobId: lockState.meta.jobId,
                trigger: lockState.meta.trigger,
                limit: lockState.meta.limit ?? null,
                status: 'running',
                startedAt: lockState.meta.startedAt,
                finishedAt: null,
                durationMs: null
            } : null);

        const lastSummary = toPublicJobSummary(this.lastJob);
        const topStatus = running
            ? 'RUNNING'
            : (lastSummary ? String(lastSummary.status || 'IDLE').toUpperCase() : 'IDLE');

        return {
            running,
            status: topStatus,
            startedAt: activeSummary ? activeSummary.startedAt : (lastSummary ? lastSummary.startedAt : null),
            finishedAt: activeSummary ? null : (lastSummary ? lastSummary.finishedAt : null),
            durationMs: activeSummary ? null : (lastSummary ? lastSummary.durationMs : null),
            activeJob: activeSummary,
            lastJob: lastSummary
        };
    }

    /**
     * Admin-only diagnostics with redacted paths/secrets.
     */
    getAdminDiagnostics() {
        return {
            publicStatus: this.getStatus(),
            lastDiagnostics: this.lastDiagnostics ? { ...this.lastDiagnostics } : null
        };
    }

    /**
     * Start a coverage bake job via supervised detached runner if lock can be atomically acquired.
     */
    startBake({ trigger = 'manual', limit, timeoutMs, heartbeatMs } = {}) {
        const safeLimit = this._sanitizeLimit(limit);
        if (safeLimit === null) {
            return {
                started: false,
                reason: 'invalid_limit',
                error: 'Invalid station limit (must be integer between 1 and 1000)'
            };
        }

        if (this.activeJob) {
            return {
                started: false,
                reason: 'already_running',
                activeJob: toPublicJobSummary(this.activeJob)
            };
        }

        const jobId = `bake-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const ownerToken = crypto.randomBytes(24).toString('hex');
        const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : this.defaultTimeoutMs;
        const effectiveHeartbeat = Number.isFinite(heartbeatMs) ? heartbeatMs : this.heartbeatMs;
        const nowIso = new Date().toISOString();

        const initialLockMeta = {
            jobId,
            ownerToken,
            hostname: os.hostname(),
            serverPid: process.pid,
            runnerPid: null,
            bakePid: null,
            trigger,
            limit: safeLimit,
            state: 'acquiring',
            createdAt: nowIso,
            startedAt: nowIso,
            heartbeatAt: nowIso,
            maxDurationMs: effectiveTimeout
        };

        const lockResult = acquireCoverageLock(this.lockDirPath, initialLockMeta, {
            heartbeatGraceMs: this.heartbeatGraceMs
        });

        if (!lockResult.acquired) {
            return {
                started: false,
                reason: lockResult.reason || 'already_running',
                activeJob: lockResult.activeJob || null
            };
        }

        const job = {
            jobId,
            trigger,
            limit: safeLimit,
            status: 'running',
            startedAt: nowIso,
            finishedAt: null,
            durationMs: null
        };

        this.activeJob = job;
        const startMs = Date.now();

        const runnerConfig = JSON.stringify({
            lockDirPath: this.lockDirPath,
            jobId,
            ownerToken,
            bakeScriptPath: this.bakeScriptPath,
            limit: safeLimit,
            timeoutMs: effectiveTimeout,
            heartbeatMs: effectiveHeartbeat
        });

        const completion = new Promise((resolve) => {
            let stdoutTail = '';
            let stderrTail = '';
            let settled = false;

            const appendTail = (prev, chunk) => {
                const next = prev + String(chunk || '');
                return next.length > 4096 ? next.slice(-4096) : next;
            };

            let child;
            try {
                child = this.spawnFn(process.execPath, [this.runnerScriptPath], {
                    shell: false,
                    detached: true,
                    stdio: ['ignore', 'ignore', 'ignore'],
                    windowsHide: true,
                    env: {
                        ...process.env,
                        ...this.envOverrides,
                        COVERAGE_RUNNER_CONFIG: runnerConfig
                    }
                });
            } catch (spawnErr) {
                job.status = 'failed';
                job.finishedAt = new Date().toISOString();
                job.durationMs = Date.now() - startMs;
                this.lastJob = { ...job };
                this.lastDiagnostics = {
                    jobId,
                    status: 'failed',
                    exitCode: null,
                    error: redactPathsAndSecrets(spawnErr.message)
                };
                this.activeJob = null;
                this.activeChild = null;
                releaseCoverageLock(this.lockDirPath, jobId, ownerToken);
                return resolve({ ...job, exitCode: null, error: spawnErr.message });
            }

            this.activeChild = child;

            if (child.stdout) {
                child.stdout.on('data', (chunk) => {
                    stdoutTail = appendTail(stdoutTail, chunk);
                });
            }
            if (child.stderr) {
                child.stderr.on('data', (chunk) => {
                    stderrTail = appendTail(stderrTail, chunk);
                });
            }

            const finalize = (code, signal, errMsg = null) => {
                if (settled) return;
                settled = true;

                job.finishedAt = new Date().toISOString();
                job.durationMs = Date.now() - startMs;

                if (errMsg) {
                    job.status = 'failed';
                } else if (code === 124) {
                    job.status = 'timed_out';
                } else if (code === 0) {
                    job.status = 'completed';
                } else {
                    job.status = 'failed';
                }

                this.lastJob = { ...job };
                this.lastDiagnostics = {
                    jobId,
                    status: job.status,
                    exitCode: code,
                    signal: signal || null,
                    error: errMsg ? redactPathsAndSecrets(errMsg) : (code !== 0 ? redactPathsAndSecrets(stderrTail.trim() || `Exited with code ${code}`) : null),
                    stdoutTail: redactPathsAndSecrets(stdoutTail),
                    stderrTail: redactPathsAndSecrets(stderrTail)
                };
                this.activeJob = null;
                this.activeChild = null;

                // Runner normally releases lock; ensure release if runner crashed before releasing
                releaseCoverageLock(this.lockDirPath, jobId, ownerToken);

                resolve({
                    ...job,
                    exitCode: code,
                    signal: signal || null,
                    error: this.lastDiagnostics.error
                });
            };

            child.on('error', (err) => finalize(null, null, err.message));
            child.on('close', (code, signal) => finalize(code, signal));
        });

        return {
            started: true,
            recoveredStaleLock: lockResult.recovered,
            job: toPublicJobSummary(job),
            completion
        };
    }
}

module.exports = {
    safeTokenEqual,
    extractAdminToken,
    createRequireCoverageAdmin,
    CoverageJobController,
    redactPathsAndSecrets
};
