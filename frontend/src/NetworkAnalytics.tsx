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
  Map,
  X,
  Search,
  Zap,
  BatteryCharging,
  Network,
  Award,
  Repeat,
  ShieldAlert,
  Gauge,
  Sun,
  AlertTriangle,
  MapPin,
  ChevronDown,
  Filter,
  Sparkles,
  CloudRain,
  Info,
} from 'lucide-react';
import CwaNodeMap, { NodeComparison } from './CwaNodeMap';
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

const COUNTY_COLORS: { [key: string]: string } = {
  '全網平均': '#f59e0b',
  '全網/其它': '#94a3b8',
  '臺北市': '#3b82f6',
  '台北市': '#3b82f6',
  '新北市': '#10b981',
  '桃園市': '#ec4899',
  '臺中市': '#8b5cf6',
  '台中市': '#8b5cf6',
  '臺南市': '#f97316',
  '台南市': '#f97316',
  '高雄市': '#06b6d4',
  '基隆市': '#0284c7',
  '新竹市': '#14b8a6',
  '嘉義市': '#84cc16',
  '新竹縣': '#a855f7',
  '苗栗縣': '#eab308',
  '彰化縣': '#f43f5e',
  '南投縣': '#6366f1',
  '雲林縣': '#d97706',
  '嘉義縣': '#65a30d',
  '屏東縣': '#ef4444',
  '宜蘭縣': '#059669',
  '花蓮縣': '#c026d3',
  '臺東縣': '#4f46e5',
  '台東縣': '#4f46e5',
  '澎湖縣': '#0891b2',
  '金門縣': '#b45309',
  '連江縣': '#475569'
};

const DEFAULT_COLOR_PALETTE = [
  '#f59e0b', '#3b82f6', '#10b981', '#ec4899', '#8b5cf6', 
  '#06b6d4', '#f97316', '#a855f7', '#14b8a6', '#f43f5e', 
  '#84cc16', '#0284c7', '#d97706', '#6366f1', '#c026d3'
];

const getCountyColor = (county: string, index: number) => {
  return COUNTY_COLORS[county] || DEFAULT_COLOR_PALETTE[index % DEFAULT_COLOR_PALETTE.length];
};

interface TitleHelpTooltipProps {
  title: string;
  dataExplanation: string;
  funcPurpose: string;
  darkMode: boolean;
  icon?: React.ReactNode;
  textColor?: string;
}

const TitleHelpTooltip: React.FC<TitleHelpTooltipProps> = ({
  title,
  dataExplanation,
  funcPurpose,
  darkMode,
  icon,
  textColor = 'text-cyan-400'
}) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative inline-flex items-center" onMouseEnter={() => setIsOpen(true)} onMouseLeave={() => setIsOpen(false)}>
      <h3 className={`text-sm font-black uppercase tracking-wider flex items-center gap-2 cursor-help ${textColor}`}>
        {icon}
        <span>{title}</span>
        <Info size={14} className="opacity-60 hover:opacity-100 transition-opacity shrink-0 text-cyan-400" />
      </h3>

      {isOpen && (
        <div className={`absolute left-0 top-full mt-2 w-72 p-3.5 rounded-xl border shadow-2xl z-50 text-xs space-y-2 pointer-events-none transition-all ${
          darkMode ? 'bg-slate-900/95 border-slate-700 text-slate-100 backdrop-blur-md shadow-black/80' : 'bg-white/95 border-slate-300 text-slate-800 shadow-slate-400/30 backdrop-blur-md'
        }`}>
          <div className={`font-bold text-xs flex items-center gap-1.5 border-b pb-2 ${darkMode ? 'border-slate-700/60' : 'border-slate-200'} ${textColor}`}>
            <Info size={14} /> {title} — 說明指南
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400 mb-0.5">📊 數據意義:</div>
            <div className="text-[11px] leading-relaxed text-slate-300">{dataExplanation}</div>
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400 mb-0.5">💡 功能與維運用途:</div>
            <div className="text-[11px] leading-relaxed text-slate-300">{funcPurpose}</div>
          </div>
        </div>
      )}
    </div>
  );
};

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

interface NodeComparison {
  nodeId: string;
  nodeName: string;
  nodeShortName: string;
  nodeLat: number;
  nodeLng: number;
  nodeTemp: number | null;
  nodeHumidity: number | null;
  cwaStationId: string;
  cwaStationName: string;
  cwaCounty: string;
  cwaTown: string;
  cwaLat: number;
  cwaLng: number;
  cwaTemp: number;
  cwaHumidity: number | null;
  cwaWeather: string;
  distanceKm: number;
  deltaTemp: number | null;
  deltaHum: number | null;
  anomaly: boolean;
}

interface RegionSummary {
  county: string;
  nodeCount: number;
  avgDeltaTemp: number | null;
  maxDeltaTemp: number | null;
  minDeltaTemp: number | null;
  avgDeltaHum: number | null;
  anomalyCount: number;
  anomalyRate: number;
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
  const [hopAnalysis, setHopAnalysis] = useState<{
    actualHops: { hop: number; count: number }[];
    configuredHops: { hop: number; count: number }[];
    avgActualHops: number;
    avgConfiguredHops: number;
    diff: number;
    recommendation: string | null;
  } | null>(null);
  const [hourlyActivity, setHourlyActivity] = useState<HourlyPoint[]>([]);
  const [hourlyStacked, setHourlyStacked] = useState<any[]>([]);
  const [cuDist, setCuDist] = useState<{
    totalNodes: number;
    avgCU: number;
    tiers: {
      critical: { count: number; pct: number; nodes: any[] };
      congested: { count: number; pct: number; nodes: any[] };
      normal: { count: number; pct: number; nodes: any[] };
      low: { count: number; pct: number; nodes: any[] };
    };
  } | null>(null);
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
  const [cwaNodeComparison, setCwaNodeComparison] = useState<{
    nodeComparisons: NodeComparison[];
    regionSummary: RegionSummary[];
    totalNodes: number;
    cwaStationCount: number;
    cwaReady: boolean;
  } | null>(null);
  const [cwaViewMode, setCwaViewMode] = useState<'region' | 'nodes' | 'map'>('map');

  // ⛅ 縣市分區遙測趨勢 States
  const [countyWeatherTrends, setCountyWeatherTrends] = useState<{
    counties: string[];
    tempTrends: any[];
    humTrends: any[];
  } | null>(null);
  const [selectedCounties, setSelectedCounties] = useState<string[]>([]);
  const [isCountyDropdownOpen, setIsCountyDropdownOpen] = useState<boolean>(false);

  const isCountySelected = (c: string): boolean => {
    return Array.isArray(selectedCounties) && selectedCounties.includes(c);
  };

  const [selectedCuTier, setSelectedCuTier] = useState<'critical' | 'congested' | 'normal' | 'low' | null>(null);
  const [cuSearchTerm, setCuSearchTerm] = useState<string>('');

  // 6 個新高階分析模組 States
  const [airUtilDist, setAirUtilDist] = useState<any | null>(null);
  const [selectedAirUtilTier, setSelectedAirUtilTier] = useState<'high' | 'medium' | 'low' | null>(null);
  const [airUtilSearchTerm, setAirUtilSearchTerm] = useState<string>('');

  const [topGateways, setTopGateways] = useState<any[]>([]);
  const [duplicateStats, setDuplicateStats] = useState<any | null>(null);
  const [trafficSourceRatio, setTrafficSourceRatio] = useState<any[]>([]);

  const [powerHealth, setPowerHealth] = useState<any | null>(null);
  const [selectedPowerTier, setSelectedPowerTier] = useState<'critical' | 'warning' | 'healthy' | null>(null);
  const [powerSearchTerm, setPowerSearchTerm] = useState<string>('');

  const [meshInterconnectivity, setMeshInterconnectivity] = useState<any | null>(null);

  // ⚠️ Module 3 & ☀️ Module 5 States
  const [weakSignalAlerts, setWeakSignalAlerts] = useState<any | null>(null);
  const [showWeakSignalList, setShowWeakSignalList] = useState<boolean>(false);
  const [solarChargingHealth, setSolarChargingHealth] = useState<any | null>(null);

