import React, { useState, useEffect } from 'react';
import {
  Activity,
  WifiOff,
  BatteryLow,
  MapPinOff,
  RefreshCw,
  Clock,
  PieChart as PieChartIcon,
  TrendingUp,
  BarChart3,
  ShieldCheck,
  Radio,
  Share2,
  Cpu,
  Layers,
  CloudSun,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';

interface NetworkAnalyticsProps {
  darkMode: boolean;
}

interface KpiData {
  activeNodes: number;
  offlineNodes: number;
  ghostNodes: number;
  lowBatteryAlerts: number;
}

interface TrendPoint {
  date: string;
  activeNodes: number;
  ghostNodes: number;
}

interface RolePoint {
  role: string;
  count: number;
}

interface TrafficPoint {
  date: string;
  Position: number;
  Telemetry: number;
  TextMessage: number;
  Routing: number;
  Other: number;
}

interface SignalHealthPoint {
  date: string;
  avgSnr: number;
  avgRssi: number;
}

interface HopDistPoint {
  hop_category: string;
  count: number;
}

interface HourlyPoint {
  hour: string;
  count: number;
}

interface ModelPoint {
  model: string;
  count: number;
}

interface FirmwarePoint {
  version: string;
  count: number;
}

interface EnvPoint {
  date: string;
  avgTemp: number;
  avgHumidity: number;
}

const PALETTE_COLORS = ['#06b6d4', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#64748b', '#14b8a6', '#6366f1'];

export default function NetworkAnalytics({ darkMode }: NetworkAnalyticsProps) {
  const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d'>('7d');
  const [loading, setLoading] = useState<boolean>(true);

  // States
  const [kpi, setKpi] = useState<KpiData>({ activeNodes: 0, offlineNodes: 0, ghostNodes: 0, lowBatteryAlerts: 0 });
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [roles, setRoles] = useState<RolePoint[]>([]);
  const [traffic, setTraffic] = useState<TrafficPoint[]>([]);
  const [signalHealth, setSignalHealth] = useState<SignalHealthPoint[]>([]);
  const [hopDist, setHopDist] = useState<HopDistPoint[]>([]);
  const [hourlyActivity, setHourlyActivity] = useState<HourlyPoint[]>([]);
  const [hwModels, setHwModels] = useState<ModelPoint[]>([]);
  const [firmwareVersions, setFirmwareVersions] = useState<{ series: FirmwarePoint[]; exact: FirmwarePoint[] }>({ series: [], exact: [] });
  const [fwViewMode, setFwViewMode] = useState<'series' | 'exact'>('series');
  const [envTrends, setEnvTrends] = useState<EnvPoint[]>([]);
  const [cwaComparison, setCwaComparison] = useState<{
    cwaAvgTemp: number;
    cwaAvgHumidity: number;
    meshAvgTemp: number;
    meshAvgHumidity: number;
    tempDelta: number;
    humidityDelta: number;
  } | null>(null);

  const fetchData = async (range: string) => {
    setLoading(true);
    try {
      const [
        kpiRes,
        trendRes,
        roleRes,
        trafficRes,
        signalRes,
        hopRes,
        hourlyRes,
        modelRes,
        fwRes,
        envRes,
        cwaRes,
      ] = await Promise.all([
        fetch(`/api/analytics/kpi?range=${range}`),
        fetch(`/api/analytics/trends?range=${range}`),
        fetch('/api/analytics/roles'),
        fetch(`/api/analytics/traffic?range=${range}`),
        fetch(`/api/analytics/signal-health?range=${range}`),
        fetch(`/api/analytics/hop-distribution?range=${range}`),
        fetch(`/api/analytics/hourly-activity?range=${range}`),
        fetch('/api/analytics/hardware-models'),
        fetch('/api/analytics/firmware-versions'),
        fetch(`/api/analytics/environment-trends?range=${range}`),
        fetch('/api/analytics/cwa-comparison'),
      ]);

      const [
        kpiData,
        trendData,
        roleData,
        trafficData,
        signalData,
        hopData,
        hourlyData,
        modelData,
        fwData,
        envData,
        cwaData,
      ] = await Promise.all([
        kpiRes.json(),
        trendRes.json(),
        roleRes.json(),
        trafficRes.json(),
        signalRes.json(),
        hopRes.json(),
        hourlyRes.json(),
        modelRes.json(),
        fwRes.json(),
        envRes.json(),
        cwaRes.json(),
      ]);

      setKpi(kpiData || { activeNodes: 0, offlineNodes: 0, ghostNodes: 0, lowBatteryAlerts: 0 });
      setTrends(Array.isArray(trendData) ? trendData : []);
      setRoles(Array.isArray(roleData) ? roleData : []);
      setTraffic(Array.isArray(trafficData) ? trafficData : []);
      setSignalHealth(Array.isArray(signalData) ? signalData : []);
      setHopDist(Array.isArray(hopData) ? hopData : []);
      setHourlyActivity(Array.isArray(hourlyData) ? hourlyData : []);
      setHwModels(Array.isArray(modelData) ? modelData : []);
      setFirmwareVersions({
        series: Array.isArray(fwData?.series) ? fwData.series : [],
        exact: Array.isArray(fwData?.exact) ? fwData.exact : (Array.isArray(fwData) ? fwData : []),
      });
      setEnvTrends(Array.isArray(envData) ? envData : []);
      setCwaComparison(cwaData || null);
    } catch (e) {
      console.error('Failed to fetch network analytics data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(timeRange);
  }, [timeRange]);

  const customTooltipStyle = {
    backgroundColor: darkMode ? '#0f172a' : '#ffffff',
    borderColor: darkMode ? '#334155' : '#e2e8f0',
    color: darkMode ? '#f8fafc' : '#0f172a',
    borderRadius: '0.75rem',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
    fontSize: '12px',
    fontFamily: 'monospace',
  };

  return (
    <div className="space-y-6 text-sm">
      {/* 🚀 1. 面板頁首 (Header + Time Range Dropdown) */}
      <div className={`p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-4 shadow-sm ${darkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-md">
            <ShieldCheck size={22} />
          </div>
          <div>
            <h2 className={`text-base font-black tracking-wide flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              全網宏觀戰情中心 (NOC Network Operations Center)
            </h2>
            <p className="text-xs text-slate-400">
              全方位監控 Mesh 網路健康度、RF訊號品質、跳數覆蓋深度、時段熱區與硬體生態
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchData(timeRange)}
            className={`p-2 rounded-xl border transition-colors ${darkMode ? 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300' : 'bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-600'}`}
            title="重新載入數據"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border bg-slate-100 dark:bg-slate-800 dark:border-slate-700">
            <Clock size={14} className="text-cyan-500" />
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as any)}
              className="bg-transparent font-bold text-xs outline-none cursor-pointer text-slate-700 dark:text-slate-200"
            >
              <option value="24h">過去 24 小時</option>
              <option value="7d">過去 7 天</option>
              <option value="30d">過去 30 天</option>
            </select>
          </div>
        </div>
      </div>

      {/* 🚀 2. 頂部 KPI 卡片區 (3 欄 Grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* 卡片 1: 總活躍節點 */}
        <div className={`p-5 rounded-2xl border shadow-sm flex items-center justify-between transition-all ${darkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="space-y-1">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">總活躍節點 (Active)</span>
            <div className="text-2xl font-black text-cyan-500 font-mono">
              {kpi.activeNodes} <span className="text-xs text-slate-400 font-normal">nodes</span>
            </div>
            <span className="text-[10px] text-slate-500 block">選定時間範圍內活躍</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-cyan-500/10 text-cyan-500 border border-cyan-500/20">
            <Activity size={24} />
          </div>
        </div>

        {/* 卡片 2: 離線 / 失聯節點 */}
        <div className={`p-5 rounded-2xl border shadow-sm flex items-center justify-between transition-all ${darkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="space-y-1">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">離線 / 失聯節點</span>
            <div className="text-2xl font-black text-rose-500 font-mono">
              {kpi.offlineNodes} <span className="text-xs text-slate-400 font-normal">nodes</span>
            </div>
            <span className="text-[10px] text-slate-500 block">超過 48 小時未活動</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-rose-500/10 text-rose-500 border border-rose-500/20">
            <WifiOff size={24} />
          </div>
        </div>

        {/* 卡片 3: 無座標幽靈節點 */}
        <div className={`p-5 rounded-2xl border shadow-sm flex items-center justify-between transition-all ${darkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="space-y-1">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block">無座標幽靈節點</span>
            <div className="text-2xl font-black text-amber-500 font-mono">
              {kpi.ghostNodes} <span className="text-xs text-slate-400 font-normal">nodes</span>
            </div>
            <span className="text-[10px] text-slate-500 block">活躍但未回送 GPS 座標</span>
          </div>
          <div className="p-3.5 rounded-2xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
            <MapPinOff size={24} />
          </div>
        </div>
      </div>

      {/* 🚀 3. 射頻與覆蓋深度分析 (RF Quality & Propagation) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 左圖: 全網平均 SNR / RSSI 品質歷史雙軸趨勢圖 */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-500">
              <Radio size={16} /> 全網 RF 訊號品質趨勢 (Avg SNR & RSSI)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">平均 SNR (dB) & RSSI (dBm)</span>
          </div>

          <div className="h-64 w-full">
            {signalHealth.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                {loading ? '載入訊號品質中...' : '暫無歷史訊號品質紀錄'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={signalHealth} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                  <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="snr" orientation="left" stroke="#10b981" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <YAxis yAxisId="rssi" orientation="right" stroke="#06b6d4" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={customTooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                  <Line yAxisId="snr" type="monotone" dataKey="avgSnr" name="平均 SNR (dB)" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                  <Line yAxisId="rssi" type="monotone" dataKey="avgRssi" name="平均 RSSI (dBm)" stroke="#06b6d4" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 右圖: 跳數傳播深度分佈圖 (Hop Count) */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-indigo-500">
              <Share2 size={16} /> 跳數傳播深度分佈 (Hop Count Distribution)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">Direct vs Multi-Hop 比例</span>
          </div>

          <div className="h-64 w-full">
            {hopDist.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                {loading ? '載入跳數分佈中...' : '暫無跳數分佈紀錄'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hopDist} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                  <XAxis dataKey="hop_category" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={customTooltipStyle} />
                  <Bar dataKey="count" name="封包數量" fill="#6366f1" radius={[6, 6, 0, 0]}>
                    {hopDist.map((_, index) => (
                      <Cell key={`cell-hop-${index}`} fill={PALETTE_COLORS[index % PALETTE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* 🚀 4. 流量負載與時段熱區 (Traffic & Peak Hours) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左側 2 欄: 活躍與幽靈趨勢折線圖 */}
        <div className={`lg:col-span-2 p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-500">
              <TrendingUp size={16} /> 節點活躍與幽靈趨勢 (Node Activity & Ghost Trend)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">每日 Active vs Ghost</span>
          </div>

          <div className="h-64 w-full">
            {trends.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                {loading ? '載入趨勢數據中...' : '暫無歷史趨勢數據'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                  <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={customTooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                  <Line type="monotone" dataKey="activeNodes" name="活躍節點 (Active)" stroke="#06b6d4" strokeWidth={3} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="ghostNodes" name="幽靈節點 (No GPS)" stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 4" dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 右側 1 欄: 24小時時段熱門活動高峰圖 */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-amber-500">
              <Clock size={16} /> 24 小時熱點活動高峰 (Hourly Peak)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">00:00 ~ 23:00</span>
          </div>

          <div className="h-64 w-full">
            {hourlyActivity.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                {loading ? '載入時段熱區中...' : '暫無時段活動數據'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourlyActivity} margin={{ top: 10, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                  <XAxis dataKey="hour" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 9 }} interval={3} />
                  <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={customTooltipStyle} />
                  <Bar dataKey="count" name="封包數量" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* 🚀 5. 硬體與韌體生態系 (Fleet & Firmware Analytics) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左側 1 欄: 硬體型號佔比 Donut 圖 */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-500">
              <Cpu size={16} /> 硬體設備型號分佈 (Hardware Models)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">Hardware</span>
          </div>

          <div className="h-64 w-full flex items-center justify-center">
            {hwModels.length === 0 ? (
              <div className="text-slate-500 italic text-xs">{loading ? '載入硬體資訊中...' : '暫無硬體型號數據'}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={hwModels}
                    dataKey="count"
                    nameKey="model"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    paddingAngle={2}
                    label={({ name }) => name.substring(0, 10)}
                    labelLine={false}
                  >
                    {hwModels.map((_, index) => (
                      <Cell key={`cell-hw-${index}`} fill={PALETTE_COLORS[index % PALETTE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={customTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 中間 1 欄: 韌體版本分佈 (官方離散版本系列 / Top 版號) */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-teal-500">
              <Layers size={16} /> 韌體版本分佈 (Firmware)
            </h3>
            <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg text-[9px] font-bold">
              <button
                onClick={() => setFwViewMode('series')}
                className={`px-2 py-0.5 rounded transition-all ${fwViewMode === 'series' ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
              >
                主系列
              </button>
              <button
                onClick={() => setFwViewMode('exact')}
                className={`px-2 py-0.5 rounded transition-all ${fwViewMode === 'exact' ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
              >
                主要版號
              </button>
            </div>
          </div>

          <div className="h-64 w-full flex items-center justify-center">
            {((fwViewMode === 'series' ? firmwareVersions.series : firmwareVersions.exact) || []).length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                {loading ? '載入韌體版本中...' : '暫無韌體版本數據'}
              </div>
            ) : fwViewMode === 'series' ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={firmwareVersions.series}
                    dataKey="count"
                    nameKey="version"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    paddingAngle={2}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {firmwareVersions.series.map((_, index) => (
                      <Cell key={`cell-fw-series-${index}`} fill={PALETTE_COLORS[index % PALETTE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={customTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={firmwareVersions.exact} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                  <XAxis dataKey="version" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                  <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={customTooltipStyle} />
                  <Bar dataKey="count" name="節點數量" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* 右側 1 欄: 網路角色分佈 Donut 圖 */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-purple-500">
              <PieChartIcon size={16} /> 網路角色分佈 (Node Roles)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">Role 佔比</span>
          </div>

          <div className="h-64 w-full flex items-center justify-center">
            {roles.length === 0 ? (
              <div className="text-slate-500 italic text-xs">{loading ? '載入角色中...' : '暫無角色數據'}</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={roles}
                    dataKey="count"
                    nameKey="role"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    paddingAngle={2}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {roles.map((_, index) => (
                      <Cell key={`cell-role-${index}`} fill={PALETTE_COLORS[index % PALETTE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={customTooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* 🚀 ⛅ 中央氣象署 (CWA) 官方數據對比卡片 */}
      {cwaComparison && (
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-400">
              <CloudSun size={18} /> 台灣中央氣象署 (CWA) 官方觀測 vs Mesh 網路數據對比
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">即時全台官方氣象站平均比對</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* 官方氣溫 */}
            <div className={`p-4 rounded-xl border flex flex-col justify-between ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
              <span className="text-[11px] font-bold text-slate-400">CWA 官方氣象站平均溫度</span>
              <div className="text-2xl font-black text-blue-400 font-mono mt-1">
                {cwaComparison.cwaAvgTemp} °C
              </div>
              <span className="text-[9px] text-slate-500 mt-1">全台標準百葉箱觀測值</span>
            </div>

            {/* Mesh 氣溫 */}
            <div className={`p-4 rounded-xl border flex flex-col justify-between ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
              <span className="text-[11px] font-bold text-slate-400">Mesh 節點實測平均溫度</span>
              <div className="text-2xl font-black text-amber-400 font-mono mt-1">
                {cwaComparison.meshAvgTemp} °C
              </div>
              <span className="text-[9px] text-slate-500 mt-1">來自 BME280 / SHT31 感測器</span>
            </div>

            {/* 氣溫偏差 Delta T */}
            <div className={`p-4 rounded-xl border flex flex-col justify-between ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
              <span className="text-[11px] font-bold text-slate-400">平均氣溫偏差值 (ΔT)</span>
              <div className={`text-2xl font-black font-mono mt-1 ${cwaComparison.tempDelta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {cwaComparison.tempDelta > 0 ? `+${cwaComparison.tempDelta}` : cwaComparison.tempDelta} °C
              </div>
              <span className="text-[9px] text-slate-500 mt-1">
                {cwaComparison.tempDelta > 2 ? '⚠️ 氣溫高於官方 (外殼日照微氣候)' : '良好 (接近標準觀測值)'}
              </span>
            </div>

            {/* 濕度偏差 Delta H */}
            <div className={`p-4 rounded-xl border flex flex-col justify-between ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
              <span className="text-[11px] font-bold text-slate-400">平均相對濕度偏差 (ΔH)</span>
              <div className="text-2xl font-black text-cyan-400 font-mono mt-1">
                {cwaComparison.humidityDelta > 0 ? `+${cwaComparison.humidityDelta}` : cwaComparison.humidityDelta} %
              </div>
              <span className="text-[9px] text-slate-500 mt-1">Mesh: {cwaComparison.meshAvgHumidity}% vs CWA: {cwaComparison.cwaAvgHumidity}%</span>
            </div>
          </div>
        </div>
      )}

      {/* 🚀 6. 全網氣候環境遙測趨勢 (Environmental Telemetry) */}
      <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-emerald-500">
            <CloudSun size={16} /> 全網環境與氣候遙測趨勢 (Aggregated Weather Sensors)
          </h3>
          <span className="text-[10px] text-slate-400 font-mono">全網平均 溫度 (°C) & 濕度 (%)</span>
        </div>

        <div className="h-64 w-full">
          {envTrends.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
              {loading ? '載入環境氣象數據中...' : '暫無感測器環境趨勢數據'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={envTrends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="temp" stroke="#f59e0b" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                <YAxis yAxisId="hum" orientation="right" stroke="#3b82f6" tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                <Tooltip contentStyle={customTooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                <Line yAxisId="temp" type="monotone" dataKey="avgTemp" name="平均溫度 (°C)" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3 }} />
                <Line yAxisId="hum" type="monotone" dataKey="avgHumidity" name="平均濕度 (%)" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 🚀 7. 全網封包流量解析 (Traffic Distribution by Packet Type) */}
      <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-500">
            <BarChart3 size={16} /> 全網封包流量解析 (Traffic Distribution by Packet Type)
          </h3>
          <span className="text-[10px] text-slate-400 font-mono">按天 Stacked 分類流量</span>
        </div>

        <div className="h-64 w-full">
          {traffic.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
              {loading ? '載入流量分析中...' : '暫無歷史流量數據'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={traffic} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={customTooltipStyle} />
                <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
                <Bar dataKey="Position" name="位置 (Position)" stackId="a" fill="#3b82f6" />
                <Bar dataKey="Telemetry" name="遙測 (Telemetry)" stackId="a" fill="#10b981" />
                <Bar dataKey="TextMessage" name="訊息 (Text)" stackId="a" fill="#f59e0b" />
                <Bar dataKey="Routing" name="路由 (Routing)" stackId="a" fill="#8b5cf6" />
                <Bar dataKey="Other" name="其他 (Other)" stackId="a" fill="#64748b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
