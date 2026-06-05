import { useEffect, useState, useMemo, useRef } from 'react';
import { io } from 'socket.io-client';
import { Activity, Star, Radio, Search, Clock, Zap, Map as MapIcon, List, BarChart3, Info, Database, Signal, HardDrive, Smartphone, Battery, ZapOff, PieChart, X } from 'lucide-react';
import NodeMap from './NodeMap'; // 兩者都在 src 下，保持不變
import TelemetryCharts from './TelemetryCharts';
import PacketTypePieChart from './PacketTypePieChart';

export interface Node {
  node_id: string;
  long_name: string;
  short_name: string;
  last_seen: string;
  is_favorite: number;
  role?: string;
  latitude?: number;
  longitude?: number;
  last_topic?: string;
  battery_level?: number;
  voltage?: number;
  snr?: number;
  rssi?: number;
  air_util_tx?: number;
  channel_utilization?: number;
  temperature?: number;
  humidity?: number;
}

interface Packet {
  from: string;
  portnum: string;
  topic: string;
  time: string;
  snr?: number;
  rssi?: number;
  gateway_id?: string;
}

interface GatewayStat {
  gateway_id: string;
  count: number;
  last_seen: string;
  hop_start?: number;
  hop_limit?: number;
}

interface PacketStat {
  portnum: string;
  count: number;
  last_seen: string;
}

const socket = io(); // 使用 Vite Proxy

