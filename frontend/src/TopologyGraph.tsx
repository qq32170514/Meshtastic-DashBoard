import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

interface Node {
  node_id: string;
  long_name?: string;
  short_name?: string;
  role?: string;
  hardware_model?: string;
  [key: string]: any;
}

interface Edge {
  source_id: string;
  target_id: string;
  confidence: number;
  method: string;
  snr: number;
}

interface TopologyGraphProps {
  nodes: Node[];
  edges: Edge[];
  darkMode: boolean;
}

const TopologyGraph: React.FC<TopologyGraphProps> = ({ nodes, edges, darkMode }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [filterLowConfidence, setFilterLowConfidence] = useState(false);
  const [showOnlyDirect, setShowOnlyDirect] = useState(false);

  useEffect(() => {
    const observeTarget = containerRef.current;
    if (!observeTarget) return;

    const resizeObserver = new ResizeObserver(entries => {
      if (entries.length > 0) {
        setDimensions({
          width: entries[0].contentRect.width,
          height: entries[0].contentRect.height
        });
      }
    });

    resizeObserver.observe(observeTarget);
    return () => resizeObserver.unobserve(observeTarget);
  }, []);

  const graphData = useMemo(() => {
    const validNodeIds = new Set(nodes.map(n => String(n.node_id).toLowerCase()));

    let filteredEdges = edges.filter(e => validNodeIds.has(String(e.source_id).toLowerCase()) && validNodeIds.has(String(e.target_id).toLowerCase()));

    if (filterLowConfidence) {
      filteredEdges = filteredEdges.filter(e => e.confidence > 40);
    }
    if (showOnlyDirect) {
      filteredEdges = filteredEdges.filter(e => e.method === 'NEIGHBOR_INFO');
    }

    const connectedNodeIds = new Set(); 
    filteredEdges.forEach(e => { connectedNodeIds.add(String(e.source_id).toLowerCase()); connectedNodeIds.add(String(e.target_id).toLowerCase()); }); 
    const graphNodes = nodes.filter(n => connectedNodeIds.has(String(n.node_id).toLowerCase())).map(n => ({
      id: String(n.node_id).toLowerCase(),
      name: n.short_name || n.node_id,
      role: n.role || 'UNKNOWN',
      val: 1
    }));

    const graphLinks = filteredEdges.map(e => ({
      source: String(e.source_id).toLowerCase(),
      target: String(e.target_id).toLowerCase(),
      confidence: e.confidence,
      method: e.method,
      snr: e.snr
    }));

    return { nodes: graphNodes, links: graphLinks };
  }, [nodes, edges, filterLowConfidence, showOnlyDirect]);

  const getNodeColor = useCallback((role: string) => {
    switch (role) {
      case 'ROUTER':
      case 'ROUTER_CLIENT':
        return '#ef4444'; // Red
      case 'TRACKER':
        return '#22c55e'; // Green
      case 'CLIENT':
      case 'CLIENT_MUTE':
      case 'CLIENT_HIDDEN':
        return '#3b82f6'; // Blue
      default:
        return '#94a3b8'; // Slate
    }
  }, []);

  const getLinkColor = useCallback((method: string, confidence: number) => {
    let baseColor = '148, 163, 184'; // Default slate
    if (method === 'NEIGHBOR_INFO') baseColor = '34, 197, 94'; // Green
    if (method === 'TRACEROUTE') baseColor = '56, 130, 246'; // Blue
    if (method === 'HOP_LIMIT') baseColor = '245, 158, 11'; // Orange

    // Map confidence (40-100) to opacity (0.2-0.8)
    const opacity = Math.max(0.2, Math.min(0.8, confidence / 100));
    return `rgba(${baseColor}, ${opacity})`;
  }, []);

  const drawNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const label = node.name;
    const fontSize = 12 / globalScale;
    ctx.font = `${fontSize}px Sans-Serif`;
    const textWidth = ctx.measureText(label).width;
    const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2); // some padding

    // Draw Node Circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI, false);
    ctx.fillStyle = getNodeColor(node.role);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = darkMode ? '#1e293b' : '#ffffff';
    ctx.stroke();

    // Draw Text Background
    ctx.fillStyle = darkMode ? 'rgba(15, 23, 42, 0.8)' : 'rgba(255, 255, 255, 0.8)';
    ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y + 6, bckgDimensions[0], bckgDimensions[1]);

    // Draw Text
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = darkMode ? '#cbd5e1' : '#334155';
    ctx.fillText(label, node.x, node.y + 6 + bckgDimensions[1] / 2);
  }, [darkMode, getNodeColor]);

  return (
    <div className={`flex flex-col w-full h-full rounded-xl border shadow-sm overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
      
      {/* Control Panel */}
      <div className={`p-3 border-b flex flex-wrap gap-4 items-center ${darkMode ? 'border-slate-800 bg-slate-800/50' : 'border-slate-200 bg-slate-50'}`}>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-black uppercase tracking-widest ${darkMode ? 'text-cyan-500' : 'text-cyan-600'}`}>邏輯拓撲過濾器:</span>
        </div>
        
        <label className={`flex items-center gap-2 text-xs font-bold cursor-pointer transition-colors ${darkMode ? 'text-slate-300 hover:text-white' : 'text-slate-600 hover:text-slate-900'}`}>
          <input 
            type="checkbox" 
            checked={filterLowConfidence} 
            onChange={e => setFilterLowConfidence(e.target.checked)} 
            className="rounded border-slate-300 text-cyan-500 focus:ring-cyan-500 bg-slate-800"
          />
          隱藏低信心連線 (Hop Limit)
        </label>

        <label className={`flex items-center gap-2 text-xs font-bold cursor-pointer transition-colors ${darkMode ? 'text-slate-300 hover:text-white' : 'text-slate-600 hover:text-slate-900'}`}>
          <input 
            type="checkbox" 
            checked={showOnlyDirect} 
            onChange={e => setShowOnlyDirect(e.target.checked)} 
            className="rounded border-slate-300 text-cyan-500 focus:ring-cyan-500 bg-slate-800"
          />
          只顯示鄰居直連 (NeighborInfo)
        </label>

        <div className="ml-auto flex gap-4 text-[10px] font-bold">
          <span className="flex items-center gap-1 text-green-500"><div className="w-2 h-2 rounded-full bg-green-500"></div> 直連 (80%)</span>
          <span className="flex items-center gap-1 text-blue-500"><div className="w-2 h-2 rounded-full bg-blue-500"></div> 路徑 (60%)</span>
          <span className="flex items-center gap-1 text-amber-500"><div className="w-2 h-2 rounded-full bg-amber-500"></div> 猜測 (40%)</span>
        </div>
      </div>

      {/* Graph Container */}
      <div ref={containerRef} className="flex-1 w-full relative min-h-[500px]">
        {graphData.nodes.length > 0 ? (
          <ForceGraph2D
            width={dimensions.width}
            height={dimensions.height}
            graphData={graphData}
            backgroundColor={darkMode ? '#0f172a' : '#f8fafc'}
            nodeCanvasObject={drawNode}
            nodeRelSize={5}
            linkColor={link => getLinkColor((link as any).method, (link as any).confidence)}
            linkWidth={link => ((link as any).method === 'NEIGHBOR_INFO' ? 4 : 2)}
            linkDirectionalParticles={link => ((link as any).snr < -15 ? 2 : 0)}
            linkDirectionalParticleSpeed={0.01}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleColor={() => darkMode ? '#fbbf24' : '#f59e0b'} // Amber color for particles
            cooldownTicks={100}
            onEngineStop={() => { /* Option to fit graph to center after settling */ }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 font-bold text-sm">
            沒有拓撲資料可顯示
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(TopologyGraph);
