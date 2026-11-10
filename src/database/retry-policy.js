// src/database/retry-policy.js
const ERROR_TYPES = {
    DATA_CONSTRAINT: 'DATA_CONSTRAINT',
    RETRYABLE_BUSY: 'RETRYABLE_BUSY',
    DISK_FULL: 'DISK_FULL',
    FATAL_CORRUPT: 'FATAL_CORRUPT',
    IOERR_TRANSIENT: 'IOERR_TRANSIENT',
    IOERR_PERMANENT: 'IOERR_PERMANENT',
    ROLLBACK_FAILURE: 'ROLLBACK_FAILURE',
    UNKNOWN: 'UNKNOWN'
};

function classifyError(err) {
    if (!err) return ERROR_TYPES.UNKNOWN;

    const msg = String(err.message || '');
    const code = err.code || '';
    const errno = err.errno;

    // 1. 交易回滾失敗
    if (msg.includes('FATAL_ROLLBACK_FAILURE') || (msg.includes('ROLLBACK') && msg.includes('fail'))) {
        return ERROR_TYPES.ROLLBACK_FAILURE;
    }

    // 2. 磁碟滿額 (SQLITE_FULL = 13)
    if (code === 'SQLITE_FULL' || errno === 13 || msg.includes('database or disk is full')) {
        return ERROR_TYPES.DISK_FULL;
    }

    // 3. 資料庫結構毀損 (SQLITE_CORRUPT = 11, SQLITE_NOTADB = 26)
    if (code === 'SQLITE_CORRUPT' || errno === 11 || code === 'SQLITE_NOTADB' || errno === 26 ||
        msg.includes('malformed') || msg.includes('file is not a database')) {
        return ERROR_TYPES.FATAL_CORRUPT;
    }

    // 4. 鎖競爭 (SQLITE_BUSY = 5, SQLITE_LOCKED = 6)
    if (code === 'SQLITE_BUSY' || errno === 5 || code === 'SQLITE_LOCKED' || errno === 6 ||
        msg.includes('busy') || msg.includes('locked')) {
        return ERROR_TYPES.RETRYABLE_BUSY;
    }

    // 5. 資料約束錯誤 (SQLITE_CONSTRAINT = 19, SQLITE_MISMATCH = 20)
    if (code === 'SQLITE_CONSTRAINT' || errno === 19 || code === 'SQLITE_MISMATCH' || errno === 20 ||
        msg.includes('constraint failed') || msg.includes('datatype mismatch')) {
        return ERROR_TYPES.DATA_CONSTRAINT;
    }

    // 6. I/O 錯誤細分 (SQLITE_IOERR = 10)
    if (code === 'SQLITE_IOERR' || errno === 10 || msg.includes('disk I/O error')) {
        if (msg.includes('BLOCKED') || msg.includes('LOCK') || msg.includes('ACCESS')) {
            return ERROR_TYPES.IOERR_TRANSIENT;
        }
        return ERROR_TYPES.IOERR_PERMANENT;
    }

    return ERROR_TYPES.UNKNOWN;
}

function calculateBackoffDelay(attempt, baseDelayMs = 200, maxDelayMs = 5000) {
    const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = Math.random() * (expDelay * 0.3);
    return Math.floor(expDelay + jitter);
}

module.exports = {
    ERROR_TYPES,
    classifyError,
    calculateBackoffDelay
};
