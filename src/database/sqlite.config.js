// src/database/sqlite.config.js
module.exports = {
    pragmas: {
        journal_mode: 'WAL',
        synchronous: 'NORMAL',
        busy_timeout: 10000,
        foreign_keys: 'OFF',
        cache_size: -64000,         // 64MB Cache
        temp_store: 'MEMORY',
        wal_autocheckpoint: 1000,
        mmap_size: 268435456        // 256MB Memory-mapped I/O
    },
    queue: {
        batchChunkSize: 50,
        flushIntervalMs: 1000,
        maxCapacity: 5000,
        maxRetryAttempts: 5,        // 統一上限為 5 次
        retryBaseDelayMs: 200,
        retryMaxDelayMs: 5000,
        diskRecoveryThresholdMb: 500
    },
    backup: {
        retentionDays: 30,
        cronSchedule: '0 4 * * *'
    },
    shutdown: {
        drainTimeoutMs: 8000,
        pm2KillTimeoutMs: 10000,
        drainWaitBufferMs: 1500,    // 8.0s ~ 9.5s 有界等待緩衝
        emergencyWaitMs: 1000
    }
};
