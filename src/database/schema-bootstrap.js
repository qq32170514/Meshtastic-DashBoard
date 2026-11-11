// src/database/schema-bootstrap.js

const REQUIRED_TABLES = [
    {
        name: 'telemetry_data',
        ddl: `
            CREATE TABLE IF NOT EXISTS telemetry_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                battery_level REAL,
                voltage REAL,
                temperature REAL,
                humidity REAL,
                channel_utilization REAL,
                air_util_tx REAL,
                snr REAL,
                rssi REAL,
                current REAL,
                hop_limit INTEGER,
                hop_start INTEGER,
                adc_voltage REAL
            )
        `,
        requiredColumns: [
            'id', 'node_id', 'timestamp', 'battery_level', 'voltage',
            'temperature', 'humidity', 'channel_utilization', 'air_util_tx',
            'snr', 'rssi', 'current', 'hop_limit', 'hop_start', 'adc_voltage'
        ]
    },
    {
        name: 'nodes',
        ddl: `
            CREATE TABLE IF NOT EXISTS nodes (
                node_id TEXT PRIMARY KEY,
                long_name TEXT,
                short_name TEXT,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                latitude REAL,
                longitude REAL,
                is_favorite INTEGER DEFAULT 0,
                last_topic TEXT,
                hop_limit INTEGER,
                hop_start INTEGER,
                role TEXT,
                channel TEXT,
                hw_model TEXT,
                battery_level REAL,
                voltage REAL,
                current REAL,
                temperature REAL,
                humidity REAL,
                firmware_version TEXT,
                firmware_build_num TEXT,
                last_gateway TEXT
            )
        `,
        requiredColumns: [
            'node_id', 'long_name', 'short_name', 'last_seen', 'latitude',
            'longitude', 'is_favorite', 'last_topic', 'hop_limit', 'hop_start',
            'role', 'channel', 'hw_model', 'battery_level', 'voltage',
            'current', 'temperature', 'humidity', 'firmware_version',
            'firmware_build_num', 'last_gateway'
        ]
    },
    {
        name: 'packet_logs',
        ddl: `
            CREATE TABLE IF NOT EXISTS packet_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                portnum TEXT,
                topic TEXT,
                gateway_id TEXT,
                snr REAL,
                rssi REAL,
                hop_limit INTEGER,
                hop_start INTEGER,
                payload_json TEXT,
                raw_hex TEXT
            )
        `,
        requiredColumns: [
            'id', 'node_id', 'timestamp', 'portnum', 'topic', 'gateway_id',
            'snr', 'rssi', 'hop_limit', 'hop_start', 'payload_json', 'raw_hex',
            'latitude', 'longitude', 'hops_away', 'source'
        ]
    },
    {
        name: 'neighbors',
        ddl: `
            CREATE TABLE IF NOT EXISTS neighbors (
                node_id TEXT,
                neighbor_id TEXT,
                snr REAL,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(node_id, neighbor_id)
            )
        `,
        requiredColumns: ['node_id', 'neighbor_id', 'snr', 'last_seen']
    },
    {
        name: 'chat_messages',
        ddl: `
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                message TEXT,
                channel_name TEXT
            )
        `,
        requiredColumns: ['id', 'node_id', 'timestamp', 'message', 'channel_name']
    },
    {
        name: 'packets',
        ddl: `
            CREATE TABLE IF NOT EXISTS packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT,
                lat REAL,
                lon REAL,
                snr REAL,
                source TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `,
        requiredColumns: ['id', 'node_id', 'lat', 'lon', 'snr', 'source', 'timestamp']
    },
    {
        name: 'daily_analytics_summary',
        ddl: `
            CREATE TABLE IF NOT EXISTS daily_analytics_summary (
                date TEXT PRIMARY KEY,
                active_count INTEGER DEFAULT 0,
                ghost_count INTEGER DEFAULT 0,
                snr_sum REAL DEFAULT 0,
                snr_count INTEGER DEFAULT 0,
                rssi_sum REAL DEFAULT 0,
                rssi_count INTEGER DEFAULT 0,
                temp_sum REAL DEFAULT 0,
                temp_count INTEGER DEFAULT 0,
                hum_sum REAL DEFAULT 0,
                hum_count INTEGER DEFAULT 0,
                position_count INTEGER DEFAULT 0,
                telemetry_count INTEGER DEFAULT 0,
                text_count INTEGER DEFAULT 0,
                routing_count INTEGER DEFAULT 0,
                other_count INTEGER DEFAULT 0,
                hop0_count INTEGER DEFAULT 0,
                hop1_count INTEGER DEFAULT 0,
                hop2_count INTEGER DEFAULT 0,
                hop3_count INTEGER DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `,
        requiredColumns: [
            'date', 'active_count', 'ghost_count', 'snr_sum', 'snr_count',
            'rssi_sum', 'rssi_count', 'temp_sum', 'temp_count', 'hum_sum',
            'hum_count', 'position_count', 'telemetry_count', 'text_count',
            'routing_count', 'other_count', 'hop0_count', 'hop1_count',
            'hop2_count', 'hop3_count', 'updated_at'
        ]
    },
    {
        name: 'cwa_weather_stations',
        ddl: `
            CREATE TABLE IF NOT EXISTS cwa_weather_stations (
                station_id TEXT PRIMARY KEY,
                station_name TEXT,
                county TEXT,
                town TEXT,
                latitude REAL,
                longitude REAL,
                temperature REAL,
                humidity REAL,
                weather TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `,
        requiredColumns: [
            'station_id', 'station_name', 'county', 'town', 'latitude',
            'longitude', 'temperature', 'humidity', 'weather', 'updated_at'
        ]
    }
];

