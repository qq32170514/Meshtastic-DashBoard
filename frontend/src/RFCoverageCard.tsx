import React, { useState, useEffect, useMemo } from 'react';
import {
  Radio,
  Sliders,
  Maximize2,
  Minimize2,
  ExternalLink,
  Copy,
  Check,
  ChevronDown,
  RotateCw,
  Mountain,
  Signal,
  MapPin
} from 'lucide-react';

interface RFCoverageCardProps {
  node: {
    node_id: string;
    short_name?: string;
    long_name?: string;
    latitude?: number;
    longitude?: number;
    role?: string;
    hw_model?: string;
  };
  allNodes?: any[];
  darkMode?: boolean;
}

interface RFConfig {
  antennaHeight: number;       // 天線高出地面公尺 (AGL)
  antennaGain: number;         // 天線增益 (dBi)
  txPower: number;             // 發射功率 (dBm)
  frequency: number;           // 頻段 MHz (台灣預設 923)
  maxRange: number;            // 模擬演算半徑 (km, 預設 50)
  lat?: number;
  lng?: number;
}

export const RFCoverageCard: React.FC<RFCoverageCardProps> = ({ node, darkMode = false }) => {
  const [isOpen, setIsOpen] = useState(true);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [copiedCoords, setCopiedCoords] = useState(false);
  const [iframeKey, setIframeKey] = useState(1);

  // 讀取/儲存該節點專屬 RF 模擬參數
  const [config, setConfig] = useState<RFConfig>(() => {
    try {
      const saved = localStorage.getItem(`rf_cov_cfg_${node.node_id}`);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      antennaHeight: 5,        // 預設 5 米 (透天頂/陽台外伸)
      antennaGain: 5.8,        // 預設 5.8 dBi (標準玻璃鋼天線)
      txPower: 20,             // 預設 20 dBm (100 mW 台灣法規常用功率)
      frequency: 923,          // 台灣 LoRa 專用 923 MHz
      maxRange: 50,            // 模擬半徑 50 公里
      lat: node.latitude,
      lng: node.longitude
    };
  });

  // 當節點切換時自動同步
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`rf_cov_cfg_${node.node_id}`);
      if (saved) {
        setConfig(JSON.parse(saved));
        return;
      }
    } catch (e) {}
    setConfig(prev => ({
      ...prev,
      lat: node.latitude,
      lng: node.longitude
    }));
  }, [node.node_id, node.latitude, node.longitude]);

  // 保存設定至本機
  const saveConfig = (newCfg: RFConfig) => {
    setConfig(newCfg);
    try {
      localStorage.setItem(`rf_cov_cfg_${node.node_id}`, JSON.stringify(newCfg));
    } catch (e) {}
  };

  const centerLat = config.lat ?? node.latitude;
  const centerLng = config.lng ?? node.longitude;

  // 複製座標
  const handleCopyCoords = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!centerLat || !centerLng) return;
    const text = `${centerLat.toFixed(5)}, ${centerLng.toFixed(5)}`;
    navigator.clipboard.writeText(text);
    setCopiedCoords(true);
    setTimeout(() => setCopiedCoords(false), 2000);
  };

  // 計算 EIRP 等效全向輻射功率 (dBm & mW)
  const eirpMetrics = useMemo(() => {
    const pTx = config.txPower ?? 20;
    const gTx = config.antennaGain ?? 5.8;
    const eirpDbm = pTx + gTx - 0.5; // 扣除 0.5dB 饋線接頭損耗
    const eirpMilliwatts = Math.round(Math.pow(10, eirpDbm / 10));
    return {
      eirpDbm: Math.round(eirpDbm * 10) / 10,
      eirpMilliwatts
    };
  }, [config.txPower, config.antennaGain]);

  // 構造 Meshtastic 官方 Site Planner 原生深度傳遞網址 (符合 permalink.ts 契約)
  const officialSitePlannerUrl = useMemo(() => {
    if (!centerLat || !centerLng) return 'https://site.meshtastic.org/';

    // 官方 Site Planner 接收 tx_power 單位為瓦特 (Watts)
    // 14 dBm = 0.025W, 20 dBm = 0.1W, 22 dBm = 0.16W, 27 dBm = 0.5W, 30 dBm = 1.0W
    const watts = Math.pow(10, ((config.txPower || 20) - 30) / 10);
    const powerFormatted = watts < 0.1 ? Number(watts.toFixed(3)) : Number(watts.toFixed(2));
    const nodeLabel = encodeURIComponent(node.long_name || node.short_name || node.node_id);
    const maxRange = Math.min(150, Math.max(10, config.maxRange || 50));

    return `https://site.meshtastic.org/?lat=${centerLat}&lon=${centerLng}&name=${nodeLabel}&tx_power=${powerFormatted}&tx_freq=${config.frequency || 923}&tx_height=${config.antennaHeight || 5}&tx_gain=${config.antennaGain || 5.8}&rx_sensitivity=-130&rx_height=1&max_range=${maxRange}&color_scale=plasma&run=1`;
  }, [centerLat, centerLng, node, config.txPower, config.frequency, config.antennaHeight, config.antennaGain, config.maxRange]);

  // 快捷高度設定
  const heightPresets = [
    { label: '隨身 1.5m', val: 1.5 },
    { label: '陽台 5m', val: 5 },
    { label: '頂樓 12m', val: 12 },
    { label: '高塔 30m', val: 30 },
  ];

  // 快捷天線增益設定
  const gainPresets = [
    { label: '膠棒 2.5dBi', val: 2.5 },
    { label: '玻璃鋼 5.8dBi', val: 5.8 },
    { label: '基站 8dBi', val: 8.0 },
  ];

  // 快捷發射功率設定
  const powerPresets = [
    { label: '14dBm (25mW)', val: 14 },
    { label: '20dBm (100mW)', val: 20 },
    { label: '22dBm (160mW)', val: 22 },
  ];

  // 快捷模擬半徑設定
  const rangePresets = [
    { label: '30 km', val: 30 },
    { label: '50 km', val: 50 },
    { label: '80 km', val: 80 },
    { label: '100 km', val: 100 },
  ];

  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden transition-all ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      {/* 標題欄 */}
      <div
        className={`p-4 flex items-center justify-between cursor-pointer select-none transition-colors ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}
        onClick={() => setIsOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Radio size={17} className="text-purple-400 animate-pulse" />
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
            3D 地形電波覆蓋模擬 (Site Planner)
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-normal bg-purple-500/10 text-purple-400 border border-purple-500/20 flex items-center gap-1">
              <Mountain size={11} /> 官方 Longley-Rice ITM
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-normal bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              LORA 923MHZ
            </span>
          </h4>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={officialSitePlannerUrl}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-bold transition shadow-sm ${
              darkMode
                ? 'bg-purple-950/40 border-purple-800/60 text-purple-300 hover:bg-purple-900/60 hover:text-white'
                : 'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100'
            }`}
            title="在新分頁中直接開啟官方 Site Planner 並自動代入當前節點所有參數"
          >
            <ExternalLink size={12} />
            <span className="hidden sm:inline">在新分頁開啟</span>
          </a>
          <ChevronDown
            size={16}
            className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          />
        </div>
      </div>

      {isOpen && (
        <div className="p-4 pt-0 space-y-4 border-t border-slate-100 dark:border-slate-800/60">
          {/* 參數設定面板 */}
          <div className={`p-4 rounded-xl border space-y-4 mt-3 ${darkMode ? 'bg-slate-950/40 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-center justify-between border-b border-slate-700/40 pb-2">
              <span className="text-xs font-bold text-purple-400 flex items-center gap-1.5">
                <Sliders size={13} />
                天線高度、增益與發射條件設定 (自動同步至官方演算)
              </span>
              <span className="text-[11px] font-mono text-slate-400">
                等效輻射功率: <b className="text-amber-400">{eirpMetrics.eirpDbm} dBm</b> ({eirpMetrics.eirpMilliwatts} mW EIRP)
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* 1. 天線高度 */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  天線離地高程 (AGL, 米)
                </label>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input
                    type="number"
                    min="1"
                    max="300"
                    step="0.5"
                    value={config.antennaHeight}
                    onChange={e => saveConfig({ ...config, antennaHeight: Math.max(1, Number(e.target.value) || 1) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-purple-700'}`}
                  />
                  <span className="text-xs text-slate-400 font-mono">m</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {heightPresets.map(p => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => saveConfig({ ...config, antennaHeight: p.val })}
                      className={`text-[9px] px-1.5 py-0.5 rounded border transition font-mono ${
                        config.antennaHeight === p.val
                          ? 'bg-purple-600 text-white border-purple-500 font-bold'
                          : darkMode ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. 天線增益 */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  天線增益 (Antenna Gain)
                </label>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input
                    type="number"
                    min="0"
                    max="15"
                    step="0.1"
                    value={config.antennaGain}
                    onChange={e => saveConfig({ ...config, antennaGain: Math.max(0, Number(e.target.value) || 0) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-purple-700'}`}
                  />
                  <span className="text-xs text-slate-400 font-mono">dBi</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {gainPresets.map(p => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => saveConfig({ ...config, antennaGain: p.val })}
                      className={`text-[9px] px-1.5 py-0.5 rounded border transition font-mono ${
                        config.antennaGain === p.val
                          ? 'bg-purple-600 text-white border-purple-500 font-bold'
                          : darkMode ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. 發射功率 */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  發射功率 (TX Power)
                </label>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input
                    type="number"
                    min="0"
                    max="30"
                    step="1"
                    value={config.txPower}
                    onChange={e => saveConfig({ ...config, txPower: Math.min(30, Math.max(0, Number(e.target.value) || 0)) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-purple-700'}`}
                  />
                  <span className="text-xs text-slate-400 font-mono">dBm</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {powerPresets.map(p => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => saveConfig({ ...config, txPower: p.val })}
                      className={`text-[9px] px-1.5 py-0.5 rounded border transition font-mono ${
                        config.txPower === p.val
                          ? 'bg-purple-600 text-white border-purple-500 font-bold'
                          : darkMode ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. 模擬半徑範圍 */}
              <div>
                <label className="block text-[10px] font-bold text-slate-400 mb-1">
                  模擬半徑 (Simulation Range)
                </label>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <input
                    type="number"
                    min="10"
                    max="150"
                    step="5"
                    value={config.maxRange || 50}
                    onChange={e => saveConfig({ ...config, maxRange: Math.min(150, Math.max(10, Number(e.target.value) || 50)) })}
                    className={`w-full px-2.5 py-1.5 rounded-lg border text-xs font-mono font-bold ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-purple-700'}`}
                  />
                  <span className="text-xs text-slate-400 font-mono">km</span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {rangePresets.map(p => (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => saveConfig({ ...config, maxRange: p.val })}
                      className={`text-[9px] px-1.5 py-0.5 rounded border transition font-mono ${
                        (config.maxRange || 50) === p.val
                          ? 'bg-purple-600 text-white border-purple-500 font-bold'
                          : darkMode ? 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* GPS 座標顯示與快捷操作 */}
            <div className="flex flex-wrap items-center justify-between text-[11px] pt-2 border-t border-slate-700/40 gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-slate-400">📍 發射站座標:</span>
                {(!node.latitude || !node.longitude) ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="緯度"
                      value={config.lat ?? ''}
                      onChange={e => saveConfig({ ...config, lat: Number(e.target.value) || undefined })}
                      className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-slate-800'}`}
                    />
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="經度"
                      value={config.lng ?? ''}
                      onChange={e => saveConfig({ ...config, lng: Number(e.target.value) || undefined })}
                      className={`w-20 px-1.5 py-0.5 rounded border text-[11px] font-mono ${darkMode ? 'bg-slate-900 border-slate-700 text-purple-300' : 'bg-white border-slate-300 text-slate-800'}`}
                    />
                    <span className="text-amber-400 text-[10px]">(請手動輸入節點坐標)</span>
                  </div>
                ) : (
                  <span className="font-mono text-purple-300 font-bold flex items-center gap-1">
                    {centerLat?.toFixed(4)}, {centerLng?.toFixed(4)}
                    <button
                      type="button"
                      onClick={handleCopyCoords}
                      className="p-1 hover:bg-slate-700/50 rounded text-slate-400 hover:text-purple-300 transition"
                      title="複製座標"
                    >
                      {copiedCoords ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </button>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIframeKey(k => k + 1)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-lg border border-purple-500/50 text-purple-300 bg-purple-950/30 hover:bg-purple-900/50 transition font-bold shadow-sm"
                >
                  <RotateCw size={12} />
                  <span>同步參數並重新演算 (Re-run)</span>
                </button>
              </div>
            </div>
          </div>

          {/* 視圖呈現容器 */}
          <div className={`relative rounded-xl overflow-hidden border shadow-inner ${
            isFullScreen ? 'fixed inset-4 z-[9999] shadow-2xl h-auto' : 'h-[580px]'
          } ${darkMode ? 'border-slate-800 bg-slate-950' : 'border-slate-200 bg-slate-100'}`}>
            {centerLat && centerLng ? (
              <iframe
                key={iframeKey}
                src={officialSitePlannerUrl}
                className="w-full h-full border-0"
                title="Meshtastic Official Site Planner"
                allow="geolocation; clipboard-write; fullscreen"
                loading="lazy"
              />
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400 text-xs font-mono">
                📍 該節點尚未回報 GPS 座標，請先於上方輸入座標以載入官方 Site Planner
              </div>
            )}

            {/* 右上角浮動全螢幕按鈕 */}
            <div className="absolute top-3 right-3 z-[1000] flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setIsFullScreen(v => !v)}
                className={`p-1.5 rounded-lg border backdrop-blur-md transition shadow-md ${darkMode ? 'bg-slate-900/80 border-slate-700 text-slate-300 hover:text-white' : 'bg-white/90 border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                title={isFullScreen ? '結束全螢幕' : '全螢幕檢視'}
              >
                {isFullScreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            </div>
          </div>

          <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono flex-wrap gap-2 pt-1">
            <span className="flex items-center gap-1">
              <Mountain size={11} className="text-purple-400" />
              採用官方開源 WebAssembly (SPLAT! / Longley-Rice ITM 傳播模型) 結合真實 3D 數值高程 (DEM) 計算山脈地貌遮蔽
            </span>
            <span>修改上方發射條件後，點擊「同步參數並重新演算」即可即時重繪電波覆蓋熱區</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default RFCoverageCard;
