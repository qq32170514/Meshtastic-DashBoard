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

class BackupManager {
    #adapter;
    #config;
    #backupDir;
    #backupInProgress = false;
    #inProgressBackupPaths = new Set();
    #verifiedBackups = new Set();
    #scheduledTask = null;
    #scheduledCronExpression = null;

    constructor(adapter, backupDir, config = {}) {
        if (!adapter) {
            throw new Error('[BACKUP_INIT_ERROR] adapter 為必填');
        }
        this.#adapter = adapter;
        this.#backupDir = backupDir || path.join(process.cwd(), 'backups');
        this.#config = { ...defaultBackupConfig, ...config };
        this.lastBackupError = null;
        this.lastBackupResult = null;

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
        if (!newBackupDir || typeof newBackupDir !== 'string') {
            throw new Error('[BACKUP_CONFIG_ERROR] newBackupDir 必須為非空字串');
        }
        this.#backupDir = newBackupDir;
        if (!fs.existsSync(this.#backupDir)) {
            fs.mkdirSync(this.#backupDir, { recursive: true });
        }
    }

    /**
     * 驗證備份檔案完整性 (P1-03 & 4.0.1 P1: 檔案存在、大小 > 0、可開啟、PRAGMA integrity_check === 'ok')
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
     * 執行線上備份 (4.0.1 P1: 透過 VACUUM INTO 建立 WAL 一致性快照、防重疊、不完整檔案清理、完整性檢驗與安全保留策略)
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

        const targetDir = (options && options.backupDir) ? options.backupDir : this.#backupDir;
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = customFileName || `backup-${timestamp}.db`;
        if (String(filename).includes('\0') || String(targetDir).includes('\0')) {
            throw new Error('[BACKUP_INVALID_PATH] 備份路徑或檔名包含非法空字元');
        }

        const targetPath = path.resolve(targetDir, filename);
        const existedBefore = fs.existsSync(targetPath);
        const writeTargetPath = existedBefore
            ? path.resolve(targetDir, `${filename}.staging-${process.pid}-${Date.now()}`)
            : targetPath;

        this.#backupInProgress = true;
        this.#inProgressBackupPaths.add(targetPath);
        this.#inProgressBackupPaths.add(writeTargetPath);

        try {
            return await this.#adapter.maintenanceTask('ONLINE_BACKUP', async (rawContext) => {
                console.log(`📦 [BACKUP] 開始執行線上備份至: ${targetPath}`);

                // 確保寫入目標在 VACUUM INTO 前不存在殘留半成品
                if (writeTargetPath !== targetPath && fs.existsSync(writeTargetPath)) {
                    try { fs.unlinkSync(writeTargetPath); } catch (_) {}
                }

                try {
                    const escapedSqlPath = writeTargetPath.replace(/\\/g, '/').replace(/'/g, "''");
                    await rawContext.execute(`VACUUM INTO '${escapedSqlPath}'`);
                } catch (vErr) {
                    console.warn(`⚠️ [BACKUP] VACUUM INTO 失敗 (${vErr.message})，正在清理不完整輸出...`);
                    if (fs.existsSync(writeTargetPath)) {
                        try {
                            fs.unlinkSync(writeTargetPath);
                        } catch (_) {}
                    }
                    this.lastBackupError = vErr;
                    this.lastBackupResult = {
                        success: false,
                        targetPath,
                        stage: 'VACUUM_INTO',
                        error: vErr.message,
                        timestamp: new Date().toISOString()
                    };
                    throw vErr;
                }

                // 驗證備份完整性
                const verify = await this.verifyIntegrity(writeTargetPath);
                if (verify.status !== BACKUP_VERIFY_STATUS.VALID) {
                    console.error(`❌ [BACKUP_VERIFY_FAILED] 備份驗證未通過 (狀態: ${verify.status}):`, verify.details);
                    if (writeTargetPath !== targetPath) {
                        try { fs.unlinkSync(writeTargetPath); } catch (_) {}
                    } else if (verify.status === BACKUP_VERIFY_STATUS.CORRUPTED) {
                        // 僅在明確 CORRUPTED 時移除壞檔；若為 VERIFY_ERROR 則保留以防誤刪，但不納入 #verifiedBackups
                        try { fs.unlinkSync(targetPath); } catch (_) {}
                    }
                    const verifyErr = new Error(
                        `[BACKUP_VERIFY_FAILED] 備份完整性檢查失敗 (${verify.status}): ${verify.details}`
                    );
                    verifyErr.verify = verify;
                    this.lastBackupError = verifyErr;
                    this.lastBackupResult = {
                        success: false,
                        targetPath,
                        stage: 'VERIFY_INTEGRITY',
                        verify,
                        error: verifyErr.message,
                        timestamp: new Date().toISOString()
                    };
                    throw verifyErr;
                }

                // 若使用 staging 檔案，於驗證通過後原子替換至 targetPath
                if (writeTargetPath !== targetPath) {
                    fs.renameSync(writeTargetPath, targetPath);
                }

                this.#verifiedBackups.add(targetPath);
                this.#inProgressBackupPaths.delete(writeTargetPath);
                this.#inProgressBackupPaths.delete(targetPath);

                console.log(`✅ [BACKUP] 備份成功並通過完整性檢驗: ${targetPath}`);
                await this._rotateOldBackups(targetDir, targetPath);

                const result = {
                    success: true,
                    targetPath,
                    verify,
                    timestamp: new Date().toISOString()
                };
                this.lastBackupError = null;
                this.lastBackupResult = result;
                return result;
            });
        } finally {
            this.#inProgressBackupPaths.delete(writeTargetPath);
            this.#inProgressBackupPaths.delete(targetPath);
            this.#backupInProgress = false;
        }
    }

    /**
     * 從已驗證之備份檔案安全還原至獨立目標資料庫路徑，並執行完整性驗證 (4.0.1 P1 Restore Verification)
     */
    async restoreFromBackup(backupFilePath, targetRestoreDbPath) {
        if (!backupFilePath || !targetRestoreDbPath) {
            throw new Error('[BACKUP_RESTORE_ERROR] backupFilePath 與 targetRestoreDbPath 皆為必填');
        }

        const resolvedSource = path.resolve(backupFilePath);
        const resolvedTarget = path.resolve(targetRestoreDbPath);
        if (resolvedSource === resolvedTarget) {
            throw new Error('[BACKUP_RESTORE_ERROR] 來源備份路徑與目標還原路徑不得相同');
        }

        // 1. 先驗證來源備份檔案完整性
        const sourceVerify = await this.verifyIntegrity(resolvedSource);
        if (sourceVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
            throw new Error(
                `[BACKUP_RESTORE_REJECTED] 來源備份未通過完整性檢驗 (${sourceVerify.status}): ${sourceVerify.details}`
            );
        }

        const targetDir = path.dirname(resolvedTarget);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        // 2. 清理目標位置可能存在的舊檔案與殘留 WAL/SHM
        const stagingRestorePath = `${resolvedTarget}.restore-staging-${process.pid}-${Date.now()}`;
        try { if (fs.existsSync(stagingRestorePath)) fs.unlinkSync(stagingRestorePath); } catch (_) {}

        await new Promise((resolve, reject) => {
            const sourceDb = new sqlite3.Database(resolvedSource, sqlite3.OPEN_READONLY, (openErr) => {
                if (openErr) {
                    return reject(new Error(`[BACKUP_RESTORE_ERROR] 開啟來源備份失敗: ${openErr.message}`));
                }
                const escapedStaging = stagingRestorePath.replace(/\\/g, '/').replace(/'/g, "''");
                sourceDb.run(`VACUUM INTO '${escapedStaging}'`, (vacErr) => {
                    sourceDb.close((closeErr) => {
                        if (vacErr) {
                            try { if (fs.existsSync(stagingRestorePath)) fs.unlinkSync(stagingRestorePath); } catch (_) {}
                            return reject(new Error(`[BACKUP_RESTORE_ERROR] 還原執行失敗: ${vacErr.message}`));
                        }
                        if (closeErr) {
                            try { if (fs.existsSync(stagingRestorePath)) fs.unlinkSync(stagingRestorePath); } catch (_) {}
                            return reject(new Error(`[BACKUP_RESTORE_ERROR] 關閉來源備份失敗: ${closeErr.message}`));
                        }
                        resolve();
                    });
                });
            });
        });

        // 3. 驗證還原出的目標資料庫完整性
        const restoredVerify = await this.verifyIntegrity(stagingRestorePath);
        if (restoredVerify.status !== BACKUP_VERIFY_STATUS.VALID) {
            try { if (fs.existsSync(stagingRestorePath)) fs.unlinkSync(stagingRestorePath); } catch (_) {}
            throw new Error(
                `[BACKUP_RESTORE_VERIFY_FAILED] 還原後資料庫未通過完整性檢驗 (${restoredVerify.status}): ${restoredVerify.details}`
            );
        }

        // 4. 清除舊目標之 WAL/SHM 並原子替換為已驗證之還原檔
        try { if (fs.existsSync(`${resolvedTarget}-wal`)) fs.unlinkSync(`${resolvedTarget}-wal`); } catch (_) {}
        try { if (fs.existsSync(`${resolvedTarget}-shm`)) fs.unlinkSync(`${resolvedTarget}-shm`); } catch (_) {}
        try { if (fs.existsSync(resolvedTarget)) fs.unlinkSync(resolvedTarget); } catch (_) {}
        fs.renameSync(stagingRestorePath, resolvedTarget);

        return {
            success: true,
            backupFilePath: resolvedSource,
            restoredPath: resolvedTarget,
            verify: restoredVerify
        };
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
    BACKUP_VERIFY_STATUS
};
