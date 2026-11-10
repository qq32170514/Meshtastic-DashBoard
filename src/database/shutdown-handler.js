// src/database/shutdown-handler.js
const { shutdown: defaultShutdownConfig } = require('./sqlite.config');

class ShutdownHandler {
    #authority;
    #adapter;
    #writeQueue;
    #config;
    #shutdownPromise = null;

    constructor({ adapter, writeQueue, authority, config = {} }) {
        if (!adapter || !writeQueue || !authority) {
            throw new Error('[SHUTDOWN_INIT_ERROR] adapter, writeQueue 與 authority 皆為必填');
        }
        this.#adapter = adapter;
        this.#writeQueue = writeQueue;
        this.#authority = authority;
        this.#config = { ...defaultShutdownConfig, ...config };
    }

    /**
     * 優雅關閉 (Graceful Shutdown - P0-1, P0-6)
     */
    handle(signal = 'SIGINT', options = {}) {
        if (this.#shutdownPromise) {
            console.log(`ℹ️ [SHUTDOWN] 已在執行關閉流程中，忽略重複呼叫 (${signal})`);
            return this.#shutdownPromise;
        }

        this.#shutdownPromise = (async () => {
            const startTime = Date.now();
            console.log(`🛑 [SHUTDOWN] 接收到信號 ${signal}，啟動安全關閉流程...`);

            const deadlineMs = this.#config.drainTimeoutMs || 8000;
            let drainCap = null;
            let drainClean = false;

            // 1. 簽發本次專屬且受限時間之 DrainCapability
            try {
                drainCap = this.#authority.issueDrainCapability(deadlineMs);
            } catch (authErr) {
                console.error('❌ [SHUTDOWN] 簽發 DrainCapability 失敗:', authErr.message);
                throw authErr;
            }

            // 2. 執行 WriteQueue 排空
            try {
                await this.#writeQueue.drain(drainCap, deadlineMs);
                const qMetrics = this.#writeQueue.getMetrics();
                if (qMetrics.totalUncommitted === 0 && qMetrics.inFlightCount === 0) {
                    drainClean = true;
                    this.#authority.markDrainCompleted(drainCap);
                    console.log('✅ [SHUTDOWN] 隊列資料已全數安全寫入並排空');
                } else {
                    console.warn(`⚠️ [SHUTDOWN] 隊列未完全排空 (未提交: ${qMetrics.totalUncommitted}, 在途: ${qMetrics.inFlightCount})`);
                }
            } catch (drainErr) {
                console.error('⚠️ [SHUTDOWN] 隊列排空階段遭遇異常或超時:', drainErr.message);
            }

            // 3. 執行 TRUNCATE Checkpoint (僅在排空乾淨且具有完成憑證時)
            if (drainClean && this.#authority.isDrainCompleted(drainCap)) {
                try {
                    console.log('🔄 [SHUTDOWN] 執行 wal_checkpoint(TRUNCATE)...');
                    await this.#adapter.checkpoint('TRUNCATE', drainCap, () => this.#writeQueue.getMetrics());
                    console.log('✅ [SHUTDOWN] WAL 檔案已安全截斷並回寫主資料庫');
                } catch (cpErr) {
                    console.error('⚠️ [SHUTDOWN] Checkpoint TRUNCATE 失敗:', cpErr.message);
                }
            } else {
                console.warn('⚠️ [SHUTDOWN] 由於隊列未乾淨排空，跳過 TRUNCATE Checkpoint 以防止損壞');
            }

            // 4. 關閉 Adapter
            try {
                await this.#adapter.close();
                console.log('🔒 [SHUTDOWN] SQLite 連線已安全關閉');
            } catch (closeErr) {
                console.error('❌ [SHUTDOWN] Adapter 關閉失敗:', closeErr.message);
                throw closeErr;
            }

            const durationMs = Date.now() - startTime;
            const finalMetrics = this.#writeQueue.getMetrics();
            console.log(`🏁 [SHUTDOWN] 關閉流程完成，耗時 ${durationMs}ms`);

            const result = {
                success: drainClean,
                durationMs,
                signal,
                metrics: finalMetrics
            };

            if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
                process.exit(drainClean ? 0 : 1);
            }

            return result;
        })();

        return this.#shutdownPromise;
    }

    /**
     * 緊急崩潰關閉處理 (Emergency Crash Shutdown - P0-2)
     * 絕對不可在 SQLite 底層仍在操作時強制 rawClose()，必須等待有界時間，超時則放棄連線釋放直接診斷轉儲
     */
    async handleEmergencyCrash(err, origin = 'uncaughtException', options = {}) {
        console.error(`🚨 [EMERGENCY_SHUTDOWN] 觸發緊急關閉！來源: ${origin} | 錯誤:`, err);

        // 1. 立即停止 WriteQueue 接收新寫入
        this.#writeQueue.close();

        // 2. 有界等待底層操作結束 (最多等待 emergencyWaitMs, 預設 1000ms)
        const waitDeadline = Date.now() + (this.#config.emergencyWaitMs || 1000);
        let status = this.#adapter.getActiveStatus();

        while ((status.underlyingExecuting || status.activeTransactions > 0) && Date.now() < waitDeadline) {
            await new Promise(r => setTimeout(r, 50));
            status = this.#adapter.getActiveStatus();
        }

        // 3. 檢查是否仍有底層操作執行中
        if (status.underlyingExecuting || status.activeTransactions > 0) {
            console.error('🚨 [EMERGENCY_CLOSE_ABORTED] SQLite 底層仍在執行操作，為防記憶體損毀嚴禁呼叫 rawClose()！');
            const dump = {
                timestamp: new Date().toISOString(),
                origin,
                error: err?.message || String(err),
                stack: err?.stack || null,
                adapterStatus: status,
                queueMetrics: this.#writeQueue.getMetrics()
            };
            console.error('💥 [CRASH_DIAGNOSTIC_DUMP]', JSON.stringify(dump, null, 2));

            if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
                process.exit(1);
            }
            return { success: false, forcedExit: true, dump };
        }

        // 4. 底層無操作，可安全調用 emergencyClose
        try {
            await this.#adapter.emergencyClose();
            console.log('🔒 [EMERGENCY_SHUTDOWN] SQLite 連線已安全釋放');
        } catch (closeErr) {
            console.error('⚠️ [EMERGENCY_SHUTDOWN] emergencyClose 報錯:', closeErr.message);
        }

        if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
            process.exit(1);
        }
        return { success: true, forcedExit: false };
    }
}

module.exports = {
    ShutdownHandler
};
