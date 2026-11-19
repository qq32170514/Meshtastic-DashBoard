/**
 * Hop Analysis SQL computation with strict error checking on both queries
 * and single-response guard.
 */

const SQL_ACTUAL_HOPS = `
    SELECT 
        COALESCE(hops_away, (hop_start - hop_limit)) as hop,
        COUNT(*) as count
    FROM packet_logs
    WHERE timestamp >= datetime('now', '-24 hours')
      AND (hops_away IS NOT NULL OR (hop_start IS NOT NULL AND hop_limit IS NOT NULL))
      AND COALESCE(hops_away, (hop_start - hop_limit)) >= 0
    GROUP BY hop
    ORDER BY hop ASC
`;

const SQL_CONFIGURED_HOPS = `
    SELECT 
        hop_limit as hop,
        COUNT(*) as count
    FROM nodes
    WHERE hop_limit IS NOT NULL AND hop_limit > 0
      AND last_seen >= datetime('now', '-7 days')
    GROUP BY hop_limit
    ORDER BY hop_limit ASC
`;

function computeHopAnalysis(db, callback) {
    let finished = false;
    const done = (err, payload) => {
        if (finished) return;
        finished = true;
        callback(err, payload);
    };

    db.all(SQL_ACTUAL_HOPS, [], (err, actualRows) => {
        if (err) {
            return done(err);
        }

        db.all(SQL_CONFIGURED_HOPS, [], (cErr, configuredRows) => {
            if (cErr) {
                return done(cErr);
            }

            let actualTotal = 0;
            let actualSum = 0;
            (actualRows || []).forEach((r) => {
                actualTotal += r.count;
                actualSum += r.hop * r.count;
            });
            const avgActualHops = actualTotal > 0 ? Math.round((actualSum / actualTotal) * 10) / 10 : 0;

            let confTotal = 0;
            let confSum = 0;
            (configuredRows || []).forEach((r) => {
                confTotal += r.count;
                confSum += r.hop * r.count;
            });
            const avgConfiguredHops = confTotal > 0 ? Math.round((confSum / confTotal) * 10) / 10 : 0;

            const diff = Math.round((avgConfiguredHops - avgActualHops) * 10) / 10;
            let recommendation = null;
            if (avgConfiguredHops > 0 && avgActualHops > 0 && diff >= 1.2) {
                recommendation = `💡 網路診斷提醒：全網封包實際傳播深度平均僅 ${avgActualHops} 跳，但節點預設的 Hop Limit 限額平均高達 ${avgConfiguredHops} 跳（相差 ${diff} 跳）。建議引導用戶將 Hop Limit 降低至 2~3，以大幅減少無謂重複廣播與頻道碰撞，有效節省 Mesh 頻寬！`;
            } else {
                recommendation = `✅ 網路診斷良好：封包實際跳轉數 (${avgActualHops} 跳) 與節點 Hop 限額設定 (${avgConfiguredHops} 跳) 匹配良好，頻寬利用順暢。`;
            }

            return done(null, {
                actualHops: actualRows || [],
                configuredHops: configuredRows || [],
                avgActualHops,
                avgConfiguredHops,
                diff,
                recommendation
            });
        });
    });
}

module.exports = {
    SQL_ACTUAL_HOPS,
    SQL_CONFIGURED_HOPS,
    computeHopAnalysis
};

