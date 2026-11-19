const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isValidPngBuffer(buf) {
    return Buffer.isBuffer(buf) && buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

function validatePngFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 24) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(8);
        const bytesRead = fs.readSync(fd, header, 0, 8, 0);
        return bytesRead === 8 && header.equals(PNG_SIGNATURE);
    } finally {
        fs.closeSync(fd);
    }
}

function validateJsonFile(filePath, expectedGenerationId) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        if (expectedGenerationId && parsed.generationId !== expectedGenerationId) return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function writeFileAtomic(targetPath, data, encoding) {
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}`;
    try {
        if (encoding) {
            fs.writeFileSync(tmpPath, data, encoding);
        } else {
            fs.writeFileSync(tmpPath, data);
        }
        fs.renameSync(tmpPath, targetPath);
    } catch (err) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
        throw err;
    }
}

/**
 * Publish a complete (PNG + JSON) coverage generation atomically via staging -> generation -> current.json.
 * Never updates current.json unless both PNG and JSON are verified and have matching generationId.
 */
function publishCoverageGeneration(baseDir, { pngBuffer, metadata, generationId, keepGenerations = 3 } = {}) {
    if (!isValidPngBuffer(pngBuffer)) {
        throw new Error('Invalid PNG buffer: missing PNG signature or truncated payload');
    }
    if (!metadata || typeof metadata !== 'object') {
        throw new Error('Invalid coverage metadata object');
    }

    const genId = generationId || `gen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const generationsDir = path.join(baseDir, 'generations');
    const stagingDir = path.join(generationsDir, `.staging-${genId}`);
    const finalGenDir = path.join(generationsDir, genId);

    fs.mkdirSync(generationsDir, { recursive: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const stagedPng = path.join(stagingDir, 'taiwan_coverage.png');
    const stagedJson = path.join(stagingDir, 'taiwan_coverage.json');
    const enrichedMeta = { ...metadata, generationId: genId };

    try {
        fs.writeFileSync(stagedPng, pngBuffer);
        fs.writeFileSync(stagedJson, JSON.stringify(enrichedMeta, null, 2), 'utf8');

        if (!validatePngFile(stagedPng)) {
            throw new Error('Staged PNG verification failed');
        }
        const verifiedMeta = validateJsonFile(stagedJson, genId);
        if (!verifiedMeta) {
            throw new Error('Staged JSON verification or generationId match failed');
        }

        fs.renameSync(stagingDir, finalGenDir);

        const finalPng = path.join(finalGenDir, 'taiwan_coverage.png');
        const finalJson = path.join(finalGenDir, 'taiwan_coverage.json');
        if (!validatePngFile(finalPng) || !validateJsonFile(finalJson, genId)) {
            throw new Error('Published generation verification failed');
        }

        const manifest = {
            generationId: genId,
            updatedAt: enrichedMeta.updated_at || new Date().toISOString(),
            pngFile: 'taiwan_coverage.png',
            jsonFile: 'taiwan_coverage.json'
        };
        writeFileAtomic(path.join(baseDir, 'current.json'), JSON.stringify(manifest, null, 2), 'utf8');

        // Keep legacy flat copies in sync for tools/Vite public copying, using atomic writes
        writeFileAtomic(path.join(baseDir, 'taiwan_coverage.png'), pngBuffer);
        writeFileAtomic(path.join(baseDir, 'taiwan_coverage.json'), JSON.stringify(enrichedMeta, null, 2), 'utf8');

        // Prune older generations beyond keepGenerations
        try {
            const entries = fs.readdirSync(generationsDir, { withFileTypes: true })
                .filter((d) => d.isDirectory() && !d.name.startsWith('.staging-') && d.name !== genId)
                .map((d) => ({
                    name: d.name,
                    mtimeMs: fs.statSync(path.join(generationsDir, d.name)).mtimeMs
                }))
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

            for (const old of entries.slice(Math.max(0, keepGenerations - 1))) {
                fs.rmSync(path.join(generationsDir, old.name), { recursive: true, force: true });
            }
        } catch (_) {}

        return { generationId: genId, manifest, pngPath: finalPng, jsonPath: finalJson };
    } catch (err) {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
        throw err;
    }
}

/**
 * Resolve the currently published coverage generation (PNG + JSON).
 * Only returns a generation if manifest, PNG, JSON, and matching generationId are all valid.
 */
function resolveCurrentCoverage(baseDir) {
    const manifestPath = path.join(baseDir, 'current.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest && manifest.generationId) {
                const genDir = path.join(baseDir, 'generations', manifest.generationId);
                const pngPath = path.join(genDir, manifest.pngFile || 'taiwan_coverage.png');
                const jsonPath = path.join(genDir, manifest.jsonFile || 'taiwan_coverage.json');
                const meta = validateJsonFile(jsonPath, manifest.generationId);
                if (meta && validatePngFile(pngPath)) {
                    return {
                        available: true,
                        source: 'generation',
                        generationId: manifest.generationId,
                        pngPath,
                        jsonPath,
                        metadata: meta
                    };
                }
            }
        } catch (_) {}
        return { available: false, reason: 'generation_integrity_failed' };
    }

    // Legacy fallback if current.json has not been created yet
    const legacyPng = path.join(baseDir, 'taiwan_coverage.png');
    const legacyJson = path.join(baseDir, 'taiwan_coverage.json');
    const legacyMeta = validateJsonFile(legacyJson, null);
    if (legacyMeta && validatePngFile(legacyPng)) {
        return {
            available: true,
            source: 'legacy',
            generationId: legacyMeta.generationId || null,
            pngPath: legacyPng,
            jsonPath: legacyJson,
            metadata: legacyMeta
        };
    }

    return { available: false };
}

module.exports = {
    PNG_SIGNATURE,
    isValidPngBuffer,
    validatePngFile,
    validateJsonFile,
    publishCoverageGeneration,
    resolveCurrentCoverage
};
