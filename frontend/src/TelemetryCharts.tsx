import { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { 
  Chart as ChartJS, 
  CategoryScale, 
  LinearScale, 
  PointElement, 
  LineElement, 
  Title, 
  Tooltip, 
  Legend,
  Filler
} from 'chart.js';
import { Smartphone } from 'lucide-react';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

interface Telemetry {
  timestamp: string;
  battery_level: number;
  voltage: number;
  snr: number;
  temperature?: number;
  humidity?: number;
  channel_utilization?: number;
  air_util_tx?: number;
  current?: number;
}

export default function TelemetryCharts({ nodeId, socket, node, darkMode }: { nodeId: string, socket: any, node?: any, darkMode?: boolean }) {
  const [history, setHistory] = useState<Telemetry[]>([]);

  useEffect(() => {
    // 抓取歷史數據
    fetch(`/api/telemetry?node_id=${encodeURIComponent(nodeId)}&limit=20`)
      .then(res => res.json())
      .then(data => setHistory(data.reverse()));

    // 監聽即時更新
    const handleUpdate = (data: any) => {
      if (data.node_id === nodeId) {
        setHistory(prev => [...prev, { 
          ...data, 
          voltage: data.voltage || 0,
          current: data.current || 0,
          air_util_tx: data.air_util_tx || 0,
          channel_utilization: data.channel_utilization || 0
        }].slice(-30));
      }
    };

    socket.on('telemetry_update', handleUpdate);
    return () => socket.off('telemetry_update', handleUpdate);
  }, [nodeId, socket]);

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { 
        position: 'top' as const,
        labels: { boxWidth: 10, font: { size: 10 } }
      }
    },
    scales: {
      x: { 
        display: true,
        grid: { color: 'rgba(148, 163, 184, 0.1)' }, 
        ticks: { color: '#64748b', font: { size: 9, weight: 'bold' }, maxRotation: 0, autoSkip: true, maxTicksLimit: 5 } 
      },
      y: { 
        grid: { color: 'rgba(148, 163, 184, 0.1)' },
        ticks: { color: '#64748b', font: { size: 9 } } 
      }
    }
  };

  const labels = history.map(h => {
    const dateStr = h.timestamp.includes(' ') ? h.timestamp.replace(' ', 'T') + 'Z' : h.timestamp;
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  // 圖表 1: 電池與通道佔用率
  const batteryChartData = {
    labels,
    datasets: [
      { label: '電池 (%)', data: history.map(h => h.battery_level), borderColor: '#22c55e', backgroundColor: '#22c55e20', fill: true, tension: 0.4 },
      { label: 'AU (%)', data: history.map(h => h.air_util_tx), borderColor: '#3b82f6', tension: 0.4 },
      { label: 'CU (%)', data: history.map(h => h.channel_utilization), borderColor: '#a855f7', tension: 0.4 },
    ]
  };

  // 圖表 2: 綜合電力監測 (電壓 + 電流) - 整合至 Q3
  const powerChartData = {
    labels,
    datasets: [
      { label: '電壓 (V)', data: history.map(h => h.voltage), borderColor: '#f59e0b', backgroundColor: '#f59e0b20', fill: true, tension: 0.4, yAxisID: 'y' },
      { label: '電流 (mA)', data: history.map(h => h.current), borderColor: '#10b981', backgroundColor: '#10b98110', fill: false, tension: 0.4, yAxisID: 'y1' },
    ]
  };

  // 針對電力圖表的特殊配置 (雙 Y 軸)
  const powerOptions = {
    ...commonOptions,
    scales: {
      ...commonOptions.scales,
      y: { ...commonOptions.scales.y, position: 'left' as const, title: { display: false } },
      y1: { 
        position: 'right' as const, 
        grid: { drawOnChartArea: false }, 
        ticks: { color: '#10b981', font: { size: 9 } },
        suggestedMin: 0
      }
    }
  };

  // 圖表 3: 環境監測
  const envChartData = {
    labels,
    datasets: [
      { label: '溫度 (°C)', data: history.map(h => h.temperature), borderColor: '#ef4444', tension: 0.4 },
      { label: '濕度 (%)', data: history.map(h => h.humidity), borderColor: '#06b6d4', tension: 0.4 },
    ]
  };

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-x-8 gap-y-10">
      {/* 象限 1: 左上 - 電池與通道 */}
      <div className="h-56 col-start-1 row-start-1">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] font-black text-blue-500 uppercase tracking-widest">Q1. 電池與通道佔用率</span>
        </div>
        <Line data={batteryChartData} options={commonOptions} />
      </div>

      {/* 象限 2: 右上 - 節點身份資訊 - 確保 node 更新時重繪 */}
      <div key={`identity-${node?.node_id}`} className={`h-56 col-start-2 row-start-1 p-5 rounded-xl border shadow-inner ${darkMode ? 'bg-slate-800/30 border-slate-700/50' : 'bg-slate-50 border-slate-100'}`}>
        <h5 className="text-[10px] font-black uppercase text-slate-500 mb-4 tracking-widest flex items-center gap-2">
          <Smartphone size={14} className="text-cyan-500" /> 節點身份資訊 Node Identity
        </h5>
        {node && node.node_id ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div className="flex flex-col border-b border-slate-100 dark:border-slate-800 pb-1">
              <span className="text-slate-400 text-[9px] uppercase font-bold">Long Name</span>
              <span className="font-bold truncate" title={node.long_name}>{node.long_name || 'Unknown'}</span>
            </div>
            <div className="flex flex-col border-b border-slate-100 dark:border-slate-800 pb-1">
              <span className="text-slate-400 text-[9px] uppercase font-bold">Short Name</span>
              <span className="font-bold">{node.short_name || '??'}</span>
            </div>
            <div className="flex flex-col border-b border-slate-100 dark:border-slate-800 pb-1">
              <span className="text-slate-400 text-[9px] uppercase font-bold">Hardware</span>
              <span className="font-bold truncate text-slate-500" title={node.hw_model}>{node.hw_model?.replace(/_/g, ' ') || 'UNKNOWN'}</span>
            </div>
            <div className="flex flex-col border-b border-slate-100 dark:border-slate-800 pb-1">
              <span className="text-slate-400 text-[9px] uppercase font-bold">Role</span>
              <span className="font-bold text-cyan-500">{node.role || 'CLIENT'}</span>
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-slate-400 italic">無身份資料</p>
        )}
      </div>

      {/* 象限 3: 左下 - 電力監測 */}
      <div className="h-56 col-start-1 row-start-2">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Q3. 設備綜合電力監測 (V / mA)</span>
        </div>
        <Line data={powerChartData} options={powerOptions} />
      </div>

      {/* 象限 4: 右下 - 環境遙測 */}
      <div className="h-56 col-start-2 row-start-2">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] font-black text-cyan-500 uppercase tracking-widest">Q4. 環境遙測趨勢 (Temp/Hum)</span>
        </div>
        <Line data={envChartData} options={commonOptions} />
      </div>
    </div>
  );
}