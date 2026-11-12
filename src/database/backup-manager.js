// src/database/backup-manager.js
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { backup: defaultBackupConfig } = require('./sqlite.config');
const { ADAPTER_STATES } = require('./sqlite.adapter');

const BACKUP_VERIFY_STATUS = {
    VALID: 'VALID',
    CORRUPTED: 'CORRUPTED',
    VERIFY_ERROR: 'VERIFY_ERROR'
};

const RESTORE_STATUS = {
    COMPLETED: 'RESTORE_COMPLETED',
    REJECTED_PRECONDITION: 'RESTORE_REJECTED_PRECONDITION',
    FAILED_ROLLED_BACK: 'RESTORE_FAILED_ROLLED_BACK',
    FAILED_ROLLBACK_INCOMPLETE: 'RESTORE_FAILED_ROLLBACK_INCOMPLETE'
};

// 追蹤程序內所有已綁定之 SQLiteAdapter 與其資料庫路徑，防止對任何線上活躍 DB 執行 Restore
const registeredAdapterEntries = new Set();

function _normalizeComparablePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return '';
    const resolved = path.resolve(inputPath);
    let canonical = resolved;
    try {
        if (fs.existsSync(resolved)) {
            canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
        } else {
            const parentDir = path.dirname(resolved);
            const baseName = path.basename(resolved);
            if (fs.existsSync(parentDir)) {
                const realParent = fs.realpathSync.native ? fs.realpathSync.native(parentDir) : fs.realpathSync(parentDir);
                canonical = path.join(realParent, baseName);
            }
        }
    } catch (_) {
        canonical = resolved;
    }
    const normalizedSlashes = canonical.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normalizedSlashes.toLowerCase() : normalizedSlashes;
}

class BackupManager {
    #adapter;
    #config;
    #backupDir;
    #backupInProgress = false;
    #inProgressBackupPaths = new Set();
    #verifiedBackups = new Set();
    #scheduledTask = null;
    #scheduledCronExpression = null;

    static registerAdapter(adapter, dbPath) {
        if (!adapter) return;
        for (const entry of registeredAdapterEntries) {
            if (entry.adapter === adapter) {
                if (dbPath) entry.dbPath = dbPath;
                return;
            }
        }
        registeredAdapterEntries.add({ adapter, dbPath: dbPath || adapter.dbPath || null });
    }

