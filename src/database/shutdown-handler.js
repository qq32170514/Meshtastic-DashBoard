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
     * 🌟 判斷是否符合 Emergency Close 的 7 項嚴格准入條件 (v2.7.5 P1)
     */
    _canSafelyEmergencyClose() {
        const status = this.#adapter.getActiveStatus();
        const qMetrics = this.#writeQueue.getMetrics();
        const flushWorkerActive = typeof this.#writeQueue.isFlushWorkerActive === 'function'
            ? this.#writeQueue.isFlushWorkerActive()
            : Boolean(this.#writeQueue.isFlushing || qMetrics.flushWorkerActive);

        return Boolean(
            this.#adapter.isQuiescent() &&
            status.isQuiescent &&
            qMetrics.inFlightCount === 0 &&
            !flushWorkerActive &&
            status.schedulerPending === 0 &&
            status.schedulerActive === 0 &&
            status.activeTransactions === 0 &&
            !status.underlyingExecuting &&
            !status.maintenanceInProgress &&
            !status.checkpointInProgress
        );
    }

    /**
     * 🌟 優雅關閉 (Graceful Shutdown - v2.7.5 P0 全流程共用單一絕對 Deadline)
     */
    handle(signal = 'SIGINT', options = {}) {
        if (this.#shutdownPromise) {
            console.log(`ℹ️ [SHUTDOWN] 已在執行關閉流程中，忽略重複呼叫 (${signal})`);
            return this.#shutdownPromise;
        }

        this.#shutdownPromise = (async () => {
            const startTime = Date.now();
            console.log(`🛑 [SHUTDOWN] 接收到信號 ${signal}，啟動安全關閉流程...`);

            // 🌟 v2.7.5 P0: 建立唯一絕對 Shutdown Deadline，Drain / Checkpoint / Close 全流程共用
            const totalShutdownBudget = typeof this.#config.pm2KillTimeoutMs === 'number'
                ? this.#config.pm2KillTimeoutMs
                : 10000;
            const shutdownDeadlineAt = startTime + totalShutdownBudget;
            const configuredWaitBufferMs = typeof this.#config.drainWaitBufferMs === 'number'
                ? this.#config.drainWaitBufferMs
                : 1500;
            const waitBufferMs = Math.min(configuredWaitBufferMs, Math.floor(totalShutdownBudget * 0.5));
            const configuredDrainTimeout = typeof this.#config.drainTimeoutMs === 'number'
                ? this.#config.drainTimeoutMs
                : 8000;

            const getRemainingBudget = () => shutdownDeadlineAt - Date.now();

            let drainCap = null;
            let drainClean = false;
            let deadlineExpired = false;
            let drainError = null;

            let checkpointAttempted = false;
            let checkpointCompleted = false;
            let checkpointTimedOut = false;
            let checkpointError = null;

            let adapterClosed = false;
            let closeTimedOut = false;
            let closeError = null;

            // 1. 簽發本次專屬且受限於共用 Deadline 之 DrainCapability
            const capTtlMs = getRemainingBudget();
            if (capTtlMs <= 0) {
                deadlineExpired = true;
            } else {
                try {
                    drainCap = this.#authority.issueDrainCapability(capTtlMs);
                } catch (authErr) {
                    console.error('❌ [SHUTDOWN] 簽發 DrainCapability 失敗:', authErr.message);
                    throw authErr;
                }
            }

            // 2. 階段一：執行 WriteQueue 排空 (受共用 Deadline 限制)
            const remainingForDrain = getRemainingBudget();
            if (remainingForDrain <= 0 || !drainCap) {
                deadlineExpired = true;
                drainClean = false;
                console.warn('⚠️ [SHUTDOWN] 進入 Drain 階段前已無剩餘時間預算，直接進入 Timeout 處理');
            } else {
                const maxDrainBudget = Math.max(1, totalShutdownBudget - waitBufferMs);
                const drainTimeoutMs = Math.min(configuredDrainTimeout, maxDrainBudget, remainingForDrain);

                try {
                    const drainResult = await this.#writeQueue.drain(drainCap, drainTimeoutMs);
                    const qMetrics = this.#writeQueue.getMetrics();
                    const adapterStatus = this.#adapter.getActiveStatus();
                    const flushWorkerActive = typeof this.#writeQueue.isFlushWorkerActive === 'function'
                        ? this.#writeQueue.isFlushWorkerActive()
                        : Boolean(this.#writeQueue.isFlushing);

                    if (drainResult.deadlineExpired || getRemainingBudget() <= 0) {
                        deadlineExpired = true;
                    }

                    if (
                        drainResult.isClean &&
                        !drainResult.deadlineExpired &&
                        !drainResult.hasUncommittedErrors &&
                        !drainResult.isDiskFull &&
                        qMetrics.totalUncommitted === 0 &&
                        qMetrics.inFlightCount === 0 &&
                        !flushWorkerActive &&
                        adapterStatus.activeTransactions === 0 &&
                        adapterStatus.isQuiescent
                    ) {
                        drainClean = true;
                        if (getRemainingBudget() > 0) {
                            this.#authority.markDrainCompleted(drainCap);
                        } else {
                            deadlineExpired = true;
                        }
                        console.log('✅ [SHUTDOWN] 隊列資料已全數安全寫入並排空');
                    } else {
                        console.warn(`⚠️ [SHUTDOWN] 隊列未完全排空 (未提交: ${qMetrics.totalUncommitted}, 在途: ${qMetrics.inFlightCount}, 未提錯誤: ${qMetrics.uncommittedErrorCount || 0}, 磁碟滿額: ${Boolean(drainResult.isDiskFull)}, Quiescent: ${adapterStatus.isQuiescent})`);
                    }
                } catch (drainErr) {
                    drainError = drainErr;
                    if (getRemainingBudget() <= 0) {
                        deadlineExpired = true;
                    }
                    console.error('⚠️ [SHUTDOWN] 隊列排空階段遭遇異常或超時:', drainErr.message);
                }
            }

            // 3. 階段二：執行 TRUNCATE Checkpoint (必須在排空乾淨、前置條件成立且共用 Deadline 尚有剩餘時間時)
            const preCpMetrics = this.#writeQueue.getMetrics();
            const preCpStatus = this.#adapter.getActiveStatus();
            const canAttemptTruncate = Boolean(
                drainClean &&
                drainCap &&
                this.#authority.isDrainCompleted(drainCap) &&
                preCpMetrics.totalUncommitted === 0 &&
                preCpMetrics.uncommittedErrorCount === 0 &&
                preCpMetrics.inFlightCount === 0 &&
                preCpStatus.activeTransactions === 0 &&
                preCpStatus.isQuiescent
            );

            if (canAttemptTruncate) {
                const remainingForCheckpoint = getRemainingBudget();
                if (remainingForCheckpoint <= 0) {
                    checkpointTimedOut = true;
                    deadlineExpired = true;
                    checkpointError = new Error('[CHECKPOINT_TIMEOUT] 進入 Checkpoint 階段時已超過 Shutdown Deadline');
                    console.warn('⚠️ [SHUTDOWN] 剩餘時間小於零，標記 Checkpoint Timeout 並跳過執行');
                } else {
                    checkpointAttempted = true;
                    try {
                        console.log('🔄 [SHUTDOWN] 執行 wal_checkpoint(TRUNCATE)...');
                        await this.#adapter.checkpoint(
                            'TRUNCATE',
                            drainCap,
                            () => this.#writeQueue.getMetrics(),
                            {
                                timeoutMs: remainingForCheckpoint,
                                deadlineAt: shutdownDeadlineAt
                            }
                        );
                        checkpointCompleted = true;
                        console.log('✅ [SHUTDOWN] WAL 檔案已安全截斷並回寫主資料庫');
                    } catch (cpErr) {
                        checkpointError = cpErr;
                        checkpointCompleted = false;
                        if (String(cpErr.message || '').includes('CHECKPOINT_TIMEOUT') || getRemainingBudget() <= 0) {
                            checkpointTimedOut = true;
                            deadlineExpired = true;
                        }
                        console.error('⚠️ [SHUTDOWN] Checkpoint TRUNCATE 失敗:', cpErr.message);
                    }
                }
            } else {
                console.warn('⚠️ [SHUTDOWN] 由於隊列未乾淨排空或未達靜止，跳過 TRUNCATE Checkpoint 以防止損壞');
            }

            // 4. 階段三：關閉 Adapter 連線 (嚴格使用剩餘共用預算與單一絕對 Deadline，絕不保底加時、絕不對活動連線執行 rawClose)
            const remainingForClose = getRemainingBudget();
            if (remainingForClose <= 0 || checkpointTimedOut) {
                deadlineExpired = true;
                adapterClosed = false;
                if (!checkpointTimedOut) {
                    closeTimedOut = true;
                }
                const reasonMsg = checkpointTimedOut
                    ? '[CLOSE_SKIPPED_CHECKPOINT_TIMEOUT] Checkpoint 超時未完成，禁止強制關閉仍在活動中之 SQLite 連線'
                    : `[CLOSE_TIMEOUT] Shutdown Deadline 已到期 (剩餘: ${remainingForClose}ms)，跳過 Close 階段`;
                closeError = new Error(reasonMsg);
                console.error(`❌ [SHUTDOWN] ${reasonMsg}`);
            } else {
                try {
                    await this.#adapter.close({
                        timeoutMs: remainingForClose,
                        deadlineAt: shutdownDeadlineAt
                    });
                    const postCloseStatus = this.#adapter.getActiveStatus();
                    adapterClosed = Boolean(
                        this.#adapter.state === ADAPTER_STATES.CLOSED &&
                        !postCloseStatus.nativeClosePending
                    );
                    console.log('🔒 [SHUTDOWN] SQLite 連線已安全關閉');
                } catch (closeErr) {
                    closeError = closeErr;
                    adapterClosed = false;
                    const errMsg = String(closeErr.message || '');
                    if (errMsg.includes('CLOSE_TIMEOUT') || errMsg.includes('NATIVE_CLOSE_TIMEOUT') || getRemainingBudget() <= 0) {
                        closeTimedOut = true;
                        deadlineExpired = true;
                    }
                    console.error('❌ [SHUTDOWN] Adapter 關閉失敗:', closeErr.message);
                }
            }

            const durationMs = Date.now() - startTime;
            const finalMetrics = this.#writeQueue.getMetrics();
            const finalAdapterStatus = this.#adapter.getActiveStatus();
            const nativeClosePending = Boolean(finalAdapterStatus.nativeClosePending);
            closeTimedOut = Boolean(closeTimedOut || finalAdapterStatus.closeTimedOut);
            adapterClosed = Boolean(
                adapterClosed &&
                this.#adapter.state === ADAPTER_STATES.CLOSED &&
                !nativeClosePending
            );
            const hasUncommittedData = (finalMetrics.totalUncommitted > 0);
            const overallSuccess = Boolean(
                drainClean &&
                checkpointCompleted &&
                !checkpointTimedOut &&
                !checkpointError &&
                !deadlineExpired &&
                !closeTimedOut &&
                !nativeClosePending &&
                adapterClosed &&
                !hasUncommittedData
            );
            console.log(`🏁 [SHUTDOWN] 關閉流程完成，耗時 ${durationMs}ms (成功: ${overallSuccess}, Checkpoint完成: ${checkpointCompleted}, Adapter關閉: ${adapterClosed}, NativeClosePending: ${nativeClosePending}, 資料潔淨: ${!hasUncommittedData})`);

            const result = {
                success: overallSuccess,
                adapterClosed: Boolean(adapterClosed),
                nativeClosePending: Boolean(nativeClosePending),
                closeTimedOut: Boolean(closeTimedOut),
                dataClean: Boolean(drainClean && !hasUncommittedData),
                hasUncommittedData,
                checkpointCompleted: Boolean(checkpointCompleted),
                checkpointTimedOut: Boolean(checkpointTimedOut),
                deadlineExpired: Boolean(deadlineExpired),
                durationMs,
                signal,
                metrics: finalMetrics,
                diagnostics: {
                    adapterStatus: finalAdapterStatus,
                    queueMetrics: finalMetrics,
                    nativeClosePending: Boolean(nativeClosePending),
                    closeTimedOut: Boolean(closeTimedOut),
                    adapterClosed: Boolean(adapterClosed),
                    checkpoint: {
                        attempted: checkpointAttempted,
                        completed: checkpointCompleted,
                        timedOut: checkpointTimedOut,
                        error: checkpointError ? checkpointError.message : null
                    },
                    drainError: drainError ? drainError.message : null,
                    closeError: closeError ? closeError.message : null,
                    deadlineAt: shutdownDeadlineAt,
                    remainingBudgetMs: getRemainingBudget()
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
     * 🌟 緊急崩潰關閉處理 (Emergency Crash Shutdown - v2.7.5 P1 & v2.7.6 P0-2)
     * 同時檢查 Adapter 靜止、WriteQueue In-Flight 與 Flush Worker 狀態；
     * 全程共用單一絕對 emergencyDeadlineAt 約束靜止等待與原生 db.close(callback)
     */
    async handleEmergencyCrash(err, origin = 'uncaughtException', options = {}) {
        console.error(`🚨 [EMERGENCY_SHUTDOWN] 觸發緊急關閉！來源: ${origin} | 錯誤:`, err);

        // 1. 立即停止 Adapter 接受新工作閘門與 WriteQueue
        this.#adapter.stopAcceptingNewTasks();
        this.#writeQueue.close();

        // 2. 建立單一絕對 Emergency Deadline，有界等待底層操作、Scheduler、Queue In-Flight 與 Flush Worker 靜止
        const emergencyBudgetMs = typeof this.#config.emergencyWaitMs === 'number'
            ? this.#config.emergencyWaitMs
            : 1000;
        const emergencyDeadlineAt = Date.now() + emergencyBudgetMs;
        const getRemainingEmergencyBudget = () => emergencyDeadlineAt - Date.now();

        while (
            !this._canSafelyEmergencyClose() &&
            !this.#adapter.getActiveStatus().nativeClosePending &&
            Date.now() < emergencyDeadlineAt
        ) {
            const remainingWait = getRemainingEmergencyBudget();
            if (remainingWait <= 0) break;
            await new Promise(r => setTimeout(r, Math.min(25, remainingWait)));
        }

        const status = this.#adapter.getActiveStatus();
        const qMetrics = this.#writeQueue.getMetrics();
        const flushWorkerActive = typeof this.#writeQueue.isFlushWorkerActive === 'function'
            ? this.#writeQueue.isFlushWorkerActive()
            : Boolean(this.#writeQueue.isFlushing || qMetrics.flushWorkerActive);
        const hasUncommittedData = (qMetrics.totalUncommitted > 0);
        const dataClean = (!hasUncommittedData);

        const safeToJoinExistingNativeClose = Boolean(
            status.nativeClosePending &&
            qMetrics.inFlightCount === 0 &&
            !flushWorkerActive &&
            status.schedulerPending === 0 &&
            status.schedulerActive === 0 &&
            status.activeTransactions === 0 &&
            !status.underlyingExecuting &&
            !status.maintenanceInProgress &&
            !status.checkpointInProgress
        );

        // 3. 檢查 7 項安全關閉准入條件 (Adapter Quiescent + Queue In-Flight 為 0 + Flush Worker 未執行)
        if (!this._canSafelyEmergencyClose() && !safeToJoinExistingNativeClose) {
            console.error('🚨 [EMERGENCY_CLOSE_ABORTED] SQLite Adapter 或 WriteQueue In-Flight / Flush Worker 尚未達到完全靜止狀態，為防記憶體損毀或競態嚴禁呼叫 emergencyClose()！');
            const dump = {
                timestamp: new Date().toISOString(),
                origin,
                error: err?.message || String(err),
                stack: err?.stack || null,
                adapterStatus: status,
                queueMetrics: qMetrics,
                flushWorkerActive: Boolean(flushWorkerActive),
                schedulerPending: status.schedulerPending,
                schedulerActive: status.schedulerActive
            };
            console.error('💥 [CRASH_DIAGNOSTIC_DUMP]', JSON.stringify(dump, null, 2));

            if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
                process.exit(1);
            }
            return {
                success: false,
                adapterClosed: false,
                nativeClosePending: Boolean(status.nativeClosePending),
                closeTimedOut: Boolean(status.closeTimedOut),
                dataClean: false,
                hasUncommittedData,
                queueMetrics: qMetrics,
                flushWorkerActive: Boolean(flushWorkerActive),
                schedulerPending: status.schedulerPending,
                schedulerActive: status.schedulerActive,
                forcedExit: true,
                dump,
                diagnostics: {
                    adapterStatus: status,
                    queueMetrics: qMetrics,
                    flushWorkerActive: Boolean(flushWorkerActive),
                    schedulerPending: status.schedulerPending,
                    schedulerActive: status.schedulerActive,
                    nativeClosePending: Boolean(status.nativeClosePending),
                    closeTimedOut: Boolean(status.closeTimedOut),
                    adapterClosed: false,
                    closeError: '[EMERGENCY_CLOSE_ABORTED] Adapter 或 WriteQueue In-Flight / Flush Worker 尚有在途操作未靜止',
                    deadlineAt: emergencyDeadlineAt,
                    remainingBudgetMs: getRemainingEmergencyBudget()
                }
            };
        }

        // 4. 底層無操作、Queue 無 In-Flight 且 Flush Worker 靜止，受共用 emergencyDeadlineAt 限制調用 emergencyClose
        let adapterClosed = false;
        let closeTimedOut = false;
        let closeErrMessage = null;
        const remainingForEmergencyClose = getRemainingEmergencyBudget();

        try {
            await this.#adapter.emergencyClose(
                {
                    inFlightCount: qMetrics.inFlightCount,
                    flushWorkerActive: Boolean(flushWorkerActive)
                },
                {
                    timeoutMs: remainingForEmergencyClose,
                    deadlineAt: emergencyDeadlineAt
                }
            );
            const postCloseStatus = this.#adapter.getActiveStatus();
            adapterClosed = Boolean(
                this.#adapter.state === ADAPTER_STATES.CLOSED &&
                !postCloseStatus.nativeClosePending
            );
            console.log('🔒 [EMERGENCY_SHUTDOWN] SQLite 連線已安全釋放');
        } catch (closeErr) {
            closeErrMessage = closeErr.message;
            adapterClosed = false;
            const errMsg = String(closeErr.message || '');
            if (errMsg.includes('CLOSE_TIMEOUT') || errMsg.includes('NATIVE_CLOSE_TIMEOUT') || getRemainingEmergencyBudget() <= 0) {
                closeTimedOut = true;
            }
            console.error('⚠️ [EMERGENCY_SHUTDOWN] emergencyClose 報錯:', closeErr.message);
        }

        const finalStatus = this.#adapter.getActiveStatus();
        const nativeClosePending = Boolean(finalStatus.nativeClosePending);
        closeTimedOut = Boolean(closeTimedOut || finalStatus.closeTimedOut);
        adapterClosed = Boolean(
            adapterClosed &&
            this.#adapter.state === ADAPTER_STATES.CLOSED &&
            !nativeClosePending
        );
        const overallSuccess = Boolean(adapterClosed && !nativeClosePending && !closeTimedOut && dataClean);

        if (options.exitProcess !== false && typeof process !== 'undefined' && process.exit) {
            process.exit(overallSuccess ? 0 : 1);
        }
        return {
            success: overallSuccess,
            adapterClosed: Boolean(adapterClosed),
            nativeClosePending: Boolean(nativeClosePending),
            closeTimedOut: Boolean(closeTimedOut),
            dataClean: Boolean(dataClean),
            hasUncommittedData,
            queueMetrics: qMetrics,
            flushWorkerActive: Boolean(flushWorkerActive),
            schedulerPending: finalStatus.schedulerPending,
            schedulerActive: finalStatus.schedulerActive,
            forcedExit: false,
            diagnostics: {
                adapterStatus: finalStatus,
                queueMetrics: qMetrics,
                flushWorkerActive: Boolean(flushWorkerActive),
                schedulerPending: finalStatus.schedulerPending,
                schedulerActive: finalStatus.schedulerActive,
                nativeClosePending: Boolean(nativeClosePending),
                closeTimedOut: Boolean(closeTimedOut),
                adapterClosed: Boolean(adapterClosed),
                closeError: closeErrMessage,
                deadlineAt: emergencyDeadlineAt,
                remainingBudgetMs: getRemainingEmergencyBudget()
            }
        };
    }
}

module.exports = {
    ShutdownHandler
};