function App() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'nodes' | 'favorites' | 'details' | 'map' | 'logs'>('nodes');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [mapShowFavoritesOnly, setMapShowFavoritesOnly] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false); // 控制漂浮詳情頁
  const [gatewayStats, setGatewayStats] = useState<GatewayStat[]>([]);
  const [packetStats, setPacketStats] = useState<PacketStat[]>([]);
  const [nodePackets, setNodePackets] = useState<Packet[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedNodeIdRef = useRef<string | null>(null);

  // 計算過濾後的列表
  const filteredNodes = useMemo(() => {
    return nodes
      .filter(n => 
        n.node_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (n.long_name && n.long_name.toLowerCase().includes(searchQuery.toLowerCase()))
      );
  }, [nodes, searchQuery]);

  const favoriteNodes = useMemo(() => {
    return nodes.filter(n => n.is_favorite === 1);
  }, [nodes]);

  useEffect(() => {
    // 1. 初始抓取節點狀態
    fetch('/api/node-status')
      .then(res => res.json())
      .then(data => setNodes(data));
    
    // 2. 監聽 MQTT 狀態
    socket.on('mqtt_status', (data) => setMqttConnected(data.connected));

    // 3. 監聽節點更新事件
    socket.on('node_seen', (updatedNode: Partial<Node>) => {
      setNodes(prev => {
        const index = prev.findIndex(n => n.node_id === updatedNode.node_id);
        if (index !== -1) {
          const newNodes = [...prev];
          newNodes[index] = { ...prev[index], ...updatedNode };
          return [...newNodes];
        }
        return [updatedNode as Node, ...prev];
      });
    });

    // 監聽原始封包
    socket.on('raw_packet', (packet) => {
      setPackets(prev => [packet, ...prev].slice(0, 50));
      // 如果當前收到的封包來自正在檢視的節點，則同步更新詳情頁列表
      if (selectedNodeIdRef.current && packet.from === selectedNodeIdRef.current) {
        setNodePackets(prev => [packet, ...prev].slice(0, 20));
      }
    });

    // 4. 監聽遙測更新 (更新列表中的數據)
    socket.on('telemetry_update', (data) => {
      setNodes(prev => prev.map(n => n.node_id === data.node_id ? { 
        ...n, 
        battery_level: data.battery_level, 
        voltage: data.voltage,
        snr: data.snr,
        rssi: data.rssi,
        air_util_tx: data.air_util_tx,
        channel_utilization: data.channel_utilization,
        temperature: data.temperature,
        humidity: data.humidity
      } : n));
    });

    return () => {
      socket.off('mqtt_status');
      socket.off('node_seen');
      socket.off('raw_packet');
    };
  }, []);

  // 當選擇變動時同步更新 selectedNode 物件
  useEffect(() => {
    const node = nodes.find(n => n.node_id === selectedNodeId);
    selectedNodeIdRef.current = selectedNodeId;
    if (node) setSelectedNode(node);

    if (selectedNodeId) {
      // 抓取該節點的額外統計資訊 (原本 index.html 的深度功能)
      fetch(`/api/node/${encodeURIComponent(selectedNodeId)}/gateways`)
        .then(res => res.json())
        .then(data => setGatewayStats(data))
        .catch(() => setGatewayStats([]));

      fetch(`/api/node/${encodeURIComponent(selectedNodeId)}/packet-stats`)
        .then(res => res.json())
        .then(data => setPacketStats(data))
        .catch(() => setPacketStats([]));

      fetch(`/api/node/${encodeURIComponent(selectedNodeId)}/packets?limit=20`)
        .then(res => res.json())
        .then(data => setNodePackets(data.map((p: any) => ({
          from: p.node_id,
          portnum: p.portnum,
          topic: p.topic,
          time: new Date(p.timestamp).toLocaleTimeString(),
          snr: p.snr,
          rssi: p.rssi,
          gateway_id: p.gateway_id
        }))))
        .catch(() => setNodePackets([]));
    }
  }, [selectedNodeId, nodes]);

  // 切換最愛狀態
  const toggleFavorite = async (nodeId: string, currentStatus: number) => {
    const newStatus = currentStatus === 1 ? 0 : 1;
    try {
      const res = await fetch(`/api/node/${encodeURIComponent(nodeId)}/favorite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_favorite: newStatus })
      });
      if (res.ok) {
        setNodes(prev => prev.map(n => n.node_id === nodeId ? { ...n, is_favorite: newStatus } : n));
      }
    } catch (err) {
      console.error("Failed to toggle favorite", err);
    }
  };

  // 開啟漂浮詳情頁的處理
  const handleShowModal = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setIsDetailModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Top Navbar */}
      <nav className="bg-[#1e293b] text-white px-6 py-3 flex justify-between items-center shadow-lg border-b border-slate-700">
        <div className="flex items-center gap-3">
          <Radio className={mqttConnected ? "text-cyan-400 animate-pulse" : "text-slate-500"} size={24} />
          <span className="text-lg font-black tracking-widest uppercase">Meshtastic <span className="text-cyan-400">Radar</span></span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[10px] font-bold ${mqttConnected ? 'border-cyan-500/50 text-cyan-400 bg-cyan-500/10' : 'border-red-500/50 text-red-400 bg-red-500/10'}`}>
            <div className={`w-2 h-2 rounded-full ${mqttConnected ? 'bg-green-400' : 'bg-red-400'}`}></div>
            {mqttConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </nav>

      {/* Tabs Menu */}
      <div className="border-b border-slate-200 bg-white sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto flex">
          <button 
            onClick={() => setActiveTab('nodes')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'nodes' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <List size={18} /> 節點清單
          </button>
          <button 
            onClick={() => setActiveTab('favorites')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'favorites' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Star size={16} /> 最愛節點
          </button>
          <button 
            onClick={() => setActiveTab('details')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'details' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Info size={16} /> 節點詳情
          </button>
          <button 
            onClick={() => setActiveTab('map')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'map' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <MapIcon size={16} /> 地圖監控
          </button>
          <button 
            onClick={() => setActiveTab('logs')}
            className={`px-6 py-4 text-xs font-black uppercase tracking-widest flex items-center gap-2 border-b-2 transition-all ${activeTab === 'logs' ? 'border-cyan-500 text-cyan-600 bg-cyan-50/50' : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'}`}
          >
            <Database size={16} /> 原始日誌
          </button>
        </div>
      </div>

      <main className="max-w-7xl mx-auto p-6">
        {activeTab === 'nodes' && (
          <div className="space-y-6">
            <div className="relative max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text" 
                placeholder="快速搜尋節點..." 
                className="w-full pl-10 pr-4 py-2 bg-white border border-slate-300 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 outline-none text-sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                    <th className="px-6 py-4">最愛</th>
                    <th className="px-6 py-4">Node ID</th>
                    <th className="px-6 py-4">角色</th>
                    <th className="px-6 py-4">Short Name</th>
                    <th className="px-6 py-4">Long Name</th>
                    <th className="px-6 py-4">頻道</th>
                    <th className="px-6 py-4">最後活動</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredNodes.map(node => (
                    <tr 
                      key={node.node_id} 
                      onClick={() => { setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                      className="hover:bg-slate-50 cursor-pointer transition-colors group text-sm"
                    >
                      <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => toggleFavorite(node.node_id, node.is_favorite)} className={node.is_favorite ? 'text-yellow-500' : 'text-slate-300 hover:text-slate-400'}>
                          <Star fill={node.is_favorite ? "currentColor" : "none"} size={18} />
                        </button>
                      </td>
                      <td className="px-6 py-4 font-mono font-bold text-cyan-600">{node.node_id}</td>
                      <td className="px-6 py-4"><span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-bold uppercase">{node.role || 'CLIENT'}</span></td>
                      <td className="px-6 py-4 font-black">{node.short_name || '??'}</td>
                      <td className="px-6 py-4 text-slate-600">{node.long_name || 'Unknown'}</td>
                      <td className="px-6 py-4">
                        <div className="text-[10px] text-slate-500 max-w-[120px] truncate" title={node.last_topic}>
                          {(() => {
                            if (!node.last_topic) return '-';
                            const parts = node.last_topic.split('/');
                            // 預期格式: msh/TW/2/e/MediumFast/!nodeid 或 msh/TW/2/c/LongFast
                            // Modem Preset (如 MediumFast) 通常位在第 5 個片段 (索引 4)
                            return parts.length >= 5 ? parts[4] : (parts[2] || '-');
                          })()}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-xs font-medium text-slate-400 whitespace-nowrap">
                        {new Date(node.last_seen).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'favorites' && (
          <div className="space-y-6">
            <h2 className="text-2xl font-bold flex items-center gap-2 text-yellow-600">
              <Star size={24} fill="currentColor" /> 最愛節點 ({favoriteNodes.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {favoriteNodes.map(node => (
                <div 
                  key={node.node_id} 
                  onClick={() => { setSelectedNodeId(node.node_id); setActiveTab('details'); }}
                  className="p-4 rounded-xl border-2 border-yellow-100 bg-white hover:border-yellow-400 transition-all cursor-pointer shadow-sm"
                >
                  <div className="flex justify-between items-start mb-3">
                    <span className="px-2 py-1 bg-yellow-500 text-white text-xs font-mono rounded">{node.node_id}</span>
                    <button onClick={(e) => { e.stopPropagation(); toggleFavorite(node.node_id, node.is_favorite); }} className="text-yellow-500">
                      <Star fill="currentColor" size={20} />
                    </button>
                  </div>
                  <div className="text-lg font-bold truncate">{node.long_name || 'Unknown'}</div>
                  <div className="text-sm text-slate-500 flex items-center gap-1 mt-1 font-mono uppercase tracking-tighter">
                    {node.short_name || '??'} | <Clock size={12}/> {new Date(node.last_seen).toLocaleTimeString()}
                  </div>
                </div>
              ))}
              {favoriteNodes.length === 0 && (
                <div className="col-span-full py-20 text-center text-slate-400 italic">
                  尚無收藏節點。點擊節點清單中的星星圖示來加入收藏。
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'details' && (
          <div className="space-y-6">
            {selectedNode ? (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-900 p-6 text-white flex justify-between items-center">
                  <div>
                    <div className="text-3xl font-black tracking-tight flex items-center gap-3">
                      {selectedNode.long_name}
                      <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                    </div>
                    <div className="text-slate-400 text-sm font-mono mt-1">ID: {selectedNode.node_id} | Topic: {selectedNode.last_topic}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-500 uppercase font-bold tracking-widest">最後活動</div>
                    <div className="text-blue-400 font-mono text-lg">{new Date(selectedNode.last_seen).toLocaleString()}</div>
                  </div>
                </div>

                <div className="p-6 space-y-8">
                  {/* 歷史趨勢圖表 (三個曲線圖) */}
                  <section>
                    <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} />
                  </section>

                  {/* 單一節點地圖 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <MapIcon size={14} /> 節點位置
                    </h4>
                    <div className="h-64 rounded-xl overflow-hidden border border-slate-200">
                      {selectedNode.latitude || gatewayStats.length > 0 ? (
                        <NodeMap 
                          nodes={[selectedNode]} 
                          allNodes={nodes} 
                          gateways={gatewayStats}
                          onSelectNode={() => {}} 
                        />
                      ) : (
                        <div className="h-full flex items-center justify-center bg-slate-50 text-slate-400 text-sm italic">
                          此節點尚未回報 GPS 位置
                        </div>
                      )}
                    </div>
                    </section>

                  {/* 封包種類分布表格與圓餅圖 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <PieChart size={14} className="text-blue-500" /> 封包種類分布
                    </h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                        <table className="w-full text-sm text-left">
                          <thead className="text-xs text-slate-400 border-b">
                            <tr>
                              <th className="pb-2">Portnum</th>
                              <th className="pb-2 text-right">Count</th>
                            </tr>
                          </thead>
                          <tbody>
                            {packetStats.map((p, i) => (
                              <tr key={i} className="border-b border-slate-200 last:border-0">
                                <td className="py-2 text-slate-700">{p.portnum}</td>
                                <td className="py-2 text-right font-bold text-slate-500">{p.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {packetStats.length === 0 && <div className="text-xs text-slate-300 italic mt-2">無資料</div>}
                      </div>
                      <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                        <PacketTypePieChart packetStats={packetStats} />
                      </div>
                    </div>
                  </section>

                  {/* 閘道收信統計 (Gateways) */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                      <Signal size={14} className="text-green-500" /> 途經閘道統計 (Gateways Analytics)
                    </h4>
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-50 border-b">
                          <tr className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                            <th className="px-4 py-3">Gateway ID</th>
                            <th className="px-4 py-3">角色</th>
                            <th className="px-4 py-3">名稱 (Name)</th>
                            <th className="px-4 py-3 text-center">跳數 (Hops)</th>
                            <th className="px-4 py-3 text-right">累積封包</th>
                            <th className="px-4 py-3">最後活動</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {gatewayStats.map((g, i) => {
                            const gwNode = nodes.find(n => n.node_id === g.gateway_id);
                            const hops = (g.hop_start || 0) - (g.hop_limit || 0);
                            return (
                              <tr key={i} className="hover:bg-slate-50 transition-colors">
                                <td className="px-4 py-3 font-mono font-bold text-blue-600">{g.gateway_id}</td>
                                <td className="px-4 py-3">
                                  <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-bold uppercase border">
                                    {gwNode?.role || 'UNKNOWN'}
                                  </span>
                                </td>
                                <td className="px-4 py-3 font-medium text-slate-700">
                                  {gwNode ? `${gwNode.short_name} | ${gwNode.long_name}` : <span className="text-slate-300 italic">尚未識別節點</span>}
                                </td>
                                <td className="px-4 py-3 text-center">
                                  <span className={`font-bold ${hops <= 0 ? 'text-green-600' : 'text-orange-500'}`}>{hops <= 0 ? '直接接收' : `${hops} 跳`}</span>
                                </td>
                                <td className="px-4 py-3 text-right font-black text-slate-600 bg-slate-50/50">{g.count} <span className="text-[9px] font-normal text-slate-400 ml-1 whitespace-nowrap">pkts</span></td>
                                <td className="px-4 py-3 text-slate-400 text-[10px]">{new Date(g.last_seen).toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {gatewayStats.length === 0 && <div className="p-10 text-center text-slate-300 italic text-sm">無路徑紀錄資料</div>}
                    </div>
                  </section>

                  {/* 節點專屬封包日誌 */}
                  <section>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                      <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                    </h4>
                    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-[11px] font-mono border-collapse">
                        <thead className="bg-slate-50 border-b">
                          <tr>
                            <th className="p-3 text-slate-500">收到時間</th>
                            <th className="p-3 text-slate-500">種類</th>
                            <th className="p-3 text-slate-500">Gateway</th>
                            <th className="p-3 text-slate-500 text-center">SNR/RSSI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {nodePackets.map((p, i) => (
                            <tr key={i} className="border-b last:border-0 hover:bg-slate-50 transition-colors">
                              <td className="p-3 text-slate-400">{p.time}</td>
                              <td className="p-3">
                                <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded border border-blue-100">{p.portnum}</span>
                              </td>
                              <td className="p-3 text-slate-600 font-bold">{p.gateway_id || 'Unknown'}</td>
                              <td className="p-3 text-center text-slate-500">{p.snr ?? '-'}/{p.rssi ?? '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {nodePackets.length === 0 && <div className="p-10 text-center text-slate-300 italic">暫無通訊紀錄</div>}
                    </div>
                  </section>
                  </div>
                </div>
            ) : (
              <div className="h-[60vh] flex flex-col items-center justify-center bg-white rounded-2xl border-2 border-dashed border-slate-200 text-slate-400">
                <Info size={48} className="mb-4 opacity-20" />
                <p className="text-lg">請先從節點清單選擇一個節點以查看詳情</p>
                <button 
                  onClick={() => setActiveTab('nodes')}
                  className="mt-4 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                  前往節點清單
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'map' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
              <div className="flex bg-slate-100 rounded-lg p-1">
                <button 
                  onClick={() => setMapShowFavoritesOnly(false)}
                  className={`px-6 py-1.5 text-xs font-black uppercase tracking-widest rounded-md transition-all ${!mapShowFavoritesOnly ? 'bg-cyan-500 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  顯示全部
                </button>
                <button 
                  onClick={() => setMapShowFavoritesOnly(true)}
                  className={`px-6 py-1.5 text-xs font-black uppercase tracking-widest rounded-md transition-all ${mapShowFavoritesOnly ? 'bg-cyan-500 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  最愛節點
                </button>
              </div>
              <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                Map Visualization: {mapShowFavoritesOnly ? favoriteNodes.length : nodes.length} Nodes
              </div>
            </div>
            <div className="h-[70vh] rounded-2xl overflow-hidden border-4 border-slate-100 shadow-inner relative">
              <NodeMap 
                nodes={mapShowFavoritesOnly ? favoriteNodes : nodes} 
                onSelectNode={(id) => setSelectedNodeId(id)} 
                onShowDetail={handleShowModal}
              />
            </div>
          </div>
        )}

        {/* 漂浮詳情頁 (Detail Modal) */}
        {isDetailModalOpen && selectedNode && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4">
            {/* 背景遮罩 */}
            <div 
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" 
              onClick={() => setIsDetailModalOpen(false)}
            ></div>
            
            {/* 彈窗主體 */}
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto flex flex-col">
              {/* Modal Header */}
              <div className="sticky top-0 bg-slate-900 text-white p-6 flex justify-between items-center z-10">
                <div>
                  <div className="text-2xl font-black tracking-tight flex items-center gap-3">
                    {selectedNode.long_name}
                    <span className="text-blue-400 text-lg">({selectedNode.short_name})</span>
                  </div>
                  <div className="text-slate-400 text-sm font-mono mt-1">ID: {selectedNode.node_id}</div>
                </div>
                <button 
                  onClick={() => setIsDetailModalOpen(false)}
                  className="p-2 hover:bg-slate-800 rounded-full transition-colors"
                >
                  <X size={24} />
                </button>
              </div>

              {/* Modal Body (複用原本詳情頁的內容) */}
              <div className="p-6 space-y-8">
                <section>
                  <TelemetryCharts nodeId={selectedNode.node_id} socket={socket} />
                </section>

                {/* 封包種類分布 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                    <PieChart size={14} className="text-blue-500" /> 封包種類分布
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                      <table className="w-full text-sm text-left">
                        <thead className="text-xs text-slate-400 border-b">
                          <tr><th className="pb-2">Portnum</th><th className="pb-2 text-right">Count</th></tr>
                        </thead>
                        <tbody>
                          {packetStats.map((p, i) => (
                            <tr key={i} className="border-b border-slate-200 last:border-0">
                              <td className="py-2 text-slate-700">{p.portnum}</td>
                              <td className="py-2 text-right font-bold text-slate-500">{p.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                      <PacketTypePieChart packetStats={packetStats} />
                    </div>
                  </div>
                </section>

                {/* 閘道統計 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Signal size={14} className="text-green-500" /> 途經閘道統計
                  </h4>
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b">
                        <tr className="text-[10px] font-black uppercase text-slate-400">
                          <th className="px-4 py-3">Gateway ID</th><th className="px-4 py-3 text-center">跳數</th><th className="px-4 py-3 text-right">累積封包</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gatewayStats.map((g, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="px-4 py-3 font-mono text-blue-600">{g.gateway_id}</td>
                            <td className="px-4 py-3 text-center">{(g.hop_start || 0) - (g.hop_limit || 0)} 跳</td>
                            <td className="px-4 py-3 text-right font-bold text-slate-500">{g.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* 封包紀錄 */}
                <section>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4 border-b pb-2 flex items-center gap-2">
                    <Database size={14} /> 節點封包紀錄 (MQTT Trace)
                  </h4>
                  <div className="bg-white border border-slate-200 rounded-xl overflow-hidden mb-10">
                    <table className="w-full text-left text-[11px] font-mono">
                      <tbody>
                        {nodePackets.map((p, i) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-slate-50"><td className="p-2 text-slate-400">{p.time}</td><td className="p-2 text-blue-600 font-bold">{p.portnum}</td><td className="p-2 text-slate-500 truncate">{p.topic}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}
        {activeTab === 'logs' && (
          <div className="bg-white rounded-xl overflow-hidden border border-slate-200 shadow-sm">
            <div className="p-4 bg-slate-50 border-b border-slate-200 flex justify-between items-center text-xs font-bold text-slate-500 uppercase tracking-widest">
              <span>MQTT 原始封包軌跡 (最近 50 筆)</span>
              <span className="text-blue-500">Auto-update active</span>
            </div>
            <div className="h-[70vh] overflow-y-auto">
              <table className="w-full text-left text-xs font-mono border-collapse">
                <thead className="bg-slate-100 sticky top-0 z-10">
                  <tr className="border-b">
                    <th className="p-3">Time</th>
                    <th className="p-3">From</th>
                    <th className="p-3">PortNum</th>
                    <th className="p-3 text-center">SNR</th>
                    <th className="p-3">Topic</th>
                  </tr>
                </thead>
                <tbody>
                  {packets.map((p, i) => (
                    <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="p-3 text-slate-500 whitespace-nowrap">{p.time}</td>
                      <td className="p-3 text-blue-600 font-bold">{p.from}</td>
                      <td className="p-3"><span className="px-2 py-0.5 bg-slate-100 rounded text-slate-600">{p.portnum}</span></td>
                      <td className="p-3 text-center text-orange-600 font-bold">{p.snr ?? '-'}</td>
                      <td className="p-3 text-slate-400 truncate max-w-xs">{p.topic}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {packets.length === 0 && <div className="text-slate-400 italic text-center py-20">等待封包中...</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;