const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const {
    PNG_SIGNATURE,
    publishCoverageGeneration,
    resolveCurrentCoverage
} = require('../../src/utils/coverage-storage');
const {
    createRequireCoverageAdmin,
    CoverageJobController
} = require('../../src/utils/coverage-controller');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakePng(extra = 'fake-png-payload-123456') {
    return Buffer.concat([PNG_SIGNATURE, Buffer.from(`fake-png-payload-${extra}-00000000`, 'utf8')]);
}

function invokeExpress(app, { method = 'GET', url = '/', headers = {} }) {
    return new Promise((resolve, reject) => {
        const resHeaders = {};
        let statusCode = 200;
        let finished = false;
        const normalizedHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
            normalizedHeaders[k.toLowerCase()] = v;
        }
        const parsed = new URL(url, 'http://localhost');
        const req = {
            method,
            url,
            originalUrl: url,
            path: parsed.pathname,
            query: Object.fromEntries(parsed.searchParams.entries()),
            headers: normalizedHeaders,
            get(name) {
                return this.headers[String(name).toLowerCase()];
            }
        };
        const res = {
            statusCode: 200,
            setHeader(n, v) { resHeaders[String(n).toLowerCase()] = v; },
            status(c) { statusCode = c; this.statusCode = c; return this; },
            json(p) { if (!finished) { finished = true; resolve({ statusCode, headers: resHeaders, body: p }); } return this; }
        };
        app.handle(req, res, (err) => {
            if (err) return reject(err);
            if (!finished) { finished = true; resolve({ statusCode: 404, headers: resHeaders, body: null }); }
        });
    });
}

test('Stage 2.1: Generation/Manifest publishes PNG + JSON atomically and preserves old generation on failure', () => {
    const baseDir = makeTempDir('cov-gen-');

    // Publish Generation 1
    const g1 = publishCoverageGeneration(baseDir, {
        pngBuffer: makeFakePng('gen1'),
        metadata: { station_count: 100, updated_at: '2026-11-19T00:00:00Z' },
        generationId: 'gen-1'
    });
    assert.equal(g1.generationId, 'gen-1');

    const resolved1 = resolveCurrentCoverage(baseDir);
    assert.equal(resolved1.available, true);
    assert.equal(resolved1.generationId, 'gen-1');
    assert.equal(resolved1.metadata.station_count, 100);

    // Attempt Generation 2 with invalid PNG -> must fail and keep gen-1 active
    assert.throws(() => {
        publishCoverageGeneration(baseDir, {
            pngBuffer: Buffer.from('not-a-png'),
            metadata: { station_count: 200 },
            generationId: 'gen-2-bad-png'
        });
    });
    assert.equal(resolveCurrentCoverage(baseDir).generationId, 'gen-1');

    // Attempt Generation 2 with invalid metadata -> must fail and keep gen-1 active
    assert.throws(() => {
        publishCoverageGeneration(baseDir, {
            pngBuffer: makeFakePng('gen2'),
            metadata: null,
            generationId: 'gen-2-bad-json'
        });
    });
    assert.equal(resolveCurrentCoverage(baseDir).generationId, 'gen-1');

    // Simulate leftover incomplete .staging-crash directory -> ignored by reader
    const crashStaging = path.join(baseDir, 'generations', '.staging-crash');
    fs.mkdirSync(crashStaging, { recursive: true });
    fs.writeFileSync(path.join(crashStaging, 'taiwan_coverage.png'), makeFakePng('partial'));
    assert.equal(resolveCurrentCoverage(baseDir).generationId, 'gen-1');

    // Publish valid Generation 2 -> switches atomically
    const g2 = publishCoverageGeneration(baseDir, {
        pngBuffer: makeFakePng('gen2'),
        metadata: { station_count: 180, updated_at: '2026-11-19T04:00:00Z' },
        generationId: 'gen-2'
    });
    assert.equal(g2.generationId, 'gen-2');
    const resolved2 = resolveCurrentCoverage(baseDir);
    assert.equal(resolved2.generationId, 'gen-2');
    assert.equal(resolved2.metadata.station_count, 180);

    // Mismatched generationId inside JSON vs current.json -> rejected cleanly
    fs.writeFileSync(
        path.join(baseDir, 'generations', 'gen-2', 'taiwan_coverage.json'),
        JSON.stringify({ generationId: 'wrong-gen', station_count: 999 })
    );
    const mismatched = resolveCurrentCoverage(baseDir);
    assert.equal(mismatched.available, false);

    fs.rmSync(baseDir, { recursive: true, force: true });
});

