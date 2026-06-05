import React from 'react';
import { Pie } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

interface PacketStat {
  portnum: string;
  count: number;
  last_seen: string;
}

interface PacketTypePieChartProps {
  packetStats: PacketStat[];
}

const PacketTypePieChart: React.FC<PacketTypePieChartProps> = ({ packetStats }) => {
  const chartData = {
    labels: packetStats.map(stat => stat.portnum),
    datasets: [
      {
        label: '封包數量',
        data: packetStats.map(stat => stat.count),
        backgroundColor: [
          'rgba(255, 99, 132, 0.8)', // Red
          'rgba(54, 162, 235, 0.8)', // Blue
          'rgba(255, 206, 86, 0.8)', // Yellow
          'rgba(75, 192, 192, 0.8)', // Green
          'rgba(153, 102, 255, 0.8)', // Purple
          'rgba(255, 159, 64, 0.8)', // Orange
          'rgba(199, 199, 199, 0.8)', // Grey
          'rgba(83, 109, 254, 0.8)', // Indigo
          'rgba(255, 99, 255, 0.8)', // Pink
          'rgba(99, 255, 132, 0.8)', // Light Green
        ],
        borderColor: [
          'rgba(255, 99, 132, 1)',
          'rgba(54, 162, 235, 1)',
          'rgba(255, 206, 86, 1)',
          'rgba(75, 192, 192, 1)',
          'rgba(153, 102, 255, 1)',
          'rgba(255, 159, 64, 1)',
          'rgba(199, 199, 199, 1)',
          'rgba(83, 109, 254, 1)',
          'rgba(255, 99, 255, 1)',
          'rgba(99, 255, 132, 1)',
        ],
        borderWidth: 1,
      },
    ],
  };

  return (
    <div className="h-64 flex justify-center items-center">
      {packetStats.length > 0 ? <Pie data={chartData} options={{ responsive: true, maintainAspectRatio: false }} /> : <p className="text-slate-400 text-sm italic">無封包種類資料</p>}
    </div>
  );
};

export default PacketTypePieChart;