const COLUMN_MIGRATIONS = [
    { t: 'nodes', c: 'is_favorite', d: 'INTEGER DEFAULT 0' },
    { t: 'nodes', c: 'last_topic', d: 'TEXT' },
    { t: 'packet_logs', c: 'gateway_id', d: 'TEXT' },
    { t: 'telemetry_data', c: 'current', d: 'REAL' },
    { t: 'packet_logs', c: 'hop_limit', d: 'INTEGER' },
    { t: 'packet_logs', c: 'hop_start', d: 'INTEGER' },
    { t: 'packet_logs', c: 'payload_json', d: 'TEXT' },
    { t: 'packet_logs', c: 'raw_hex', d: 'TEXT' },
    { t: 'nodes', c: 'hop_limit', d: 'INTEGER' },
    { t: 'nodes', c: 'hop_start', d: 'INTEGER' },
    { t: 'nodes', c: 'role', d: 'TEXT' },
    { t: 'nodes', c: 'channel', d: 'TEXT' },
    { t: 'nodes', c: 'hw_model', d: 'TEXT' },
    { t: 'nodes', c: 'battery_level', d: 'REAL' },
    { t: 'nodes', c: 'voltage', d: 'REAL' },
    { t: 'nodes', c: 'current', d: 'REAL' },
    { t: 'nodes', c: 'temperature', d: 'REAL' },
    { t: 'nodes', c: 'humidity', d: 'REAL' },
    { t: 'nodes', c: 'firmware_version', d: 'TEXT' },
    { t: 'nodes', c: 'firmware_build_num', d: 'TEXT' },
    { t: 'nodes', c: 'last_gateway', d: 'TEXT' },
    { t: 'packet_logs', c: 'latitude', d: 'REAL' },
    { t: 'packet_logs', c: 'longitude', d: 'REAL' },
    { t: 'packet_logs', c: 'hops_away', d: 'INTEGER' },
    { t: 'packet_logs', c: 'source', d: 'TEXT' },
    { t: 'telemetry_data', c: 'adc_voltage', d: 'REAL' }
];

const OBSOLETE_INDEXES = [
    'idx_packet_logs_rawhex_ts',
    'idx_packet_logs_port_ts',
    'idx_packet_logs_node_id',
    'idx_packet_logs_gateway',
    'idx_packet_logs_source_timestamp'
];

