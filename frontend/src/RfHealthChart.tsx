import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend
} from 'recharts';
import { Activity, Radio, RefreshCw, AlertTriangle, ShieldCheck } from 'lucide-react';

interface RfPoint {
  time_label: string;
  avg_snr: number;
  avg_rssi: number;
  packet_count: number;
  raw_time: string;
}

interface RfHealthChartProps {
  nodeId: string;
  darkMode?: boolean;
}

export default function RfHealthChart({ nodeId, darkMode = false }: RfHealthChartProps) {
  const [data, setData] = useState<RfPoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [days, setDays] = useState<number>(7);
  const [error, setError] = useState<string | null>(null);

  const fetchRfData = async () => {
    if (!nodeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/node/${encodeURIComponent(nodeId)}/rf-health?days=${days}`);
      if (!res.ok) throw new Error('API Error');
      const result = await res.json();
      setData(Array.isArray(result) ? result : []);
    } catch (e: any) {
      console.error('Failed to fetch RF health data:', e);
      setError('無法讀取 RF 健康度數據');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRfData();
  }, [nodeId, days]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const pData = payload[0].payload as RfPoint;
      return (
        <div className={`p-3 rounded-xl border shadow-xl ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
          <div className="font-bold border-b pb-1 mb-1 text-cyan-400 font-mono flex justify-between gap-4">
            <span>🕒 {label}</span>
            <span className="text-slate-400 font-normal">({pData.packet_count} 封包)</span>
          </div>
          <div className="space-y-1 text-xs font-mono">
            <div className="flex justify-between gap-4 text-blue-400">
              <span>平均 RSSI:</span>
              <span className="font-bold">{pData.avg_rssi} dBm</span>
            </div>
            <div className="flex justify-between gap-4 text-amber-400">
              <span>平均 SNR:</span>
              <span className="font-bold">{pData.avg_snr} dB</span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  // 診斷說明計算 (分析 RSSI / SNR 是否過低)
  const latestPoint = data.length > 0 ? data[data.length - 1] : null;
  const isSignalWeak = latestPoint ? latestPoint.avg_rssi < -110 || latestPoint.avg_snr < -10 : false;

  return (
    <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      {/* 標題與控制器 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-500 border border-cyan-500/20">
            <Radio size={18} />
          </div>
          <div>
            <h4 className={`text-sm font-black tracking-wide flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              直連 RF 訊號健康度趨勢 (0-Hop RF Signal Health)
            </h4>
            <p className="text-[11px] text-slate-400">
              僅過濾 Gateway 直連 (0-Hop) 封包，用於天線老化、接頭受潮或傳輸功率硬體衰退診斷
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchRfData}
            className={`p-1.5 rounded-lg border transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-600'}`}
            title="重新讀取"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>

          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={`px-2.5 py-1 rounded-lg border text-xs font-bold outline-none cursor-pointer ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
          >
            <option value={7}>近 7 天</option>
            <option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option>
          </select>
        </div>
      </div>

      {/* 圖表呈現 */}
      <div className="h-64 w-full relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900/20 backdrop-blur-[1px] z-10 rounded-xl">
            <RefreshCw size={24} className="animate-spin text-cyan-400" />
          </div>
        )}

        {data.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 italic text-xs space-y-2">
            <Activity size={28} className="opacity-30" />
            <p>{loading ? '載入 RF 數據中...' : '近期間無 Gateway 直連 (0-Hop) 封包紀錄'}</p>
            <p className="text-[10px] text-slate-400">（此節點封包可能皆透過多級中繼轉發聽取）</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
              <XAxis
                dataKey="time_label"
                stroke={darkMode ? '#64748b' : '#94a3b8'}
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              {/* 左 Y 軸: RSSI */}
              <YAxis
                yAxisId="left"
                orientation="left"
                stroke="#3b82f6"
                tick={{ fontSize: 10 }}
                domain={[-130, -30]}
                unit="dBm"
              />
              {/* 右 Y 軸: SNR */}
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#f59e0b"
                tick={{ fontSize: 10 }}
                domain={[-25, 15]}
                unit="dB"
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="avg_rssi"
                name="直連 RSSI (dBm)"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avg_snr"
                name="直連 SNR (dB)"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 診斷卡片摘要 */}
      {data.length > 0 && latestPoint && (
        <div className={`p-3 rounded-xl border text-xs font-mono flex items-center justify-between shadow-sm ${
          isSignalWeak
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
        }`}>
          <div className="flex items-center gap-2">
            {isSignalWeak ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}
            <span>
              {isSignalWeak
                ? `⚠️ 警告：直連訊號弱 (RSSI ${latestPoint.avg_rssi} dBm / SNR ${latestPoint.avg_snr} dB)，請檢查天線或饋線`
                : `🟢 訊號狀況良好：最新直連 RSSI ${latestPoint.avg_rssi} dBm / SNR ${latestPoint.avg_snr} dB`}
            </span>
          </div>
          <span className="text-[10px] text-slate-400">最後採樣: {latestPoint.time_label}</span>
        </div>
      )}
    </div>
  );
}
