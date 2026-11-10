// src/database/backup-manager.js
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { backup: defaultBackupConfig } = require('./sqlite.config');

const BACKUP_VERIFY_STATUS = {
    VALID: 'VALID',
    CORRUPTED: 'CORRUPTED',
    VERIFY_ERROR: 'VERIFY_ERROR'
};

class BackupManager {
    #adapter;
    #config;
    #backupDir;

    constructor(adapter, backupDir, config = {}) {
        if (!adapter) {
            throw new Error('[BACKUP_INIT_ERROR] adapter 為必填');
        }
        this.#adapter = adapter;
        this.#backupDir = backupDir || path.join(process.cwd(), 'backups');
        this.#config = { ...defaultBackupConfig, ...config };

        if (!fs.existsSync(this.#backupDir)) {
            fs.mkdirSync(this.#backupDir, { recursive: true });
        }
    }

    get backupDir() {
        return this.#backupDir;
    }

    /**
     * 驗證備份檔案完整性 (P1-03: 完整性三態分類、close 錯誤處理與防誤刪)
     */
    async verifyIntegrity(backupFilePath) {
        if (!fs.existsSync(backupFilePath)) {
            return { status: BACKUP_VERIFY_STATUS.VERIFY_ERROR, details: 'FILE_NOT_FOUND' };
        }

        return new Promise((resolve) => {
            let tempDb = null;
            try {
                tempDb = new sqlite3.Database(backupFilePath, sqlite3.OPEN_READONLY, (openErr) => {
                    if (openErr) {
                        return resolve({
                            status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                            details: `OPEN_FAILED: ${openErr.message}`
                        });
                    }

                    tempDb.all('PRAGMA integrity_check', (checkErr, rows) => {
                        tempDb.close((closeErr) => {
                            if (closeErr) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: `CLOSE_FAILED: ${closeErr.message}`
                                });
                            }

                            if (checkErr) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: `QUERY_FAILED: ${checkErr.message}`
                                });
                            }

                            if (!Array.isArray(rows) || rows.length === 0) {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VERIFY_ERROR,
                                    details: 'EMPTY_INTEGRITY_RESULT'
                                });
                            }

                            const resultText = String(rows[0].integrity_check || '');
                            if (resultText.toLowerCase() === 'ok') {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.VALID,
                                    details: 'OK'
                                });
                            } else {
                                return resolve({
                                    status: BACKUP_VERIFY_STATUS.CORRUPTED,
                                    details: resultText
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
                    details: `EXCEPTION: ${err.message}`
                });
            }
        });
    }

    /**
     * 執行線上備份 (透過 VACUUM INTO 安全快照)
     */
    async performBackup(customFileName = null) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = customFileName || `backup-${timestamp}.db`;
        const targetPath = path.join(this.#backupDir, filename);

        return this.#adapter.maintenanceTask('ONLINE_BACKUP', async (rawContext) => {
            console.log(`📦 [BACKUP] 開始執行線上備份至: ${targetPath}`);

            try {
                const safePath = targetPath.replace(/\\/g, '/');
                await rawContext.execute(`VACUUM INTO '${safePath}'`);
            } catch (vErr) {
                console.warn(`⚠️ [BACKUP] VACUUM INTO 不可用或失敗 (${vErr.message})`);
                throw vErr;
            }

            // 驗證備份完整性
            const verify = await this.verifyIntegrity(targetPath);
            if (verify.status !== BACKUP_VERIFY_STATUS.VALID) {
                console.error(`❌ [BACKUP_VERIFY_FAILED] 備份驗證未通過 (狀態: ${verify.status}):`, verify.details);
                // 僅在明確 CORRUPTED 時移除壞檔；若為 VERIFY_ERROR 則保留以防誤刪
                if (verify.status === BACKUP_VERIFY_STATUS.CORRUPTED) {
                    try { fs.unlinkSync(targetPath); } catch (_) {}
                }
                throw new Error(`[BACKUP_VERIFY_FAILED] 備份完整性檢查失敗 (${verify.status}): ${verify.details}`);
            }

            console.log(`✅ [BACKUP] 備份成功並通過完整性檢驗: ${targetPath}`);
            this._rotateOldBackups();
            return { success: true, targetPath, verify };
        });
    }

    /**
     * 清理過期備份
     */
    _rotateOldBackups() {
        try {
            const retentionDays = this.#config.retentionDays || 30;
            const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

            const files = fs.readdirSync(this.#backupDir);
            for (const file of files) {
                if (file.endsWith('.db')) {
                    const filePath = path.join(this.#backupDir, file);
                    const stats = fs.statSync(filePath);
                    if (stats.mtimeMs < cutoffTime) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ [BACKUP_ROTATE] 已清除過期備份: ${file}`);
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ [BACKUP_ROTATE_WARN] 清理過期備份遭遇警告:', err.message);
        }
    }
}

module.exports = {
    BackupManager,
    BACKUP_VERIFY_STATUS
};
