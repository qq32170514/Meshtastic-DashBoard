const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CoverageJobController } = require('../../src/utils/coverage-controller');
const {
    acquireCoverageLock,
    releaseCoverageLock,
    readLockMetadata,
    isPidAlive
} = require('../../src/utils/coverage-lock');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runNodeChild(scriptPath, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath], {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, ...env }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('Stage 1.1: Real cross-process lock race — two Node processes race, only one acquires', async () => {
    const tmpDir = makeTempDir('cov-race-');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');
    const bakeScript = path.join(tmpDir, 'mock-bake.mjs');
    const workerScript = path.join(tmpDir, 'server-worker.js');

    fs.writeFileSync(bakeScript, 'await new Promise(r => setTimeout(r, 400));', 'utf8');
    fs.writeFileSync(workerScript, `
        const { CoverageJobController } = require(${JSON.stringify(path.resolve(__dirname, '../../src/utils/coverage-controller.js'))});
        const ctrl = new CoverageJobController({
            bakeScriptPath: ${JSON.stringify(bakeScript)},
            lockDirPath: ${JSON.stringify(lockDir)},
            heartbeatMs: 100,
            heartbeatGraceMs: 1500
        });
        const res = ctrl.startBake({ trigger: 'manual', limit: 10, timeoutMs: 5000, heartbeatMs: 100 });
        if (!res.started) {
            console.log(JSON.stringify({ started: false, reason: res.reason }));
            process.exit(0);
        }
        res.completion.then((done) => {
            console.log(JSON.stringify({ started: true, status: done.status }));
            process.exit(0);
        });
    `, 'utf8');

    const [r1, r2] = await Promise.all([runNodeChild(workerScript), runNodeChild(workerScript)]);
    const o1 = JSON.parse(r1.stdout.trim().split(/\r?\n/).pop());
    const o2 = JSON.parse(r2.stdout.trim().split(/\r?\n/).pop());

    const startedCount = [o1, o2].filter((x) => x.started).length;
    const rejectedCount = [o1, o2].filter((x) => !x.started).length;
    assert.equal(startedCount, 1, `Expected exactly 1 process to acquire lock, got o1=${JSON.stringify(o1)} o2=${JSON.stringify(o2)}`);
    assert.equal(rejectedCount, 1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Stage 1.2: Server A killed (SIGKILL) while Runner+Bake survive — Server B MUST NOT steal lock until Bake finishes', async () => {
    const tmpDir = makeTempDir('cov-orphan-server-');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');
    const bakeScript = path.join(tmpDir, 'slow-bake.mjs');
    const markerFile = path.join(tmpDir, 'bake-done.txt');
    const serverAScript = path.join(tmpDir, 'server-a.js');

    fs.writeFileSync(bakeScript, `
        import fs from 'fs';
        await new Promise(r => setTimeout(r, 900));
        fs.writeFileSync(${JSON.stringify(markerFile)}, 'done', 'utf8');
    `, 'utf8');

    fs.writeFileSync(serverAScript, `
        const { CoverageJobController } = require(${JSON.stringify(path.resolve(__dirname, '../../src/utils/coverage-controller.js'))});
        const ctrl = new CoverageJobController({
            bakeScriptPath: ${JSON.stringify(bakeScript)},
            lockDirPath: ${JSON.stringify(lockDir)},
            heartbeatMs: 100,
            heartbeatGraceMs: 1200
        });
        const res = ctrl.startBake({ trigger: 'cron', limit: 20, timeoutMs: 5000, heartbeatMs: 100 });
        console.log(JSON.stringify({ started: res.started, jobId: res.job && res.job.jobId }));
        // Keep Server A alive until parent kills it
        setInterval(() => {}, 1000);
    `, 'utf8');

    const serverA = spawn(process.execPath, [serverAScript], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    await new Promise((resolve, reject) => {
        serverA.stdout.on('data', (d) => {
            if (d.toString().includes('"started":true')) resolve();
        });
        serverA.on('error', reject);
        setTimeout(() => reject(new Error('Server A did not start bake in time')), 4000);
    });

    // Wait briefly so runner records runnerPid & bakePid in owner.json
    await new Promise((r) => setTimeout(r, 250));
    const metaBeforeKill = readLockMetadata(lockDir);
    assert.equal(metaBeforeKill.status, 'valid');
    assert.ok(metaBeforeKill.data.runnerPid, 'runnerPid must be recorded');

    // Kill Server A abruptly!
    serverA.kill('SIGKILL');
    await new Promise((r) => serverA.once('close', r));

    // Server B attempts to start a new bake immediately while Runner+Bake are still alive
    const serverB = new CoverageJobController({
        bakeScriptPath: bakeScript,
        lockDirPath: lockDir,
        heartbeatMs: 100,
        heartbeatGraceMs: 1200
    });
    const attemptB = serverB.startBake({ trigger: 'manual', limit: 20 });
    assert.equal(attemptB.started, false, 'Server B MUST NOT start second bake while Runner+Bake are alive');
    assert.ok(['active_heartbeat', 'active_process'].includes(attemptB.reason), `Unexpected reason: ${attemptB.reason}`);

    // Wait for Bake to finish naturally and release lock
    const deadline = Date.now() + 5000;
    while (fs.existsSync(lockDir) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(fs.existsSync(markerFile), true, 'Original bake should complete cleanly');
    assert.equal(fs.existsSync(lockDir), false, 'Runner should release lock after bake finishes');

    // Now Server B can start a new bake
    const fastBake = path.join(tmpDir, 'fast-bake.mjs');
    fs.writeFileSync(fastBake, 'process.exit(0);', 'utf8');
    const serverB2 = new CoverageJobController({
        bakeScriptPath: fastBake,
        lockDirPath: lockDir,
        heartbeatMs: 100,
        heartbeatGraceMs: 1200
    });
    const attemptB2 = serverB2.startBake({ trigger: 'manual', limit: 10 });
    assert.equal(attemptB2.started, true);
    const resB2 = await attemptB2.completion;
    assert.equal(resB2.status, 'completed');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Stage 1.3: Two processes racing stale lock recovery — only ONE succeeds and winner lock is intact', async () => {
    const tmpDir = makeTempDir('cov-stale-race-');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');
    const bakeScript = path.join(tmpDir, 'fast.mjs');
    const recoverScript = path.join(tmpDir, 'recover-worker.js');

    fs.writeFileSync(bakeScript, 'await new Promise(r => setTimeout(r, 300));', 'utf8');

    // Create a genuine stale lock (dead PIDs + old heartbeat)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        jobId: 'dead-job-1',
        ownerToken: 'dead-owner-token',
        hostname: os.hostname(),
        serverPid: 999998,
        runnerPid: 999999,
        bakePid: 999997,
        trigger: 'cron',
        state: 'running',
        createdAt: new Date(Date.now() - 60000).toISOString(),
        startedAt: new Date(Date.now() - 60000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60000).toISOString(),
        maxDurationMs: 10000
    }));

    fs.writeFileSync(recoverScript, `
        const { CoverageJobController } = require(${JSON.stringify(path.resolve(__dirname, '../../src/utils/coverage-controller.js'))});
        const ctrl = new CoverageJobController({
            bakeScriptPath: ${JSON.stringify(bakeScript)},
            lockDirPath: ${JSON.stringify(lockDir)},
            heartbeatMs: 80,
            heartbeatGraceMs: 1000
        });
        const res = ctrl.startBake({ trigger: 'manual', limit: 5, timeoutMs: 5000, heartbeatMs: 80 });
        if (!res.started) {
            console.log(JSON.stringify({ started: false, reason: res.reason }));
            process.exit(0);
        }
        res.completion.then((done) => {
            console.log(JSON.stringify({ started: true, recovered: res.recoveredStaleLock, status: done.status }));
            process.exit(0);
        });
    `, 'utf8');

    const [r1, r2] = await Promise.all([runNodeChild(recoverScript), runNodeChild(recoverScript)]);
    const o1 = JSON.parse(r1.stdout.trim().split(/\r?\n/).pop());
    const o2 = JSON.parse(r2.stdout.trim().split(/\r?\n/).pop());

    assert.equal([o1, o2].filter((x) => x.started).length, 1);
    assert.equal([o1, o2].filter((x) => !x.started).length, 1);
    const winner = o1.started ? o1 : o2;
    assert.equal(winner.status, 'completed');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Stage 1.4: Corrupted lock metadata fails closed and is never unlinked; owner mismatch cannot release foreign lock', () => {
    const tmpDir = makeTempDir('cov-corrupt-');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), '{corrupted-json', 'utf8');

    const res = acquireCoverageLock(lockDir, {
        jobId: 'new-job',
        ownerToken: 'new-token',
        hostname: os.hostname(),
        createdAt: new Date().toISOString()
    });
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'lock_corrupted');
    assert.equal(fs.existsSync(path.join(lockDir, 'owner.json')), true, 'Corrupted lock metadata must be preserved for diagnostics');

    // Foreign release test on valid lock
    const lockDir2 = path.join(tmpDir, '.coverage_bake2.lockdir');
    const acq2 = acquireCoverageLock(lockDir2, {
        jobId: 'job-owner-a',
        ownerToken: 'token-a',
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString()
    });
    assert.equal(acq2.acquired, true);

    const wrongRelease = releaseCoverageLock(lockDir2, 'job-owner-a', 'wrong-token');
    assert.equal(wrongRelease.released, false);
    assert.equal(wrongRelease.reason, 'owner_mismatch');
    assert.equal(fs.existsSync(lockDir2), true);

    const rightRelease = releaseCoverageLock(lockDir2, 'job-owner-a', 'token-a');
    assert.equal(rightRelease.released, true);
    assert.equal(fs.existsSync(lockDir2), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Stage 1.5: Timeout terminates Bake process tree and releases lock; spawn failure cleans up', async () => {
    const tmpDir = makeTempDir('cov-timeout-tree-');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');
    const hangBake = path.join(tmpDir, 'hang-bake.mjs');
    const pidFile = path.join(tmpDir, 'bake.pid');

    fs.writeFileSync(hangBake, `
        import fs from 'fs';
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), 'utf8');
        setInterval(() => {}, 1000);
    `, 'utf8');

    const ctrl = new CoverageJobController({
        bakeScriptPath: hangBake,
        lockDirPath: lockDir,
        heartbeatMs: 50,
        heartbeatGraceMs: 1000
    });

    const launch = ctrl.startBake({ trigger: 'manual', limit: 10, timeoutMs: 250, heartbeatMs: 50 });
    assert.equal(launch.started, true);

    const result = await launch.completion;
    assert.equal(result.status, 'timed_out');
    assert.equal(fs.existsSync(lockDir), false);

    if (fs.existsSync(pidFile)) {
        const bakePid = Number(fs.readFileSync(pidFile, 'utf8'));
        assert.equal(isPidAlive(bakePid), false, 'Bake child PID must be terminated after timeout');
    }

    // Spawn failure cleanup
    const badCtrl = new CoverageJobController({
        bakeScriptPath: hangBake,
        runnerScriptPath: path.join(tmpDir, 'nonexistent-runner.js'),
        lockDirPath: lockDir,
        spawnFn: () => { throw new Error('Simulated spawn failure'); }
    });
    const badLaunch = badCtrl.startBake({ trigger: 'manual', limit: 10 });
    assert.equal(badLaunch.started, true);
    const badResult = await badLaunch.completion;
    assert.equal(badResult.status, 'failed');
    assert.equal(fs.existsSync(lockDir), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

