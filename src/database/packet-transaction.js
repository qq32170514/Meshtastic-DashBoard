// src/database/packet-transaction.js
// 4.0.2 Packet Transaction Boundary
// 將單一邏輯封包事件（MQTT ServiceEnvelope 或 RF Tunnel Position）的所有關聯 SQLite 寫入
// 封裝為不可拆分的單一交易單位（Atomic Packet Transaction Unit），並嚴格隔離交易內 SQL 與交易後（Post-Commit）副作用。

const NODE_DISCOVERY_UPSERT_SQL = `
    INSERT INTO nodes (node_id, last_seen, last_topic, channel, hop_limit, hop_start, last_gateway) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET last_seen=excluded.last_seen, last_topic=excluded.last_topic, channel=COALESCE(excluded.channel, nodes.channel), hop_limit=excluded.hop_limit, hop_start=excluded.hop_start, last_gateway=excluded.last_gateway
`.trim();

const ENCRYPTED_PACKET_LOG_INSERT_SQL = `
    INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, hops_away) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const DECODED_PACKET_LOG_INSERT_SQL = `
    INSERT INTO packet_logs (node_id, portnum, topic, gateway_id, snr, rssi, hop_limit, hop_start, payload_json, raw_hex, latitude, longitude, hops_away) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const CHAT_MESSAGE_INSERT_SQL = `
    INSERT INTO chat_messages (node_id, message, channel_name) VALUES (?, ?, ?)
`.trim();

const NEIGHBOR_UPSERT_SQL = `
    INSERT INTO neighbors (node_id, neighbor_id, snr) VALUES (?, ?, ?) ON CONFLICT(node_id, neighbor_id) DO UPDATE SET snr=excluded.snr, last_seen=CURRENT_TIMESTAMP
`.trim();

const NODE_POSITION_UPDATE_SQL = `
    UPDATE nodes SET latitude = ?, longitude = ? WHERE node_id = ?
`.trim();

const NODE_INFO_UPDATE_SQL = `
    UPDATE nodes SET long_name = ?, short_name = ?, role = ?, hw_model = ?, firmware_version = ?, firmware_build_num = ? WHERE node_id = ?
`.trim();

const NODE_MAP_REPORT_UPDATE_SQL = `
    UPDATE nodes SET 
        long_name = COALESCE(?, nodes.long_name), 
        short_name = COALESCE(?, nodes.short_name), 
        latitude = ?, 
        longitude = ?,
        hw_model = COALESCE(?, nodes.hw_model),
        role = COALESCE(?, nodes.role),
        firmware_version = COALESCE(?, nodes.firmware_version)
    WHERE node_id = ?
`.trim();

const NODE_TELEMETRY_UPDATE_SQL = `
    UPDATE nodes SET 
        battery_level = COALESCE(?, nodes.battery_level), 
        voltage = COALESCE(?, nodes.voltage), 
        current = COALESCE(?, nodes.current), 
        temperature = COALESCE(?, nodes.temperature), 
        humidity = COALESCE(?, nodes.humidity) 
    WHERE node_id = ?
`.trim();