const REQUIRED_INDEXES = [
    { name: 'idx_packets_timestamp', table: 'packets', ddl: 'CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON packets(timestamp DESC)' },
    { name: 'idx_nodes_last_seen', table: 'nodes', ddl: 'CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen DESC)' },
    { name: 'idx_cwa_lat_lng', table: 'cwa_weather_stations', ddl: 'CREATE INDEX IF NOT EXISTS idx_cwa_lat_lng ON cwa_weather_stations(latitude, longitude)' },
    { name: 'idx_telemetry_timestamp', table: 'telemetry_data', ddl: 'CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_data (timestamp DESC)' },
    { name: 'idx_telemetry_node_timestamp', table: 'telemetry_data', ddl: 'CREATE INDEX IF NOT EXISTS idx_telemetry_node_timestamp ON telemetry_data (node_id, timestamp DESC)' },
    { name: 'idx_packet_logs_timestamp', table: 'packet_logs', ddl: 'CREATE INDEX IF NOT EXISTS idx_packet_logs_timestamp ON packet_logs (timestamp DESC)' },
    { name: 'idx_packet_logs_node_timestamp', table: 'packet_logs', ddl: 'CREATE INDEX IF NOT EXISTS idx_packet_logs_node_timestamp ON packet_logs (node_id, timestamp DESC)' },
    { name: 'idx_packet_logs_portnum_timestamp', table: 'packet_logs', ddl: 'CREATE INDEX IF NOT EXISTS idx_packet_logs_portnum_timestamp ON packet_logs (portnum, timestamp DESC)' },
    { name: 'idx_packet_logs_gw_ts', table: 'packet_logs', ddl: 'CREATE INDEX IF NOT EXISTS idx_packet_logs_gw_ts ON packet_logs (gateway_id, timestamp DESC)' },
    { name: 'idx_packet_logs_ts_hops', table: 'packet_logs', ddl: 'CREATE INDEX IF NOT EXISTS idx_packet_logs_ts_hops ON packet_logs (timestamp DESC, hops_away)' },
    { name: 'idx_chat_channel_timestamp', table: 'chat_messages', ddl: 'CREATE INDEX IF NOT EXISTS idx_chat_channel_timestamp ON chat_messages (channel_name, timestamp DESC)' }
];

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidIdentifier(ident, context) {
    if (!ident || typeof ident !== 'string' || !IDENTIFIER_REGEX.test(ident)) {
        throw new Error(`[SCHEMA_INVALID_IDENTIFIER] 非法的 SQL 識別字 (${context}): ${String(ident)}`);
    }
}

/**
 * 查詢指定資料表的現有欄位資訊
 */
async function getTableColumns(adapter, tableName) {
    assertValidIdentifier(tableName, 'tableName');
    const rows = await adapter.query(`PRAGMA table_info(${tableName})`);
    return Array.isArray(rows) ? rows : [];
}

/**
 * 驗證所有必要資料表、欄位與索引皆已完整存在
 */
async function verifyDatabaseSchema(adapter, customSpec = {}) {
    const tables = customSpec.tables || REQUIRED_TABLES;
    const indexes = customSpec.indexes || REQUIRED_INDEXES;

    const masterRows = await adapter.query(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')`
    );
    const existingTables = new Set(
        masterRows.filter(r => r.type === 'table').map(r => String(r.name))
    );
    const existingIndexes = new Set(
        masterRows.filter(r => r.type === 'index').map(r => String(r.name))
    );

    const missingTables = [];
    const missingColumns = [];
    const missingIndexes = [];

    for (const tableSpec of tables) {
        if (!existingTables.has(tableSpec.name)) {
            missingTables.push(tableSpec.name);
            continue;
        }
        const cols = await getTableColumns(adapter, tableSpec.name);
        const colNames = new Set(cols.map(c => String(c.name).toLowerCase()));
        for (const reqCol of (tableSpec.requiredColumns || [])) {
            if (!colNames.has(String(reqCol).toLowerCase())) {
                missingColumns.push(`${tableSpec.name}.${reqCol}`);
            }
        }
    }

    for (const idxSpec of indexes) {
        if (!existingIndexes.has(idxSpec.name)) {
            missingIndexes.push(idxSpec.name);
        }
    }

    if (missingTables.length > 0 || missingColumns.length > 0 || missingIndexes.length > 0) {
        const details = {
            missingTables,
            missingColumns,
            missingIndexes
        };
        const err = new Error(
            `[SCHEMA_VERIFICATION_FAILED] 資料庫 Schema 驗證未通過: ${JSON.stringify(details)}`
        );
        err.details = details;
        throw err;
    }

    return {
        verified: true,
        tableCount: tables.length,
        indexCount: indexes.length
    };
}

