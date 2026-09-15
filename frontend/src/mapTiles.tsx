import React, { useState, useEffect, useRef } from 'react';
import { TileLayer } from 'react-leaflet';
import { Layers, Check } from 'lucide-react';

export interface TileProvider {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  badge: string;
  description: string;
  url: string;
  referenceUrl?: string; // 浮層標籤 (例如透明道路地名標籤)
  attribution: string;
  subdomains?: string | string[];
  maxZoom?: number;
}

export const MAP_TILE_PROVIDERS: Record<string, TileProvider> = {
  'esri-dark': {
    id: 'esri-dark',
    name: '戰術深色 (Dark Canvas)',
    shortName: '深色雷達',
    icon: '🌙',
    badge: '推薦',
    description: '深灰黑科技風格，高對比突顯節點、跳數與訊號連線 (無浮水印)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    referenceUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 19
  },
  'osm-hot': {
    id: 'osm-hot',
    name: '彩色街道 (OSM HOT)',
    shortName: '彩色街道',
    icon: '🗺️',
    badge: '經典',
    description: '全彩道路與地名標籤，Humanitarian OSM 志工鏡像服務 (無浮水印)',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles by <a href="https://www.hotosm.org/">HOT</a>',
    subdomains: 'abc',
    maxZoom: 19
  },
  'esri-satellite': {
    id: 'esri-satellite',
    name: '衛星空照 (Satellite)',
    shortName: '衛星影像',
    icon: '🛰️',
    badge: '真實',
    description: 'Esri 全球高解析空照圖含地名地界標註，適合地形與無線電通視分析',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    referenceUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, GeoEye',
    maxZoom: 19
  },
  'esri-topo': {
    id: 'esri-topo',
    name: '地形等高 (Topographic)',
    shortName: '地形等高',
    icon: '⛰️',
    badge: '地形',
    description: 'Esri 全球地形立體暈渲與等高線，山區中繼站架設必備',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Sources: USGS, FAO, NOAA',
    maxZoom: 19
  },
  'esri-light': {
    id: 'esri-light',
    name: '簡潔淺色 (Light Canvas)',
    shortName: '簡潔淺色',
    icon: '☀️',
    badge: '高對比',
    description: '極簡淺灰底高明度，適合白天或明亮環境 (無浮水印)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    referenceUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 19
  },
  'osm-fr': {
    id: 'osm-fr',
    name: '開放街道 (OSM France)',
    shortName: '開放街道',
    icon: '🇹🇼',
    badge: '開源',
    description: 'OSM 法國高速節點，原汁原味開放街道圖地貌',
    url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, OpenStreetMap France',
    subdomains: 'abc',
    maxZoom: 19
  }
};

export const TILE_STYLE_STORAGE_KEY = 'meshtastic_map_tile_style';

export function getSavedTileStyle(): string | null {
  try {
    const val = localStorage.getItem(TILE_STYLE_STORAGE_KEY);
    if (val && MAP_TILE_PROVIDERS[val]) return val;
  } catch (e) {
    // ignore
  }
  return null;
}

export function setSavedTileStyle(styleId: string): void {
  try {
    localStorage.setItem(TILE_STYLE_STORAGE_KEY, styleId);
    window.dispatchEvent(new CustomEvent('meshtastic-map-tile-change', { detail: styleId }));
  } catch (e) {
    // ignore
  }
}

export function getDefaultTileStyle(darkMode: boolean = true): string {
  const saved = getSavedTileStyle();
  if (saved) return saved;
  return darkMode ? 'esri-dark' : 'osm-hot';
}

interface AppTileLayerProps {
  tileStyle?: string;
  darkMode?: boolean;
}

/**
 * 通用安全地圖底圖元件
 * 自動處理雙層疊加（底圖 + 標籤層）、圖層切換 key 與合規授權標註，徹底杜絕 403 阻擋與浮水印問題
 */
