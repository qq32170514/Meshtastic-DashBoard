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
}

export default function TelemetryCharts({ nodeId, socket }: { nodeId: string, socket: any }) {
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
        grid: { display: false }, 
        ticks: { font: { size: 8 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } 
      },
      y: { ticks: { font: { size: 9 } } }
    }
  };

  const labels = history.map(h => new Date(h.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

  // 圖表 1: 電池與通道佔用率
  const batteryChartData = {
    labels,
    datasets: [
      { label: '電池 (%)', data: history.map(h => h.battery_level), borderColor: '#22c55e', backgroundColor: '#22c55e20', fill: true, tension: 0.4 },
      { label: 'Air Util (AC)', data: history.map(h => h.air_util_tx), borderColor: '#3b82f6', tension: 0.4 },
      { label: 'Channel Util (CU)', data: history.map(h => h.channel_utilization), borderColor: '#a855f7', tension: 0.4 },
    ]
  };

  // 圖表 2: 電力監測 (電壓)
  const powerChartData = {
    labels,
    datasets: [
      { label: '電壓 (V)', data: history.map(h => h.voltage), borderColor: '#f59e0b', backgroundColor: '#f59e0b20', fill: true, tension: 0.4 },
    ]
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

      {/* 象限 2: 右上 - 預留留白 (或放置統計摘要) */}
      <div className="h-56 col-start-2 row-start-1 flex items-center justify-center border border-dashed border-slate-100 rounded-xl">
        <span className="text-[9px] text-slate-300 font-bold uppercase tracking-[0.3em]">Analysis Node Ready</span>
      </div>

      {/* 象限 3: 左下 - 電力監測 */}
      <div className="h-56 col-start-1 row-start-2">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] font-black text-orange-500 uppercase tracking-widest">Q3. 設備電力監測 (Voltage)</span>
        </div>
        <Line data={powerChartData} options={commonOptions} />
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