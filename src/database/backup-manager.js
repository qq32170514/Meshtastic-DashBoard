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
    FAILED_INSTALL_ABORTED: 'RESTORE_FAILED_INSTALL_ABORTED',
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
    #verifiedBackupSeqMap = new Map();
    #backupSeqCounter = 0;
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
     * 取得目前正在執行中之備份保護路徑清單快照 (唯讀診斷與測試驗證用)
     */
    getInProgressBackupPaths() {
        return Array.from(this.#inProgressBackupPaths);
    }

    /**
     * 取得目前已通過驗證之有效備份路徑清單快照 (唯讀診斷與測試驗證用)
     */
    getVerifiedBackups() {
        return Array.from(this.#verifiedBackups);
    }

    _markBackupVerified(fullPath) {
        const resolved = path.resolve(fullPath);
        this.#verifiedBackups.add(resolved);
        this.#backupSeqCounter++;
        this.#verifiedBackupSeqMap.set(resolved, this.#backupSeqCounter);
    }

    _unmarkBackupVerified(fullPath) {
        const resolved = path.resolve(fullPath);
        this.#verifiedBackups.delete(resolved);
        this.#verifiedBackupSeqMap.delete(resolved);
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
        const unlinkFn = (options && typeof options.unlinkImpl === 'function')
            ? options.unlinkImpl
            : fs.unlinkSync;
        const lstatFn = (options && typeof options.lstatImpl === 'function')
            ? options.lstatImpl
            : fs.lstatSync;
        const cleanupOpts = { unlinkImpl: unlinkFn, lstatImpl: lstatFn };
        let lastStagingCleanup = null;

        this.#backupInProgress = true;
        this.#inProgressBackupPaths.add(targetPath);
        this.#inProgressBackupPaths.add(stagingPath);

        try {
            // 階段 1: 僅將 VACUUM INTO 放入 adapter.maintenanceTask()，完成後立即釋放 Scheduler
            await this.#adapter.maintenanceTask('ONLINE_BACKUP', async (rawContext) => {
                console.log(`📦 [BACKUP] 開始建立線上一致性快照 (staging): ${stagingPath}`);

                this._cleanupFileAndSidecars(stagingPath, cleanupOpts);

                try {
                    const escapedSqlPath = stagingPath.replace(/\\/g, '/').replace(/'/g, "''");
                    await rawContext.execute(`VACUUM INTO '${escapedSqlPath}'`);
                    if (this._inspectPathExistence(stagingPath, lstatFn).state !== 'PRESENT') {
                        throw new Error('[BACKUP_VACUUM_MISSING_OUTPUT] VACUUM INTO 完成後未產生目標快照檔案');
                    }
                } catch (vErr) {
                    console.warn(`⚠️ [BACKUP] VACUUM INTO 失敗 (${vErr.message})，正在清理不完整 staging 檔案...`);
                    const stagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                    lastStagingCleanup = stagingCleanup;
                    this._attachBackupCleanupDiagnostics(vErr, stagingCleanup);
                    this.lastBackupError = vErr;
                    this.lastBackupResult = {
                        success: false,
                        status: 'FAILED_VACUUM_INTO',
                        targetPath,
                        stagingPath,
                        stage: 'VACUUM_INTO',
                        error: vErr.message,
                        cleanupComplete: stagingCleanup.complete,
                        cleanupResult: stagingCleanup,
                        cleanupFailures: stagingCleanup.failures,
                        remainingPaths: [...stagingCleanup.remainingPaths],
                        unverifiablePaths: [...stagingCleanup.unverifiablePaths],
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
                let retainRenameError = null;
                let stagingCleanup = null;
                if (
                    options &&
                    options.retainFailedStaging === true &&
                    this._inspectPathExistence(stagingPath, lstatFn).state === 'PRESENT'
                ) {
                    const invalidPath = path.resolve(resolvedTargetDir, `${filename}.failed-${uniqueSuffix}.invalid`);
                    try {
                        renameFn(stagingPath, invalidPath);
                        retainedInvalidPath = invalidPath;
                        stagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                    } catch (retainErr) {
                        retainRenameError = retainErr;
                        stagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                    }
                } else {
                    stagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                }
                lastStagingCleanup = stagingCleanup;

                const verifyErr = new Error(
                    `[BACKUP_VERIFY_FAILED] 備份完整性檢查失敗 (${verify.status}): ${verify.details}`
                );
                verifyErr.verify = verify;
                verifyErr.retainedInvalidPath = retainedInvalidPath;
                if (retainRenameError) {
                    verifyErr.retainRenameError = retainRenameError;
                }
                this._attachBackupCleanupDiagnostics(verifyErr, stagingCleanup);
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
                    cleanupComplete: stagingCleanup.complete,
                    cleanupResult: stagingCleanup,
                    cleanupFailures: stagingCleanup.failures,
                    remainingPaths: [...stagingCleanup.remainingPaths],
                    unverifiablePaths: [...stagingCleanup.unverifiablePaths],
                    timestamp: new Date().toISOString()
                };
                throw verifyErr;
            }

            // 階段 3: 將通過驗證的 staging 檔案安全安裝至正式備份路徑 (保護既有同名有效備份不被破壞)
            const existedBefore = this._inspectPathExistence(targetPath, lstatFn).state === 'PRESENT';
            const rollbackPrevPath = existedBefore
                ? path.resolve(resolvedTargetDir, `.prev-${filename}-${uniqueSuffix}`)
                : null;

            try {
                if (existedBefore && rollbackPrevPath) {
                    fs.renameSync(targetPath, rollbackPrevPath);
                }
                renameFn(stagingPath, targetPath);
                if (rollbackPrevPath && this._inspectPathExistence(rollbackPrevPath, lstatFn).state === 'PRESENT') {
                    try { unlinkFn(rollbackPrevPath); } catch (_) {}
                }
            } catch (renameErr) {
                // 若 rename 失敗且先前移開了舊的有效備份，立即將舊有效備份還原回 targetPath
                let previousBackupRestored = false;
                if (
                    rollbackPrevPath &&
                    this._inspectPathExistence(rollbackPrevPath, lstatFn).state === 'PRESENT' &&
                    this._inspectPathExistence(targetPath, lstatFn).state === 'ABSENT'
                ) {
                    try {
                        fs.renameSync(rollbackPrevPath, targetPath);
                        previousBackupRestored = true;
                    } catch (_) {}
                }
                const stagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                lastStagingCleanup = stagingCleanup;

                const installErr = new Error(
                    `[BACKUP_INSTALL_FAILED] 將已驗證之 staging 備份安裝至目標路徑失敗: ${renameErr.message}`
                );
                installErr.cause = renameErr;
                installErr.originalError = renameErr;
                if (renameErr && renameErr.code) {
                    installErr.originalCode = renameErr.code;
                }
                installErr.previousBackupRestored = previousBackupRestored;
                this._attachBackupCleanupDiagnostics(installErr, stagingCleanup);
                this.lastBackupError = installErr;
                this.lastBackupResult = {
                    success: false,
                    status: 'FAILED_RENAME_INSTALL',
                    targetPath,
                    stagingPath,
                    previousBackupRestored,
                    stage: 'RENAME_INSTALL',
                    error: installErr.message,
                    cleanupComplete: stagingCleanup.complete,
                    cleanupResult: stagingCleanup,
                    cleanupFailures: stagingCleanup.failures,
                    remainingPaths: [...stagingCleanup.remainingPaths],
                    unverifiablePaths: [...stagingCleanup.unverifiablePaths],
                    timestamp: new Date().toISOString()
                };
                throw installErr;
            }

            this._markBackupVerified(targetPath);
            this.#inProgressBackupPaths.delete(stagingPath);

            // 確認成功安裝後 stagingPath 及其 sidecars 已無殘留並保存結構化清理結果
            const postInstallStagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
            lastStagingCleanup = postInstallStagingCleanup;

            if (options && typeof options.beforeRotation === 'function') {
                await options.beforeRotation({ targetPath });
            }

            // 階段 4: 於 Scheduler 外執行舊備份掃描與輪替清理
            // 注意：此時 targetPath 仍位於 #inProgressBackupPaths 中受保護，同時由 _rotateOldBackups 明確識別
            // 納入有效備份總數計算一次且標記為本輪不可刪除。
            console.log(`✅ [BACKUP] 備份成功並通過完整性檢驗: ${targetPath}`);
            const rotation = await this._rotateOldBackups(resolvedTargetDir, targetPath);

            const result = {
                success: true,
                status: 'COMPLETED',
                targetPath,
                verify,
                rotation,
                cleanupComplete: postInstallStagingCleanup.complete,
                cleanupResult: postInstallStagingCleanup,
                cleanupFailures: postInstallStagingCleanup.failures,
                remainingPaths: [...postInstallStagingCleanup.remainingPaths],
                unverifiablePaths: [...postInstallStagingCleanup.unverifiablePaths],
                timestamp: new Date().toISOString()
            };
            this.lastBackupError = null;
            this.lastBackupResult = result;
            return result;
        } finally {
            if (!lastStagingCleanup) {
                lastStagingCleanup = this._cleanupFileAndSidecars(stagingPath, cleanupOpts);
                if (this.lastBackupError && !this.lastBackupError.cleanupResult) {
                    this._attachBackupCleanupDiagnostics(this.lastBackupError, lastStagingCleanup);
                }
                if (this.lastBackupResult && !this.lastBackupResult.cleanupResult) {
                    this.lastBackupResult.cleanupComplete = lastStagingCleanup.complete;
                    this.lastBackupResult.cleanupResult = lastStagingCleanup;
                    this.lastBackupResult.cleanupFailures = lastStagingCleanup.failures;
                    this.lastBackupResult.remainingPaths = [...lastStagingCleanup.remainingPaths];
                    this.lastBackupResult.unverifiablePaths = [...lastStagingCleanup.unverifiablePaths];
                }
            }
            if (!lastStagingCleanup.complete) {
                console.warn(
                    `⚠️ [BACKUP_STAGING_CLEANUP_WARN] 備份 staging 清理未完全確認成功 (remaining: ${lastStagingCleanup.remainingPaths.join(', ') || 'none'}, unverifiable: ${lastStagingCleanup.unverifiablePaths.join(', ') || 'none'})`
                );
            }
            this.#inProgressBackupPaths.delete(stagingPath);
            this.#inProgressBackupPaths.delete(targetPath);
            this.#backupInProgress = false;
        }
    }

    /**
     * 將結構化 Cleanup Result 附加至 Backup/Restore 錯誤物件，且不覆蓋原始錯誤之 message/code/stack/cause
     */
    _attachBackupCleanupDiagnostics(targetErr, cleanupResult) {
        if (!targetErr || !cleanupResult) return;
        targetErr.cleanupComplete = cleanupResult.complete;
        targetErr.cleanupResult = cleanupResult;
        targetErr.cleanupFailures = cleanupResult.failures;
        targetErr.remainingPaths = [...cleanupResult.remainingPaths];
        targetErr.unverifiablePaths = [...(cleanupResult.unverifiablePaths || [])];
    }

    /**
     * 使用 lstatSync 精確檢查檔案存在性與狀態 (4.0.1.4 P2 — Cleanup State Verification):
     * 明確區分三種狀態：
     * - 'PRESENT': 成功取得檔案資訊，檔案確實存在於磁碟
     * - 'ABSENT': lstat 拋出 ENOENT，確認檔案確實不存在
     * - 'UNKNOWN': lstat 拋出 EPERM / EACCES / EIO 等其他錯誤，無法確認檔案是否存在
     */
    _inspectPathExistence(filePath, lstatFn = fs.lstatSync) {
        try {
            const stats = lstatFn(filePath);
            return {
                state: 'PRESENT',
                exists: true,
                confirmedAbsent: false,
                unverifiable: false,
                stats,
                error: null
            };
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                return {
                    state: 'ABSENT',
                    exists: false,
                    confirmedAbsent: true,
                    unverifiable: false,
                    stats: null,
                    error: null
                };
            }
            return {
                state: 'UNKNOWN',
                exists: false,
                confirmedAbsent: false,
                unverifiable: true,
                stats: null,
                error: {
                    path: filePath,
                    code: (err && err.code) ? String(err.code) : 'CLEANUP_STAT_FAILED',
                    message: (err && err.message) ? String(err.message) : String(err)
                }
            };
        }
    }

    /**
     * 安全清理指定資料庫檔案及其 `-wal` / `-shm` sidecars，並回傳可觀測之結構化清理結果
     * (4.0.1.3 P2 & 4.0.1.4 P2 — Cleanup State Verification):
     * - 改用 `lstatSync` (`_inspectPathExistence`) 取代 `fs.existsSync()`，嚴格區分：
     *   1. `ENOENT` -> 歸類為 `alreadyAbsent`
     *   2. 成功取得檔案資訊 -> 執行 `unlink`，並在 `unlink` 後再次以 `lstat` 驗證是否確實不存在
     *   3. `EPERM`、`EACCES` 等非 `ENOENT` 錯誤 -> 記錄至 `failures` 與 `unverifiablePaths`，絕不誤判為 `alreadyAbsent`
     * - 只有當所有候選檔案均確認已不存在 (`alreadyAbsent.length + removed.length === candidatePaths.length`)，
     *   且 `failures`、`remainingPaths`、`unverifiablePaths` 皆為空時，才回報 `complete: true`。
     */
    _cleanupFileAndSidecars(filePath, options = {}) {
        const result = {
            complete: true,
            attempted: [],
            removed: [],
            alreadyAbsent: [],
            failures: [],
            remainingPaths: [],
            unverifiablePaths: []
        };
        if (!filePath || typeof filePath !== 'string') {
            return result;
        }

        const resolvedBase = path.resolve(filePath);
        const unlinkFn = (options && typeof options.unlinkImpl === 'function')
            ? options.unlinkImpl
            : fs.unlinkSync;
        const lstatFn = (options && typeof options.lstatImpl === 'function')
            ? options.lstatImpl
            : fs.lstatSync;
        const candidatePaths = [
            resolvedBase,
            `${resolvedBase}-wal`,
            `${resolvedBase}-shm`
        ];

        for (const p of candidatePaths) {
            result.attempted.push(p);
            const preCheck = this._inspectPathExistence(p, lstatFn);

            if (preCheck.state === 'ABSENT') {
                result.alreadyAbsent.push(p);
                continue;
            }

            if (preCheck.state === 'UNKNOWN') {
                result.failures.push({
                    path: p,
                    code: preCheck.error.code,
                    message: preCheck.error.message,
                    stage: 'PRE_UNLINK_STAT'
                });
                if (!result.unverifiablePaths.includes(p)) {
                    result.unverifiablePaths.push(p);
                }
                continue;
            }

            // preCheck.state === 'PRESENT' -> 執行 unlink 並再次確認檔案狀態
            try {
                unlinkFn(p);
                const postCheck = this._inspectPathExistence(p, lstatFn);
                if (postCheck.state === 'ABSENT') {
                    result.removed.push(p);
                } else if (postCheck.state === 'PRESENT') {
                    result.failures.push({
                        path: p,
                        code: 'CLEANUP_STILL_EXISTS',
                        message: `檔案於執行 unlink 後仍殘留於磁碟: ${p}`,
                        stage: 'POST_UNLINK_STAT'
                    });
                    if (!result.remainingPaths.includes(p)) {
                        result.remainingPaths.push(p);
                    }
                } else {
                    result.failures.push({
                        path: p,
                        code: postCheck.error.code,
                        message: `檔案於執行 unlink 後無法確認是否存在: ${postCheck.error.message}`,
                        stage: 'POST_UNLINK_STAT'
                    });
                    if (!result.unverifiablePaths.includes(p)) {
                        result.unverifiablePaths.push(p);
                    }
                }
            } catch (err) {
                const postCheck = this._inspectPathExistence(p, lstatFn);
                if (err && err.code === 'ENOENT' && postCheck.state === 'ABSENT') {
                    result.alreadyAbsent.push(p);
                } else {
                    result.failures.push({
                        path: p,
                        code: (err && err.code) ? String(err.code) : 'CLEANUP_UNLINK_FAILED',
                        message: (err && err.message) ? String(err.message) : String(err),
                        stage: 'UNLINK'
                    });
                    if (postCheck.state === 'PRESENT') {
                        if (!result.remainingPaths.includes(p)) {
                            result.remainingPaths.push(p);
                        }
                    } else if (postCheck.state === 'UNKNOWN') {
                        if (!result.unverifiablePaths.includes(p)) {
                            result.unverifiablePaths.push(p);
                        }
                    }
                }
            }
        }

        const allConfirmedAbsent =
            (result.alreadyAbsent.length + result.removed.length) === candidatePaths.length;
        result.complete =
            allConfirmedAbsent &&
            result.failures.length === 0 &&
            result.remainingPaths.length === 0 &&
            result.unverifiablePaths.length === 0;
        return result;
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
     * 確認目標資料庫滿足 Restore 離線保證條件 (4.0.1.2 P1 — Restore Offline Assurance):
     * 嚴格區分三層檢查：
     * 1. Adapter Path Protection: 確認目標路徑未被程序內已註冊之 SQLiteAdapter 使用且無進行中之 Native Close。
     * 2. Offline Confirmation: 強制要求呼叫端明確傳入 `options.offlineConfirmed === true`，確認目標已進入受控離線維護狀態。
     * 3. Lock Contention Probe: 作為輔助檢查偵測當下寫入鎖衝突 (注意：WAL 模式下 BEGIN EXCLUSIVE 成功不等於無外部閒置或唯讀連線)。
     */
    async _assertTargetDbOffline(resolvedTarget, options = {}) {
        // 1. Adapter Path Protection
        const activeMatch = this._findActiveAdapterUsingPath(resolvedTarget);
        if (activeMatch) {
            const err = new Error(
                `[BACKUP_RESTORE_ACTIVE_DB_FORBIDDEN] 目標路徑 (${resolvedTarget}) 正由活躍的 SQLiteAdapter 使用中 (state: ${activeMatch.state}, nativeClosePending: ${activeMatch.nativeClosePending})，禁止對線上資料庫執行 Restore`
            );
            err.code = 'BACKUP_RESTORE_ACTIVE_DB_FORBIDDEN';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            err.reason = 'ACTIVE_ADAPTER_DB_PATH';
            throw err;
        }

        // 2. Offline Confirmation (預設強制要求，不得省略)
        if (!options || options.offlineConfirmed !== true) {
            const err = new Error(
                `[BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED] 執行 Restore 必須由呼叫端明確傳入 { offlineConfirmed: true } 確認目標資料庫已進入受控離線維護狀態`
            );
            err.code = 'BACKUP_RESTORE_OFFLINE_CONFIRMATION_REQUIRED';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            err.reason = 'OFFLINE_CONFIRMATION_REQUIRED';
            throw err;
        }

        // 3. Lock Contention Probe (輔助檢查：偵測外部寫入交易鎖衝突，不作為無外部連線之唯一證明)
        if (fs.existsSync(resolvedTarget)) {
            await new Promise((resolve, reject) => {
                const probeDb = new sqlite3.Database(resolvedTarget, sqlite3.OPEN_READWRITE, (openErr) => {
                    if (openErr) {
                        const unavailErr = new Error(
                            `[BACKUP_RESTORE_TARGET_UNAVAILABLE] 無法開啟目標資料庫以執行輔助鎖定探測: ${openErr.message}`
                        );
                        unavailErr.code = 'BACKUP_RESTORE_TARGET_UNAVAILABLE';
                        unavailErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
                        unavailErr.reason = 'TARGET_DB_OPEN_FAILED';
                        return reject(unavailErr);
                    }
                    probeDb.serialize(() => {
                        probeDb.run('PRAGMA busy_timeout = 0');
                        probeDb.run('BEGIN EXCLUSIVE TRANSACTION', (lockErr) => {
                            if (lockErr) {
                                return probeDb.close(() => {
                                    const busyErr = new Error(
                                        `[BACKUP_RESTORE_TARGET_BUSY_ONLINE] 目標資料庫 (${resolvedTarget}) 目前被其他連線或程序持有衝突鎖定 (${lockErr.message})，禁止執行還原`
                                    );
                                    busyErr.code = 'BACKUP_RESTORE_TARGET_BUSY_ONLINE';
                                    busyErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
                                    busyErr.reason = 'TARGET_DB_LOCKED_OR_ONLINE';
                                    reject(busyErr);
                                });
                            }
                            probeDb.run('ROLLBACK', () => {
                                probeDb.close((closeErr) => {
                                    if (closeErr) {
                                        const closeProbeErr = new Error(
                                            `[BACKUP_RESTORE_TARGET_UNAVAILABLE] 關閉輔助鎖定探測連線失敗: ${closeErr.message}`
                                        );
                                        closeProbeErr.code = 'BACKUP_RESTORE_TARGET_UNAVAILABLE';
                                        closeProbeErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
                                        return reject(closeProbeErr);
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
     * 從已驗證之備份檔案安全還原至獨立離線目標資料庫路徑，
     * 具備 Offline Assurance 與針對既有/全新目標之精確 Rollback 狀態追蹤 (4.0.1.2 P1)
     */
    async restoreFromBackup(backupFilePath, targetRestoreDbPath, options = {}) {
        if (!backupFilePath || !targetRestoreDbPath || typeof backupFilePath !== 'string' || typeof targetRestoreDbPath !== 'string') {
            const err = new Error('[BACKUP_RESTORE_ERROR] backupFilePath 與 targetRestoreDbPath 皆為必填非空字串');
            err.code = 'BACKUP_RESTORE_ERROR';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }
        if (backupFilePath.includes('\0') || targetRestoreDbPath.includes('\0')) {
            const err = new Error('[BACKUP_RESTORE_ERROR] 路徑包含非法 NUL 字元');
            err.code = 'BACKUP_RESTORE_ERROR';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        const resolvedSource = path.resolve(backupFilePath);
        const resolvedTarget = path.resolve(targetRestoreDbPath);

        // Precondition 1: 目標路徑不能與來源備份路徑相同 (含正規化與不分大小寫比對)
        if (_normalizeComparablePath(resolvedSource) === _normalizeComparablePath(resolvedTarget)) {
            const err = new Error('[BACKUP_RESTORE_ERROR] 來源備份路徑與目標還原路徑不得相同');
            err.code = 'BACKUP_RESTORE_ERROR';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        // Precondition 2: 目標路徑不得是正在進行中之備份路徑
        if (this.#inProgressBackupPaths.has(resolvedTarget) || this.#inProgressBackupPaths.has(resolvedSource)) {
            const err = new Error('[BACKUP_RESTORE_REJECTED] 來源或目標路徑正在執行備份作業中，禁止同時還原');
            err.code = 'BACKUP_RESTORE_REJECTED';
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            this.lastRestoreError = err;
            throw err;
        }

        // Precondition 3: 檢查 Adapter Path Protection、Offline Confirmation (必填) 與輔助 Lock Contention Probe
        try {
            await this._assertTargetDbOffline(resolvedTarget, options);
        } catch (preErr) {
            this.lastRestoreError = preErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: preErr.restoreStatus || RESTORE_STATUS.REJECTED_PRECONDITION,
                reason: preErr.reason || null,
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
            err.code = 'BACKUP_RESTORE_REJECTED';
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

        // 明確追蹤 Restore 生命週期狀態 (4.0.1.2 P1 — Restore Rollback for New Target)
        const lifecycle = {
            stagingCreated: false,
            stagingVerified: false,
            hadExistingTargetDb: fs.existsSync(resolvedTarget),
            hadExistingSidecars: fs.existsSync(`${resolvedTarget}-wal`) || fs.existsSync(`${resolvedTarget}-shm`),
            originalMovedToRollback: false,
            newTargetInstalled: false,
            postInstallVerified: false,
            newTargetCleanedUp: false,
            originalRestored: false
        };
        const hadAnyExistingTargetFiles = lifecycle.hadExistingTargetDb || lifecycle.hadExistingSidecars;
        const renameFn = (options && typeof options.renameImpl === 'function')
            ? options.renameImpl
            : fs.renameSync;
        const unlinkFn = (options && typeof options.unlinkImpl === 'function')
            ? options.unlinkImpl
            : fs.unlinkSync;
        const lstatFn = (options && typeof options.lstatImpl === 'function')
            ? options.lstatImpl
            : fs.lstatSync;
        const cleanupOpts = { unlinkImpl: unlinkFn, lstatImpl: lstatFn };
        const postInstallVerifyFn = (options && typeof options.postInstallVerifyImpl === 'function')
            ? options.postInstallVerifyImpl
            : (filePath) => this.verifyIntegrity(filePath);

        // Step 1: 在目標 DB 同一目錄 (同一檔案系統) 建立唯一 staging DB
        const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const stagingRestorePath = path.resolve(targetDir, `.restore-staging-${path.basename(resolvedTarget)}-${uniqueSuffix}`);
        this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);

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
                                return reject(new Error(`[BACKUP_RESTORE_ERROR] 建立還原 staging DB 失敗: ${vacErr.message}`));
                            }
                            if (closeErr) {
                                return reject(new Error(`[BACKUP_RESTORE_ERROR] 關閉來源備份失敗: ${closeErr.message}`));
                            }
                            resolve();
                        });
                    });
                });
            });
            lifecycle.stagingCreated = fs.existsSync(stagingRestorePath);
        } catch (stageErr) {
            const stagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            stageErr.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            stageErr.cleanupComplete = stagingCleanup.complete;
            stageErr.cleanupResult = stagingCleanup;
            stageErr.cleanupFailures = stagingCleanup.failures;
            stageErr.remainingPaths = [...stagingCleanup.remainingPaths];
            stageErr.unverifiablePaths = [...stagingCleanup.unverifiablePaths];
            stageErr.lifecycle = { ...lifecycle };
            this.lastRestoreError = stageErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: RESTORE_STATUS.REJECTED_PRECONDITION,
                cleanupComplete: stagingCleanup.complete,
                cleanupResult: stagingCleanup,
                cleanupFailures: stagingCleanup.failures,
                remainingPaths: stageErr.remainingPaths,
                unverifiablePaths: stageErr.unverifiablePaths,
                lifecycle: { ...lifecycle },
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
            const stagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            const err = new Error(
                `[BACKUP_RESTORE_VERIFY_FAILED] 還原 staging DB 未通過完整性檢驗 (${stagingVerify.status}): ${stagingVerify.details}`
            );
            err.restoreStatus = RESTORE_STATUS.REJECTED_PRECONDITION;
            err.cleanupComplete = stagingCleanup.complete;
            err.cleanupResult = stagingCleanup;
            err.cleanupFailures = stagingCleanup.failures;
            err.remainingPaths = [...stagingCleanup.remainingPaths];
            err.unverifiablePaths = [...stagingCleanup.unverifiablePaths];
            err.lifecycle = { ...lifecycle };
            this.lastRestoreError = err;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: RESTORE_STATUS.REJECTED_PRECONDITION,
                cleanupComplete: stagingCleanup.complete,
                cleanupResult: stagingCleanup,
                cleanupFailures: stagingCleanup.failures,
                remainingPaths: err.remainingPaths,
                unverifiablePaths: err.unverifiablePaths,
                lifecycle: { ...lifecycle },
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            throw err;
        }
        lifecycle.stagingVerified = true;

        // Step 3: 替換前再次確認目標 DB 離線且未被活躍 Adapter 使用
        try {
            await this._assertTargetDbOffline(resolvedTarget, options);
        } catch (recheckErr) {
            const stagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            recheckErr.cleanupComplete = stagingCleanup.complete;
            recheckErr.cleanupResult = stagingCleanup;
            recheckErr.cleanupFailures = stagingCleanup.failures;
            recheckErr.remainingPaths = [...stagingCleanup.remainingPaths];
            recheckErr.unverifiablePaths = [...stagingCleanup.unverifiablePaths];
            recheckErr.lifecycle = { ...lifecycle };
            this.lastRestoreError = recheckErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: recheckErr.restoreStatus || RESTORE_STATUS.REJECTED_PRECONDITION,
                cleanupComplete: stagingCleanup.complete,
                cleanupResult: stagingCleanup,
                cleanupFailures: stagingCleanup.failures,
                remainingPaths: recheckErr.remainingPaths,
                unverifiablePaths: recheckErr.unverifiablePaths,
                lifecycle: { ...lifecycle },
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: recheckErr.message,
                timestamp: new Date().toISOString()
            };
            throw recheckErr;
        }

        // Step 4: 若原始目標 DB 或其 -wal / -shm 存在，移至可回復之 rollback 路徑 (絕不先行直接刪除)
        const targetFilesToProtect = [
            { original: resolvedTarget, rollback: `${resolvedTarget}.rollback-${uniqueSuffix}` },
            { original: `${resolvedTarget}-wal`, rollback: `${resolvedTarget}-wal.rollback-${uniqueSuffix}` },
            { original: `${resolvedTarget}-shm`, rollback: `${resolvedTarget}-shm.rollback-${uniqueSuffix}` }
        ];
        const movedRollbacks = [];

        try {
            for (const item of targetFilesToProtect) {
                if (fs.existsSync(item.original)) {
                    fs.renameSync(item.original, item.rollback);
                    movedRollbacks.push(item);
                }
            }
            if (movedRollbacks.length > 0) {
                lifecycle.originalMovedToRollback = true;
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
            const stagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            if (!stagingCleanup.complete) {
                for (const failure of stagingCleanup.failures) {
                    rollbackErrors.push(`無法清理還原 staging 檔案 ${failure.path} (${failure.code}): ${failure.message}`);
                }
            }

            const rollbackSucceeded = rollbackErrors.length === 0 && stagingCleanup.complete;
            const cleanupComplete = rollbackSucceeded;
            lifecycle.originalRestored = rollbackErrors.length === 0;
            const status = rollbackSucceeded
                ? RESTORE_STATUS.FAILED_ROLLED_BACK
                : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;
            const remainingPaths = [...stagingCleanup.remainingPaths];
            const confirmedRollbackFiles = movedRollbacks
                .map(m => m.rollback)
                .filter(p => this._inspectPathExistence(p, lstatFn).state === 'PRESENT');
            const err = new Error(
                `[BACKUP_RESTORE_PREPARE_FAILED] 備份原始目標檔案至 rollback 路徑時失敗 (${moveOriginalErr.message}) | 狀態: ${status}`
            );
            err.cause = moveOriginalErr;
            err.restoreStatus = status;
            err.rollbackSucceeded = rollbackSucceeded;
            err.cleanupComplete = cleanupComplete;
            err.cleanupResult = stagingCleanup;
            err.cleanupFailures = stagingCleanup.failures;
            err.remainingPaths = remainingPaths;
            err.unverifiablePaths = [...stagingCleanup.unverifiablePaths];
            err.rollbackErrors = rollbackErrors;
            err.preservedRollbackPaths = rollbackSucceeded
                ? []
                : Array.from(new Set([...confirmedRollbackFiles, ...remainingPaths]));
            err.lifecycle = { ...lifecycle };
            this.lastRestoreError = err;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: status,
                rollbackSucceeded,
                cleanupComplete,
                cleanupResult: stagingCleanup,
                cleanupFailures: stagingCleanup.failures,
                remainingPaths,
                unverifiablePaths: err.unverifiablePaths,
                rollbackErrors,
                preservedRollbackPaths: err.preservedRollbackPaths,
                lifecycle: { ...lifecycle },
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: err.message,
                timestamp: new Date().toISOString()
            };
            throw err;
        }

        // Step 5: 將已驗證的 staging DB 安裝至目標路徑並執行安裝後完整性驗證
        try {
            if (options && typeof options.beforeFinalInstall === 'function') {
                await options.beforeFinalInstall({ stagingRestorePath, resolvedTarget, movedRollbacks });
            }

            renameFn(stagingRestorePath, resolvedTarget);
            lifecycle.newTargetInstalled = true;

            const installedVerify = await postInstallVerifyFn(resolvedTarget);
            if (!installedVerify || installedVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
                const vStatus = installedVerify ? installedVerify.status : 'UNKNOWN';
                const vDetails = installedVerify ? installedVerify.details : 'NO_VERIFY_RESULT';
                throw new Error(
                    `[BACKUP_RESTORE_POST_INSTALL_INVALID] 安裝後目標資料庫驗證失敗 (${vStatus}): ${vDetails}`
                );
            }
            lifecycle.postInstallVerified = true;

            // Step 6: 確認替換與驗證完全成功後，才清理舊 .rollback-* 檔案
            // (4.0.1.3 P2 & 4.0.1.4 P2 — Restore Rollback Cleanup Diagnostics & Rollback Path Verification)
            const cleanupWarnings = [];
            const preservedRollbackPaths = [];
            for (const moved of movedRollbacks) {
                const preStat = this._inspectPathExistence(moved.rollback, lstatFn);
                if (preStat.state === 'ABSENT') {
                    continue;
                }
                if (preStat.state === 'UNKNOWN') {
                    cleanupWarnings.push({
                        path: moved.rollback,
                        code: preStat.error.code,
                        message: preStat.error.message,
                        stage: 'ROLLBACK_FILE_CLEANUP',
                        existenceState: 'UNKNOWN'
                    });
                    // 無法確認檔案是否存在時，只記錄 warning，不得直接宣稱檔案仍保留於 preservedRollbackPaths
                    continue;
                }

                // preStat.state === 'PRESENT' -> 執行 unlink 並再次以 lstat 確認檔案狀態
                try {
                    unlinkFn(moved.rollback);
                    const postStat = this._inspectPathExistence(moved.rollback, lstatFn);
                    if (postStat.state === 'PRESENT') {
                        cleanupWarnings.push({
                            path: moved.rollback,
                            code: 'ROLLBACK_CLEANUP_STILL_EXISTS',
                            message: `舊 rollback 檔案於 unlink 後仍存在於磁碟: ${moved.rollback}`,
                            stage: 'ROLLBACK_FILE_CLEANUP',
                            existenceState: 'PRESENT'
                        });
                        if (!preservedRollbackPaths.includes(moved.rollback)) {
                            preservedRollbackPaths.push(moved.rollback);
                        }
                    } else if (postStat.state === 'UNKNOWN') {
                        cleanupWarnings.push({
                            path: moved.rollback,
                            code: postStat.error.code,
                            message: `舊 rollback 檔案於 unlink 後無法確認是否存在: ${postStat.error.message}`,
                            stage: 'ROLLBACK_FILE_CLEANUP',
                            existenceState: 'UNKNOWN'
                        });
                    }
                } catch (unlinkErr) {
                    const postStat = this._inspectPathExistence(moved.rollback, lstatFn);
                    if (unlinkErr && unlinkErr.code === 'ENOENT' && postStat.state === 'ABSENT') {
                        continue;
                    }
                    cleanupWarnings.push({
                        path: moved.rollback,
                        code: (unlinkErr && unlinkErr.code) ? String(unlinkErr.code) : 'ROLLBACK_CLEANUP_FAILED',
                        message: (unlinkErr && unlinkErr.message) ? String(unlinkErr.message) : String(unlinkErr),
                        stage: 'ROLLBACK_FILE_CLEANUP',
                        existenceState: postStat.state
                    });
                    // 只有確認檔案仍然存在於磁碟 (postStat.state === 'PRESENT')，才加入 preservedRollbackPaths
                    if (postStat.state === 'PRESENT' && !preservedRollbackPaths.includes(moved.rollback)) {
                        preservedRollbackPaths.push(moved.rollback);
                    }
                }
            }

            // 同時確認 stagingRestorePath 及其 sidecars 已無殘留
            const postInstallStagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            if (!postInstallStagingCleanup.complete) {
                for (const failure of postInstallStagingCleanup.failures) {
                    cleanupWarnings.push({
                        path: failure.path,
                        code: failure.code,
                        message: failure.message,
                        stage: 'STAGING_FILE_CLEANUP'
                    });
                }
            }

            const cleanupComplete =
                cleanupWarnings.length === 0 &&
                preservedRollbackPaths.length === 0 &&
                postInstallStagingCleanup.complete;

            const result = {
                success: true,
                restoreStatus: RESTORE_STATUS.COMPLETED,
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                hadExistingTarget: hadAnyExistingTargetFiles,
                lifecycle: { ...lifecycle },
                cleanupComplete,
                cleanupWarnings,
                preservedRollbackPaths,
                verify: installedVerify,
                timestamp: new Date().toISOString()
            };
            this.lastRestoreError = null;
            this.lastRestoreResult = result;
            return result;
        } catch (installErr) {
            const rollbackErrors = [];
            const uncleanedTargetPaths = [];

            // 檢查新目標檔案或本次新產生的 sidecars 是否已存在於目標路徑 (不依賴 movedRollbacks.length！)
            const targetOrSidecarPresent =
                lifecycle.newTargetInstalled ||
                this._inspectPathExistence(resolvedTarget, lstatFn).state !== 'ABSENT' ||
                this._inspectPathExistence(`${resolvedTarget}-wal`, lstatFn).state !== 'ABSENT' ||
                this._inspectPathExistence(`${resolvedTarget}-shm`, lstatFn).state !== 'ABSENT';

            if (targetOrSidecarPresent) {
                for (const newFile of [resolvedTarget, `${resolvedTarget}-wal`, `${resolvedTarget}-shm`]) {
                    const preNewStat = this._inspectPathExistence(newFile, lstatFn);
                    if (preNewStat.state === 'ABSENT') {
                        continue;
                    }
                    if (preNewStat.state === 'UNKNOWN') {
                        rollbackErrors.push(`無法確認新目標檔案狀態 ${newFile} (${preNewStat.error.code}): ${preNewStat.error.message}`);
                        continue;
                    }
                    try {
                        unlinkFn(newFile);
                        const postNewStat = this._inspectPathExistence(newFile, lstatFn);
                        if (postNewStat.state === 'PRESENT') {
                            rollbackErrors.push(`新目標檔案於 unlink 後仍殘留於磁碟 ${newFile}`);
                            uncleanedTargetPaths.push(newFile);
                        } else if (postNewStat.state === 'UNKNOWN') {
                            rollbackErrors.push(`新目標檔案於 unlink 後無法確認狀態 ${newFile} (${postNewStat.error.code}): ${postNewStat.error.message}`);
                        }
                    } catch (unlinkErr) {
                        const postNewStat = this._inspectPathExistence(newFile, lstatFn);
                        if (!(unlinkErr && unlinkErr.code === 'ENOENT' && postNewStat.state === 'ABSENT')) {
                            rollbackErrors.push(`無法移除安裝失敗之新目標檔案 ${newFile}: ${unlinkErr.message}`);
                            if (postNewStat.state === 'PRESENT') {
                                uncleanedTargetPaths.push(newFile);
                            }
                        }
                    }
                }
                lifecycle.newTargetCleanedUp =
                    uncleanedTargetPaths.length === 0 &&
                    rollbackErrors.length === 0 &&
                    this._inspectPathExistence(resolvedTarget, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-wal`, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-shm`, lstatFn).state === 'ABSENT';
            }

            // 若原始目標存在且已移至 rollback 路徑，按反序將 rollback 檔案復原回原始路徑
            if (movedRollbacks.length > 0) {
                for (let i = movedRollbacks.length - 1; i >= 0; i--) {
                    const moved = movedRollbacks[i];
                    try {
                        if (this._inspectPathExistence(moved.rollback, lstatFn).state === 'PRESENT') {
                            fs.renameSync(moved.rollback, moved.original);
                        }
                    } catch (rbErr) {
                        rollbackErrors.push(`${moved.rollback} -> ${moved.original}: ${rbErr.message}`);
                    }
                }
                lifecycle.originalRestored =
                    rollbackErrors.length === 0 &&
                    (!lifecycle.hadExistingTargetDb || this._inspectPathExistence(resolvedTarget, lstatFn).state === 'PRESENT');
            }

            // 清理殘留之 staging 檔案並取得結構化清理結果 (4.0.1.3 P2 & 4.0.1.4 P2)
            const stagingCleanup = this._cleanupFileAndSidecars(stagingRestorePath, cleanupOpts);
            if (!stagingCleanup.complete) {
                for (const failure of stagingCleanup.failures) {
                    rollbackErrors.push(`無法清理還原 staging 檔案 ${failure.path} (${failure.code}): ${failure.message}`);
                }
            }

            const remainingPaths = Array.from(
                new Set([
                    ...uncleanedTargetPaths,
                    ...stagingCleanup.remainingPaths
                ])
            );

            // 判定最終狀態 (嚴格區分 Case B / Case C / Case D 與 staging cleanup 是否完全成功):
            let status;
            let rollbackSucceeded;
            let cleanupComplete;
            let preservedRollbackPaths = [];

            if (!hadAnyExistingTargetFiles && !targetOrSidecarPresent) {
                // Case B: 原始目標不存在且 Rename 階段即失敗 (未安裝新檔)
                const targetStillAbsent =
                    this._inspectPathExistence(resolvedTarget, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-wal`, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-shm`, lstatFn).state === 'ABSENT';
                cleanupComplete =
                    targetStillAbsent &&
                    stagingCleanup.complete &&
                    remainingPaths.length === 0 &&
                    stagingCleanup.unverifiablePaths.length === 0;
                rollbackSucceeded = false;
                status = cleanupComplete
                    ? RESTORE_STATUS.FAILED_INSTALL_ABORTED
                    : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;
                if (!cleanupComplete) {
                    preservedRollbackPaths = [...remainingPaths];
                }
            } else if (!hadAnyExistingTargetFiles && targetOrSidecarPresent) {
                // Case C: 原始目標不存在，新目標已安裝但安裝後驗證失敗
                const targetRestoredToAbsent =
                    lifecycle.newTargetCleanedUp &&
                    rollbackErrors.length === 0 &&
                    stagingCleanup.complete &&
                    this._inspectPathExistence(resolvedTarget, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-wal`, lstatFn).state === 'ABSENT' &&
                    this._inspectPathExistence(`${resolvedTarget}-shm`, lstatFn).state === 'ABSENT';
                cleanupComplete =
                    targetRestoredToAbsent &&
                    remainingPaths.length === 0 &&
                    stagingCleanup.unverifiablePaths.length === 0;
                rollbackSucceeded = cleanupComplete;
                status = cleanupComplete
                    ? RESTORE_STATUS.FAILED_ROLLED_BACK
                    : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;
                if (!cleanupComplete) {
                    preservedRollbackPaths = [...remainingPaths];
                }
            } else {
                // Case D: 原始目標存在，需恢復原始 DB 與 sidecars
                cleanupComplete =
                    rollbackErrors.length === 0 &&
                    lifecycle.originalRestored &&
                    stagingCleanup.complete &&
                    remainingPaths.length === 0 &&
                    stagingCleanup.unverifiablePaths.length === 0;
                rollbackSucceeded = cleanupComplete;
                status = cleanupComplete
                    ? RESTORE_STATUS.FAILED_ROLLED_BACK
                    : RESTORE_STATUS.FAILED_ROLLBACK_INCOMPLETE;
                if (!cleanupComplete) {
                    const confirmedRemainingRollbacks = movedRollbacks
                        .map(m => m.rollback)
                        .filter(p => this._inspectPathExistence(p, lstatFn).state === 'PRESENT');
                    preservedRollbackPaths = Array.from(
                        new Set([
                            ...confirmedRemainingRollbacks,
                            ...remainingPaths
                        ])
                    );
                }
            }

            const finalErr = new Error(
                `[BACKUP_RESTORE_INSTALL_FAILED] 還原替換失敗 (${installErr.message}) | 回復狀態: ${status}`
            );
            finalErr.cause = installErr;
            finalErr.originalError = installErr;
            if (installErr && installErr.code) {
                finalErr.originalCode = installErr.code;
            }
            finalErr.restoreStatus = status;
            finalErr.cleanupComplete = cleanupComplete;
            finalErr.cleanupResult = stagingCleanup;
            finalErr.cleanupFailures = stagingCleanup.failures;
            finalErr.remainingPaths = remainingPaths;
            finalErr.unverifiablePaths = [...stagingCleanup.unverifiablePaths];
            finalErr.rollbackSucceeded = rollbackSucceeded;
            finalErr.rollbackErrors = rollbackErrors;
            finalErr.uncleanedTargetPaths = uncleanedTargetPaths;
            finalErr.preservedRollbackPaths = preservedRollbackPaths;
            finalErr.lifecycle = { ...lifecycle };

            this.lastRestoreError = finalErr;
            this.lastRestoreResult = {
                success: false,
                restoreStatus: status,
                cleanupComplete,
                cleanupResult: stagingCleanup,
                cleanupFailures: stagingCleanup.failures,
                remainingPaths,
                unverifiablePaths: finalErr.unverifiablePaths,
                rollbackSucceeded,
                rollbackErrors,
                uncleanedTargetPaths,
                preservedRollbackPaths,
                lifecycle: { ...lifecycle },
                backupFilePath: resolvedSource,
                restoredPath: resolvedTarget,
                error: finalErr.message,
                timestamp: new Date().toISOString()
            };
            throw finalErr;
        }
    }

    /**
     * 清理過期或超額備份 (4.0.1.2 P2 — Backup Rotation maxBackups Exact Count):
     * 1. 明確識別本輪剛通過完整性驗證並完成安裝的 `latestVerifiedPath`，將其納入有效備份總數計算一次（不因 #inProgressBackupPaths 而忽略，也不重複計數）。
     * 2. 將 `latestVerifiedPath` 標記為本輪不可刪除保護對象。
     * 3. 其他位於 `#inProgressBackupPaths` 中的 staging 或進行中檔案仍維持嚴格跳過與保護。
     * 4. 僅將通過驗證的有效備份納入計數，並確保至少保留 1 份最新可用備份。
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

            const resolvedLatest = latestVerifiedPath ? path.resolve(latestVerifiedPath) : null;
            const normLatest = (
                resolvedLatest &&
                this.#verifiedBackups.has(resolvedLatest) &&
                fs.existsSync(resolvedLatest)
            )
                ? _normalizeComparablePath(resolvedLatest)
                : null;

            const files = fs.readdirSync(targetDir);
            const verifiedCandidates = [];
            const seenNormalizedPaths = new Set();

            for (const file of files) {
                if (!file.endsWith('.db')) continue;
                if (
                    file.startsWith('.staging-') ||
                    file.startsWith('.prev-') ||
                    file.startsWith('.restore-staging-') ||
                    file.includes('.rollback-')
                ) {
                    continue;
                }

                const fullPath = path.resolve(targetDir, file);
                const normPath = _normalizeComparablePath(fullPath);
                if (!normPath || seenNormalizedPaths.has(normPath)) continue;

                const isCurrentLatestVerified = Boolean(normLatest && normPath === normLatest);

                // 絕不碰觸其他正在建立中的備份或 staging 檔案；
                // 但允許本輪剛完成驗證與安裝的 latestVerifiedPath 納入有效備份總數並受不可刪除保護
                if (this.#inProgressBackupPaths.has(fullPath) && !isCurrentLatestVerified) {
                    continue;
                }

                let stats;
                try {
                    stats = fs.statSync(fullPath);
                } catch (_) {
                    continue;
                }
                if (!stats.isFile() || stats.size <= 0) continue;

                // 只將已驗證成功之備份納入保留計數與清理候選
                let isVerified = this.#verifiedBackups.has(fullPath) || isCurrentLatestVerified;
                if (!isVerified) {
                    const check = await this.verifyIntegrity(fullPath);
                    if (check.status === BACKUP_VERIFY_STATUS.VALID) {
                        this._markBackupVerified(fullPath);
                        isVerified = true;
                    }
                }

                if (isVerified) {
                    seenNormalizedPaths.add(normPath);
                    verifiedCandidates.push({
                        file,
                        fullPath,
                        mtimeMs: stats.mtimeMs,
                        verifiedSeq: this.#verifiedBackupSeqMap.get(fullPath) || 0,
                        isCurrentLatestVerified,
                        protectedFromDeletion: isCurrentLatestVerified
                    });
                }
            }

            // 若有效備份數 <= 1，絕不刪除唯一可用備份
            if (verifiedCandidates.length <= 1) {
                return {
                    retainedCount: verifiedCandidates.length,
                     retainedFiles: verifiedCandidates.map(c => c.file),
                    deletedFiles: []
                };
            }

            // 依下列優先序由新到舊排序 (index 0 為最新有效備份，永遠保留):
            // 1. 本輪剛完成驗證的 latestVerifiedPath 優先置於 index 0 (受本輪不可刪除保護)
            // 2. 依檔案修改時間 mtimeMs 由新到舊
            // 3. 若同一毫秒內建立多份備份 (mtimeMs 相同)，依驗證序號 verifiedSeq 由新到舊
            verifiedCandidates.sort((a, b) => {
                if (a.isCurrentLatestVerified !== b.isCurrentLatestVerified) {
                    return a.isCurrentLatestVerified ? -1 : 1;
                }
                if (b.mtimeMs !== a.mtimeMs) {
                    return b.mtimeMs - a.mtimeMs;
                }
                return b.verifiedSeq - a.verifiedSeq;
            });

            const deletedFiles = [];
            const retainedFiles = [];
            let remainingValidCount = verifiedCandidates.length;

            // 由最舊往較新方向依序檢查刪除，確保保留順序、保護最新備份與最低 1 份可用備份
            for (let i = verifiedCandidates.length - 1; i >= 1; i--) {
                const candidate = verifiedCandidates[i];
                if (remainingValidCount <= 1 || candidate.protectedFromDeletion) {
                    continue;
                }

                const expiredByAge = candidate.mtimeMs < cutoffTime;
                const exceededMaxCount = maxBackups !== null && remainingValidCount > maxBackups;

                if (expiredByAge || exceededMaxCount) {
                    try {
                        fs.unlinkSync(candidate.fullPath);
                        this._unmarkBackupVerified(candidate.fullPath);
                        remainingValidCount--;
                        deletedFiles.push(candidate.file);
                        console.log(`🗑️ [BACKUP_ROTATE] 已清除舊備份: ${candidate.file}`);
                    } catch (unlinkErr) {
                        console.warn(`⚠️ [BACKUP_ROTATE_WARN] 刪除舊備份 ${candidate.file} 失敗:`, unlinkErr.message);
                    }
                }
            }

            for (const candidate of verifiedCandidates) {
                if (!deletedFiles.includes(candidate.file) && fs.existsSync(candidate.fullPath)) {
                    retainedFiles.push(candidate.file);
                }
            }

            return {
                retainedCount: remainingValidCount,
                deletedCount: deletedFiles.length,
                retainedFiles,
                deletedFiles
            };
        } catch (err) {
            console.warn('⚠️ [BACKUP_ROTATE_WARN] 清理過期備份遭遇警告:', err.message);
            return { retainedCount: 0, deletedCount: 0, retainedFiles: [], deletedFiles: [], error: err.message };
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