    constructor(adapter, backupDir, config = {}) {
        if (!adapter) {
            throw new Error('[BACKUP_INIT_ERROR] adapter 為必填');
        }
        this.#adapter = adapter;
        this.#backupDir = backupDir || path.join(process.cwd(), 'backups');
        this.#config = { ...defaultBackupConfig, ...config };
        this.lastBackupError = null;
        this.lastBackupResult = null;
        this.lastRestoreError = null;
        this.lastRestoreResult = null;

        BackupManager.registerAdapter(adapter, adapter.dbPath || (adapter.db && adapter.db.filename) || null);

        if (!fs.existsSync(this.#backupDir)) {
            fs.mkdirSync(this.#backupDir, { recursive: true });
        }
    }

    get backupDir() {
        return this.#backupDir;
    }

    get isBackupInProgress() {
        return this.#backupInProgress;
    }

    get isScheduleActive() {
        return this.#scheduledTask !== null;
    }

    get scheduledCronExpression() {
        return this.#scheduledCronExpression;
    }

    /**
     * 動態更新備份目錄 (例如環境變數 BACKUP_PATH 指定之目標目錄)
     */
    setBackupDir(newBackupDir) {
        if (!newBackupDir || typeof newBackupDir !== 'string' || newBackupDir.includes('\0')) {
            throw new Error('[BACKUP_CONFIG_ERROR] newBackupDir 必須為合法非空字串且不含 NUL 字元');
        }
        this.#backupDir = newBackupDir;
        if (!fs.existsSync(this.#backupDir)) {
            fs.mkdirSync(this.#backupDir, { recursive: true });
        }
    }

    /**
     * 4.0.1.1 P2: 嚴格驗證備份檔名與目錄邊界 (Backup Path Containment)
     * 拒絕 NUL 字元、../ 目錄穿越、絕對路徑、Windows 磁碟機路徑、UNC 路徑與任何子目錄分隔符，
     * 確保最終解析路徑嚴格位於指定 targetDir 目錄內。
     */
    validateBackupFilePath(filename, targetDir = this.#backupDir) {
        if (!filename || typeof filename !== 'string') {
            throw new Error('[BACKUP_PATH_CONTAINMENT_VIOLATION] 備份檔名必須為非空字串');
        }
        if (!targetDir || typeof targetDir !== 'string') {
            throw new Error('[BACKUP_PATH_CONTAINMENT_VIOLATION] 目標備份目錄必須為非空字串');
        }
        if (filename.includes('\0') || targetDir.includes('\0')) {
            throw new Error('[BACKUP_PATH_CONTAINMENT_VIOLATION] 備份路徑或檔名包含非法 NUL 空字元');
        }

        const trimmed = filename.trim();
        if (!trimmed || trimmed === '.' || trimmed === '..') {
            throw new Error(`[BACKUP_PATH_CONTAINMENT_VIOLATION] 非法的備份檔名: ${filename}`);
        }

        // 拒絕 Windows 磁碟機前綴 (如 C:foo 或 C:\foo)、UNC 路徑 (\\server\share 或 //server/share) 與絕對路徑
        if (
            /^[A-Za-z]:/.test(filename) ||
            filename.startsWith('\\\\') ||
            filename.startsWith('//') ||
            path.isAbsolute(filename) ||
            path.win32.isAbsolute(filename) ||
            path.posix.isAbsolute(filename)
        ) {
            throw new Error(`[BACKUP_PATH_CONTAINMENT_VIOLATION] 禁止使用絕對路徑、Windows 磁碟機路徑或 UNC 路徑作為備份檔名: ${filename}`);
        }

        // 僅接受單純檔名契約，禁止包含 / 或 \ 或 ..
        if (
            filename.includes('/') ||
            filename.includes('\\') ||
            filename.includes('..') ||
            path.basename(filename) !== filename ||
            path.win32.basename(filename) !== filename ||
            path.posix.basename(filename) !== filename
        ) {
            throw new Error(`[BACKUP_PATH_CONTAINMENT_VIOLATION] 備份檔名禁止包含目錄穿越 (../) 或路徑分隔符: ${filename}`);
        }

        const resolvedTargetDir = path.resolve(targetDir);
        const resolvedTargetPath = path.resolve(resolvedTargetDir, filename);
        const relativePath = path.relative(resolvedTargetDir, resolvedTargetPath);

        if (
            !relativePath ||
            relativePath === '' ||
            relativePath.startsWith('..') ||
            relativePath.includes('/') ||
            relativePath.includes('\\') ||
            path.isAbsolute(relativePath) ||
            path.win32.isAbsolute(relativePath) ||
            path.dirname(resolvedTargetPath) !== resolvedTargetDir
        ) {
            throw new Error(`[BACKUP_PATH_CONTAINMENT_VIOLATION] 解析後之備份路徑超出目標備份目錄範圍: ${resolvedTargetPath}`);
        }

        return {
            resolvedTargetDir,
            resolvedTargetPath,
            filename
        };
    }

    /**
     * 驗證備份檔案完整性 (P1-03 & 4.0.1 P1: 使用獨立唯讀連線檢查檔案存在、大小 > 0、可開啟、PRAGMA integrity_check === 'ok')
     */
    async verifyIntegrity(backupFilePath) {
        if (!backupFilePath || !fs.existsSync(backupFilePath)) {
            return { status: BACKUP_VERIFY_STATUS.VERIFY_ERROR, details: 'FILE_NOT_FOUND' };
        }

        let stats;
        try {
            stats = fs.statSync(backupFilePath);
        } catch (statErr) {
            return {
                status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                details: `STAT_FAILED: ${statErr.message}`
            };
        }

        if (!stats.isFile() || stats.size <= 0) {
            return {
                status: BACKUP_VERIFY_STATUS.CORRUPTED,
                details: `INVALID_FILE_SIZE: ${stats.size}`,
                sizeBytes: stats.size || 0
            };
        }

        return new Promise((resolve) => {
            let tempDb = null;
            try {
                tempDb = new sqlite3.Database(backupFilePath, sqlite3.OPEN_READONLY, (openErr) => {
                    if (openErr) {
                        return resolve({
                            status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                            details: `OPEN_FAILED: ${openErr.message}`,
                            sizeBytes: stats.size
                        });
                    }

                    tempDb.all('PRAGMA integrity_check', (checkErr, rows) => {
                        tempDb.close((closeErr) => {
                            if (closeErr) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: `CLOSE_FAILED: ${closeErr.message}`,
                                    sizeBytes: stats.size
                                });
                            }

                            if (checkErr) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: `QUERY_FAILED: ${checkErr.message}`,
                                    sizeBytes: stats.size
                                });
                            }

                            if (!Array.isArray(rows) || rows.length === 0) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: 'EMPTY_INTEGRITY_RESULT',
                                    sizeBytes: stats.size
                                });
                            }

                            const resultText = String(rows[0].integrity_check || '');
                            if (rows.length === 1 && resultText.toLowerCase() === 'ok') {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VALID,
                                    details: 'OK',
                                    sizeBytes: stats.size
                                });
                            } else {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.CORRUPTED,
                                    details: rows.map(r => r.integrity_check).join('; ') || resultText,
                                    sizeBytes: stats.size
                                });
                            }
                        });
                    });
                });
            } catch (err) {
                if (tempDb) {
                    try { tempDb.close(); } catch (_) {}
                }
                resolve({
                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                    details: `EXCEPTION: ${err.message}`,
                    sizeBytes: stats.size
                });
            }
        });
    }

    /**
     * 執行線上備份 (4.0.1.1 P1 — Backup Scheduler Isolation):
     * 1. 僅將建立 SQLite 一致性快照之 `VACUUM INTO` 放入 `adapter.maintenanceTask('ONLINE_BACKUP', ...)`。
     * 2. `VACUUM INTO` 完成後立即結束 `maintenanceTask` 並釋放 Scheduler，不阻塞後續 WriteQueue / API 讀寫。
     * 3. 在 `#backupInProgress` 與 `#inProgressBackupPaths` 完整生命週期保護下，以獨立唯讀連線執行 `verifyIntegrity()`、
     *    可回復式 staging rename 安裝與 `_rotateOldBackups()`。
     */
    async performBackup(customFileName = null, options = {}) {
        if (this.#backupInProgress) {
            if (options && options.skipIfRunning) {
                console.warn('⚠️ [BACKUP_SKIPPED_OVERLAP] 備份任務已在執行中，略過本次重疊觸發');
                return {
                    success: false,
                    skipped: true,
                    reason: 'BACKUP_ALREADY_IN_PROGRESS'
                };
            }
            throw new Error('[BACKUP_ALREADY_IN_PROGRESS] 備份任務已在執行中，禁止同時啟動多個 Backup Job');
        }

        const rawTargetDir = (options && options.backupDir) ? options.backupDir : this.#backupDir;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rawFilename = customFileName !== null && customFileName !== undefined
            ? customFileName
            : `backup-${timestamp}.db`;

        // P2: 執行路徑邊界安全驗證 (Path Containment)
        const { resolvedTargetDir, resolvedTargetPath: targetPath, filename } =
            this.validateBackupFilePath(rawFilename, rawTargetDir);

        if (!fs.existsSync(resolvedTargetDir)) {
            fs.mkdirSync(resolvedTargetDir, { recursive: true });
        }

        // 建立唯一 staging 路徑 (不以 .db 結尾，防止未完成或異常殘留檔被誤認為有效 .db 備份)
        const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const stagingPath = path.resolve(resolvedTargetDir, `.staging-${filename}-${uniqueSuffix}`);
        const renameFn = (options && typeof options.renameImpl === 'function')
            ? options.renameImpl
            : fs.renameSync;

        this.#backupInProgress = true;
        this.#inProgressBackupPaths.add(targetPath);
        this.#inProgressBackupPaths.add(stagingPath);

        try {
            // 階段 1: 僅將 VACUUM INTO 放入 adapter.maintenanceTask()，完成後立即釋放 Scheduler
            await this.#adapter.maintenanceTask('ONLINE_BACKUP', async (rawContext) => {
                console.log(`📦 [BACKUP] 開始建立線上一致性快照 (staging): ${stagingPath}`);

                if (fs.existsSync(stagingPath)) {
                    try { fs.unlinkSync(stagingPath); } catch (_) {}
                }

                try {
                    const escapedSqlPath = stagingPath.replace(/\\/g, '/').replace(/'/g, "''");
                    await rawContext.execute(`VACUUM INTO '${escapedSqlPath}'`);
                    if (!fs.existsSync(stagingPath)) {
                        throw new Error('[BACKUP_VACUUM_MISSING_OUTPUT] VACUUM INTO 完成後未產生目標快照檔案');
                    }
                } catch (vErr) {
                    console.warn(`⚠️ [BACKUP] VACUUM INTO 失敗 (${vErr.message})，正在清理不完整 staging 檔案...`);
                    this._cleanupFileAndSidecars(stagingPath);
                    this.lastBackupError = vErr;
                    this.lastBackupResult = {
                        success: false,
                        status: 'FAILED_VACUUM_INTO',
                        targetPath,
                        stagingPath,
                        stage: 'VACUUM_INTO',
                        error: vErr.message,
                        timestamp: new Date().toISOString()
                    };
                    throw vErr;
                }
            });

            // 此刻 adapter.maintenanceTask 已返回，SQLite Adapter Scheduler 已釋放 (maintenanceInProgress === false)，
            // 但 #backupInProgress 與 #inProgressBackupPaths 仍保持 active，保護整個備份後續流程。
            if (options && typeof options.afterVacuumBeforeVerify === 'function') {
                await options.afterVacuumBeforeVerify({ stagingPath, targetPath });
            }

            // 階段 2: 使用獨立唯讀 SQLite connection 對 staging 檔案執行完整性驗證
            const verify = await this.verifyIntegrity(stagingPath);
            if (verify.status !== BACKUP_VERIFY_STATUS.VALID) {
                console.error(`❌ [BACKUP_VERIFY_FAILED] 備份驗證未通過 (狀態: ${verify.status}):`, verify.details);

                let retainedInvalidPath = null;
                if (options && options.retainFailedStaging === true && fs.existsSync(stagingPath)) {
                    const invalidPath = path.resolve(resolvedTargetDir, `${filename}.failed-${uniqueSuffix}.invalid`);
                    try {
                        fs.renameSync(stagingPath, invalidPath);
                        retainedInvalidPath = invalidPath;
                    } catch (_) {
                        this._cleanupFileAndSidecars(stagingPath);
                    }
                } else {
                    this._cleanupFileAndSidecars(stagingPath);
                }

                const verifyErr = new Error(
                    `[BACKUP_VERIFY_FAILED] 備份完整性檢查失敗 (${verify.status}): ${verify.details}`
                );
                verifyErr.verify = verify;
                verifyErr.retainedInvalidPath = retainedInvalidPath;
                this.lastBackupError = verifyErr;
                this.lastBackupResult = {
                    success: false,
                    status: 'FAILED_VERIFICATION',
                    targetPath,
                    stagingPath,
                    retainedInvalidPath,
                    stage: 'VERIFY_INTEGRITY',
                    verify,
                    error: verifyErr.message,
                    timestamp: new Date().toISOString()
                };
                throw verifyErr;
            }

            // 階段 3: 將通過驗證的 staging 檔案安全安裝至正式備份路徑 (保護既有同名有效備份不被破壞)
            const existedBefore = fs.existsSync(targetPath);
            const rollbackPrevPath = existedBefore
                ? path.resolve(resolvedTargetDir, `.prev-${filename}-${uniqueSuffix}`)
                : null;

            try {
                if (existedBefore && rollbackPrevPath) {
                    fs.renameSync(targetPath, rollbackPrevPath);
                }
                renameFn(stagingPath, targetPath);
                if (rollbackPrevPath && fs.existsSync(rollbackPrevPath)) {
                    try { fs.unlinkSync(rollbackPrevPath); } catch (_) {}
                }
            } catch (renameErr) {
                // 若 rename 失敗且先前移開了舊的有效備份，立即將舊有效備份還原回 targetPath
                let previousBackupRestored = false;
                if (rollbackPrevPath && fs.existsSync(rollbackPrevPath) && !fs.existsSync(targetPath)) {
                    try {
                        fs.renameSync(rollbackPrevPath, targetPath);
                        previousBackupRestored = true;
                    } catch (_) {}
                }
                this._cleanupFileAndSidecars(stagingPath);

                const installErr = new Error(
                    `[BACKUP_INSTALL_FAILED] 將已驗證之 staging 備份安裝至目標路徑失敗: ${renameErr.message}`
                );
                installErr.cause = renameErr;
                installErr.previousBackupRestored = previousBackupRestored;
                this.lastBackupError = installErr;
                this.lastBackupResult = {
                    success: false,
                    status: 'FAILED_RENAME_INSTALL',
                    targetPath,
                    stagingPath,
                    previousBackupRestored,
                    stage: 'RENAME_INSTALL',
                    error: installErr.message,
                    timestamp: new Date().toISOString()
                };
                throw installErr;
            }

            this.#verifiedBackups.add(targetPath);
            this.#inProgressBackupPaths.delete(stagingPath);

            // 階段 4: 於 Scheduler 外執行舊備份掃描與輪替清理
            console.log(`✅ [BACKUP] 備份成功並通過完整性檢驗: ${targetPath}`);
            const rotation = await this._rotateOldBackups(resolvedTargetDir, targetPath);

            const result = {
                success: true,
                status: 'COMPLETED',
                targetPath,
                verify,
                rotation,
                timestamp: new Date().toISOString()
            };
            this.lastBackupError = null;
            this.lastBackupResult = result;
            return result;
        } finally {
            if (fs.existsSync(stagingPath)) {
                this._cleanupFileAndSidecars(stagingPath);
            }
            this.#inProgressBackupPaths.delete(stagingPath);
            this.#inProgressBackupPaths.delete(targetPath);
            this.#backupInProgress = false;
        }
    }

    _cleanupFileAndSidecars(filePath) {
        if (!filePath) return;
        for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (_) {}
        }
    }

    /**
     * 檢查指定目標路徑是否正由目前 Adapter 或程序內任何已註冊之 SQLiteAdapter 使用中
     */
    _findActiveAdapterUsingPath(resolvedTarget) {
        const targetNorm = _normalizeComparablePath(resolvedTarget);
        if (!targetNorm) return null;

        const candidates = new Set([
            {
                adapter: this.#adapter,
                dbPath: this.#adapter.dbPath || (this.#adapter.db && this.#adapter.db.filename) || null
            },
            ...registeredAdapterEntries
        ]);

        for (const entry of candidates) {
            const adp = entry.adapter;
            if (!adp) continue;
            const rawPath = adp.dbPath || (adp.db && adp.db.filename) || entry.dbPath || null;
            if (!rawPath || rawPath === ':memory:') continue;

            const adpNorm = _normalizeComparablePath(rawPath);
            if (adpNorm === targetNorm) {
                const status = typeof adp.getActiveStatus === 'function' ? adp.getActiveStatus() : {};
                const isClosedAndReleased =
                    adp.state === ADAPTER_STATES.CLOSED &&
                    !adp.db &&
                    !status.nativeClosePending;
                if (!isClosedAndReleased) {
                    return {
                        adapter: adp,
                        state: adp.state,
                        nativeClosePending: Boolean(status.nativeClosePending),
                        dbPath: rawPath
                    };
                }
            }
        }
        return null;
    }

    /**
     * 確認目標資料庫處於離線且未被鎖定狀態 (4.0.1.1 P1 Restore Precondition)
     */
    async _assertTargetDbOffline(resolvedTarget, options = {}) {
        // 1. 檢查是否為目前或任何程序內活躍 SQLiteAdapter 正在使用的路徑
        const activeMatch = this._findActiveAdapterUsingPath(resolvedTarget);
        if (activeMatch) {
            const err = new Error(
                `[BACKUP_RESTORE_ACTIVE_DB_FORBIDDEN] 目標路徑 (${resolvedTarget}) 正由活躍的 SQLiteAdapter 使用中 (state: ${activeMatch.state}, nativeClosePending: ${activeMatch.nativeClosePending})，禁止對線上資料庫執行 Restore`
            );
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            err.reason = 'ACTIVE_ADAPTER_DB_PATH';
            throw err;
        }

        // 2. 若呼叫端明確要求離線確認旗標但未提供，拒絕執行
        if (options && options.requireOfflineConfirmation === true && options.offlineConfirmed !== true) {
            const err = new Error(
                `[BACKUP_RESTORE_OFFLINE_REQUIRED] 目標資料庫還原要求明確確認離線狀態 (offlineConfirmed: true)`
            );
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            err.reason = 'OFFLINE_CONFIRMATION_MISSING';
            throw err;
        }

        // 3. 若目標檔案已存在於磁碟，透過 busy_timeout=0 + BEGIN EXCLUSIVE 探測是否被其他程序或未關閉連線持有鎖
        if (fs.existsSync(resolvedTarget)) {
            await new Promise((resolve, reject) => {
                const probeDb = new sqlite3.Database(resolvedTarget, sqlite3.OPEN_READWRITE, (openErr) => {
                    if (openErr) {
                        return reject(new Error(`[BACKUP_RESTORE_TARGET_UNAVAILABLE] 無法開啟目標資料庫以確認離線狀態: ${openErr.message}`));
                    }
                    probeDb.serialize(() => {
                        probeDb.run('PRAGMA busy_timeout = 0');
                        probeDb.run('BEGIN EXCLUSIVE TRANSACTION', (lockErr) => {
                            if (lockErr) {
                                return probeDb.close(() => {
                                    const busyErr = new Error(
                                        `[BACKUP_RESTORE_TARGET_BUSY_ONLINE] 目標資料庫 (${resolvedTarget}) 目前被其他連線或程序鎖定中 (${lockErr.message})，禁止執行線上覆蓋還原`
                                    );
                                    busyErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
                                    busyErr.reason = 'TARGET_DB_LOCKED_OR_ONLINE';
                                    reject(busyErr);
                                });
                            }
                            probeDb.run('ROLLBACK', () => {
                                probeDb.close((closeErr) => {
                                    if (closeErr) {
                                        return reject(new Error(`[BACKUP_RESTORE_TARGET_UNAVAILABLE] 關閉離線探測連線失敗: ${closeErr.message}`));
                                    }
                                    resolve();
                                });
                            });
                        });
                    });
                });
            });
        }
    }

    /**
     * 從已驗證之備份檔案安全還原至獨立離線目標資料庫路徑，並具備可回復 Rollback 保護 (4.0.1.1 P1 Restore Safety Hardening)
     */
    async restoreFromBackup(backupFilePath, targetRestoreDbPath, options = {}) {
        if (!backupFilePath || !targetRestoreDbPath || typeof backupFilePath !== 'string' || typeof targetRestoreDbPath !== 'string') {
            const err = new Error('[BACKUP_RESTORE_ERROR] backupFilePath 與 targetRestoreDbPath 皆為必填非空字串');
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }
        if (backupFilePath.includes('\0') || targetRestoreDbPath.includes('\0')) {
            const err = new Error('[BACKUP_RESTORE_ERROR] 路徑包含非法 NUL 字元');
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        const resolvedSource = path.resolve(backupFilePath);
        const resolvedTarget = path.resolve(targetRestoreDbPath);

        // Precondition 1: 目標路徑不能與來源備份路徑相同 (含正規化與不分大小寫比對)
        if (_normalizeComparablePath(resolvedSource) === _normalizeComparablePath(resolvedTarget)) {
            const err = new Error('[BACKUP_RESTORE_ERROR] 來源備份路徑與目標還原路徑不得相同');
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        // Precondition 2: 目標路徑不得是正在進行中之備份路徑
        if (this.#inProgressBackupPaths.has(resolvedTarget) || this.#inProgressBackupPaths.has(resolvedSource)) {
            const err = new Error('[BACKUP_RESTORE_REJECTED] 來源或目標路徑正在執行備份作業中，禁止同時還原');
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        // Precondition 3: 目標路徑不得為現有活躍 Adapter 使用中之 DB，且必須處於離線狀態
        try {
            await this._assertTargetDbOffline(resolvedTarget, options);
        } catch (preErr) {
            this.lastRestoreError = preErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: preErr.restoreStatus || RESTORE_STATUS.REJECTED_PRECONDITION,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: preErr.message,
                timestamp: new Date().toISOString()
            };
            throw preErr;
        }

        // Precondition 4: 來源備份檔必須存在且通過完整性驗證
        const sourceVerify = await this.verifyIntegrity(resolvedSource);
        if (sourceVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
            const err = new Error(
                `[BACKUP_RESTORE_REJECTED] 來源備份未通過完整性檢驗 (${sourceVerify.status}): ${sourceVerify.details}`
            );
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: RESTORE_STATUS.REJECTED_PRECONDITION,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            throw err;
        }

        const targetDir = path.dirname(resolvedTarget);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // Step 1: 在目標 DB 同一目錄 (同一檔案系統) 建立唯一 staging DB
        const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const stagingRestorePath = path.resolve(targetDir, `.restore-staging-${path.basename(resolvedTarget)}-${uniqueSuffix}`);
        this._cleanupFileAndSidecars(stagingRestorePath);

        try {
            await new Promise((resolve, reject) => {
                const sourceDb = new sqlite3.Database(resolvedSource, sqlite3.OPEN_READONLY, (openErr) => {
                    if (openErr) {
                        return reject(new Error(`[BACKUP_RESTORE_ERROR] 開啟來源備份失敗: ${openErr.message}`));
                    }
                    const escapedStaging = stagingRestorePath.replace(/\\/g, '/').replace(/'/g, "''");
                    sourceDb.run(`VACUUM INTO '${escapedStaging}'`, (vacErr) => {
                        sourceDb.close((closeErr) => {
                            if (vacErr) {
                                this._cleanupFileAndSidecars(stagingRestorePath);
                                return reject(new Error(`[BACKUP_RESTORE_ERROR] 建立還原 staging DB 失敗: ${vacErr.message}`));
                            }
                            if (closeErr) {
                                this._cleanupFileAndSidecars(stagingRestorePath);
                                return reject(new Error(`[BACKUP_RESTORE_ERROR] 關閉來源備份失敗: ${closeErr.message}`));
                            }
                            resolve();
                        });
                    });
                });
            });
        } catch (stageErr) {
            stageErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = stageErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: RESTORE_STATUS.REJECTED_PRECONDITION,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: stageErr.message,
                timestamp: new Date().toISOString()
            };
            throw stageErr;
        }

        // Step 2: 驗證 staging DB 完整性
        const stagingVerify = await this.verifyIntegrity(stagingRestorePath);
        if (stagingVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
            this._cleanupFileAndSidecars(stagingRestorePath);
            const err = new Error(
                `[BACKUP_RESTORE_VERIFY_FAILED] 還原 staging DB 未通過完整性檢驗 (${stagingVerify.status}): ${stagingVerify.details}`
            );
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: RESTORE_STATUS.REJECTED_PRECONDITION,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            throw err;
        }

        // Step 3: 替換前再次確認目標 DB 離線且未被活躍 Adapter 使用
        try {
            await this._assertTargetDbOffline(resolvedTarget, options);
        } catch (recheckErr) {
            this._cleanupFileAndSidecars(stagingRestorePath);
            this.lastRestoreError = recheckErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: recheckErr.restoreStatus || RESTORE_STATUS.REJECTED_PRECONDITION,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: recheckErr.message,
                timestamp: new Date().toISOString()
            };
            throw recheckErr;
        }

        // Step 4: 將原始目標 DB 與其 -wal / -shm sidecar 移至可回復之 rollback 路徑 (絕不先行直接刪除)
        const targetFilesToProtect = [
            { original: resolvedTarget, rollback: `${resolvedTarget}.rollback-${uniqueSuffix}` },
            { original: `${resolvedTarget}-wal`, rollback: `${resolvedTarget}-wal.rollback-${uniqueSuffix}` },
            { original: `${resolvedTarget}-shm`, rollback: `${resolvedTarget}-shm.rollback-${uniqueSuffix}` }
        ];
        const movedRollbacks = [];
        const renameFn = (options && typeof options.renameImpl === 'function')
            ? options.renameImpl
            : fs.renameSync;

        try {
            for (const item of targetFilesToProtect) {
                if (fs.existsSync(item.original)) {
                    fs.renameSync(item.original, item.rollback);
                    movedRollbacks.push(item);
                }
            }
        } catch (moveOriginalErr) {
            // 若移動原始 DB 或 WAL/SHM 失敗，立即按反序回復已移動之檔案
            const rollbackErrors = [];
            for (let i = movedRollbacks.length - 1; i >= 0; i--) {
                const moved = movedRollbacks[i];
                try {
                    if (fs.existsSync(moved.rollback)) {
                        fs.renameSync(moved.rollback, moved.original);
                    }
                } catch (rbErr) {
                    rollbackErrors.push(`${moved.rollback} -> ${moved.original}: ${rbErr.message}`);
                }
            }
            this._cleanupFileAndSidecars(stagingRestorePath);

            const status = rollbackErrors.length === 0
                ? RESTORE_STATUS.FAILED_ROLLED_BACK
                : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;
            const err = new Error(
                `[BACKUP_RESTORE_PREPARE_FAILED] 備份原始目標檔案至 rollback 路徑時失敗 (${moveOriginalErr.message}) | 狀態: ${status}`
            );
            err.restoreStatus = status;
            err.rollbackSucceeded = rollbackErrors.length === 0;
            err.rollbackErrors = rollbackErrors;
            this.lastRestoreError = err;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: status,
                rollbackSucceeded: rollbackErrors.length === 0,
                rollbackErrors,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            throw err;
        }

        // Step 5: 將已驗證的 staging DB 安裝至目標路徑並驗證替換成功，若失敗則自動執行 Rollback
        try {
            if (options && typeof options.beforeFinalInstall === 'function') {
                await options.beforeFinalInstall({ stagingRestorePath, resolvedTarget, movedRollbacks });
            }

            renameFn(stagingRestorePath, resolvedTarget);

            const installedVerify = await this.verifyIntegrity(resolvedTarget);
            if (installedVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
                throw new Error(
                    `[BACKUP_RESTORE_POST_INSTALL_INVALID] 安裝後目標資料庫驗證失敗 (${installedVerify.status}): ${installedVerify.details}`
                );
            }

            // Step 6: 確認替換與驗證完全成功後，才清理 rollback 檔案
            const cleanupWarnings = [];
            for (const moved of movedRollbacks) {
                try {
                    if (fs.existsSync(moved.rollback)) {
                        fs.unlinkSync(moved.rollback);
                    }
                } catch (unlinkErr) {
                    cleanupWarnings.push(`${moved.rollback}: ${unlinkErr.message}`);
                }
            }

            const result = {
                success: true,
                restoreStatus: RESTORE_STATUS.COMPLETED,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                hadExistingTarget: movedRollbacks.length > 0,
                cleanupWarnings,
                verify: installedVerify,
                timestamp: new Date().toISOString()
            };
            this.lastRestoreError = null;
            this.lastRestoreResult = result;
            return result;
        } catch (installErr) {
            // 中途失敗：移除不完整的目標檔並將 rollback 檔案完整復原回原始路徑
            try {
                if (fs.existsSync(resolvedTarget) && movedRollbacks.length > 0) {
                    fs.unlinkSync(resolvedTarget);
                }
            } catch (_) {}

            const rollbackErrors = [];
            for (let i = movedRollbacks.length - 1; i >= 0; i--) {
                const moved = movedRollbacks[i];
                try {
                    if (fs.existsSync(moved.rollback)) {
                        fs.renameSync(moved.rollback, moved.original);
                    }
                } catch (rbErr) {
                    rollbackErrors.push(`${moved.rollback} -> ${moved.original}: ${rbErr.message}`);
                }
            }

            this._cleanupFileAndSidecars(stagingRestorePath);

            const rollbackSucceeded = rollbackErrors.length === 0;
            const status = rollbackSucceeded
                ? RESTORE_STATUS.FAILED_ROLLED_BACK
                : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;

            const finalErr = new Error(
                `[BACKUP_RESTORE_INSTALL_FAILED] 還原替換失敗 (${installErr.message}) | 回復狀態: ${status}`
            );
            finalErr.cause = installErr;
            finalErr.restoreStatus = status;
            finalErr.rollbackSucceeded = rollbackSucceeded;
            finalErr.rollbackErrors = rollbackErrors;
            finalErr.preservedRollbackPaths = rollbackSucceeded ? [] : movedRollbacks.map(m => m.rollback);

            this.lastRestoreError = finalErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: status,
                rollbackSucceeded,
                rollbackErrors,
                preservedRollbackPaths: finalErr.preservedRollbackPaths,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: finalErr.message,
                timestamp: new Date().toISOString()
            };
            throw finalErr;
        }
    }

    /**
     * 清理過期或超額備份 (4.0.1 P1: 僅清理已驗證成功之備份、絕不刪除唯一可用備份、絕不刪除建立中備份)
     */
    async _rotateOldBackups(targetDir = this.#backupDir, latestVerifiedPath = null) {
        try {
            const retentionDays = typeof this.#config.retentionDays === 'number'
                ? this.#config.retentionDays
                : 30;
            const maxBackups = typeof this.#config.maxBackups === 'number' && this.#config.maxBackups >= 1
                ? Math.floor(this.#config.maxBackups)
                : null;
            const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

            const files = fs.readdirSync(targetDir);
            const verifiedCandidates = [];

            for (const file of files) {
                if (!file.endsWith('.db')) continue;
                if (file.startsWith('.staging-') || file.startsWith('.prev-') || file.startsWith('.restore-staging-')) continue;
                const fullPath = path.resolve(targetDir, file);

                // 絕不碰觸正在建立中的備份
                if (this.#inProgressBackupPaths.has(fullPath)) continue;

                let stats;
                try {
                    stats = fs.statSync(fullPath);
                } catch (_) {
                    continue;
                }
                if (!stats.isFile() || stats.size <= 0) continue;

                // 只將已驗證成功之備份納入保留計數與清理候選
                let isVerified = this.#verifiedBackups.has(fullPath) || (latestVerifiedPath && fullPath === path.resolve(latestVerifiedPath));
                if (!isVerified) {
                    const check = await this.verifyIntegrity(fullPath);
                    if (check.status === BACKUP_VERIFY_STATUS.VALID) {
                        this.#verifiedBackups.add(fullPath);
                        isVerified = true;
                    }
                }

                if (isVerified) {
                    verifiedCandidates.push({
                        file,
                        fullPath,
                        mtimeMs: stats.mtimeMs
                    });
                }
            }

            // 若有效備份數 <= 1，絕不刪除唯一可用備份
            if (verifiedCandidates.length <= 1) {
                return { retainedCount: verifiedCandidates.length, deletedFiles: [] };
            }

            // 依修改時間由新到舊排序 (index 0 為最新有效備份，永遠保留)
            verifiedCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

            const deletedFiles = [];
            let remainingValidCount = verifiedCandidates.length;

            // 由最舊往較新方向依序檢查刪除，確保保留順序與最低 1 份可用備份
            for (let i = verifiedCandidates.length - 1; i >= 1; i--) {
                if (remainingValidCount <= 1) break;

                const candidate = verifiedCandidates[i];
                const expiredByAge = candidate.mtimeMs < cutoffTime;
                const exceededMaxCount = maxBackups !== null && i >= maxBackups;

                if (expiredByAge || exceededMaxCount) {
                    try {
                        fs.unlinkSync(candidate.fullPath);
                        this.#verifiedBackups.delete(candidate.fullPath);
                        remainingValidCount--;
                        deletedFiles.push(candidate.file);
                        console.log(`🗑️ [BACKUP_ROTATE] 已清除舊備份: ${candidate.file}`);
                    } catch (unlinkErr) {
                        console.warn(`⚠️ [BACKUP_ROTATE_WARN] 刪除舊備份 ${candidate.file} 失敗:`, unlinkErr.message);
                    }
                }
            }

            return { retainedCount: remainingValidCount, deletedFiles };
        } catch (err) {
            console.warn('⚠️ [BACKUP_ROTATE_WARN] 清理過期備份遭遇警告:', err.message);
            return { retainedCount: 0, deletedFiles: [], error: err.message };
        }
    }

    /**
     * 排程觸發入口 (4.0.1 P1: 具備防重疊、Shutdown 狀態保護與錯誤隔離，絕不使主服務崩潰)
     */
    async triggerScheduledBackup(customFileName = null, options = {}) {
        if (this.#backupInProgress) {
            console.warn('⚠️ [BACKUP_SCHEDULER] 上一次備份尚未完成，跳過本次排程觸發以防重疊');
            return {
                success: false,
                skipped: true,
                reason: 'BACKUP_ALREADY_IN_PROGRESS'
            };
        }

        if (this.#adapter.state !== ADAPTER_STATES.READY) {
            console.warn(`⚠️ [BACKUP_SCHEDULER] Adapter 狀態非 READY (${this.#adapter.state})，跳過排程備份`);
            return {
                success: false,
                skipped: true,
                reason: `ADAPTER_NOT_READY_${this.#adapter.state}`
            };
        }

        try {
            const res = await this.performBackup(customFileName, {
                ...options,
                skipIfRunning: true
            });
            return res;
        } catch (err) {
            this.lastBackupError = err;
            console.error('❌ [BACKUP_SCHEDULER_ERROR] 定期自動備份執行失敗:', err.message);
            return {
                success: false,
                skipped: false,
                error: err.message
            };
        }
    }

    /**
     * 綁定定時備份排程 (防止重複註冊排程)
     */
    startSchedule(cronExpression = null, cronLib = null, backupTaskOptions = {}) {
        if (this.#scheduledTask) {
            return this.#scheduledTask;
        }

        const scheduleExpr = cronExpression || this.#config.cronSchedule || '0 0 * * 0';
        const scheduler = cronLib || require('node-cron');

        this.#scheduledCronExpression = scheduleExpr;
        this.#scheduledTask = scheduler.schedule(scheduleExpr, () => {
            if (typeof backupTaskOptions.shouldRun === 'function' && !backupTaskOptions.shouldRun()) {
                return;
            }
            const fileName = typeof backupTaskOptions.fileNameProvider === 'function'
                ? backupTaskOptions.fileNameProvider()
                : null;
            const runOpts = typeof backupTaskOptions.optionsProvider === 'function'
                ? backupTaskOptions.optionsProvider()
                : {};
            this.triggerScheduledBackup(fileName, runOpts).catch(() => {});
        });

        return this.#scheduledTask;
    }

    stopSchedule() {
        if (this.#scheduledTask) {
            try {
                if (typeof this.#scheduledTask.stop === 'function') {
                    this.#scheduledTask.stop();
                }
            } catch (_) {}
            this.#scheduledTask = null;
            this.#scheduledCronExpression = null;
        }
    }
}

module.exports = {
    BackupManager,
    BACKUP_VERIFY_STATUS,
    RESTORE_STATUS
};
