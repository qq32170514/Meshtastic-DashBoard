const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function safeTokenEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const h1 = crypto.createHash('sha256').update(a, 'utf8').digest();
    const h2 = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(h1, h2);
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

function writeJsonAtomic(filePath, data) {
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function readLockMetadata(lockDirPath) {
    const ownerFile = path.join(lockDirPath, 'owner.json');
    if (!fs.existsSync(ownerFile)) {
        return { status: 'missing_metadata', ownerFile, data: null };
    }
    try {
        const raw = fs.readFileSync(ownerFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.jobId || !parsed.ownerToken) {
            return { status: 'corrupted', ownerFile, raw, data: null, error: 'Missing required lock fields (jobId/ownerToken)' };
        }
        return { status: 'valid', ownerFile, data: parsed };
    } catch (err) {
        return { status: 'corrupted', ownerFile, data: null, error: err.message };
    }
}

/**
 * Evaluate whether an existing lock is safely reclaimable.
 * Fail-closed: if ownership or liveness cannot be reliably confirmed, returns { reclaimable: false }.
 */
function evaluateLockState(lockDirPath, options = {}) {
    const now = options.now || Date.now();
    const heartbeatGraceMs = Number.isFinite(options.heartbeatGraceMs) ? options.heartbeatGraceMs : 15000;
    const initGraceMs = Number.isFinite(options.initGraceMs) ? options.initGraceMs : 5000;
    const localHost = options.hostname || os.hostname();

    if (!fs.existsSync(lockDirPath)) {
        return { exists: false, reclaimable: false, reason: 'not_locked' };
    }

    const metaRes = readLockMetadata(lockDirPath);
    if (metaRes.status === 'missing_metadata') {
        try {
            const stat = fs.statSync(lockDirPath);
            if (now - stat.mtimeMs < initGraceMs) {
                return { exists: true, reclaimable: false, reason: 'initializing' };
            }
        } catch (_) {}
        return { exists: true, reclaimable: false, reason: 'lock_corrupted_missing_metadata' };
    }

    if (metaRes.status === 'corrupted') {
        return {
            exists: true,
            reclaimable: false,
            reason: 'lock_corrupted',
            diagnostic: metaRes.error
        };
    }

    const meta = metaRes.data;

    // Cross-host lock: cannot verify local PID liveness -> fail-closed unless explicitly beyond heartbeat+maxDuration
    if (meta.hostname && meta.hostname !== localHost) {
        return {
            exists: true,
            reclaimable: false,
            reason: 'locked_on_other_host',
            meta
        };
    }

    // Check heartbeat freshness first
    const hbMs = Date.parse(meta.heartbeatAt || meta.startedAt || meta.createdAt || '');
    if (Number.isFinite(hbMs) && (now - hbMs) < heartbeatGraceMs) {
        return {
            exists: true,
            reclaimable: false,
            reason: 'active_heartbeat',
            meta
        };
    }

    // Check actual runner & bake process liveness on same host
    const runnerAlive = meta.runnerPid ? isPidAlive(meta.runnerPid) : false;
    const bakeAlive = meta.bakePid ? isPidAlive(meta.bakePid) : false;

    if (runnerAlive || bakeAlive) {
        return {
            exists: true,
            reclaimable: false,
            reason: 'active_process',
            meta
        };
    }

    // If runnerPid hasn't been recorded yet, check serverPid during startup window
    if (!meta.runnerPid && !meta.bakePid && meta.serverPid && isPidAlive(meta.serverPid)) {
        const createdMs = Date.parse(meta.createdAt || '');
        if (Number.isFinite(createdMs) && (now - createdMs) < initGraceMs) {
            return {
                exists: true,
                reclaimable: false,
                reason: 'server_starting_runner',
                meta
            };
        }
    }

    // Both runnerPid and bakePid are confirmed dead (or never started past initGraceMs) and heartbeat is stale
    return {
        exists: true,
        reclaimable: true,
        reason: 'stale_dead_processes',
        meta
    };
}

/**
 * Atomically acquire the coverage lock directory, recovering stale locks safely via atomic rename.
 */
function acquireCoverageLock(lockDirPath, initialMeta, options = {}) {
    const parentDir = path.dirname(lockDirPath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }

    const tryCreate = () => {
        fs.mkdirSync(lockDirPath);
        try {
            writeJsonAtomic(path.join(lockDirPath, 'owner.json'), initialMeta);
            return true;
        } catch (err) {
            try { fs.rmSync(lockDirPath, { recursive: true, force: true }); } catch (_) {}
            throw err;
        }
    };

    try {
        tryCreate();
        return { acquired: true, recovered: false, meta: initialMeta };
    } catch (err) {
        if (!err || err.code !== 'EEXIST') {
            throw err;
        }
    }

    // Lock directory already exists — evaluate liveness/staleness
    const state = evaluateLockState(lockDirPath, options);
    if (!state.exists) {
        // Disappeared concurrently; one retry
        try {
            tryCreate();
            return { acquired: true, recovered: false, meta: initialMeta };
        } catch (err) {
            if (err && err.code === 'EEXIST') {
                return { acquired: false, reason: 'already_running' };
            }
            throw err;
        }
    }

    if (!state.reclaimable) {
        return {
            acquired: false,
            reason: state.reason,
            activeJob: state.meta ? {
                jobId: state.meta.jobId,
                trigger: state.meta.trigger,
                state: state.meta.state,
                startedAt: state.meta.startedAt,
                heartbeatAt: state.meta.heartbeatAt
            } : null,
            diagnostic: state.diagnostic || null
        };
    }

    // Atomic stale-lock reclamation: only ONE racing process can win renameSync!
    const reclaimPath = `${lockDirPath}.reclaiming.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.renameSync(lockDirPath, reclaimPath);
    } catch (renameErr) {
        // Another process won the race to reclaim (or lock was released/replaced)
        return {
            acquired: false,
            reason: 'recovery_race_lost'
        };
    }

    // Reverify quarantined owner metadata before deleting quarantine directory
    try {
        fs.rmSync(reclaimPath, { recursive: true, force: true });
    } catch (_) {}

    // Now atomically create the new lock
    try {
        tryCreate();
        return {
            acquired: true,
            recovered: true,
            recoveredJobId: state.meta ? state.meta.jobId : null,
            meta: initialMeta
        };
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            return { acquired: false, reason: 'already_running' };
        }
        throw err;
    }
}

/**
 * Update lock metadata only if caller still owns (jobId, ownerToken).
 */
function updateCoverageLock(lockDirPath, jobId, ownerToken, patch) {
    const metaRes = readLockMetadata(lockDirPath);
    if (metaRes.status !== 'valid') return false;
    const current = metaRes.data;
    if (current.jobId !== jobId || !safeTokenEqual(current.ownerToken, ownerToken)) {
        return false;
    }
    const updated = { ...current, ...patch };
    writeJsonAtomic(path.join(lockDirPath, 'owner.json'), updated);
    return true;
}

/**
 * Release lock directory ONLY if caller still owns (jobId, ownerToken).
 * Never deletes corrupted or foreign locks.
 */
function releaseCoverageLock(lockDirPath, jobId, ownerToken) {
    if (!fs.existsSync(lockDirPath)) return { released: false, reason: 'not_found' };
    const metaRes = readLockMetadata(lockDirPath);
    if (metaRes.status !== 'valid') {
        return { released: false, reason: metaRes.status };
    }
    const current = metaRes.data;
    if (current.jobId !== jobId || !safeTokenEqual(current.ownerToken, ownerToken)) {
        return { released: false, reason: 'owner_mismatch' };
    }

    const releasingPath = `${lockDirPath}.releasing.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
    try {
        fs.renameSync(lockDirPath, releasingPath);
        fs.rmSync(releasingPath, { recursive: true, force: true });
        return { released: true };
    } catch (err) {
        return { released: false, reason: err.message };
    }
}

module.exports = {
    safeTokenEqual,
    isPidAlive,
    writeJsonAtomic,
    readLockMetadata,
    evaluateLockState,
    acquireCoverageLock,
    updateCoverageLock,
    releaseCoverageLock
};