  // 🔘 清單收起/展開 Toggle States (預設皆收起)
  const [showAirUtilList, setShowAirUtilList] = useState<boolean>(false);
  const [showPowerList, setShowPowerList] = useState<boolean>(false);
  const [showTopGatewaysList, setShowTopGatewaysList] = useState<boolean>(false);
  const [showHubNodesList, setShowHubNodesList] = useState<boolean>(false);
  const [showSolarList, setShowSolarList] = useState<boolean>(false);

  const fetchData = async (range: string) => {
    setLoading(true);
    try {
      // ⚡ 優先嘗試單一極速打包 API (/api/analytics/bundle)
      const bundleRes = await fetch(`/api/analytics/bundle?range=${range}`);
      if (bundleRes.ok) {
        const b = await bundleRes.json();
        if (b) {
          if (b.kpi) setKpi(b.kpi);
          if (Array.isArray(b.trends)) setTrends(b.trends);
          if (Array.isArray(b.roles)) setRoles(b.roles);
          if (Array.isArray(b.traffic)) setTraffic(b.traffic);
          if (Array.isArray(b.signalHealth)) setSignalHealth(b.signalHealth);

          const hopOrder: { [key: string]: number } = { '0 Hop (Direct)': 0, '1 Hop': 1, '2 Hops': 2, '3+ Hops': 3 };
          const sortedHopData = Array.isArray(b.hopDist)
            ? [...b.hopDist].sort((x, y) => (hopOrder[x.hop_category] ?? 99) - (hopOrder[y.hop_category] ?? 99))
            : [];
          setHopDist(sortedHopData);

          if (b.hopAnalysis && !b.hopAnalysis.error) setHopAnalysis(b.hopAnalysis);
          if (Array.isArray(b.hourlyActivity)) setHourlyActivity(b.hourlyActivity);
          if (Array.isArray(b.hourlyStacked)) setHourlyStacked(b.hourlyStacked);
          if (b.cuDist && !b.cuDist.error) setCuDist(b.cuDist);
          if (Array.isArray(b.hwModels)) setHwModels(b.hwModels);

          if (b.firmwareVersions) {
            setFirmwareVersions({
              series: Array.isArray(b.firmwareVersions?.series) ? b.firmwareVersions.series : [],
              exact: Array.isArray(b.firmwareVersions?.exact) ? b.firmwareVersions.exact : (Array.isArray(b.firmwareVersions) ? b.firmwareVersions : []),
            });
          }

          if (Array.isArray(b.envTrends)) setEnvTrends(b.envTrends);
          if (b.cwaComparison) setCwaComparison(b.cwaComparison);
          if (b.cwaNodeComparison?.cwaReady) setCwaNodeComparison(b.cwaNodeComparison);
          if (b.airUtilDist && !b.airUtilDist.error) setAirUtilDist(b.airUtilDist);
          if (Array.isArray(b.topGateways)) setTopGateways(b.topGateways);
          if (b.duplicateStats && !b.duplicateStats.error) setDuplicateStats(b.duplicateStats);
          if (b.powerHealth && !b.powerHealth.error) setPowerHealth(b.powerHealth);
          if (b.meshInterconnectivity && !b.meshInterconnectivity.error) setMeshInterconnectivity(b.meshInterconnectivity);
          if (b.weakSignalAlerts && !b.weakSignalAlerts.error) setWeakSignalAlerts(b.weakSignalAlerts);
          if (b.solarChargingHealth && !b.solarChargingHealth.error) setSolarChargingHealth(b.solarChargingHealth);

          if (b.countyWeatherTrends && Array.isArray(b.countyWeatherTrends.counties)) {
            setCountyWeatherTrends(b.countyWeatherTrends);
            setSelectedCounties(prev => (Array.isArray(prev) && prev.length > 0) ? prev : b.countyWeatherTrends.counties);
          }
          return;
        }
      }

      // 🔄 Fallback: 舊版 API 備用降級
      const [
        kpiRes,
        trendRes,
        roleRes,
        trafficRes,
        signalRes,
        hopRes,
        hopAnalysisRes,
        hourlyRes,
        hourlyStackedRes,
        cuRes,
        modelRes,
        fwRes,
        envRes,
        cwaRes,
        cwaNodeRes,
        airUtilRes,
        topGwRes,
        dupRes,
        pwrRes,
        meshRes,
        weakRes,
        solarRes,
        countyWeatherRes,
      ] = await Promise.all([
        fetch(`/api/analytics/kpi?range=${range}`),
        fetch(`/api/analytics/trends?range=${range}`),
        fetch('/api/analytics/roles'),
        fetch(`/api/analytics/traffic?range=${range}`),
        fetch(`/api/analytics/signal-health?range=${range}`),
        fetch(`/api/analytics/hop-distribution?range=${range}`),
        fetch('/api/analytics/hop-distribution'),
        fetch(`/api/analytics/hourly-activity?range=${range}`),
        fetch('/api/analytics/hourly-peak-stacked'),
        fetch('/api/analytics/cu-distribution'),
        fetch('/api/analytics/hardware-models'),
        fetch('/api/analytics/firmware-versions'),
        fetch(`/api/analytics/environment-trends?range=${range}`),
        fetch('/api/analytics/cwa-comparison'),
        fetch('/api/analytics/cwa-node-comparison'),
        fetch('/api/analytics/air-util-distribution'),
        fetch(`/api/analytics/top-gateways?range=${range}`),
        fetch(`/api/analytics/duplicate-stats?range=${range}`),
        fetch('/api/analytics/power-health'),
        fetch('/api/analytics/mesh-interconnectivity'),
        fetch('/api/analytics/weak-signal-alerts'),
        fetch('/api/analytics/solar-charging-health'),
        fetch('/api/analytics/county-weather-trends'),
      ]);

      const [
        kpiData,
        trendData,
        roleData,
        trafficData,
        signalData,
        hopData,
        hopAnalysisData,
        hourlyData,
        hourlyStackedData,
        cuData,
        modelData,
        fwData,
        envData,
        cwaData,
        cwaNodeData,
        airUtilData,
        topGwData,
        dupData,
        pwrData,
        meshData,
        weakData,
        solarData,
        countyWeatherData,
      ] = await Promise.all([
        kpiRes.json(),
        trendRes.json(),
        roleRes.json(),
        trafficRes.json(),
        signalRes.json(),
        hopRes.json(),
        hopAnalysisRes.json(),
        hourlyRes.json(),
        hourlyStackedRes.json(),
        cuRes.json(),
        modelRes.json(),
        fwRes.json(),
        envRes.json(),
        cwaRes.json(),
        cwaNodeRes.json(),
        airUtilData ? airUtilRes.json() : null,
        topGwRes.json(),
        dupRes.json(),
        pwrRes.json(),
        meshRes.json(),
        weakRes.json(),
        solarRes.json(),
        countyWeatherRes.json(),
      ]);

      setKpi(kpiData || { activeNodes: 0, offlineNodes: 0, ghostNodes: 0, lowBatteryAlerts: 0 });
      setTrends(Array.isArray(trendData) ? trendData : []);
      setRoles(Array.isArray(roleData) ? roleData : []);
      setTraffic(Array.isArray(trafficData) ? trafficData : []);
      setSignalHealth(Array.isArray(signalData) ? signalData : []);
      const hopOrder: { [key: string]: number } = { '0 Hop (Direct)': 0, '1 Hop': 1, '2 Hops': 2, '3+ Hops': 3 };
      const sortedHopData = Array.isArray(hopData)
        ? [...hopData].sort((a, b) => (hopOrder[a.hop_category] ?? 99) - (hopOrder[b.hop_category] ?? 99))
        : [];
      setHopDist(sortedHopData);
      if (hopAnalysisData && !hopAnalysisData.error) setHopAnalysis(hopAnalysisData);
      setHourlyActivity(Array.isArray(hourlyData) ? hourlyData : []);
      if (Array.isArray(hourlyStackedData)) setHourlyStacked(hourlyStackedData);
      if (cuData && !cuData.error) setCuDist(cuData);
      setHwModels(Array.isArray(modelData) ? modelData : []);
      setFirmwareVersions({
        series: Array.isArray(fwData?.series) ? fwData.series : [],
        exact: Array.isArray(fwData?.exact) ? fwData.exact : (Array.isArray(fwData) ? fwData : []),
      });
      setEnvTrends(Array.isArray(envData) ? envData : []);
      setCwaComparison(cwaData || null);
      setCwaNodeComparison(cwaNodeData?.cwaReady ? cwaNodeData : null);

      if (airUtilData && !airUtilData.error) setAirUtilDist(airUtilData);
      if (Array.isArray(topGwData)) setTopGateways(topGwData);
      if (dupData && !dupData.error) setDuplicateStats(dupData);
      if (pwrData && !pwrData.error) setPowerHealth(pwrData);
      if (meshData && !meshData.error) setMeshInterconnectivity(meshData);
      if (weakData && !weakData.error) setWeakSignalAlerts(weakData);
      if (solarData && !solarData.error) setSolarChargingHealth(solarData);

      if (countyWeatherData && countyWeatherData.counties) {
        setCountyWeatherTrends(countyWeatherData);
        setSelectedCounties(prev => prev.length === 0 ? countyWeatherData.counties : prev);
      }
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
            <TitleHelpTooltip
              title="全網 RF 訊號品質趨勢 (Avg SNR & RSSI)"
              icon={<Radio size={16} />}
              textColor="text-cyan-500"
              darkMode={darkMode}
              dataExplanation="統計全網接收封包之平均 SNR (信噪比 dB) 與 RSSI (訊號強度 dBm) 歷史曲線。"
              funcPurpose="診斷全網無線電覆蓋品質與空間衰減趨勢，評估中繼站架設與天線效能。"
            />
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

        {/* 右圖: 跳數傳播深度分佈圖 (Hop Count) & 網路健康診斷 */}
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <TitleHelpTooltip
              title="跳數傳播深度分佈 (Hop Count Distribution)"
              icon={<Share2 size={16} />}
              textColor="text-indigo-400"
              darkMode={darkMode}
              dataExplanation="按 0 Hop (直連) 至 3+ Hops 正序統計封包傳播經過的中繼跳數與配置限額比對。"
              funcPurpose="評估 Mesh 網狀拓撲傳遞效率與覆蓋深度，診斷多跳延遲與潛在廣播風暴。"
            />
            <span className="text-[10px] text-slate-400 font-mono">實際跳數 vs 預設 Hop 限額</span>
          </div>

          <div className="h-48 w-full">
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

          {/* 💡 網路 Hop 數健康度診斷提醒卡片 */}
          {hopAnalysis && hopAnalysis.recommendation && (
            <div className={`p-3 rounded-xl border text-[11px] font-mono leading-relaxed shadow-sm ${
              hopAnalysis.diff >= 1.2
                ? 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                : 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
            }`}>
              <div className="font-bold flex items-center justify-between mb-1 text-xs">
                <span>💡 Hop 網路傳播健康度診斷</span>
                <span>實際 {hopAnalysis.avgActualHops} 跳 / 設定 {hopAnalysis.avgConfiguredHops} 跳</span>
              </div>
              <div>{hopAnalysis.recommendation}</div>
            </div>
          )}
        </div>
      </div>

      {/* 🚀 4. 頻道佔用率 (CU) 4 階健康度分級與風險分析 */}
      {cuDist && (
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <TitleHelpTooltip
              title="頻道佔用率 (Channel Utilization) 4 階分級"
              icon={<Activity size={16} />}
              textColor="text-cyan-400"
              darkMode={darkMode}
              dataExplanation="評估全網空口 Channel Utilization (CU %) 負載，分為危險(≥25%)、壅塞(20-25%)、普通(5-20%)與低(<5%)。"
              funcPurpose="協助網管員識別區域頻道擁塞熱區，點擊可展開該階級之詳細節點清單。"
            />
            <span className="text-[10px] text-slate-400 font-mono">全網平均 CU: {cuDist.avgCU}%</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            {/* 🚨 危險 */}
            <div
              onClick={() => {
                setSelectedCuTier(selectedCuTier === 'critical' ? null : 'critical');
                setCuSearchTerm('');
              }}
              className={`p-3.5 rounded-xl border space-y-1 cursor-pointer transition-all hover:scale-[1.01] ${
                selectedCuTier === 'critical'
                  ? 'border-red-500 ring-2 ring-red-500/50 bg-red-950/50'
                  : 'border-red-500/40 bg-red-950/30 hover:border-red-500/70'
              }`}
            >
              <div className="flex justify-between items-center text-xs font-bold text-red-300">
                <span>🚨 危險 (Dangerous)</span>
                <span className="text-[10px] opacity-80">≥ 25%</span>
              </div>
              <div className="text-2xl font-black font-mono text-red-400 flex items-baseline justify-between">
                <span>{cuDist.tiers.critical.count} <span className="text-xs text-red-400/80 font-normal">節點 ({cuDist.tiers.critical.pct}%)</span></span>
                <span className="text-[10px] text-red-300/80 font-sans font-normal underline">
                  {selectedCuTier === 'critical' ? '收起清單 ▲' : '點擊查看 ▼'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400">頻寬嚴重耗盡，碰撞風險極高</div>
            </div>

            {/* ⚠️ 壅塞 */}
            <div
              onClick={() => {
                setSelectedCuTier(selectedCuTier === 'congested' ? null : 'congested');
                setCuSearchTerm('');
              }}
              className={`p-3.5 rounded-xl border space-y-1 cursor-pointer transition-all hover:scale-[1.01] ${
                selectedCuTier === 'congested'
                  ? 'border-orange-500 ring-2 ring-orange-500/50 bg-orange-950/50'
                  : 'border-orange-500/40 bg-orange-950/30 hover:border-orange-500/70'
              }`}
            >
              <div className="flex justify-between items-center text-xs font-bold text-orange-300">
                <span>⚠️ 壅塞 (Congested)</span>
                <span className="text-[10px] opacity-80">20% - 25%</span>
              </div>
              <div className="text-2xl font-black font-mono text-orange-400 flex items-baseline justify-between">
                <span>{cuDist.tiers.congested.count} <span className="text-xs text-orange-400/80 font-normal">節點 ({cuDist.tiers.congested.pct}%)</span></span>
                <span className="text-[10px] text-orange-300/80 font-sans font-normal underline">
                  {selectedCuTier === 'congested' ? '收起清單 ▲' : '點擊查看 ▼'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400">通道流量熱化，建議關注</div>
            </div>

            {/* 🟢 普通 */}
            <div
              onClick={() => {
                setSelectedCuTier(selectedCuTier === 'normal' ? null : 'normal');
                setCuSearchTerm('');
              }}
              className={`p-3.5 rounded-xl border space-y-1 cursor-pointer transition-all hover:scale-[1.01] ${
                selectedCuTier === 'normal'
                  ? 'border-emerald-500 ring-2 ring-emerald-500/50 bg-emerald-950/50'
                  : 'border-emerald-500/40 bg-emerald-950/30 hover:border-emerald-500/70'
              }`}
            >
              <div className="flex justify-between items-center text-xs font-bold text-emerald-300">
                <span>🟢 普通 (Normal)</span>
                <span className="text-[10px] opacity-80">5% - 20%</span>
              </div>
              <div className="text-2xl font-black font-mono text-emerald-400 flex items-baseline justify-between">
                <span>{cuDist.tiers.normal.count} <span className="text-xs text-emerald-400/80 font-normal">節點 ({cuDist.tiers.normal.pct}%)</span></span>
                <span className="text-[10px] text-emerald-300/80 font-sans font-normal underline">
                  {selectedCuTier === 'normal' ? '收起清單 ▲' : '點擊查看 ▼'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400">負載健康，傳播順暢</div>
            </div>

            {/* 🔵 低度使用 */}
            <div
              onClick={() => {
                setSelectedCuTier(selectedCuTier === 'low' ? null : 'low');
                setCuSearchTerm('');
              }}
              className={`p-3.5 rounded-xl border space-y-1 cursor-pointer transition-all hover:scale-[1.01] ${
                selectedCuTier === 'low'
                  ? 'border-blue-500 ring-2 ring-blue-500/50 bg-blue-950/50'
                  : 'border-blue-500/40 bg-blue-950/30 hover:border-blue-500/70'
              }`}
            >
              <div className="flex justify-between items-center text-xs font-bold text-blue-300">
                <span>🔵 低度使用 (Low)</span>
                <span className="text-[10px] opacity-80">&lt; 5%</span>
              </div>
              <div className="text-2xl font-black font-mono text-blue-400 flex items-baseline justify-between">
                <span>{cuDist.tiers.low.count} <span className="text-xs text-blue-400/80 font-normal">節點 ({cuDist.tiers.low.pct}%)</span></span>
                <span className="text-[10px] text-blue-300/80 font-sans font-normal underline">
                  {selectedCuTier === 'low' ? '收起清單 ▲' : '點擊查看 ▼'}
                </span>
              </div>
              <div className="text-[10px] text-slate-400">極度空閒或初次上線</div>
            </div>
          </div>

          {/* 節點展開清單面板 */}
          {selectedCuTier && cuDist.tiers[selectedCuTier] && (
            <div className={`mt-4 p-4 rounded-xl border ${
              darkMode ? 'bg-slate-950/70 border-slate-800' : 'bg-slate-50 border-slate-200'
            } space-y-3 transition-all`}>
              <div className="flex justify-between items-center border-b pb-2 border-slate-700/50">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold">
                    {selectedCuTier === 'critical' && <span className="text-red-400">🚨 危險階級節點清單 (CU ≥ 25%)</span>}
                    {selectedCuTier === 'congested' && <span className="text-orange-400">⚠️ 壅塞階級節點清單 (CU 20% ~ 25%)</span>}
                    {selectedCuTier === 'normal' && <span className="text-emerald-400">🟢 普通階級節點清單 (CU 5% ~ 20%)</span>}
                    {selectedCuTier === 'low' && <span className="text-blue-400">🔵 低度使用階級節點清單 (CU &lt; 5%)</span>}
                  </span>
                  <span className="px-2 py-0.5 text-xs rounded-full bg-slate-800 border border-slate-700 text-slate-300 font-mono">
                    共 {cuDist.tiers[selectedCuTier].nodes.length} 個節點
                  </span>
                </div>
                <button
                  onClick={() => setSelectedCuTier(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  title="關閉清單"
                >
                  <X size={16} />
                </button>
              </div>

              {/* 搜尋過濾器 */}
              {cuDist.tiers[selectedCuTier].nodes.length > 5 && (
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="搜尋節點名稱或 Node ID..."
                    value={cuSearchTerm}
                    onChange={(e) => setCuSearchTerm(e.target.value)}
                    className={`w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border outline-none ${
                      darkMode
                        ? 'bg-slate-900 border-slate-700 text-slate-200 placeholder-slate-500 focus:border-cyan-500'
                        : 'bg-white border-slate-300 text-slate-800 placeholder-slate-400 focus:border-cyan-500'
                    }`}
                  />
                </div>
              )}

              {/* 節點清單列表 */}
              {cuDist.tiers[selectedCuTier].nodes.length === 0 ? (
                <div className="text-xs text-slate-500 italic py-4 text-center">此分級目前無節點</div>
              ) : (
                <div className="max-h-64 overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {cuDist.tiers[selectedCuTier].nodes
                    .filter((n: any) =>
                      !cuSearchTerm ||
                      n.name.toLowerCase().includes(cuSearchTerm.toLowerCase()) ||
                      n.nodeId.toLowerCase().includes(cuSearchTerm.toLowerCase())
                    )
                    .map((node: any) => (
                      <div
                        key={node.nodeId}
                        className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 ${
                          darkMode ? 'bg-slate-900/80 border-slate-800 hover:border-slate-700' : 'bg-white border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className={`text-xs font-bold truncate ${darkMode ? 'text-slate-200' : 'text-slate-800'}`} title={node.name}>
                            {node.name}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400">
                            {node.nodeId}
                          </div>
                        </div>
                        <div className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                          selectedCuTier === 'critical' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                          selectedCuTier === 'congested' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                          selectedCuTier === 'normal' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                          'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        }`}>
                          {node.cu}%
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 🚀 4.1 📡 發射空口佔用率 (AirUtil TX Monitor) */}
      <div className="grid grid-cols-1 gap-6">
        {/* AirUtil TX */}
        {airUtilDist && (
          <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
              <TitleHelpTooltip
                title="發射空口佔用率 (AirUtil TX Monitor)"
                icon={<Zap size={16} />}
                textColor="text-yellow-400"
                darkMode={darkMode}
                dataExplanation="監測各節點發射占空比 (AirUtil TX %)，分為高頻發射(>5%)、留意(2.5-5%)與正常(<2.5%)。"
                funcPurpose="找出發射頻率過高的發射大戶節點，調整廣播間隔避免佔用空中資源。"
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">全網平均 TX: {airUtilDist.avgTx}%</span>
                <button
                  onClick={() => setShowAirUtilList(!showAirUtilList)}
                  className="px-2.5 py-1 text-xs font-bold rounded-lg bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 hover:bg-yellow-500/30 transition-colors"
                >
                  {showAirUtilList ? '收起清單 ▲' : '點擊查看清單 ▼'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div
                onClick={() => {
                  setSelectedAirUtilTier(selectedAirUtilTier === 'high' ? null : 'high');
                  setAirUtilSearchTerm('');
                }}
                className={`p-3 rounded-xl border space-y-1 cursor-pointer transition-all ${
                  selectedAirUtilTier === 'high'
                    ? 'border-red-500 ring-2 ring-red-500/50 bg-red-950/50'
                    : 'border-red-500/40 bg-red-950/30 hover:border-red-500/70'
                }`}
              >
                <div className="text-xs font-bold text-red-300">🚨 高頻發射 (&gt; 5%)</div>
                <div className="text-xl font-black font-mono text-red-400">
                  {airUtilDist.tiers.high.count} <span className="text-xs font-normal">節點</span>
                </div>
              </div>

              <div
                onClick={() => {
                  setSelectedAirUtilTier(selectedAirUtilTier === 'medium' ? null : 'medium');
                  setAirUtilSearchTerm('');
                }}
                className={`p-3 rounded-xl border space-y-1 cursor-pointer transition-all ${
                  selectedAirUtilTier === 'medium'
                    ? 'border-yellow-500 ring-2 ring-yellow-500/50 bg-yellow-950/50'
                    : 'border-yellow-500/40 bg-yellow-950/30 hover:border-yellow-500/70'
                }`}
              >
                <div className="text-xs font-bold text-yellow-300">⚠️ 留意 (2.5%-5%)</div>
                <div className="text-xl font-black font-mono text-yellow-400">
                  {airUtilDist.tiers.medium.count} <span className="text-xs font-normal">節點</span>
                </div>
              </div>

              <div
                onClick={() => {
                  setSelectedAirUtilTier(selectedAirUtilTier === 'low' ? null : 'low');
                  setAirUtilSearchTerm('');
                }}
                className={`p-3 rounded-xl border space-y-1 cursor-pointer transition-all ${
                  selectedAirUtilTier === 'low'
                    ? 'border-emerald-500 ring-2 ring-emerald-500/50 bg-emerald-950/50'
                    : 'border-emerald-500/40 bg-emerald-950/30 hover:border-emerald-500/70'
                }`}
              >
                <div className="text-xs font-bold text-emerald-300">🟢 正常 (&lt; 2.5%)</div>
                <div className="text-xl font-black font-mono text-emerald-400">
                  {airUtilDist.tiers.low.count} <span className="text-xs font-normal">節點</span>
                </div>
              </div>
            </div>

            {showAirUtilList && (
              selectedAirUtilTier && airUtilDist.tiers[selectedAirUtilTier] ? (
                <div className="p-3 rounded-xl border border-slate-700/50 bg-slate-950/60 space-y-2">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-300">
                    <span>AirUtil TX 分級清單 ({selectedAirUtilTier.toUpperCase()})</span>
                    <button onClick={() => setSelectedAirUtilTier(null)} className="text-slate-400 hover:text-white"><X size={14} /></button>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1 text-xs font-mono">
                    {airUtilDist.tiers[selectedAirUtilTier].nodes.map((n: any) => (
                      <div key={n.nodeId} className="flex justify-between items-center p-1.5 rounded bg-slate-900/80">
                        <span className="truncate max-w-[180px]">{n.name} ({n.nodeId})</span>
                        <span className="text-yellow-400 font-bold">{n.tx}% TX</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-xl border border-slate-800 bg-slate-950/30 space-y-2">
                  <div className="text-xs font-bold text-slate-400 flex items-center gap-1">
                    <ShieldAlert size={14} className="text-yellow-400" /> 發射佔用率 Top 5 廣播大戶
                  </div>
                  <div className="space-y-1.5 text-xs font-mono">
                    {airUtilDist.topNodes.slice(0, 5).map((n: any, idx: number) => (
                      <div key={n.nodeId} className="flex justify-between items-center p-1.5 rounded bg-slate-900/60">
                        <span className="truncate max-w-[200px] text-slate-300">#{idx + 1} {n.name}</span>
                        <span className="text-yellow-400 font-bold">{n.tx}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* 🚀 4.2 ⚠️ 臨界弱訊號警告 (Edge Signal) */}
      <div className="grid grid-cols-1 gap-6">
        {/* ⚠️ 臨界弱訊號警告 */}
        {weakSignalAlerts && (
          <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
              <TitleHelpTooltip
                title="臨界弱訊號警告 (Edge Signal & SNR Loss)"
                icon={<AlertTriangle size={16} />}
                textColor="text-rose-400"
                darkMode={darkMode}
                dataExplanation="列出近 24 小時平均 SNR 低於 -10 dB 瀕臨斷連邊緣之弱訊號節點。"
                funcPurpose="早期預警收訊不良節點，提醒網管員調整天線或架設中繼防範斷連。"
              />
              <span className="text-[10px] text-slate-400 font-mono">近 24h (SNR &lt; -10 dB)</span>
            </div>

            <div className="p-3.5 rounded-xl border border-rose-500/30 bg-rose-950/20 flex justify-between items-center">
              <div>
                <div className="text-xs text-rose-300 font-bold">臨界弱訊號節點數</div>
                <div className="text-2xl font-black font-mono text-rose-400">
                  {weakSignalAlerts.count} <span className="text-xs text-slate-400 font-normal">節點瀕臨斷連</span>
                </div>
              </div>
              <button
                onClick={() => setShowWeakSignalList(!showWeakSignalList)}
                className="px-3 py-1.5 text-xs font-bold rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition-colors"
              >
                {showWeakSignalList ? '收起清單 ▲' : '點擊查看清單 ▼'}
              </button>
            </div>

            {showWeakSignalList ? (
              <div className="max-h-52 overflow-y-auto space-y-1.5 text-xs font-mono pr-1">
                {weakSignalAlerts.nodes.length === 0 ? (
                  <div className="text-slate-500 italic text-[11px] py-3 text-center">全網收訊良好，無臨界弱訊號節點</div>
                ) : (
                  weakSignalAlerts.nodes.map((n: any) => (
                    <div key={n.nodeId} className="flex justify-between items-center p-2 rounded bg-slate-950/40 border border-slate-800">
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-slate-200 truncate">{n.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{n.nodeId} ({n.packetCount} 包)</div>
                      </div>
                      <div className="text-right">
                        <span className="text-rose-400 font-bold">{n.avgSnr} dB</span>
                        <div className="text-[9px] text-slate-400">範圍: {n.minSnr}~{n.maxSnr}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-400 space-y-1">
                <div className="text-[11px] text-slate-400">若節點平均 SNR 低於 -10 dB，代表 LoRa 傳輸成功率低，易造成丟包與連線障礙。</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 🚀 5. 流量負載與活躍趨勢 (Node Activity & Ghost Trends) */}
      <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
          <TitleHelpTooltip
            title="節點活躍與幽靈趨勢 (Node Activity & Ghost)"
            icon={<TrendingUp size={16} />}
            textColor="text-cyan-500"
            darkMode={darkMode}
            dataExplanation="比較全網每日有傳送封包之 Active 節點數與未回報 GPS 座標之 Ghost 幽靈節點數。"
            funcPurpose="評估全網節點地圖覆蓋率，找出缺乏座標數據之節點並補強位置設置。"
          />
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

      {/* 🚀 5.1 🏆 最狂 MQTT 閘道排行榜 */}
      <div className="grid grid-cols-1 gap-6">
        {/* 最狂 MQTT 閘道排行榜 */}
        {topGateways.length > 0 && (
          <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
              <TitleHelpTooltip
                title="最狂 MQTT 閘道排行榜 (Top Gateways)"
                icon={<Award size={16} />}
                textColor="text-cyan-400"
                darkMode={darkMode}
                dataExplanation="統計經由 MQTT 閘道轉發之封包總數與直連涵蓋節點數。"
                funcPurpose="辨識全網核心連線樞紐 Gateway，評估網際網路橋接效能。"
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">近 {timeRange} 直連與經手流量</span>
                <button
                  onClick={() => setShowTopGatewaysList(!showTopGatewaysList)}
                  className="px-2.5 py-1 text-xs font-bold rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors"
                >
                  {showTopGatewaysList ? '收起清單 ▲' : '點擊查看清單 ▼'}
                </button>
              </div>
            </div>

            {showTopGatewaysList && (
              <div className="max-h-64 overflow-y-auto pr-1 space-y-2">
                {topGateways.slice(0, 7).map((gw: any, idx: number) => (
                  <div key={gw.gatewayId} className="p-2.5 rounded-xl border border-slate-800 bg-slate-950/40 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                        idx === 0 ? 'bg-amber-500 text-black' : idx === 1 ? 'bg-slate-300 text-black' : idx === 2 ? 'bg-amber-700 text-white' : 'bg-slate-800 text-slate-400'
                      }`}>{idx + 1}</span>
                      <div className="min-w-0">
                        <div className="font-bold truncate text-slate-200">{gw.name}</div>
                        <div className="text-[10px] font-mono text-slate-400">{gw.gatewayId}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-right font-mono">
                      <div>
                        <div className="text-cyan-400 font-bold">{gw.packetCount} 包</div>
                        <div className="text-[10px] text-slate-400">直連: {gw.directNodesCount} 節點</div>
                      </div>
                      {gw.avgSnr !== null && (
                        <div className="text-slate-300 text-[10px] bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">
                          {gw.avgSnr} dB
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 🚀 5.2 🔄 封包重複率與傳播效率 */}
      {duplicateStats && (
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-emerald-400">
              <Repeat size={16} /> 封包重複率與傳遞效率 (Transmission Efficiency)
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">近 {timeRange} 經手數據</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/20 space-y-1">
              <div className="text-xs text-emerald-300 font-bold">傳播效率評分 (Efficiency Score)</div>
              <div className="text-2xl font-black font-mono text-emerald-400">{duplicateStats.efficiencyScore} <span className="text-xs font-normal">/ 100</span></div>
              <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-2">
                <div className="bg-emerald-500 h-full transition-all" style={{ width: `${duplicateStats.efficiencyScore}%` }}></div>
              </div>
            </div>

            <div className="p-3.5 rounded-xl border border-purple-500/30 bg-purple-950/20 space-y-1">
              <div className="text-xs text-purple-300 font-bold">重複經手率 (Duplicate Rate)</div>
              <div className="text-2xl font-black font-mono text-purple-400">{duplicateStats.duplicateRatePct}%</div>
              <div className="text-[10px] text-slate-400">多 Gateway 經手重複率</div>
            </div>
          </div>

          <div className="p-3 rounded-xl border border-slate-800 bg-slate-950/40 flex justify-around text-center text-xs font-mono">
            <div>
              <div className="text-slate-400 text-[10px]">經手總封包數</div>
              <div className="font-bold text-slate-200 text-sm">{duplicateStats.totalPackets}</div>
            </div>
            <div className="border-r border-slate-800"></div>
            <div>
              <div className="text-slate-400 text-[10px]">獨立事件封包</div>
              <div className="font-bold text-cyan-400 text-sm">{duplicateStats.uniquePackets}</div>
            </div>
            <div className="border-r border-slate-800"></div>
            <div>
              <div className="text-slate-400 text-[10px]">重複經手封包</div>
              <div className="font-bold text-purple-400 text-sm">{duplicateStats.duplicatePackets}</div>
            </div>
          </div>
        </div>
      )}

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

      {/* 🚀 ⛅ 中央氣象署 (CWA) 精準地理配對比對 */}
      {(cwaNodeComparison || cwaComparison) && (
        <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
          {/* 標題列 */}
          <div className="flex flex-wrap justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800 gap-3">
            <h3 className="text-sm font-black uppercase tracking-wider flex items-center gap-2 text-cyan-400">
              <CloudSun size={18} /> ⛅ 台灣中央氣象署 (CWA) 精準地理配對比對
            </h3>
            <div className="flex items-center gap-3">
              {cwaNodeComparison && (
                <span className="text-[10px] text-slate-500 font-mono">
                  {cwaNodeComparison.totalNodes} 個節點已配對 · {cwaNodeComparison.cwaStationCount} 個官方氣象站
                </span>
              )}
              {cwaNodeComparison && (
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-0.5 rounded-lg text-[9px] font-bold">
                  <button
                    onClick={() => setCwaViewMode('region')}
                    className={`px-2 py-0.5 rounded transition-all ${cwaViewMode === 'region' ? 'bg-cyan-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                  >縣市分區</button>
                  <button
                    onClick={() => setCwaViewMode('nodes')}
                    className={`px-2 py-0.5 rounded transition-all ${cwaViewMode === 'nodes' ? 'bg-cyan-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                  >節點明細</button>
                  <button
                    onClick={() => setCwaViewMode('map')}
                    className={`px-2 py-0.5 rounded transition-all flex items-center gap-1 ${cwaViewMode === 'map' ? 'bg-cyan-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                  ><Map size={10} />配對地圖</button>
                </div>
              )}
            </div>
          </div>

          {/* 縣市分區彙整表 */}
          {cwaNodeComparison && cwaViewMode === 'region' && (
            <div className="space-y-3">
              <p className="text-[10px] text-slate-500">
                每個 Mesh 節點依 GPS 座標自動配對地理距離最近的 CWA 官方氣象站，再按縣市分組聚合 ΔT/ΔH。
                偏差 &gt; ±3°C 標記為異常（日照過熱 / 外殼熱積累）。
              </p>
              <div className={`rounded-xl border overflow-hidden ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
                <table className="w-full text-left text-xs">
                  <thead className={`${darkMode ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50 text-slate-500'} border-b ${darkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                    <tr className="text-[10px] font-black uppercase tracking-widest">
                      <th className="px-4 py-3">縣市</th>
                      <th className="px-4 py-3 text-center">節點數</th>
                      <th className="px-4 py-3 text-center">平均 ΔT (°C)</th>
                      <th className="px-4 py-3 text-center">最大 ΔT</th>
                      <th className="px-4 py-3 text-center">最小 ΔT</th>
                      <th className="px-4 py-3 text-center">平均 ΔH (%)</th>
                      <th className="px-4 py-3 text-center">異常節點</th>
                    </tr>
                  </thead>
                  <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                    {cwaNodeComparison.regionSummary.map((r) => (
                      <tr key={r.county} className={`transition-colors ${darkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}`}>
                        <td className={`px-4 py-3 font-bold ${darkMode ? 'text-slate-200' : 'text-slate-800'}`}>{r.county}</td>
                        <td className="px-4 py-3 text-center font-mono text-cyan-400">{r.nodeCount}</td>
                        <td className="px-4 py-3 text-center font-mono font-bold">
                          {r.avgDeltaTemp !== null ? (
                            <span className={r.avgDeltaTemp > 2 ? 'text-red-400' : r.avgDeltaTemp < -2 ? 'text-blue-400' : 'text-emerald-400'}>
                              {r.avgDeltaTemp > 0 ? '+' : ''}{r.avgDeltaTemp.toFixed(1)}
                            </span>
                          ) : <span className="text-slate-500">--</span>}
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-red-400">
                          {r.maxDeltaTemp !== null ? (r.maxDeltaTemp > 0 ? '+' : '') + r.maxDeltaTemp.toFixed(1) : '--'}
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-blue-400">
                          {r.minDeltaTemp !== null ? (r.minDeltaTemp > 0 ? '+' : '') + r.minDeltaTemp.toFixed(1) : '--'}
                        </td>
                        <td className="px-4 py-3 text-center font-mono text-slate-400">
                          {r.avgDeltaHum !== null ? (r.avgDeltaHum > 0 ? '+' : '') + r.avgDeltaHum : '--'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {r.anomalyCount > 0 ? (
                            <span className="px-2 py-0.5 bg-red-500/15 border border-red-500/30 text-red-400 rounded-full text-[10px] font-black">
                              ⚠️ {r.anomalyCount} 個 ({r.anomalyRate}%)
                            </span>
                          ) : (
                            <span className="text-emerald-500 text-[10px] font-bold">✓ 正常</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 節點明細表 */}
          {cwaNodeComparison && cwaViewMode === 'nodes' && (
            <div className={`rounded-xl border overflow-x-auto ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className={`${darkMode ? 'bg-slate-800/60 text-slate-400' : 'bg-slate-50 text-slate-500'} border-b ${darkMode ? 'border-slate-700' : 'border-slate-200'}`}>
                  <tr className="text-[10px] font-black uppercase tracking-widest">
                    <th className="px-4 py-3">節點</th>
                    <th className="px-4 py-3">節點氣溫</th>
                    <th className="px-4 py-3">比對氣象站</th>
                    <th className="px-4 py-3">距離</th>
                    <th className="px-4 py-3">官方氣溫</th>
                    <th className="px-4 py-3">ΔT</th>
                    <th className="px-4 py-3">ΔH</th>
                    <th className="px-4 py-3">天氣現況</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
                  {cwaNodeComparison.nodeComparisons
                    .sort((a, b) => Math.abs(b.deltaTemp ?? 0) - Math.abs(a.deltaTemp ?? 0))
                    .map((n) => (
                    <tr key={n.nodeId} className={`transition-colors ${n.anomaly ? (darkMode ? 'bg-red-950/20' : 'bg-red-50') : ''} ${darkMode ? 'hover:bg-slate-800/40' : 'hover:bg-slate-50'}`}>
                      <td className="px-4 py-3">
                        <div className="font-bold text-cyan-400 font-mono text-[11px]">{n.nodeId}</div>
                        <div className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{n.nodeName}</div>
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-amber-400">
                        {n.nodeTemp !== null ? `${Number(n.nodeTemp).toFixed(1)} °C` : '--'}
                      </td>
                      <td className="px-4 py-3">
                        <div className={`font-bold text-[11px] ${darkMode ? 'text-slate-200' : 'text-slate-800'}`}>{n.cwaStationName}</div>
                        <div className="text-[10px] text-slate-500">{n.cwaCounty} {n.cwaTown}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-400 text-[11px]">{Number(n.distanceKm).toFixed(1)} km</td>
                      <td className="px-4 py-3 font-mono font-bold text-blue-400">{n.cwaTemp !== null ? `${Number(n.cwaTemp).toFixed(1)} °C` : '--'}</td>
                      <td className="px-4 py-3 font-mono font-bold text-[12px]">
                        {n.deltaTemp !== null ? (
                          <span className={n.anomaly ? 'text-red-400' : n.deltaTemp > 0 ? 'text-orange-400' : 'text-emerald-400'}>
                            {n.deltaTemp > 0 ? '+' : ''}{Number(n.deltaTemp).toFixed(1)} °C
                            {n.anomaly && ' ⚠️'}
                          </span>
                        ) : '--'}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-400">
                        {n.deltaHum !== null ? (n.deltaHum > 0 ? '+' : '') + n.deltaHum + '%' : '--'}
                      </td>
                      <td className="px-4 py-3 text-[10px] text-slate-500">{n.cwaWeather || '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 🗺️ CWA 配對地圖 - 用獨立 Component 避免 Leaflet 構造函數衝突 */}
          {cwaNodeComparison && cwaViewMode === 'map' && (
            <CwaNodeMap
              key="cwa-node-map"
              nodes={cwaNodeComparison.nodeComparisons}
              regionSummary={cwaNodeComparison.regionSummary}
              darkMode={darkMode}
            />
          )}



          {/* 若 cwaNodeComparison 尚未就緒，退化顯示舊版 4 卡片 */}
          {!cwaNodeComparison && cwaComparison && (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className={`p-4 rounded-xl border flex flex-col gap-1 ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                <span className="text-[11px] font-bold text-slate-400">CWA 官方全台平均溫度</span>
                <div className="text-2xl font-black text-blue-400 font-mono">{cwaComparison.cwaAvgTemp} °C</div>
                <span className="text-[9px] text-slate-500">（含高山站，偏低）</span>
              </div>
              <div className={`p-4 rounded-xl border flex flex-col gap-1 ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                <span className="text-[11px] font-bold text-slate-400">Mesh 節點平均溫度</span>
                <div className="text-2xl font-black text-amber-400 font-mono">{cwaComparison.meshAvgTemp} °C</div>
                <span className="text-[9px] text-slate-500">BME280 / SHT31 感測器</span>
              </div>
              <div className={`p-4 rounded-xl border flex flex-col gap-1 ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                <span className="text-[11px] font-bold text-slate-400">全台平均 ΔT（粗估）</span>
                <div className={`text-2xl font-black font-mono ${cwaComparison.tempDelta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {cwaComparison.tempDelta > 0 ? '+' : ''}{cwaComparison.tempDelta} °C
                </div>
                <span className="text-[9px] text-slate-500">⚠️ 未排除高山站偏差</span>
              </div>
              <div className={`p-4 rounded-xl border flex flex-col gap-1 ${darkMode ? 'bg-slate-800/40 border-slate-700/50' : 'bg-slate-50 border-slate-200'}`}>
                <span className="text-[11px] font-bold text-slate-400">全台平均 ΔH</span>
                <div className="text-2xl font-black text-cyan-400 font-mono">
                  {cwaComparison.humidityDelta > 0 ? '+' : ''}{cwaComparison.humidityDelta} %
                </div>
                <span className="text-[9px] text-slate-500">Mesh vs CWA 濕度差</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 🚀 6. 全網與各縣市氣候環境遙測趨勢 (Aggregated Weather Sensors by County) */}
      <div className={`p-5 rounded-2xl border shadow-sm space-y-4 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b pb-3 border-slate-200 dark:border-slate-800 gap-3">
          <div className="flex items-center gap-2">
            <TitleHelpTooltip
              title="全網與各縣市環境氣候遙測趨勢"
              icon={<CloudSun size={18} />}
              textColor="text-emerald-500"
              darkMode={darkMode}
              dataExplanation="按台灣各縣市地理區域劃分，疊加監測 30 天環境溫度 (°C) 與濕度 (%) 歷史數據。"
              funcPurpose="即時掌握跨縣市微氣候變遷與網狀氣象終端觀測數據，支援氣候監測。"
            />
          </div>

          {/* 縣市複選下拉選單 (County Selector Dropdown) */}
          {countyWeatherTrends && countyWeatherTrends.counties && (
            <div className="relative">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsCountyDropdownOpen(!isCountyDropdownOpen)}
                  className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition-colors flex items-center gap-1.5"
                >
                  <MapPin size={14} />
                  <span>
                    看縣市 ({selectedCounties.length}/{countyWeatherTrends.counties.length})
                  </span>
                  <ChevronDown size={14} className={`transition-transform ${isCountyDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                <button
                  onClick={() => {
                    if (selectedCounties.length === countyWeatherTrends.counties.length) {
                      setSelectedCounties(['全網平均']);
                    } else {
                      setSelectedCounties(countyWeatherTrends.counties);
                    }
                  }}
                  className="px-2.5 py-1.5 text-[11px] font-bold rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  {selectedCounties.length === countyWeatherTrends.counties.length ? '只看全網' : '全選縣市'}
                </button>
              </div>

              {/* 下拉浮層 Popover */}
              {isCountyDropdownOpen && (
                <div className={`absolute right-0 mt-2 w-64 p-3 rounded-xl border shadow-xl z-50 space-y-2.5 ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'}`}>
                  <div className="flex justify-between items-center border-b pb-2 border-slate-700/50">
                    <span className="text-xs font-bold text-slate-300 flex items-center gap-1">
                      <Filter size={12} className="text-emerald-400" /> 選擇要顯示的縣市
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setSelectedCounties(countyWeatherTrends.counties)}
                        className="text-[10px] text-emerald-400 hover:underline px-1"
                      >
                        全選
                      </button>
                      <span className="text-slate-600 text-[10px]">|</span>
                      <button
                        onClick={() => setSelectedCounties([])}
                        className="text-[10px] text-slate-400 hover:underline px-1"
                      >
                        清空
                      </button>
                      <button
                        onClick={() => setIsCountyDropdownOpen(false)}
                        className="text-slate-400 hover:text-white ml-1"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="max-h-60 overflow-y-auto space-y-1 pr-1 text-xs">
                    {countyWeatherTrends.counties.map((c, idx) => {
                      const isSelected = isCountySelected(c);
                      const color = getCountyColor(c, idx);
                      return (
                        <label
                          key={c}
                          className={`flex items-center justify-between p-1.5 rounded cursor-pointer transition-colors ${
                            isSelected ? 'bg-emerald-500/10 text-slate-100' : 'hover:bg-slate-800/40 text-slate-400'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                const current = Array.isArray(selectedCounties) ? selectedCounties : [];
                                if (e.target.checked) {
                                  setSelectedCounties([...current, c]);
                                } else {
                                  setSelectedCounties(current.filter(x => x !== c));
                                }
                              }}
                              className="rounded border-slate-700 text-emerald-500 focus:ring-emerald-500/30"
                            />
                            <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ backgroundColor: color }}></span>
                            <span className="truncate">{c}</span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 縣市快速切換標籤庫 (County Pill Badges) */}
        {countyWeatherTrends && countyWeatherTrends.counties && (
          <div className="flex flex-wrap items-center gap-1.5 py-1">
            <span className="text-[11px] font-bold text-slate-400 flex items-center gap-1 mr-1">
              <Sparkles size={12} className="text-amber-400" /> 快速切換:
            </span>
            {countyWeatherTrends.counties.map((c, idx) => {
              const isSelected = isCountySelected(c);
              const color = getCountyColor(c, idx);
              return (
                <button
                  key={c}
                  onClick={() => {
                    const current = Array.isArray(selectedCounties) ? selectedCounties : [];
                    if (isSelected) {
                      setSelectedCounties(current.filter(x => x !== c));
                    } else {
                      setSelectedCounties([...current, c]);
                    }
                  }}
                  className={`px-2 py-0.5 text-[11px] font-medium rounded-full border transition-all flex items-center gap-1 ${
                    isSelected
                      ? 'bg-slate-800 text-slate-200 border-slate-700 shadow-sm'
                      : 'bg-slate-950/20 text-slate-500 border-slate-800/60 opacity-50 hover:opacity-100'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: isSelected ? color : '#64748b' }}></span>
                  <span>{c}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 雙折線圖 (Two Separate Line Charts side-by-side or stacked) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
          {/* 左圖: 🌡️ 溫度趨勢圖 (Temperature Chart °C) */}
          <div className="p-4 rounded-xl border border-amber-500/20 bg-slate-950/30 space-y-3">
            <div className="flex justify-between items-center border-b pb-2 border-slate-800">
              <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                <Sun size={14} /> 全網與各縣市環境溫度遙測趨勢 (°C)
              </h4>
              <span className="text-[10px] text-slate-400 font-mono">單位: °C</span>
            </div>

            <div className="h-64 w-full">
              {!countyWeatherTrends || countyWeatherTrends.tempTrends.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                  {loading ? '載入環境溫度數據中...' : '暫無溫度趨勢數據'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={countyWeatherTrends.tempTrends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                    <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                    <YAxis stroke="#f59e0b" tick={{ fontSize: 10 }} domain={['auto', 'auto']} unit="°C" />
                    <Tooltip contentStyle={customTooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }} />
                    {countyWeatherTrends.counties
                      .filter(c => isCountySelected(c))
                      .map((c, idx) => (
                        <Line
                          key={c}
                          type="monotone"
                          dataKey={c}
                          name={c}
                          stroke={getCountyColor(c, idx)}
                          strokeWidth={c === '全網平均' ? 3 : 1.8}
                          dot={{ r: 2 }}
                          connectNulls
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* 右圖: 💧 濕度趨勢圖 (Humidity Chart %) */}
          <div className="p-4 rounded-xl border border-blue-500/20 bg-slate-950/30 space-y-3">
            <div className="flex justify-between items-center border-b pb-2 border-slate-800">
              <h4 className="text-xs font-bold text-cyan-400 flex items-center gap-1.5">
                <CloudRain size={14} /> 全網與各縣市環境濕度遙測趨勢 (%)
              </h4>
              <span className="text-[10px] text-slate-400 font-mono">單位: %</span>
            </div>

            <div className="h-64 w-full">
              {!countyWeatherTrends || countyWeatherTrends.humTrends.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                  {loading ? '載入環境濕度數據中...' : '暫無濕度趨勢數據'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={countyWeatherTrends.humTrends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                    <XAxis dataKey="date" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                    <YAxis stroke="#3b82f6" tick={{ fontSize: 10 }} domain={['auto', 'auto']} unit="%" />
                    <Tooltip contentStyle={customTooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '8px' }} />
                    {countyWeatherTrends.counties
                      .filter(c => isCountySelected(c))
                      .map((c, idx) => (
                        <Line
                          key={c}
                          type="monotone"
                          dataKey={c}
                          name={c}
                          stroke={getCountyColor(c, idx)}
                          strokeWidth={c === '全網平均' ? 3 : 1.8}
                          dot={{ r: 2 }}
                          connectNulls
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 🚀 7. 全網封包流量與時段結構解析 (Traffic Distribution & Hourly Stacked Analytics) */}
      <div className={`p-5 rounded-2xl border shadow-sm space-y-6 ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex justify-between items-center border-b pb-3 border-slate-200 dark:border-slate-800">
          <TitleHelpTooltip
            title="全網封包流量與時段結構解析"
            icon={<BarChart3 size={18} />}
            textColor="text-cyan-400"
            darkMode={darkMode}
            dataExplanation="解析按日/按時段 Text, Position, Telemetry, Routing 封包流量與有效數據淨載荷比率。"
            funcPurpose="評估 Mesh 網路傳輸淨效率，監控控制開銷與維護封包比例以避免無效廣播。"
          />
          <span className="text-[10px] text-slate-400 font-mono">按日與時段 Stacked 流量分析</span>
        </div>

        {/* 上圖: 每日封包類別推疊圖 */}
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
            <BarChart3 size={14} className="text-cyan-400" /> 歷史每日封包類別流量 (Daily Traffic by Packet Type)
          </div>
          <div className="h-60 w-full">
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

        {/* 下方雙圖/延伸分析: 24h時段分佈熱區 + 網路傳輸效率結構 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2 border-t border-slate-800/60">
          {/* 左欄 (col-span-2): 🕒 24小時時段封包類型熱區分佈 */}
          <div className="lg:col-span-2 space-y-2">
            <div className="flex justify-between items-center">
              <TitleHelpTooltip
                title="24 小時各時段封包類型分佈熱區 (Hourly Breakdown)"
                icon={<Clock size={14} />}
                textColor="text-indigo-400"
                darkMode={darkMode}
                dataExplanation="統計 24 小時 (00:00 - 23:00) 全網每小時 Text, Telemetry, Position, Routing 封包堆疊數據。"
                funcPurpose="觀察全網一天中的通訊尖峰時段，判別是使用者訊息熱絡還是定時廣播產生的流量。"
              />
              <span className="text-[10px] text-slate-400 font-mono">00:00 - 23:00 尖峰時段</span>
            </div>

            <div className="h-56 w-full">
              {hourlyStacked.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 italic text-xs">
                  {loading ? '載入 24h 時段數據中...' : '暫無時段流量數據'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourlyStacked} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#1e293b' : '#f1f5f9'} />
                    <XAxis dataKey="hour" stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                    <YAxis stroke={darkMode ? '#64748b' : '#94a3b8'} tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={customTooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '6px' }} />
                    <Bar dataKey="text" name="訊息 (Text)" stackId="b" fill="#f59e0b" />
                    <Bar dataKey="telemetry" name="遙測 (Telemetry)" stackId="b" fill="#10b981" />
                    <Bar dataKey="position" name="位置 (Position)" stackId="b" fill="#3b82f6" />
                    <Bar dataKey="routing" name="路由 (Routing)" stackId="b" fill="#8b5cf6" />
                    <Bar dataKey="other" name="其他 (Other)" stackId="b" fill="#64748b" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* 右欄 (col-span-1): ⚡ 數據淨載荷 vs 網路維護開銷比 */}
          <div className="space-y-3 flex flex-col justify-between">
            <div className="border-b pb-2 border-slate-800">
              <TitleHelpTooltip
                title="數據淨載荷 vs 開銷結構 (Payload Efficiency)"
                icon={<Zap size={14} />}
                textColor="text-emerald-400"
                darkMode={darkMode}
                dataExplanation="區分【應用層實質數據 (Position+Telemetry+Text)】與【網路維護開銷 (Routing+Other)】，計算有效傳遞比率 (Data Efficiency %)。"
                funcPurpose="診斷 Mesh 網路的傳播效率。若開銷過高 (Routing > 50%)，代表頻寬主要花在維護拓撲而非傳送有效訊息，提醒調整廣播頻率與路由配置。"
              />
            </div>

            {(() => {
              const dataCount = traffic.reduce((acc, curr) => acc + (curr.Position || 0) + (curr.Telemetry || 0) + (curr.TextMessage || 0), 0);
              const overheadCount = traffic.reduce((acc, curr) => acc + (curr.Routing || 0) + (curr.Other || 0), 0);
              const totalCount = dataCount + overheadCount;
              const efficiencyPct = totalCount > 0 ? Math.round((dataCount / totalCount) * 100) : 0;
              const dataPct = totalCount > 0 ? Math.round((dataCount / totalCount) * 100) : 0;

              return (
                <div className="space-y-3">
                  <div className="p-3.5 rounded-xl border border-emerald-500/30 bg-emerald-950/20 space-y-1.5">
                    <div className="text-xs text-emerald-300 font-bold flex justify-between items-center">
                      <span>有效數據傳播比率</span>
                      <span className="text-emerald-400 font-mono text-base font-black">{efficiencyPct}%</span>
                    </div>
                    <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                      <div className="bg-emerald-500 h-full transition-all" style={{ width: `${efficiencyPct}%` }}></div>
                    </div>
                    <div className="text-[10px] text-slate-400 flex justify-between pt-0.5 font-mono">
                      <span>數據封包: {dataCount} 包 ({dataPct}%)</span>
                      <span>開銷: {overheadCount} 包</span>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-slate-800 bg-slate-950/40 space-y-2 text-xs font-mono">
                    <div className="text-slate-400 font-bold text-[11px] border-b border-slate-800/80 pb-1">
                      📊 網路封包組成結構 (Packet Breakdown)
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-blue-400">📍 位置廣播 (Position)</span>
                      <span className="font-bold text-slate-200">
                        {traffic.reduce((acc, curr) => acc + (curr.Position || 0), 0)} 包
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-emerald-400">🌡️ 氣象與遙測 (Telemetry)</span>
                      <span className="font-bold text-slate-200">
                        {traffic.reduce((acc, curr) => acc + (curr.Telemetry || 0), 0)} 包
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-amber-400">💬 文字訊息 (Text)</span>
                      <span className="font-bold text-slate-200">
                        {traffic.reduce((acc, curr) => acc + (curr.TextMessage || 0), 0)} 包
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-purple-400">🕸️ 路由控制 (Routing)</span>
                      <span className="font-bold text-slate-200">
                        {traffic.reduce((acc, curr) => acc + (curr.Routing || 0), 0)} 包
                      </span>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
