const { spawn, execFile } = require('child_process');
const {
    isPidAlive,
    updateCoverageLock,
    releaseCoverageLock
} = require('./coverage-lock');

function killProcessTree(pid) {
    return new Promise((resolve) => {
        if (!pid || !isPidAlive(pid)) return resolve(true);

        if (process.platform === 'win32') {
            let done = false;
            const fallbackKill = () => {
                if (done) return;
                done = true;
                if (isPidAlive(pid)) {
                    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                }
                setTimeout(() => resolve(!isPidAlive(pid)), 150);
            };
            try {
                execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, () => {
                    fallbackKill();
                });
            } catch (_) {
                fallbackKill();
            }
            return;
        }

        // POSIX: target process group first, then individual PID
        try { process.kill(-pid, 'SIGTERM'); } catch (_) {
            try { process.kill(pid, 'SIGTERM'); } catch (__) {}
        }
        setTimeout(() => {
            if (!isPidAlive(pid)) return resolve(true);
            try { process.kill(-pid, 'SIGKILL'); } catch (_) {
                try { process.kill(pid, 'SIGKILL'); } catch (__) {}
            }
            setTimeout(() => resolve(!isPidAlive(pid)), 150);
        }, 500);
    });
}

async function runSupervisedBake() {
    const rawConfig = process.env.COVERAGE_RUNNER_CONFIG;
    if (!rawConfig) {
        console.error('[coverage-runner] Missing COVERAGE_RUNNER_CONFIG');
        process.exit(2);
    }

    const cfg = JSON.parse(rawConfig);
    const {
        lockDirPath,
        jobId,
        ownerToken,
        bakeScriptPath,
        limit,
        timeoutMs = 15 * 60 * 1000,
        heartbeatMs = 1000
    } = cfg;

    updateCoverageLock(lockDirPath, jobId, ownerToken, {
        runnerPid: process.pid,
        state: 'spawning_bake',
        heartbeatAt: new Date().toISOString()
    });

    if (process.stdout && typeof process.stdout.on === 'function') process.stdout.on('error', () => {});
    if (process.stderr && typeof process.stderr.on === 'function') process.stderr.on('error', () => {});

    let child;
    try {
        child = spawn(process.execPath, [bakeScriptPath, String(limit)], {
            shell: false,
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: true,
            env: process.env
        });
    } catch (spawnErr) {
        console.error('[coverage-runner] Failed to spawn bake:', spawnErr.message);
        releaseCoverageLock(lockDirPath, jobId, ownerToken);
        process.exit(1);
    }

    const bakePid = child.pid || null;
    updateCoverageLock(lockDirPath, jobId, ownerToken, {
        runnerPid: process.pid,
        bakePid,
        state: 'running',
        heartbeatAt: new Date().toISOString()
    });

    if (child.stdout) child.stdout.on('data', (d) => process.stdout.write(d));
    if (child.stderr) child.stderr.on('data', (d) => process.stderr.write(d));

    const hbTimer = setInterval(() => {
        updateCoverageLock(lockDirPath, jobId, ownerToken, {
            heartbeatAt: new Date().toISOString()
        });
    }, Math.max(50, heartbeatMs));
    if (typeof hbTimer.unref === 'function') hbTimer.unref();

    let timedOut = false;
    let settled = false;

    const finish = async (exitCode) => {
        if (settled) return;
        settled = true;
        clearInterval(hbTimer);

        if (timedOut && bakePid) {
            const dead = await killProcessTree(bakePid);
            if (!dead) {
                console.error(`[coverage-runner] Failed to confirm termination of bakePid=${bakePid}; retaining lock for safety`);
                updateCoverageLock(lockDirPath, jobId, ownerToken, {
                    state: 'cleanup_failed',
                    heartbeatAt: new Date().toISOString()
                });
                process.exit(124);
                return;
            }
        }

        releaseCoverageLock(lockDirPath, jobId, ownerToken);
        process.exit(timedOut ? 124 : (typeof exitCode === 'number' ? exitCode : 1));
    };

    const timeoutTimer = setTimeout(async () => {
        timedOut = true;
        updateCoverageLock(lockDirPath, jobId, ownerToken, {
            state: 'timed_out',
            heartbeatAt: new Date().toISOString()
        });
        if (bakePid) {
            await killProcessTree(bakePid);
        }
        finish(124);
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

    child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        console.error('[coverage-runner] Bake process error:', err.message);
        finish(1);
    });

    child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        finish(code);
    });
}

if (require.main === module) {
    runSupervisedBake().catch((err) => {
        console.error('[coverage-runner] Fatal error:', err);
        process.exit(1);
    });
}

module.exports = {
    killProcessTree
};

