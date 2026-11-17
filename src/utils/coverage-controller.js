const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/**
 * Constant-time token comparison using SHA-256 digests.
 */
function safeTokenEqual(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const hashA = crypto.createHash('sha256').update(provided, 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

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
 * Express middleware enforcing real admin authorization for Coverage Rebuild.
 * Default-deny: if no admin token is configured, returns 503 rather than allowing unauthenticated access.
 */
function createRequireCoverageAdmin(getExpectedToken = () => process.env.COVERAGE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '') {
    return function requireCoverageAdmin(req, res, next) {
        const expected = String(getExpectedToken() || '').trim();
        if (!expected) {
            return res.status(503).json({
                error: 'Coverage rebuild endpoint is disabled: admin token is not configured'
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

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err && err.code === 'EPERM';
    }
}

/**
 * Unified single-flight controller for manual and scheduled ITM coverage baking.
 */
class CoverageJobController {
    constructor(options = {}) {
        this.bakeScriptPath = options.bakeScriptPath || path.join(__dirname, '../../rf-engine/bake.mjs');
        this.lockFilePath = options.lockFilePath || path.join(__dirname, '../../public/coverage/.coverage_bake.lock');
        this.defaultTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15 * 60 * 1000;
        this.defaultLimit = Number.isFinite(options.defaultLimit) ? options.defaultLimit : 500;
        this.spawnFn = options.spawnFn || spawn;
        this.envOverrides = options.envOverrides || {};

        this.activeJob = null;
        this.activeChild = null;
        this.lastJob = null;
    }

    _acquireLock(jobMeta) {
        const lockDir = path.dirname(this.lockFilePath);
        if (!fs.existsSync(lockDir)) {
            fs.mkdirSync(lockDir, { recursive: true });
        }

        const payload = JSON.stringify({
            pid: process.pid,
            jobId: jobMeta.jobId,
            trigger: jobMeta.trigger,
            startedAt: jobMeta.startedAt
        });

        try {
            const fd = fs.openSync(this.lockFilePath, 'wx');
            try {
                fs.writeFileSync(fd, payload, 'utf8');
            } finally {
                fs.closeSync(fd);
            }
            return true;
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                // Check if lock is stale (dead process or expired past timeout + 60s)
                try {
                    const existing = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
                    const ageMs = Date.now() - Date.parse(existing.startedAt || 0);
                    const staleByAge = Number.isFinite(ageMs) && ageMs > (this.defaultTimeoutMs + 60 * 1000);
                    const staleByPid = existing.pid && existing.pid !== process.pid && !isPidAlive(existing.pid);
                    if (staleByAge || staleByPid) {
                        fs.unlinkSync(this.lockFilePath);
                        const fd = fs.openSync(this.lockFilePath, 'wx');
                        try {
                            fs.writeFileSync(fd, payload, 'utf8');
                        } finally {
                            fs.closeSync(fd);
                        }
                        return true;
                    }
                } catch (_) {
                    // Ignore parse/unlink races and treat lock as held
                }
                return false;
            }
            throw err;
        }
    }

    _releaseLock(jobId) {
        try {
            if (!fs.existsSync(this.lockFilePath)) return;
            const existing = JSON.parse(fs.readFileSync(this.lockFilePath, 'utf8'));
            if (!existing.jobId || existing.jobId === jobId) {
                fs.unlinkSync(this.lockFilePath);
            }
        } catch (_) {
            try { fs.unlinkSync(this.lockFilePath); } catch (__) {}
        }
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

    getStatus() {
        return {
            running: Boolean(this.activeJob),
            activeJob: this.activeJob ? { ...this.activeJob } : null,
            lastJob: this.lastJob ? { ...this.lastJob } : null
        };
    }

    /**
     * Start a coverage bake job if none is currently running.
     * Returns `{ started: true, job, completion }` or `{ started: false, reason, activeJob }`.
     */
    startBake({ trigger = 'manual', limit, timeoutMs } = {}) {
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
                activeJob: { ...this.activeJob }
            };
        }

        const jobId = `bake-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const job = {
            jobId,
            trigger,
            limit: safeLimit,
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            durationMs: null,
            exitCode: null,
            signal: null,
            error: null
        };

        if (!this._acquireLock(job)) {
            return {
                started: false,
                reason: 'locked_by_other_process',
                activeJob: this.activeJob ? { ...this.activeJob } : null
            };
        }

        this.activeJob = job;
        const effectiveTimeout = Number.isFinite(timeoutMs) ? timeoutMs : this.defaultTimeoutMs;
        const startMs = Date.now();

        const completion = new Promise((resolve) => {
            let stdoutTail = '';
            let stderrTail = '';
            let timedOut = false;
            let settled = false;

            const appendTail = (prev, chunk) => {
                const next = prev + String(chunk || '');
                return next.length > 4096 ? next.slice(-4096) : next;
            };

            let child;
            try {
                child = this.spawnFn(process.execPath, [this.bakeScriptPath, String(safeLimit)], {
                    shell: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: {
                        ...process.env,
                        ...this.envOverrides
                    }
                });
            } catch (spawnErr) {
                job.status = 'failed';
                job.finishedAt = new Date().toISOString();
                job.durationMs = Date.now() - startMs;
                job.error = spawnErr.message;
                this.lastJob = { ...job };
                this.activeJob = null;
                this.activeChild = null;
                this._releaseLock(jobId);
                return resolve({ ...job, stdoutTail, stderrTail });
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

            let killGraceTimer = null;
            const timeoutTimer = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGTERM');
                } catch (_) {}
                killGraceTimer = setTimeout(() => {
                    try {
                        child.kill('SIGKILL');
                    } catch (_) {}
                }, 1500);
                if (typeof killGraceTimer.unref === 'function') killGraceTimer.unref();
            }, effectiveTimeout);
            if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

            const finalize = (code, signal, errMsg = null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutTimer);
                if (killGraceTimer) clearTimeout(killGraceTimer);

                job.finishedAt = new Date().toISOString();
                job.durationMs = Date.now() - startMs;
                job.exitCode = code;
                job.signal = signal || null;

                if (timedOut) {
                    job.status = 'timed_out';
                    job.error = `Coverage bake timed out after ${effectiveTimeout}ms`;
                } else if (errMsg) {
                    job.status = 'failed';
                    job.error = errMsg;
                } else if (code === 0) {
                    job.status = 'completed';
                    job.error = null;
                } else {
                    job.status = 'failed';
                    job.error = stderrTail.trim() || `Process exited with code ${code}`;
                }

                this.lastJob = { ...job, stdoutTail, stderrTail };
                this.activeJob = null;
                this.activeChild = null;
                this._releaseLock(jobId);

                resolve({ ...job, stdoutTail, stderrTail });
            };

            child.on('error', (err) => {
                finalize(null, null, err.message);
            });

            child.on('close', (code, signal) => {
                finalize(code, signal);
            });
        });

        return {
            started: true,
            job: { ...job },
            completion
        };
    }
}

module.exports = {
    safeTokenEqual,
    extractAdminToken,
    createRequireCoverageAdmin,
    CoverageJobController
};