test('Stage 2.2: Two coverage output directories stay consistent with shared generationId', () => {
    const root = makeTempDir('cov-dual-');
    const dirPublic = path.join(root, 'public', 'coverage');
    const dirFrontend = path.join(root, 'frontend', 'public', 'coverage');
    const genId = 'gen-shared-4032';
    const png = makeFakePng('dual-sync');
    const meta = { station_count: 185, updated_at: '2026-11-19T04:00:00Z' };

    publishCoverageGeneration(dirPublic, { pngBuffer: png, metadata: meta, generationId: genId });
    publishCoverageGeneration(dirFrontend, { pngBuffer: png, metadata: meta, generationId: genId });

    const r1 = resolveCurrentCoverage(dirPublic);
    const r2 = resolveCurrentCoverage(dirFrontend);
    assert.equal(r1.available, true);
    assert.equal(r2.available, true);
    assert.equal(r1.generationId, r2.generationId);

    fs.rmSync(root, { recursive: true, force: true });
});

test('Stage 3.1: Public /api/coverage/status hides stdout/stderr/paths/tokens while admin /api/coverage/diagnostics requires auth', async () => {
    const tmpDir = makeTempDir('cov-status-');
    const bakeScript = path.join(tmpDir, 'noisy-fail-bake.mjs');
    const lockDir = path.join(tmpDir, '.coverage_bake.lockdir');

    fs.writeFileSync(bakeScript, `
        console.log('SECRET_DB_PATH=D:\\\\meshtastic\\\\secret.db');
        console.error('INTERNAL_STACK: C:\\\\Users\\\\admin\\\\token=abc123');
        process.exit(1);
    `, 'utf8');

    const ctrl = new CoverageJobController({
        bakeScriptPath: bakeScript,
        lockDirPath: lockDir,
        heartbeatMs: 50
    });

    const launch = ctrl.startBake({ trigger: 'manual', limit: 15, heartbeatMs: 50 });
    await launch.completion;

    const app = express();
    const adminToken = 'admin-secret-4032';
    const requireAdmin = createRequireCoverageAdmin(() => adminToken);
    app.get('/api/coverage/status', (req, res) => res.json(ctrl.getStatus()));
    app.get('/api/coverage/diagnostics', requireAdmin, (req, res) => res.json(ctrl.getAdminDiagnostics()));

    const publicRes = await invokeExpress(app, { url: '/api/coverage/status' });
    assert.equal(publicRes.statusCode, 200);
    const serialized = JSON.stringify(publicRes.body);
    assert.equal(serialized.includes('stdout'), false);
    assert.equal(serialized.includes('stderr'), false);
    assert.equal(serialized.includes('SECRET_DB_PATH'), false);
    assert.equal(serialized.includes('INTERNAL_STACK'), false);
    assert.equal(serialized.includes('meshtastic'), false);
    assert.equal(publicRes.body.running, false);
    assert.equal(publicRes.body.status, 'FAILED');
    assert.ok(publicRes.body.startedAt);

    const unauthDiag = await invokeExpress(app, { url: '/api/coverage/diagnostics' });
    assert.equal(unauthDiag.statusCode, 401);

    const authDiag = await invokeExpress(app, {
        url: '/api/coverage/diagnostics',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(authDiag.statusCode, 200);
    assert.ok(authDiag.body.lastDiagnostics);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
