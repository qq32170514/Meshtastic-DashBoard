// src/database/shutdown-handler.js
const { shutdown: defaultShutdownConfig } = require('./sqlite.config');
const { ADAPTER_STATES } = require('./sqlite.adapter');

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
     * 🌟 優雅關閉 (Graceful Shutdown - P0-3, P0-5, P0-6)
     */
    handle(signal = 'SIGINT', options = {}) {
        if (this.#shutdownPromise) {
            console.log(`ℹ️ [SHUTDOWN] 已在執行關閉流程中，忽略重複呼叫 (${signal})`);
            return this.#shutdownPromise;
        }

        this.#shutdownPromise = (async () => {
            const startTime = Date.now();
            console.log(`🛑 [SHUTDOWN] 接收到信號 ${signal}，啟動安全關閉流程...`);

            // P0-2: 精確計算總時間預算分配 (pm2KillTimeoutMs, drainWaitBufferMs, drainTimeoutMs)
            const totalBudget = this.#config.pm2KillTimeoutMs || 10000;
            const waitBufferMs = this.#config.drainWaitBufferMs || 1500;
            const drainTimeoutMs = Math.min(this.#config.drainTimeoutMs || 8000, Math.max(1000, totalBudget - waitBufferMs));

            let drainCap = null;
            let drainClean = false;

            // 1. 簽發本次專屬且受限時間之 DrainCapability
            try {
                drainCap = this.#authority.issueDrainCapability(drainTimeoutMs);
            } catch (authErr) {
                console.error('❌ [SHUTDOWN] 簽發 DrainCapability 失敗:', authErr.message);
                throw authErr;
            }

            // 2. 執行 WriteQueue 排空 (包含獨立 Deadline Observer 控制)
            try {
                const drainResult = await this.#writeQueue.drain(drainCap, drainTimeoutMs);
                const qMetrics = this.#writeQueue.getMetrics();
                const adapterStatus = this.#adapter.getActiveStatus();

                if (
                    drainResult.isClean &&
                    !drainResult.deadlineExpired &&
                    !drainResult.hasUncommittedErrors &&
                    !drainResult.isDiskFull &&
                    qMetrics.totalUncommitted === 0 &&
                    adapterStatus.isQuiescent
                ) {
                    drainClean = true;
                    this.#authority.markDrainCompleted(drainCap);
                    console.log('✅ [SHUTDOWN] 隊列資料已全數安全寫入並排空');
                } else {
                    console.warn(`⚠️ [SHUTDOWN] 隊列未完全排空 (未提交: ${qMetrics.totalUncommitted}, 在途: ${qMetrics.inFlightCount}, 未提錯誤: ${qMetrics.uncommittedErrorCount || 0}, 磁碟滿額: ${Boolean(drainResult.isDiskFull)}, Quiescent: ${adapterStatus.isQuiescent})`);
                }
            } catch (drainErr) {
                console.error('⚠️ [SHUTDOWN] 隊列排空階段遭遇異常或超時:', drainErr.message);
            }

            // 3. 執行 TRUNCATE Checkpoint (僅在排空乾淨且具備完成憑證與前置條件時)
            if (drainClean && this.#authority.isDrainCompleted(drainCap)) {
                try {
                    console.log('🔄 [SHUTDOWN] 執行 wal_checkpoint(TRUNCATE)...');
                    await this.#adapter.checkpoint('TRUNCATE', drainCap, () => this.#writeQueue.getMetrics());
                    console.log('✅ [SHUTDOWN] WAL 檔案已安全截斷並回寫主資料庫');
                } catch (cpErr) {
                    console.error('⚠️ [SHUTDOWN] Checkpoint TRUNCATE 失敗:', cpErr.message);
                }
            } else {
                console.warn('⚠️ [SHUTDOWN] 由於隊列未乾淨排空或未達靜止，跳過 TRUNCATE Checkpoint 以防止損壞');
            }

            // 4. 關閉 Adapter 連線 (P0-2: 有界等待，嚴禁無限懸掛)
            let adapterClosed = false;
            let closeError = null;
            const elapsed = Date.now() - startTime;
            const remainingCloseBudget = Math.max(100, Math.min(waitBufferMs, totalBudget - elapsed));

            try {
                await this.#adapter.close(remainingCloseBudget);
                adapterClosed = true;
                console.log('🔒 [SHUTDOWN] SQLite 連線已安全關閉');
            } catch (closeErr) {
                closeError = closeErr;
                adapterClosed = false;
                console.error('❌ [SHUTDOWN] Adapter 關閉失敗:', closeErr.message);
            }

            const durationMs = Date.now() - startTime;
            const finalMetrics = this.#writeQueue.getMetrics();
            const hasUncommittedData = (finalMetrics.totalUncommitted > 0);
            const overallSuccess = Boolean(drainClean && adapterClosed && !hasUncommittedData);
            console.log(`🏁 [SHUTDOWN] 關閉流程完成，耗時 ${durationMs}ms (成功: ${overallSuccess}, Adapter關閉: ${adapterClosed}, 資料潔淨: ${!hasUncommittedData})`);

            const result = {
                success: overallSuccess,
                adapterClosed: Boolean(adapterClosed),
                dataClean: Boolean(drainClean && !hasUncommittedData),
                hasUncommittedData,
                durationMs,
                signal,
                metrics: finalMetrics,
                diagnostics: {
                    adapterStatus: this.#adapter.getActiveStatus(),
                    queueMetrics: finalMetrics,
                    closeError: closeError ? closeError.message : null
                }
            };

            if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
                process.exit(overallSuccess ? 0 : 1);
            }

            return result;
        })();

        return this.#shutdownPromise;
    }

    /**
     * 🌟 緊急崩潰關閉處理 (Emergency Crash Shutdown - P0-2, P0-3, P0-4)
     * 同時檢查 Adapter 靜止與 WriteQueue 未提交狀態；未 Quiescent 嚴禁 rawClose()，有未提交資料嚴禁宣告成功
     */
    async handleEmergencyCrash(err, origin = 'uncaughtException', options = {}) {
        console.error(`🚨 [EMERGENCY_SHUTDOWN] 觸發緊急關閉！來源: ${origin} | 錯誤:`, err);

        // 1. 立即停止 Adapter 接受新工作閘門與 WriteQueue
        this.#adapter.stopAcceptingNewTasks();
        this.#writeQueue.close();

        // 2. 有界等待底層操作與 Scheduler 靜止 (最多等待 emergencyWaitMs, 預設 1000ms)
        const waitDeadline = Date.now() + (this.#config.emergencyWaitMs || 1000);
        let status = this.#adapter.getActiveStatus();

        while (!this.#adapter.isQuiescent() && Date.now() < waitDeadline) {
            await new Promise(r => setTimeout(r, 50));
            status = this.#adapter.getActiveStatus();
        }

        const qMetrics = this.#writeQueue.getMetrics();
        const hasUncommittedData = (qMetrics.totalUncommitted > 0);
        const dataClean = (!hasUncommittedData);

        // 3. 檢查是否達到完整 Quiescent (包含 schedulerPending, activeTransactions, underlyingExecuting)
        if (!this.#adapter.isQuiescent()) {
            console.error('🚨 [EMERGENCY_CLOSE_ABORTED] SQLite Adapter 尚未達到完全靜止狀態，為防記憶體損毀嚴禁呼叫 rawClose()！');
            const dump = {
                timestamp: new Date().toISOString(),
                origin,
                error: err?.message || String(err),
                stack: err?.stack || null,
                adapterStatus: status,
                queueMetrics: qMetrics
            };
            console.error('💥 [CRASH_DIAGNOSTIC_DUMP]', JSON.stringify(dump, null, 2));

            if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
                process.exit(1);
            }
            return {
                success: false,
                adapterClosed: false,
                dataClean: false,
                hasUncommittedData,
                forcedExit: true,
                queueMetrics: qMetrics,
                dump
            };
        }

        // 4. 底層無操作且佇列靜止，可安全調用 emergencyClose (P0-3: 誠實回報成功語意)
        let adapterClosed = false;
        let closeErrMessage = null;
        try {
            await this.#adapter.emergencyClose();
            adapterClosed = (this.#adapter.state === ADAPTER_STATES.CLOSED);
            console.log('🔒 [EMERGENCY_SHUTDOWN] SQLite 連線已安全釋放');
        } catch (closeErr) {
            closeErrMessage = closeErr.message;
            console.error('⚠️ [EMERGENCY_SHUTDOWN] emergencyClose 報錯:', closeErr.message);
        }

        const overallSuccess = Boolean(adapterClosed && dataClean);

        if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
            process.exit(overallSuccess ? 0 : 1);
        }
        return {
            success: overallSuccess,
            adapterClosed,
            dataClean,
            hasUncommittedData,
            forcedExit: false,
            queueMetrics: qMetrics,
            diagnostics: {
                adapterStatus: this.#adapter.getActiveStatus(),
                queueMetrics: qMetrics,
                closeError: closeErrMessage
            }
        };
    }
}

module.exports = {
    ShutdownHandler
};