const TELEMETRY_DATA_INSERT_SQL = `
    INSERT INTO telemetry_data 
    (node_id, battery_level, voltage, temperature, humidity, channel_utilization, air_util_tx, snr, rssi, current, hop_limit, hop_start, adc_voltage) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const TUNNEL_PACKET_LOG_INSERT_SQL = `
    INSERT INTO packet_logs (node_id, portnum, gateway_id, snr, rssi, latitude, longitude, hops_away, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`.trim();

const TUNNEL_NODE_UPDATE_SQL = `
    UPDATE nodes SET last_seen = CURRENT_TIMESTAMP, last_gateway = ? WHERE node_id = ?
`.trim();

/**
 * 建立單一已解碼或未解碼 MQTT 封包的交易計畫（純資料結構與 SQL 清單，無任何外部 I/O 副作用）
 *
 * @param {object} context
 * @returns {{
 *   label: string,
 *   packetMeta: object,
 *   statements: Array<{ sql: string, params: Array<any> }>,
 *   postCommitEffects: {
 *     emits: Array<{ type: string, payload: object }>,
 *     analytics: null | { port: any, snr: any, rssi: any, temp?: any, hum?: any },
 *     logs: Array<string>
 *   }
 * }}
 */
function buildMqttPacketTransactionPlan(context) {
    const {
        fromId,
        topic,
        resolvedChannel = null,
        gatewayId = 'Unknown',
        packet = {},
        rawHex = '',
        decodedData = null,
        payloadObj = null,
        packetLat = undefined,
        packetLng = undefined,
        neighborList = null,
        nodeInfoData = null,
        positionData = null,
        mapReportData = null,
        telemetryData = null,
        extraStatements = null
    } = context;

    const hopLimit = packet.hop_limit || 0;
    const hopStart = packet.hop_start || 0;
    const hopsAway = Math.max(0, hopStart - hopLimit);
    const rxSnr = packet.rx_snr !== undefined ? packet.rx_snr : null;
    const rxRssi = packet.rx_rssi !== undefined ? packet.rx_rssi : null;
    const nowIso = new Date().toISOString();
    const nowTime = new Date().toLocaleTimeString();

    const statements = [];
    const emits = [];
    const logs = [];
    let analytics = null;

    // 1. 基礎節點在線狀態 Upsert（確保未知節點在未收到 NODEINFO 前也能先建立節點紀錄並在同一交易內更新衍生欄位）
    statements.push({
        sql: NODE_DISCOVERY_UPSERT_SQL,
        params: [fromId, topic, resolvedChannel, hopLimit, hopStart, gatewayId]
    });

    emits.push({
        type: 'node_seen',
        payload: {
            node_id: fromId,
            last_seen: nowIso,
            last_topic: topic,
            channel: resolvedChannel
        }
    });

    // 2. 若無法解碼（ENCRYPTED），在同一交易中寫入 packet_logs
    if (!decodedData) {
        statements.push({
            sql: ENCRYPTED_PACKET_LOG_INSERT_SQL,
            params: [
                fromId,
                'ENCRYPTED',
                topic,
                gatewayId,
                rxSnr || null,
                rxRssi || null,
                hopLimit,
                hopStart,
                null,
                rawHex,
                hopsAway
            ]
        });

        if (Array.isArray(extraStatements) && extraStatements.length > 0) {
            for (const extra of extraStatements) {
                statements.push(extra);
            }
        }

        emits.push({
            type: 'raw_packet',
            payload: {
                from: fromId,
                portnum: 'ENCRYPTED',
                topic,
                gateway_id: gatewayId,
                timestamp: nowIso,
                time: nowTime,
                snr: packet.rx_snr,
                rssi: packet.rx_rssi
            }
        });

        return {
            label: `MQTT_PACKET:${fromId}:ENCRYPTED`,
            packetMeta: { fromId, portnum: 'ENCRYPTED', gatewayId, topic },
            statements,
            postCommitEffects: {
                emits,
                analytics: null,
                logs
            }
        };
    }

    const port = decodedData.portnum;

    // 3. Port 專屬前置關聯寫入（TEXT_MESSAGE_APP / NEIGHBORINFO_APP）
    if ((port === 1 || port === 'TEXT_MESSAGE_APP') && payloadObj && typeof payloadObj.text === 'string') {
        const channelName = payloadObj.channel_name || decodedData.channel_name || 'MediumFast';
        statements.push({
            sql: CHAT_MESSAGE_INSERT_SQL,
            params: [fromId, payloadObj.text, channelName]
        });
    }

    if ((port === 71 || port === 'NEIGHBORINFO_APP') && Array.isArray(neighborList) && neighborList.length > 0) {
        for (const n of neighborList) {
            const nId = n.neighborId || `!${Number(n.node_id).toString(16).padStart(8, '0')}`;
            statements.push({
                sql: NEIGHBOR_UPSERT_SQL,
                params: [fromId, nId, n.snr]
            });
        }
    }

    // 4. 座標同步更新與封包日誌寫入
    if (packetLat && packetLng) {
        statements.push({
            sql: NODE_POSITION_UPDATE_SQL,
            params: [packetLat, packetLng, fromId]
        });
    }

    const payloadJson = payloadObj ? JSON.stringify(payloadObj) : null;
    statements.push({
        sql: DECODED_PACKET_LOG_INSERT_SQL,
        params: [
            fromId,
            port,
            topic,
            gatewayId,
            rxSnr || null,
            rxRssi || null,
            hopLimit,
            hopStart,
            payloadJson,
            rawHex,
            packetLat,
            packetLng,
            hopsAway
        ]
    });

    emits.push({
        type: 'raw_packet',
        payload: {
            from: fromId,
            portnum: port,
            topic,
            gateway_id: gatewayId,
            timestamp: nowIso,
            time: nowTime,
            snr: packet.rx_snr,
            rssi: packet.rx_rssi,
            latitude: packetLat,
            longitude: packetLng,
            hops_away: hopsAway,
            payload_json: payloadObj
        }
    });

    // 5. Port 專屬節點狀態與衍生歷史表更新（全部納入同一個封包交易單位）
    if ((port === 4 || port === 'NODEINFO_APP') && nodeInfoData) {
        const finalRole = nodeInfoData.role || 'CLIENT';
        const hwModel = nodeInfoData.hw_model ?? nodeInfoData.hwModel ?? null;
        const firmwareVersion = nodeInfoData.firmware_version ?? nodeInfoData.firmwareVersion ?? null;
        const firmwareBuildNum = nodeInfoData.firmware_build_num ?? nodeInfoData.firmwareBuildNum ?? null;
        const longName = nodeInfoData.long_name ?? nodeInfoData.longName ?? null;
        const shortName = nodeInfoData.short_name ?? nodeInfoData.shortName ?? null;

        statements.push({
            sql: NODE_INFO_UPDATE_SQL,
            params: [longName, shortName, finalRole, hwModel, firmwareVersion, firmwareBuildNum, fromId]
        });

        logs.push(`👤 [節點資訊] 更新: ${shortName} 角色: ${finalRole}`);
        emits.push({
            type: 'node_seen',
            payload: {
                node_id: fromId,
                long_name: longName,
                short_name: shortName,
                role: finalRole,
                hw_model: hwModel,
                firmware_version: firmwareVersion,
                firmware_build_num: firmwareBuildNum,
                last_seen: nowIso,
                last_topic: topic
            }
        });
    }

    if ((port === 3 || port === 'POSITION_APP') && positionData && positionData.lat && positionData.lng) {
        // 若前置尚未寫入或座標不同，確保 nodes 表座標在同一交易更新
        if (!(packetLat && packetLng && packetLat === positionData.lat && packetLng === positionData.lng)) {
            statements.push({
                sql: NODE_POSITION_UPDATE_SQL,
                params: [positionData.lat, positionData.lng, fromId]
            });
        }
        emits.push({
            type: 'node_seen',
            payload: {
                node_id: fromId,
                latitude: positionData.lat,
                longitude: positionData.lng,
                last_seen: nowIso,
                last_topic: topic
            }
        });
    }

    if ((port === 73 || port === 'MAP_REPORT_APP') && mapReportData) {
        const {
            long_name = null,
            short_name = null,
            lat = null,
            lng = null,
            hwModel = null,
            role = null,
            fwVer = null
        } = mapReportData;

        statements.push({
            sql: NODE_MAP_REPORT_UPDATE_SQL,
            params: [long_name, short_name, lat, lng, hwModel, role, fwVer, fromId]
        });

        logs.push(`🗺️ [地圖報告] 節點: ${short_name} -> ${lat}, ${lng} FW: ${fwVer || '--'}`);
        emits.push({
            type: 'node_seen',
            payload: {
                node_id: fromId,
                long_name,
                short_name,
                latitude: lat,
                longitude: lng,
                hw_model: hwModel,
                role,
                firmware_version: fwVer,
                last_seen: nowIso,
                last_topic: topic
            }
        });
    }

    if ((port === 67 || port === 'TELEMETRY_APP') && telemetryData) {
        const {
            batteryLevel = null,
            finalVoltage = null,
            finalCurrent = null,
            temperature = null,
            humidity = null,
            channelUtilization = null,
            airUtilTx = null,
            adcVoltage = null
        } = telemetryData;

        const telemetryParams = [
            fromId,
            batteryLevel,
            finalVoltage,
            temperature,
            humidity,
            channelUtilization,
            airUtilTx,
            rxSnr,
            rxRssi,
            finalCurrent,
            hopLimit,
            hopStart,
            adcVoltage
        ];

        statements.push({
            sql: NODE_TELEMETRY_UPDATE_SQL,
            params: [batteryLevel, finalVoltage, finalCurrent, temperature, humidity, fromId]
        });

        statements.push({
            sql: TELEMETRY_DATA_INSERT_SQL,
            params: telemetryParams
        });

        analytics = {
            port,
            snr: packet.rx_snr,
            rssi: packet.rx_rssi,
            temp: temperature,
            hum: humidity
        };

        emits.push({
            type: 'telemetry_update',
            payload: {
                node_id: fromId,
                battery_level: batteryLevel,
                voltage: finalVoltage,
                current: finalCurrent,
                temperature,
                humidity,
                channel_utilization: channelUtilization,
                air_util_tx: airUtilTx,
                timestamp: nowIso,
                snr: rxSnr,
                rssi: rxRssi,
                hop_limit: hopLimit,
                hop_start: hopStart,
                adc_voltage: adcVoltage
            }
        });
    } else {
        analytics = {
            port,
            snr: packet.rx_snr,
            rssi: packet.rx_rssi
        };
    }

    if (Array.isArray(extraStatements) && extraStatements.length > 0) {
        for (const extra of extraStatements) {
            statements.push(extra);
        }
    }

    return {
        label: `MQTT_PACKET:${fromId}:${String(port)}`,
        packetMeta: { fromId, portnum: port, gatewayId, topic },
        statements,
        postCommitEffects: {
            emits,
            analytics,
            logs,
            isTelemetry: Boolean((port === 67 || port === 'TELEMETRY_APP') && telemetryData)
        }
    };
}

/**
 * 建立 RF TCP Tunnel 位置封包的原子交易計畫
 */
function buildRfTunnelPacketTransactionPlan(context) {
    const {
        fromId,
        gatewayId,
        snr = null,
        rssi = null,
        lat,
        lng,
        hopsAway = 0,
        sourceName,
        sourceLabel,
        packetData
    } = context;

    const statements = [
        {
            sql: TUNNEL_PACKET_LOG_INSERT_SQL,
            params: [fromId, 'POSITION', gatewayId, snr, rssi, lat, lng, hopsAway, sourceName]
        },
        {
            sql: TUNNEL_NODE_UPDATE_SQL,
            params: [`隧道:${sourceLabel}`, fromId]
        }
    ];

    return {
        label: `RF_TUNNEL_PACKET:${fromId}:${sourceName}`,
        packetMeta: { fromId, portnum: 'POSITION', gatewayId, source: sourceName },
        statements,
        postCommitEffects: {
            emits: packetData ? [{ type: 'raw_packet', payload: packetData }] : [],
            analytics: null,
            logs: []
        }
    };
}

/**
 * 記錄 Post-Commit Hook 異常，確保錯誤可被追蹤且不會阻斷其他 Hook 或使用者 Callback
 */
function reportPostCommitHookError(hookName, hookErr, planLabel, logger, postCommitErrors) {
    const errMsg = hookErr && hookErr.message ? hookErr.message : String(hookErr);
    const entry = {
        hook: hookName,
        label: planLabel || 'UNKNOWN_PLAN',
        message: errMsg,
        error: hookErr
    };
    postCommitErrors.push(entry);

    const formatted = `⚠️ [POST_COMMIT_HOOK_ERROR] (hook=${hookName}, plan=${planLabel || 'UNKNOWN'}): ${errMsg}`;
    if (logger && typeof logger.error === 'function') {
        try {
            logger.error(formatted);
            return;
        } catch (_) {
            // 若自訂 logger.error 本身也拋錯，退回原生 console.error
        }
    }
    try {
        console.error(formatted);
    } catch (_) {}
}

/**
 * 執行封包交易計畫：
 * - 將 `plan.statements` 作為單一不可拆分交易單位送入 `enqueuePacketFn`（或 `dbSubsystem.queuePacketTransaction`）
 * - 嚴格保證：唯有在 SQLite `COMMIT` 成功完成後，才執行 `postCommitEffects`（`batchEmit`、`recordLivePacketAnalytics`、日誌與使用者回呼）
 * - 若交易內任一語句失敗並 `ROLLBACK`，絕不觸發任何成功推播或戰情累加
 * - 每個 post-commit effect 皆有獨立 try/catch 保護，單一 hook 例外不阻斷其他 hook，且保證 caller callback 維持 exactly-once 執行
 */
function executePacketTransactionPlan(plan, hooks = {}, callback = null) {
    let callerCallbackInvoked = false;
    const invokeCallerCallbackOnce = (cbContext, cbErr, cbResult) => {
        if (typeof callback !== 'function') return;
        if (callerCallbackInvoked) return;
        callerCallbackInvoked = true;
        try {
            callback.call(cbContext || {}, cbErr, cbResult);
        } catch (cbEx) {
            try {
                console.error(`❌ [PACKET_TX_CALLBACK_EXCEPTION] (${plan?.label || 'UNKNOWN'}):`, cbEx?.message || cbEx);
            } catch (_) {}
        }
    };

    if (!plan || !Array.isArray(plan.statements) || plan.statements.length === 0) {
        const err = new Error('[INVALID_PACKET_PLAN] 封包交易計畫必須包含非空之 statements');
        invokeCallerCallbackOnce({}, err, null);
        return false;
    }

    const {
        enqueuePacketTransaction,
        batchEmit,
        recordLivePacketAnalytics,
        logger = console
    } = hooks;

    if (typeof enqueuePacketTransaction !== 'function') {
        const err = new Error('[MISSING_ENQUEUE_FN] 必須提供 enqueuePacketTransaction 函式');
        invokeCallerCallbackOnce({}, err, null);
        return false;
    }

    return enqueuePacketTransaction(
        plan.statements,
        function onPacketTransactionSettled(err, result) {
            if (err) {
                if (logger && typeof logger.error === 'function') {
                    try {
                        logger.error(`❌ [封包交易回滾] (${plan.label}):`, err.message);
                    } catch (_) {}
                }
                invokeCallerCallbackOnce(this, err, null);
                return;
            }

            // 僅在 COMMIT 成功後執行交易外副作用；每個 effect 皆有獨立保護
            const effects = plan.postCommitEffects || {};
            const postCommitErrors = [];

            // 1. Post-commit logger effects
            if (Array.isArray(effects.logs) && logger && typeof logger.log === 'function') {
                for (let i = 0; i < effects.logs.length; i++) {
                    const msg = effects.logs[i];
                    try {
                        logger.log(msg);
                    } catch (logErr) {
                        reportPostCommitHookError(`logger.log[${i}]`, logErr, plan.label, logger, postCommitErrors);
                    }
                }
                if (effects.isTelemetry && plan.packetMeta && plan.packetMeta.fromId) {
                    try {
                        const lastId = (result && result.lastID !== undefined) ? result.lastID : this?.lastID;
                        logger.log(`💾 [寫入DB成功] 節點: ${plan.packetMeta.fromId} | 紀錄 ID: ${lastId}`);
                    } catch (teleLogErr) {
                        reportPostCommitHookError('logger.log[telemetry]', teleLogErr, plan.label, logger, postCommitErrors);
                    }
                }
            }

            // 2. Post-commit live analytics effect
            if (effects.analytics && typeof recordLivePacketAnalytics === 'function') {
                try {
                    const a = effects.analytics;
                    recordLivePacketAnalytics(a.port, a.snr, a.rssi, a.temp, a.hum);
                } catch (analyticsErr) {
                    reportPostCommitHookError('recordLivePacketAnalytics', analyticsErr, plan.label, logger, postCommitErrors);
                }
            }

            // 3. Post-commit WebSocket batchEmit effects
            if (Array.isArray(effects.emits) && typeof batchEmit === 'function') {
                for (let i = 0; i < effects.emits.length; i++) {
                    const evt = effects.emits[i];
                    try {
                        batchEmit(evt.type, evt.payload);
                    } catch (emitErr) {
                        reportPostCommitHookError(`batchEmit[${i}:${evt?.type || 'unknown'}]`, emitErr, plan.label, logger, postCommitErrors);
                    }
                }
            }

            const finalResult = (result && typeof result === 'object')
                ? result
                : { status: 'COMMITTED', lastID: this?.lastID, changes: this?.changes };

            if (postCommitErrors.length > 0) {
                finalResult.postCommitErrors = postCommitErrors;
            }

            // 4. 交易已 COMMIT 成功，確保 caller callback 一定以 err = null 執行一次
            invokeCallerCallbackOnce(finalResult || this || {}, null, finalResult);
        },
        {
            label: plan.label,
            packetMeta: plan.packetMeta
        }
    );
}

/**
 * Turso / Legacy Queue 單一佇列項目順序執行器：
 * - 注意：此函式僅供未啟用 Local SQLiteAdapter 的 Turso fallback 分支使用，按 `statements` 原始順序逐一執行 SQL；
 *   不宣稱具備 Local SQLite Adapter 的單一連線原子 ROLLBACK 交易保證。
 * - 嚴格保證：
 *   1. 辨識 `item.isTransactionUnit` 並依序執行 `item.statements` 內所有 SQL，絕不將 `label` 當成 SQL 執行。
 *   2. 絕不在第一筆 SQL 完成後就提前回報成功；必須全部 SQL 依序成功後才觸發成功 callback。
 *   3. 任一筆 SQL 失敗時立即中止後續 SQL，回報錯誤並附帶 `failedStatementIndex` / `failedStatementSql`，且不執行成功副作用。
 *   4. 確保 `item.callback` 符合 Exactly-Once。
 */
function executeSequentialFallbackItem(targetDb, item, onItemDone = null) {
    let itemCbInvoked = false;
    const invokeItemCbOnce = (ctx, err, res) => {
        if (item && !item.callbackInvoked && !itemCbInvoked && typeof item.callback === 'function') {
            item.callbackInvoked = true;
            itemCbInvoked = true;
            try {
                item.callback.call(ctx || {}, err, res);
            } catch (_) {}
        } else {
            itemCbInvoked = true;
        }
    };

    const finishItem = (err, res) => {
        if (typeof onItemDone === 'function') {
            onItemDone(err, res);
        }
    };

    if (!targetDb || typeof targetDb.run !== 'function') {
        const err = new Error('[FALLBACK_DB_UNAVAILABLE] targetDb.run is not a function');
        invokeItemCbOnce({}, err, null);
        finishItem(err, null);
        return;
    }

    if (item && item.isTransactionUnit && Array.isArray(item.statements)) {
        const stmts = item.statements;
        if (
            stmts.length === 0 ||
            !stmts.every((s) => s && typeof s.sql === 'string' && s.sql.trim().length > 0)
        ) {
            const err = new Error('[INVALID_PACKET_TRANSACTION] statements 必須為非空陣列，且每筆皆須包含有效 SQL 字串');
            invokeItemCbOnce({}, err, null);
            finishItem(err, null);
            return;
        }

        const statementResults = [];
        let lastID = undefined;
        let totalChanges = 0;
        let idx = 0;

        const runNextStatement = () => {
            if (idx >= stmts.length) {
                const finalRes = {
                    status: 'COMMITTED',
                    isTransactionUnit: true,
                    isTursoSequentialFallback: true,
                    statementCount: stmts.length,
                    lastID,
                    changes: totalChanges,
                    statementResults
                };
                invokeItemCbOnce(finalRes, null, finalRes);
                finishItem(null, finalRes);
                return;
            }

            const currentIndex = idx++;
            const stmt = stmts[currentIndex];
            const sql = stmt.sql;
            const params = Array.isArray(stmt.params) ? stmt.params : [];

            let stepSettled = false;
            const onStepDone = function (stepErr) {
                if (stepSettled) return;
                stepSettled = true;

                if (stepErr) {
                    stepErr.fromPacketTransactionUnit = true;
                    stepErr.failedStatementIndex = currentIndex;
                    stepErr.failedStatementSql = sql;
                    if (item.label) {
                        stepErr.transactionLabel = item.label;
                    }
                    invokeItemCbOnce({}, stepErr, null);
                    finishItem(stepErr, null);
                    return;
                }

                const stepLastId = this && this.lastID !== undefined ? this.lastID : undefined;
                const stepChanges = this && typeof this.changes === 'number' ? this.changes : 0;
                if (stepLastId !== undefined) lastID = stepLastId;
                totalChanges += stepChanges;
                statementResults.push({ lastID: stepLastId, changes: stepChanges });
                runNextStatement();
            };

            try {
                targetDb.run(sql, params, onStepDone);
            } catch (syncErr) {
                onStepDone(syncErr);
            }
        };

        runNextStatement();
        return;
    }

    // 一般單筆 SQL 寫入項目
    const singleSql = item ? item.sql : '';
    const singleParams = item && Array.isArray(item.params) ? item.params : [];
    let singleSettled = false;
    const onSingleDone = function (err) {
        if (singleSettled) return;
        singleSettled = true;
        if (err) {
            invokeItemCbOnce(this, err, null);
            finishItem(err, null);
            return;
        }
        const resObj = {
            status: 'COMMITTED',
            isTransactionUnit: false,
            statementCount: 1,
            lastID: this && this.lastID !== undefined ? this.lastID : undefined,
            changes: this && typeof this.changes === 'number' ? this.changes : undefined
        };
        invokeItemCbOnce(this || resObj, null, resObj);
        finishItem(null, resObj);
    };

    try {
        targetDb.run(singleSql, singleParams, onSingleDone);
    } catch (syncErr) {
        onSingleDone(syncErr);
    }
}

module.exports = {
    NODE_DISCOVERY_UPSERT_SQL,
    ENCRYPTED_PACKET_LOG_INSERT_SQL,
    DECODED_PACKET_LOG_INSERT_SQL,
    CHAT_MESSAGE_INSERT_SQL,
    NEIGHBOR_UPSERT_SQL,
    NODE_POSITION_UPDATE_SQL,
    NODE_INFO_UPDATE_SQL,
    NODE_MAP_REPORT_UPDATE_SQL,
    NODE_TELEMETRY_UPDATE_SQL,
    TELEMETRY_DATA_INSERT_SQL,
    TUNNEL_PACKET_LOG_INSERT_SQL,
    TUNNEL_NODE_UPDATE_SQL,
    buildMqttPacketTransactionPlan,
    buildRfTunnelPacketTransactionPlan,
    executePacketTransactionPlan,
    executeSequentialFallbackItem
};

