const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createRequireCoverageAdmin, CoverageJobController } = require('../../src/utils/coverage-controller');

function invokeExpress(app, { method = 'POST', url = '/api/coverage/rebuild', headers = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const resHeaders = {};
        let statusCode = 200;
        let finished = false;
        const normalizedHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
            normalizedHeaders[k.toLowerCase()] = v;
        }

        const parsed = new URL(url, 'http://localhost');
        const query = Object.fromEntries(parsed.searchParams.entries());

        const req = {
            method,
            url,
            originalUrl: url,
            path: parsed.pathname,
            query,
            body,
            headers: normalizedHeaders,
            get(name) {
                return this.headers[String(name).toLowerCase()];
            }
        };

        const res = {
            statusCode: 200,
            setHeader(name, val) {
                resHeaders[String(name).toLowerCase()] = val;
            },
            status(code) {
                statusCode = code;
                this.statusCode = code;
                return this;
            },
            json(payload) {
                if (finished) return this;
                finished = true;
                resolve({ statusCode, headers: resHeaders, body: payload });
                return this;
            }
        };

        app.handle(req, res, (err) => {
            if (err) return reject(err);
            if (!finished) {
                finished = true;
                resolve({ statusCode: 404, headers: resHeaders, body: null });
            }
        });
    });
}

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Phase 2.1: Admin authorization enforces default-deny (503), 401, 403, and accepts Bearer / X-Admin-Token', async () => {
    let currentToken = '';
    const requireAdmin = createRequireCoverageAdmin(() => currentToken);

    const app = express();
    app.post('/api/coverage/rebuild', requireAdmin, (req, res) => {
        res.status(202).json({ success: true });
    });

    // 1. Token not configured -> 503 default-deny
    const unconfigured = await invokeExpress(app, {});
    assert.equal(unconfigured.statusCode, 503);

    // 2. Configured token, missing header -> 401
    currentToken = 'super-secret-test-token-4031';
    const missing = await invokeExpress(app, {});
    assert.equal(missing.statusCode, 401);

    // 3. Wrong token -> 403
    const wrong = await invokeExpress(app, { headers: { Authorization: 'Bearer wrong-token' } });
    assert.equal(wrong.statusCode, 403);

    // 4. Valid Bearer token -> 202
    const validBearer = await invokeExpress(app, { headers: { Authorization: `Bearer ${currentToken}` } });
    assert.equal(validBearer.statusCode, 202);

    // 5. Valid X-Admin-Token -> 202
    const validHeader = await invokeExpress(app, { headers: { 'X-Admin-Token': currentToken } });
    assert.equal(validHeader.statusCode, 202);
});

test('Phase 2.2: Single-flight lock prevents concurrent manual + cron bakes and writes atomic output', async () => {
    const tmpDir = makeTempDir('cov-singleflight-');
    const mockScript = path.join(tmpDir, 'mock-bake.mjs');
    const outDir = path.join(tmpDir, 'out');
    const lockFile = path.join(tmpDir, '.coverage_bake.lock');

    fs.writeFileSync(mockScript, `
        import fs from 'fs';
        import path from 'path';
        const outDir = process.env.COVERAGE_OUTPUT_DIR;
        fs.mkdirSync(outDir, { recursive: true });
        await new Promise((r) => setTimeout(r, 150));
        const pngTmp = path.join(outDir, 'taiwan_coverage.png.tmp');
        const jsonTmp = path.join(outDir, 'taiwan_coverage.json.tmp');
        fs.writeFileSync(pngTmp, Buffer.from([137, 80, 78, 71]));
        fs.writeFileSync(jsonTmp, JSON.stringify({ limit: Number(process.argv[2]), ok: true }));
        fs.renameSync(pngTmp, path.join(outDir, 'taiwan_coverage.png'));
        fs.renameSync(jsonTmp, path.join(outDir, 'taiwan_coverage.json'));
    `, 'utf8');

    const controller = new CoverageJobController({
        bakeScriptPath: mockScript,
        lockFilePath: lockFile,
        envOverrides: { COVERAGE_OUTPUT_DIR: outDir }
    });

    const first = controller.startBake({ trigger: 'manual', limit: 25 });
    assert.equal(first.started, true);
    assert.equal(controller.getStatus().running, true);

    // Concurrent manual and cron attempts must be rejected
    const secondManual = controller.startBake({ trigger: 'manual', limit: 25 });
    assert.equal(secondManual.started, false);
    assert.equal(secondManual.reason, 'already_running');

    const concurrentCron = controller.startBake({ trigger: 'cron', limit: 500 });
    assert.equal(concurrentCron.started, false);
    assert.equal(concurrentCron.reason, 'already_running');

    // Cross-process lock file check with second controller
    const otherController = new CoverageJobController({
        bakeScriptPath: mockScript,
        lockFilePath: lockFile
    });
    const crossProc = otherController.startBake({ trigger: 'manual', limit: 25 });
    assert.equal(crossProc.started, false);
    assert.equal(crossProc.reason, 'locked_by_other_process');

    const result = await first.completion;
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(controller.getStatus().running, false);
    assert.equal(fs.existsSync(lockFile), false);

    // Verify atomic output files exist and no .tmp files remain
    const files = fs.readdirSync(outDir);
    assert.ok(files.includes('taiwan_coverage.png'));
    assert.ok(files.includes('taiwan_coverage.json'));
    assert.equal(files.some((f) => f.includes('.tmp')), false);
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'taiwan_coverage.json'), 'utf8'));
    assert.equal(meta.limit, 25);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Phase 2.3: Timeout terminates child process, releases lock, and allows recovery', async () => {
    const tmpDir = makeTempDir('cov-timeout-');
    const mockScript = path.join(tmpDir, 'hang-bake.mjs');
    const lockFile = path.join(tmpDir, '.coverage_bake.lock');

    fs.writeFileSync(mockScript, `
        setInterval(() => {}, 1000);
    `, 'utf8');

    const controller = new CoverageJobController({
        bakeScriptPath: mockScript,
        lockFilePath: lockFile,
        timeoutMs: 120
    });

    const launch = controller.startBake({ trigger: 'manual', limit: 10 });
    assert.equal(launch.started, true);

    const result = await launch.completion;
    assert.equal(result.status, 'timed_out');
    assert.equal(controller.getStatus().running, false);
    assert.equal(fs.existsSync(lockFile), false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Phase 2.4: Stale lock from dead PID is automatically reclaimed', async () => {
    const tmpDir = makeTempDir('cov-stale-');
    const mockScript = path.join(tmpDir, 'fast-bake.mjs');
    const lockFile = path.join(tmpDir, '.coverage_bake.lock');

    fs.writeFileSync(mockScript, 'process.exit(0);', 'utf8');
    fs.writeFileSync(lockFile, JSON.stringify({
        pid: 999999,
        jobId: 'stale-job',
        startedAt: new Date(Date.now() - 10000).toISOString()
    }), 'utf8');

    const controller = new CoverageJobController({
        bakeScriptPath: mockScript,
        lockFilePath: lockFile
    });

    const launch = controller.startBake({ trigger: 'cron', limit: 50 });
    assert.equal(launch.started, true);
    const result = await launch.completion;
    assert.equal(result.status, 'completed');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