export const AppTileLayer: React.FC<AppTileLayerProps> = ({ tileStyle, darkMode = true }) => {
  const styleId = tileStyle && MAP_TILE_PROVIDERS[tileStyle] 
    ? tileStyle 
    : getDefaultTileStyle(darkMode);

  const provider = MAP_TILE_PROVIDERS[styleId] || MAP_TILE_PROVIDERS['esri-dark'];

  return (
    <>
      <TileLayer
        key={`${provider.id}-base`}
        url={provider.url}
        attribution={provider.attribution}
        subdomains={provider.subdomains || 'abc'}
        maxZoom={provider.maxZoom || 19}
      />
      {provider.referenceUrl && (
        <TileLayer
          key={`${provider.id}-ref`}
          url={provider.referenceUrl}
          attribution=""
          subdomains={provider.subdomains || 'abc'}
          maxZoom={provider.maxZoom || 19}
        />
      )}
    </>
  );
};

interface MapStyleSelectorProps {
  currentStyle: string;
  onSelect: (styleId: string) => void;
  darkMode?: boolean;
  className?: string;
}

/**
 * 地圖風格切換毛玻璃浮動面板
 */
export const MapStyleSelector: React.FC<MapStyleSelectorProps> = ({
  currentStyle,
  onSelect,
  darkMode = true,
  className = ''
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeProvider = MAP_TILE_PROVIDERS[currentStyle] || MAP_TILE_PROVIDERS['esri-dark'];

  // 點擊外部自動關閉下拉選單
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleSelect = (id: string) => {
    onSelect(id);
    setSavedTileStyle(id);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative z-[1001] ${className}`}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-bold tracking-tight shadow-lg backdrop-blur-md transition-all ${
          isOpen
            ? 'ring-2 ring-cyan-500/60 border-cyan-500'
            : ''
        } ${
          darkMode
            ? 'bg-slate-900/90 border-slate-700/80 text-slate-200 hover:bg-slate-800 hover:text-white'
            : 'bg-white/95 border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900'
        }`}
        title="切換地圖圖資風格"
      >
        <Layers size={13} className="text-cyan-400" />
        <span className="text-[12px]">{activeProvider.icon}</span>
        <span className="hidden sm:inline font-mono">{activeProvider.shortName}</span>
      </button>

      {isOpen && (
        <div
          className={`absolute right-0 top-full mt-2 w-72 rounded-2xl border shadow-2xl p-2 backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-150 ${
            darkMode
              ? 'bg-slate-900/95 border-slate-700/80 text-slate-100 shadow-cyan-950/40'
              : 'bg-white/95 border-slate-200 text-slate-800 shadow-slate-300'
          }`}
        >
          <div className="px-2.5 py-1.5 mb-1.5 border-b border-slate-700/50 flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Layers size={11} className="text-cyan-400" /> 圖資底圖風格
            </span>
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              6 Styles
            </span>
          </div>

          <div className="space-y-1">
            {Object.values(MAP_TILE_PROVIDERS).map((p) => {
              const isSelected = p.id === currentStyle;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleSelect(p.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-xl transition-all flex items-center justify-between group ${
                    isSelected
                      ? darkMode
                        ? 'bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 shadow-sm'
                        : 'bg-cyan-50 border border-cyan-300 text-cyan-800 shadow-sm'
                      : darkMode
                        ? 'hover:bg-slate-800/80 text-slate-300 border border-transparent'
                        : 'hover:bg-slate-100 text-slate-600 border border-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-base leading-none">{p.icon}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold truncate">{p.name}</span>
                        <span
                          className={`text-[8px] font-black px-1 py-0.2 rounded uppercase ${
                            isSelected
                              ? 'bg-cyan-500 text-slate-950'
                              : 'bg-slate-700/50 text-slate-400'
                          }`}
                        >
                          {p.badge}
                        </span>
                      </div>
                      <p className="text-[9px] text-slate-400 truncate mt-0.5 max-w-[200px]">
                        {p.description}
                      </p>
                    </div>
                  </div>

                  {isSelected && (
                    <Check size={14} className="text-cyan-400 flex-shrink-0 ml-1.5" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
