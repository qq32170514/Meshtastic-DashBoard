import React, { useState, useEffect, useMemo } from 'react';
import {
  Sun,
  Battery,
  BatteryCharging,
  Compass,
  Sliders,
  RefreshCw,
  ChevronDown,
  AlertCircle,
  Info,
  Zap,
  Calendar,
  TrendingUp,
  Activity,
  Layers
} from 'lucide-react';

interface SolarForecastCardProps {
  node: {
    node_id: string;
    short_name?: string;
    long_name?: string;
    latitude?: number;
    longitude?: number;
    battery_level?: number;
    voltage?: number;
  };
  darkMode?: boolean;
}

interface SolarConfig {
  wattage: number;          // 太陽能板瓦數 (W), 例如 10
  declination: number;      // 傾角 (0=平放, 90=垂直), 預設 20
  azimuth: number;          // 方位角 (-180~180, 0=正南), 預設 0
  batteryCapacity: number;  // 鋰電池容量數值, 例如 2600
  batteryUnit: 'mAh' | 'Ah';// 單位, 預設 'mAh'
  batteryVoltage: number;   // 標稱電壓 (V), 預設 3.7 (鋰離子) 或 3.2 (磷酸鐵鋰)
  lat?: number;
  lng?: number;
}

export const SolarForecastCard: React.FC<SolarForecastCardProps> = ({ node, darkMode = false }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [chartMetric, setChartMetric] = useState<'power' | 'irradiance'>('power'); // 'power' = Watts, 'irradiance' = W/m²

  // 預設參數 (台灣常見：10W板, 傾角20度面南, 2600mAh 18650 3.7V 電池)
  const [config, setConfig] = useState<SolarConfig>(() => {
    try {
      const saved = localStorage.getItem(`solar_cfg_${node.node_id}`);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      wattage: 10,
      declination: 20,
      azimuth: 0,
      batteryCapacity: 2600,
      batteryUnit: 'mAh',
      batteryVoltage: 3.7,
      lat: node.latitude,
      lng: node.longitude
    };
  });

  const [isLoading, setIsLoading] = useState(false);
  const [forecastData, setForecastData] = useState<any | null>(() => {
    try {
      // 讀取當日本地暫存，避免重複消耗訪客每小時 12 次配額
      const cached = localStorage.getItem(`solar_cache_${node.node_id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        const cacheAgeHours = (Date.now() - (parsed.cachedAt || 0)) / (1000 * 3600);
        if (cacheAgeHours < 2) return parsed.data; // 2小時內可複用
      }
    } catch (e) {}
    return null;
  });

  const [rateLimit, setRateLimit] = useState<{ remaining: number; limit: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 當節點切換時，自動載入該節點對應的配置
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`solar_cfg_${node.node_id}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        setConfig({
          wattage: parsed.wattage ?? 10,
          declination: parsed.declination ?? 20,
          azimuth: parsed.azimuth ?? 0,
          batteryCapacity: parsed.batteryCapacity ?? 2600,
          batteryUnit: parsed.batteryUnit ?? 'mAh',
          batteryVoltage: parsed.batteryVoltage ?? 3.7,
          lat: parsed.lat ?? node.latitude,
          lng: parsed.lng ?? node.longitude
        });
      } else {
        setConfig({
          wattage: 10,
          declination: 20,
          azimuth: 0,
          batteryCapacity: 2600,
          batteryUnit: 'mAh',
          batteryVoltage: 3.7,
          lat: node.latitude,
          lng: node.longitude
        });
      }

      const cached = localStorage.getItem(`solar_cache_${node.node_id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        const cacheAgeHours = (Date.now() - (parsed.cachedAt || 0)) / (1000 * 3600);
        if (cacheAgeHours < 2) {
          setForecastData(parsed.data);
        } else {
          setForecastData(null);
        }
      } else {
        setForecastData(null);
      }
    } catch (e) {}
    setErrorMsg(null);
  }, [node.node_id, node.latitude, node.longitude]);

  // 儲存配置至 localStorage
  const saveConfig = (newCfg: SolarConfig) => {
    setConfig(newCfg);
    try {
      localStorage.setItem(`solar_cfg_${node.node_id}`, JSON.stringify(newCfg));
    } catch (e) {}
  };

  // 快捷預設情境 (角度)
  const applyPreset = (type: 'optimal' | 'flat' | 'vertical') => {
    let next: SolarConfig = { ...config };
    if (type === 'optimal') {
      next = { ...config, declination: 20, azimuth: 0 }; // 台灣最佳斜角朝南
    } else if (type === 'flat') {
      next = { ...config, declination: 0, azimuth: 0 };  // 平放朝天
    } else if (type === 'vertical') {
      next = { ...config, declination: 90, azimuth: 0 }; // 垂直立面掛壁
    }
    saveConfig(next);
  };

  // 快捷電池預設
  const applyBatteryPreset = (cap: number, unit: 'mAh' | 'Ah', volt: number) => {
    saveConfig({
      ...config,
      batteryCapacity: cap,
      batteryUnit: unit,
      batteryVoltage: volt
    });
  };

  // 前端本地 IP 直呼 Forecast.Solar
  const handleFetchForecast = async () => {
    const lat = config.lat ?? node.latitude;
    const lng = config.lng ?? node.longitude;

    if (!lat || !lng) {
      setErrorMsg('此節點無 GPS 座標，請先手動填入經緯度！');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    try {
      // 瓦數轉換為 kWp (例如 10W -> 0.01 kWp)
      const kwp = Math.max(0.001, Math.round((config.wattage / 1000) * 1000) / 1000);
      const dec = Math.round(config.declination);
      const az = Math.round(config.azimuth);
      const urlLat = Math.round(lat * 10000) / 10000;
      const urlLng = Math.round(lng * 10000) / 10000;

      const url = `https://api.forecast.solar/estimate/${urlLat}/${urlLng}/${dec}/${az}/${kwp}`;

      const res = await fetch(url);
      const json = await res.json();

      if (!res.ok || json.message?.type === 'error') {
        const txt = json.message?.text || `HTTP 錯誤 ${res.status}`;
        if (res.status === 429) {
          setErrorMsg('已達到 Forecast.Solar 本地 IP 每小時 12 次查詢上限，請稍後幾分鐘再試。');
        } else {
          setErrorMsg(`查詢失敗: ${txt}`);
        }
        return;
      }

      if (json.message?.ratelimit) {
        setRateLimit({
          remaining: json.message.ratelimit.remaining,
          limit: json.message.ratelimit.limit
        });
      }

      setForecastData(json.result);

      // 本地暫存 2 小時，避免重複消耗用戶本機配額
      try {
        localStorage.setItem(`solar_cache_${node.node_id}`, JSON.stringify({
          cachedAt: Date.now(),
          data: json.result
        }));
      } catch (e) {}

    } catch (err: any) {
      setErrorMsg(`網絡請求異常: ${err.message || err}`);
    } finally {
      setIsLoading(false);
    }
  };

  // 今日與明日發電總量
  const daySummary = useMemo(() => {
    if (!forecastData || !forecastData.watt_hours_day) return null;
    const days = Object.entries(forecastData.watt_hours_day);
    if (days.length === 0) return null;

    const todayEntry = days[0];
    const tomorrowEntry = days.length > 1 ? days[1] : null;

    // 計算今日最高峰值功率
    let peakTodayWatts = 0;
    let peakTodayHour = '';
    if (forecastData.watts) {
      Object.entries(forecastData.watts).forEach(([t, w]) => {
        const d = new Date(t);
        if (d.getDate() === new Date().getDate()) {
          const num = Number(w);
          if (num > peakTodayWatts) {
            peakTodayWatts = num;
            peakTodayHour = `${d.getHours()}:00`;
          }
        }
      });
    }

    return {
      todayDate: todayEntry[0],
      todayWh: Number(todayEntry[1]) || 0,
      tomorrowDate: tomorrowEntry ? tomorrowEntry[0] : null,
      tomorrowWh: tomorrowEntry ? Number(tomorrowEntry[1]) || 0 : null,
      peakTodayWatts,
      peakTodayHour
    };
  }, [forecastData]);

  // 電池儲能計算與 Meshtastic 續航估算
  const batteryStats = useMemo(() => {
    const cap = Math.max(1, config.batteryCapacity || 2600);
    const capAh = config.batteryUnit === 'mAh' ? cap / 1000 : cap;
    const volt = config.batteryVoltage || 3.7;
    const totalWh = Math.round(capAh * volt * 100) / 100;

    // Meshtastic 節點平均待機功耗約 0.65W (每日約 15.6 Wh)
    const nodeDailyWh = 15.6;
    const offGridDays = (totalWh / nodeDailyWh).toFixed(1);

    return {
      capAh,
      totalWh,
      offGridDays,
      label: `${config.batteryCapacity} ${config.batteryUnit} (${volt}V)`
    };
  }, [config.batteryCapacity, config.batteryUnit, config.batteryVoltage]);

  // 今日可充飽次數 / 回充率估算
  const rechargeStats = useMemo(() => {
    if (!daySummary || batteryStats.totalWh <= 0) return null;
    const times = daySummary.todayWh / batteryStats.totalWh;
    const percent = Math.round(times * 100);

    // 充飽所需尖峰日照小時數 (以 80% 峰值等效充電功率估算)
    const effectiveWatts = Math.max(0.5, daySummary.peakTodayWatts * 0.8);
    const chargeHoursNeeded = (batteryStats.totalWh / effectiveWatts).toFixed(1);

    return {
      times: Math.round(times * 10) / 10,
      percent,
      chargeHoursNeeded
    };
  }, [daySummary, batteryStats]);

  // Forecast.Solar 功率轉換為等效預期太陽照度 (W/m²)
  // 標準測試條件 (STC) = 1000 W/m² 下產生額定功率 (W)
  // 故 Irradiance (W/m²) = (即時瓦數 / 額定瓦數) * 1000
  const ratedWatts = Math.max(1, config.wattage || 10);

  // 整理未來每小時發電曲線數據 (支援發電瓦數 W 與等效日射強度 W/m²)
  const hourlyData = useMemo(() => {
    if (!forecastData || !forecastData.watts) return [];
    const entries = Object.entries(forecastData.watts);

    return entries.map(([timeStr, watts]) => {
      const d = new Date(timeStr);
      const hour = d.getHours();
      const month = d.getMonth() + 1;
      const date = d.getDate();
      const numWatts = Number(watts) || 0;
      const irradiance = Math.round((numWatts / ratedWatts) * 1000);

      return {
        timestamp: timeStr,
        label: `${month}/${date} ${String(hour).padStart(2, '0')}:00`,
        hour,
        watts: numWatts,
        irradiance,
        isToday: new Date().getDate() === date
      };
    });
  }, [forecastData, ratedWatts]);

  // 圖表刻度最大值
  const maxMetricVal = useMemo(() => {
    if (hourlyData.length === 0) return chartMetric === 'power' ? 10 : 1000;
    const maxVal = Math.max(...hourlyData.map(d => chartMetric === 'power' ? d.watts : d.irradiance));
    if (chartMetric === 'power') {
      return Math.max(config.wattage, Math.ceil(maxVal * 1.15));
    } else {
      return Math.max(1000, Math.ceil(maxVal * 1.15));
    }
  }, [hourlyData, chartMetric, config.wattage]);

  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden transition-all ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      {/* 標題欄 */}
      <div
        className={`p-4 flex items-center justify-between cursor-pointer select-none transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}
        onClick={() => setIsOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Sun size={17} className="text-amber-500 animate-spin-slow" />
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
            太陽能發電試算 (Solar Forecast)
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-bold border border-amber-500/20">
              本地 IP 直連
            </span>
          </h4>
        </div>
        <div className="flex items-center gap-3">
          {rateLimit && (
            <span className={`text-[10px] font-mono ${rateLimit.remaining <= 2 ? 'text-rose-400 font-bold' : 'text-slate-400'}`}>
              本地額度: {rateLimit.remaining}/{rateLimit.limit}
            </span>
          )}
          <ChevronDown size={14} className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {isOpen && (
        <div className={`p-4 border-t space-y-4 ${darkMode ? 'border-slate-800 text-slate-200' : 'border-slate-100 text-slate-700'}`}>
          {/* 參數設定表單 */}
          <div className={`p-4 rounded-xl border text-xs space-y-3.5 ${darkMode ? 'bg-slate-800/40 border-slate-700/60' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="font-bold flex items-center gap-1.5 text-amber-400 font-mono">
                <Sliders size={13} /> 太陽能板與儲能電池條件設定 (自動記憶)
              </span>
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-[10px] text-slate-400 mr-1">安裝角度:</span>
                <button
                  type="button"
                  onClick={() => applyPreset('optimal')}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${config.declination === 20 && config.azimuth === 0 ? 'bg-amber-500 text-white font-bold border-amber-400 shadow-sm' : darkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'}`}
                  title="傾角 20°, 正南 0° (台灣全年發電效益最高)"
                >
                  🇹🇼 最佳面南 (20°)
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('flat')}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${config.declination === 0 ? 'bg-amber-500 text-white font-bold border-amber-400 shadow-sm' : darkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'}`}
                  title="傾角 0° (車頂或水平屋頂平放)"
                >
                  平放 (0°)
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('vertical')}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${config.declination === 90 ? 'bg-amber-500 text-white font-bold border-amber-400 shadow-sm' : darkMode ? 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-100'}`}
                  title="傾角 90° (垂直壁掛或綁在鐵桿柱面)"
                >
                  垂直掛壁 (90°)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              {/* 1. 太陽能板功率 */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  面板標稱瓦數 (Watts)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={config.wattage}
                    onChange={e => saveConfig({ ...config, wattage: Number(e.target.value) || 10 })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                  />
                  <span className="text-xs font-mono text-slate-400">W</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {[5, 10, 20, 50].map(w => (
                    <button
                      key={w}
                      type="button"
                      onClick={() => saveConfig({ ...config, wattage: w })}
                      className={`text-[9px] px-1.5 py-0.5 rounded ${config.wattage === w ? 'bg-amber-500 text-white font-bold' : darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'}`}
                    >
                      {w}W
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. 傾角 Declination */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  仰角 / 傾角 (0°~90°)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    max="90"
                    value={config.declination}
                    onChange={e => saveConfig({ ...config, declination: Math.min(90, Math.max(0, Number(e.target.value))) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                  />
                  <span className="text-xs font-mono text-slate-400">度</span>
                </div>
                <span className="text-[10px] text-slate-400 block mt-1 truncate">
                  {config.declination === 0 ? '水平平躺朝天' : config.declination === 90 ? '垂直垂直掛壁' : `夾角 ${config.declination}°`}
                </span>
              </div>

              {/* 3. 方位角 Azimuth */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  朝向方位角 (-180°~180°)
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min="-180"
                    max="180"
                    value={config.azimuth}
                    onChange={e => saveConfig({ ...config, azimuth: Math.min(180, Math.max(-180, Number(e.target.value))) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                  />
                  <span className="text-xs font-mono text-slate-400">度</span>
                </div>
                <div className="flex gap-1 mt-1">
                  {[
                    { label: '南', az: 0 },
                    { label: '東南', az: -45 },
                    { label: '西南', az: 45 },
                    { label: '東', az: -90 },
                    { label: '西', az: 90 }
                  ].map(item => (
                    <button
                      key={item.az}
                      type="button"
                      onClick={() => saveConfig({ ...config, azimuth: item.az })}
                      className={`text-[9px] px-1 py-0.5 rounded ${config.azimuth === item.az ? 'bg-amber-500 text-white font-bold' : darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'}`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. 鋰電池容量自訂 (新功能: mAh/Ah 單位與預設) */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1 flex items-center justify-between">
                  <span>儲能電池容量大小</span>
                  <span className="text-[10px] text-cyan-400 font-mono">
                    {batteryStats.totalWh} Wh
                  </span>
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={config.batteryCapacity}
                    onChange={e => saveConfig({ ...config, batteryCapacity: Math.max(1, Number(e.target.value) || 2600) })}
                    className={`w-full px-2 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-900'}`}
                  />
                  <select
                    value={config.batteryUnit}
                    onChange={e => saveConfig({ ...config, batteryUnit: e.target.value as 'mAh' | 'Ah' })}
                    className={`px-1.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-cyan-300' : 'bg-white border-slate-300 text-cyan-600'}`}
                  >
                    <option value="mAh">mAh</option>
                    <option value="Ah">Ah</option>
                  </select>
                </div>
                <div className="flex gap-1 mt-1 flex-wrap">
                  <button
                    type="button"
                    onClick={() => applyBatteryPreset(2600, 'mAh', 3.7)}
                    className={`text-[9px] px-1 py-0.5 rounded ${config.batteryCapacity === 2600 && config.batteryUnit === 'mAh' ? 'bg-cyan-500 text-white font-bold' : darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'}`}
                    title="標準 18650 鋰電池 (約 9.6 Wh)"
                  >
                    18650 (2.6Ah)
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBatteryPreset(5000, 'mAh', 3.7)}
                    className={`text-[9px] px-1 py-0.5 rounded ${config.batteryCapacity === 5000 && config.batteryUnit === 'mAh' ? 'bg-cyan-500 text-white font-bold' : darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'}`}
                    title="大容量 21700 鋰電池 (約 18.5 Wh)"
                  >
                    21700 (5Ah)
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBatteryPreset(10, 'Ah', 3.2)}
                    className={`text-[9px] px-1 py-0.5 rounded ${config.batteryCapacity === 10 && config.batteryUnit === 'Ah' ? 'bg-cyan-500 text-white font-bold' : darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-200 text-slate-600'}`}
                    title="10Ah 磷酸鐵鋰組 (約 32 Wh)"
                  >
                    10Ah 電箱
                  </button>
                </div>
              </div>
            </div>

            {/* GPS 座標顯示與自訂 & 試算按鈕 */}
            <div className="flex flex-wrap items-center justify-between text-[11px] pt-2 border-t border-slate-700/40 gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-slate-400">📍 測算坐標:</span>
                {(!node.latitude || !node.longitude) ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="緯度 (Lat)"
                      value={config.lat ?? ''}
                      onChange={e => saveConfig({ ...config, lat: Number(e.target.value) || undefined })}
                      className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${darkMode ? 'bg-slate-900 border-slate-700 text-cyan-300' : 'bg-white border-slate-300 text-slate-800'}`}
                    />
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="經度 (Lng)"
                      value={config.lng ?? ''}
                      onChange={e => saveConfig({ ...config, lng: Number(e.target.value) || undefined })}
                      className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${darkMode ? 'bg-slate-900 border-slate-700 text-cyan-300' : 'bg-white border-slate-300 text-slate-800'}`}
                    />
                    <span className="text-amber-400 text-[10px]">(節點無GPS，請自填)</span>
                  </div>
                ) : (
                  <b className="font-mono text-cyan-400 font-normal">
                    {Number(config.lat ?? node.latitude).toFixed(4)}, {Number(config.lng ?? node.longitude).toFixed(4)}
                  </b>
                )}
              </div>

              <button
                type="button"
                onClick={handleFetchForecast}
                disabled={isLoading}
                className={`px-4 py-1.5 rounded-lg font-bold text-xs flex items-center gap-1.5 transition-all shadow-md ${
                  isLoading
                    ? 'bg-amber-500/50 text-white cursor-not-allowed'
                    : 'bg-amber-500 hover:bg-amber-400 text-slate-950 hover:shadow-amber-500/25 active:scale-95'
                }`}
              >
                <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
                {isLoading ? '正在向 Forecast.Solar 試算中...' : '開始本地試算'}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2">
              <AlertCircle size={15} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* 試算結果呈現 */}
          {daySummary && (
            <div className="space-y-4 animate-fadeIn">
              {/* 今日與明日指標大卡片 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {/* 今日預估發電量 */}
                <div className={`p-3 rounded-xl border ${darkMode ? 'bg-slate-800/60 border-slate-700/80' : 'bg-amber-50/50 border-amber-200/60'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold text-amber-500 uppercase tracking-wider flex items-center gap-1">
                      <Sun size={12} /> 今日預估發電
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">{daySummary.todayDate}</span>
                  </div>
                  <div className="text-xl font-black font-mono text-amber-400">
                    {daySummary.todayWh} <span className="text-xs font-normal text-slate-400">Wh</span>
                  </div>
                  {rechargeStats && (
                    <div className="text-[10px] text-cyan-400 font-mono mt-1 flex items-center gap-1">
                      <BatteryCharging size={11} className="text-emerald-400" />
                      {rechargeStats.times >= 1.0 ? (
                        <span>充飽 {config.batteryCapacity}{config.batteryUnit}: <b>{rechargeStats.times} 次</b></span>
                      ) : (
                        <span>今日回充電量: <b>約 {rechargeStats.percent}%</b></span>
                      )}
                    </div>
                  )}
                </div>

                {/* 明日預估發電量 */}
                <div className={`p-3 rounded-xl border ${darkMode ? 'bg-slate-800/60 border-slate-700/80' : 'bg-sky-50/50 border-sky-200/60'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1">
                      <Calendar size={12} /> 明日預估發電
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">{daySummary.tomorrowDate || '--'}</span>
                  </div>
                  <div className="text-xl font-black font-mono text-sky-400">
                    {daySummary.tomorrowWh !== null ? daySummary.tomorrowWh : '--'} <span className="text-xs font-normal text-slate-400">Wh</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-1">
                    {daySummary.tomorrowWh !== null && (
                      daySummary.tomorrowWh >= daySummary.todayWh
                        ? <span className="text-emerald-400">較今日 ↗ 增加 {daySummary.tomorrowWh - daySummary.todayWh} Wh</span>
                        : <span className="text-amber-400">較今日 ↘ 減少 {daySummary.todayWh - daySummary.tomorrowWh} Wh</span>
                    )}
                  </div>
                </div>

                {/* 今日尖峰功率 */}
                <div className={`p-3 rounded-xl border ${darkMode ? 'bg-slate-800/60 border-slate-700/80' : 'bg-emerald-50/50 border-emerald-200/60'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1">
                      <TrendingUp size={12} /> 今日尖峰功率
                    </span>
                  </div>
                  <div className="text-xl font-black font-mono text-emerald-400">
                    {daySummary.peakTodayWatts} <span className="text-xs font-normal text-slate-400">Watts</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-1">
                    預計高峰於 <b className="text-white">{daySummary.peakTodayHour || '--'}</b>
                  </div>
                </div>

                {/* 電池離網支援能力 */}
                <div className={`p-3 rounded-xl border ${darkMode ? 'bg-slate-800/60 border-slate-700/80' : 'bg-purple-50/50 border-purple-200/60'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1">
                      <Battery size={12} /> 節點離網續航
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">~0.65W耗電</span>
                  </div>
                  <div className="text-xl font-black font-mono text-purple-400">
                    {batteryStats.offGridDays} <span className="text-xs font-normal text-slate-400">天</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-1 truncate">
                    充滿需約 <b className="text-cyan-300">{rechargeStats?.chargeHoursNeeded || '--'}</b> 小時尖峰日照
                  </div>
                </div>
              </div>

              {/* 48 小時發電與照度曲線長條圖 */}
              <div className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                    <Activity size={14} className="text-cyan-400" />
                    48 小時預估發電走勢曲線 ({chartMetric === 'power' ? '瓦數 Watts' : '受光日射照度 W/m²'})
                  </span>

                  <div className="flex items-center gap-2">
                    {/* 切換單位模式 (瓦數 / 輻照度) */}
                    <div className="flex items-center rounded-lg p-0.5 border border-slate-700 bg-slate-900/80 text-[10px] font-mono">
                      <button
                        type="button"
                        onClick={() => setChartMetric('power')}
                        className={`px-2 py-0.5 rounded transition-all ${chartMetric === 'power' ? 'bg-amber-500 text-slate-950 font-bold shadow' : 'text-slate-400 hover:text-white'}`}
                      >
                        ⚡ 發電功率 (W)
                      </button>
                      <button
                        type="button"
                        onClick={() => setChartMetric('irradiance')}
                        className={`px-2 py-0.5 rounded transition-all ${chartMetric === 'irradiance' ? 'bg-cyan-500 text-slate-950 font-bold shadow' : 'text-slate-400 hover:text-white'}`}
                        title="將輸出瓦數反推為板面受光等效太陽輻照度 (W/m²)"
                      >
                        ☀️ 太陽照度 (W/m²)
                      </button>
                    </div>

                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-500 inline-block"></span>今日</span>
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-cyan-400 inline-block"></span>明日</span>
                    </div>
                  </div>
                </div>

                {/* 視覺化長條圖容器 */}
                <div className="h-44 w-full flex items-end gap-1 pt-6 pb-2 overflow-x-auto select-none border-b border-slate-700/40 relative">
                  {/* 標準全日照 1000 W/m² 參考線 (當為 irradiance 模式時) */}
                  {chartMetric === 'irradiance' && (
                    <div className="absolute top-2 right-2 text-[9px] font-mono text-amber-500/80 flex items-center gap-1">
                      <span>── 標準晴空照度: 1,000 W/m²</span>
                    </div>
                  )}

                  {hourlyData.map((d, idx) => {
                    const currentVal = chartMetric === 'power' ? d.watts : d.irradiance;
                    const heightPercent = maxMetricVal > 0 ? Math.min(100, (currentVal / maxMetricVal) * 100) : 0;
                    const isZero = currentVal === 0;

                    return (
                      <div
                        key={idx}
                        className="flex-1 min-w-[16px] h-full flex flex-col justify-end items-center group relative cursor-pointer"
                      >
                        {/* Hover Tooltip */}
                        <div className="hidden group-hover:flex flex-col absolute bottom-full mb-2 bg-slate-950 text-white text-[10px] font-mono p-2 rounded-lg shadow-2xl border border-slate-700 z-50 whitespace-nowrap pointer-events-none">
                          <span className="font-bold text-cyan-300">{d.label}</span>
                          <span>預估發電: <b className="text-amber-400">{d.watts} W</b></span>
                          <span>等效照度: <b className="text-cyan-400">{d.irradiance} W/m²</b></span>
                          <span className="text-slate-400">全日照比例: {((d.irradiance / 1000) * 100).toFixed(0)}%</span>
                          {config.batteryVoltage && (
                            <span className="text-emerald-400">回充電流約: {Math.round((d.watts / config.batteryVoltage) * 1000)} mA</span>
                          )}
                        </div>

                        {/* 長條柱體 */}
                        <div
                          style={{ height: `${Math.max(isZero ? 2 : 6, heightPercent)}%` }}
                          className={`w-full rounded-t transition-all ${
                            isZero
                              ? 'bg-slate-700/20'
                              : d.isToday
                                ? 'bg-gradient-to-t from-amber-600 to-amber-400 group-hover:from-amber-500 group-hover:to-amber-300 shadow-sm shadow-amber-500/20'
                                : 'bg-gradient-to-t from-cyan-600 to-cyan-400 group-hover:from-cyan-500 group-hover:to-cyan-300 shadow-sm shadow-cyan-500/20'
                          }`}
                        />

                        {/* X 軸小時標示 (每 3 小時標一次，或在日照關鍵時段標) */}
                        {d.hour % 3 === 0 && (
                          <span className="text-[9px] font-mono text-slate-500 mt-1">
                            {String(d.hour).padStart(2, '0')}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-between items-center text-[10px] text-slate-400 mt-2 font-mono flex-wrap gap-2">
                  <span>
                    💡 橫軸為時段 (00~23時)，高度反映即時
                    {chartMetric === 'power' ? '發電瓦數 (W)' : '等效受光日射強度 (W/m²)'}
                  </span>
                  <span>由訪客瀏覽器本地 IP 提供查詢 · 2小時智慧暫存</span>
                </div>
              </div>
            </div>
          )}

          {!daySummary && !isLoading && (
            <div className={`p-8 text-center rounded-xl border border-dashed ${darkMode ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'} text-xs font-mono`}>
              <Sun size={32} className="mx-auto mb-2 opacity-30 text-amber-500 animate-pulse" />
              <p className="font-bold text-slate-400">自訂上方太陽能板瓦數、傾角與鋰電池容量後，點擊「開始本地試算」</p>
              <p className="text-[10px] text-slate-500 mt-1.5">
                完全免費，透過瀏覽器直接向 Forecast.Solar 查詢，每小時享有 12 次本地 IP 查詢配額 (內建 2 小時暫存快取)
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SolarForecastCard;