/**
 * 執行完整 Schema 初始化、欄位 Migration 與驗證屏障 (4.0.1 P0)
 * 嚴格順序：
 *   1. 建立核心資料表 (CREATE TABLE IF NOT EXISTS)
 *   2. 執行欄位擴充 Migration (PRAGMA table_info 預檢 + ALTER TABLE ADD COLUMN，區分已存在欄位與真實錯誤)
 *   3. 清理廢棄索引 (DROP INDEX IF EXISTS)
 *   4. 建立核心索引 (CREATE INDEX IF NOT EXISTS — 依賴 Step 2 遷移完成之欄位)
 *   5. 執行最終 Schema Verification
 */
async function bootstrapDatabaseSchema(adapter, options = {}) {
    const tables = options.tables || REQUIRED_TABLES;
    const migrations = options.migrations || COLUMN_MIGRATIONS;
    const obsoleteIndexes = options.obsoleteIndexes || OBSOLETE_INDEXES;
    const indexes = options.indexes || REQUIRED_INDEXES;

    const migrationReport = {
        tablesCreatedOrVerified: [],
        columnsAdded: [],
        columnsAlreadyExisted: [],
        obsoleteIndexesDropped: [],
        indexesCreatedOrVerified: [],
        verification: null
    };

    if (typeof options.beforeSchemaBootstrap === 'function') {
        await options.beforeSchemaBootstrap(adapter);
    }

    // 1. 階段一：依序建立所有核心資料表
    for (const tableSpec of tables) {
        assertValidIdentifier(tableSpec.name, 'tableSpec.name');
        try {
            await adapter.execute(tableSpec.ddl);
            migrationReport.tablesCreatedOrVerified.push(tableSpec.name);
        } catch (ddlErr) {
            const err = new Error(
                `[SCHEMA_DDL_TABLE_FAILED] 建立資料表 ${tableSpec.name} 失敗: ${ddlErr.message}`
            );
            err.step = 'CREATE_TABLE';
            err.table = tableSpec.name;
            err.code = ddlErr.code;
            err.cause = ddlErr;
            throw err;
        }
    }

    // 2. 階段二：依序執行欄位 Migration (嚴格區分「欄位已存在」與「SQL/環境/損壞/不相容錯誤」)
    for (const colSpec of migrations) {
        const tableName = colSpec.t;
        const columnName = colSpec.c;
        const columnDef = colSpec.d;

        assertValidIdentifier(tableName, 'migration.table');
        assertValidIdentifier(columnName, 'migration.column');
        if (!columnDef || typeof columnDef !== 'string' || columnDef.includes(';')) {
            const defErr = new Error(
                `[SCHEMA_MIGRATION_FAILED] 資料表 ${tableName} 欄位 ${columnName} 定義無效: ${String(columnDef)}`
            );
            defErr.step = 'COLUMN_MIGRATION';
            defErr.table = tableName;
            defErr.column = columnName;
            throw defErr;
        }

        let existingCols;
        try {
            existingCols = await getTableColumns(adapter, tableName);
        } catch (infoErr) {
            const err = new Error(
                `[SCHEMA_MIGRATION_FAILED] 讀取資料表 ${tableName} 結構失敗: ${infoErr.message}`
            );
            err.step = 'COLUMN_MIGRATION_INSPECT';
            err.table = tableName;
            err.column = columnName;
            err.code = infoErr.code;
            err.cause = infoErr;
            throw err;
        }

        if (!existingCols || existingCols.length === 0) {
            const missingTableErr = new Error(
                `[SCHEMA_MIGRATION_FAILED] Migration 目標資料表 ${tableName} 不存在，無法新增欄位 ${columnName}`
            );
            missingTableErr.step = 'COLUMN_MIGRATION';
            missingTableErr.table = tableName;
            missingTableErr.column = columnName;
            throw missingTableErr;
        }

        const matchedCol = existingCols.find(
            c => String(c.name).toLowerCase() === String(columnName).toLowerCase()
        );

        if (matchedCol) {
            // 檢查既有欄位相容性：若定義了基礎型別且既有欄位型別明顯衝突則報錯
            const expectedBaseType = String(columnDef).trim().split(/\s+/)[0].toUpperCase();
            const actualType = String(matchedCol.type || '').trim().split(/\s+/)[0].toUpperCase();
            if (
                actualType &&
                expectedBaseType &&
                actualType !== expectedBaseType
            ) {
                const incompatErr = new Error(
                    `[SCHEMA_INCOMPATIBLE_COLUMN] 資料表 ${tableName}.${columnName} 既有型別 (${actualType}) 與預期 (${expectedBaseType}) 不相容`
                );
                incompatErr.step = 'COLUMN_MIGRATION_COMPATIBILITY';
                incompatErr.table = tableName;
                incompatErr.column = columnName;
                throw incompatErr;
            }
            migrationReport.columnsAlreadyExisted.push(`${tableName}.${columnName}`);
            continue;
        }

        try {
            await adapter.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
            migrationReport.columnsAdded.push(`${tableName}.${columnName}`);
        } catch (alterErr) {
            const msg = String(alterErr.message || '');
            // 僅在 SQLite 回報 duplicate column name 且二次查證欄位確實存在時視為冪等完成
            if (/duplicate column name/i.test(msg)) {
                const recheckCols = await getTableColumns(adapter, tableName);
                const existsNow = recheckCols.some(
                    c => String(c.name).toLowerCase() === String(columnName).toLowerCase()
                );
                if (existsNow) {
                    migrationReport.columnsAlreadyExisted.push(`${tableName}.${columnName}`);
                    continue;
                }
            }

            const err = new Error(
                `[SCHEMA_MIGRATION_FAILED] 資料表 ${tableName} 新增欄位 ${columnName} (${columnDef}) 失敗: ${msg}`
            );
            err.step = 'COLUMN_MIGRATION';
            err.table = tableName;
            err.column = columnName;
            err.code = alterErr.code;
            err.cause = alterErr;
            throw err;
        }
    }

    // 3. 階段三：卸載舊版冗餘索引
    for (const oldIdx of obsoleteIndexes) {
        assertValidIdentifier(oldIdx, 'obsoleteIndex');
        try {
            await adapter.execute(`DROP INDEX IF EXISTS ${oldIdx}`);
            migrationReport.obsoleteIndexesDropped.push(oldIdx);
        } catch (dropErr) {
            const err = new Error(
                `[SCHEMA_DDL_DROP_INDEX_FAILED] 卸載舊索引 ${oldIdx} 失敗: ${dropErr.message}`
            );
            err.step = 'DROP_INDEX';
            err.index = oldIdx;
            err.code = dropErr.code;
            err.cause = dropErr;
            throw err;
        }
    }

    // 4. 階段四：建立所有必要索引 (位於 Column Migration 之後，確保 gateway_id / hops_away 等欄位已就緒)
    for (const idxSpec of indexes) {
        assertValidIdentifier(idxSpec.name, 'indexSpec.name');
        try {
            await adapter.execute(idxSpec.ddl);
            migrationReport.indexesCreatedOrVerified.push(idxSpec.name);
        } catch (idxErr) {
            const err = new Error(
                `[SCHEMA_DDL_INDEX_FAILED] 建立索引 ${idxSpec.name} 失敗: ${idxErr.message}`
            );
            err.step = 'CREATE_INDEX';
            err.index = idxSpec.name;
            err.table = idxSpec.table;
            err.code = idxErr.code;
            err.cause = idxErr;
            throw err;
        }
    }

    // 5. 階段五：執行最終 Schema Verification
    migrationReport.verification = await verifyDatabaseSchema(adapter, { tables, indexes });

    return migrationReport;
}

module.exports = {
    REQUIRED_TABLES,
    COLUMN_MIGRATIONS,
    OBSOLETE_INDEXES,
    REQUIRED_INDEXES,
    getTableColumns,
    verifyDatabaseSchema,
    bootstrapDatabaseSchema
};

