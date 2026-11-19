import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Node } from '../App';
import NodeListRow, { type FavGroup } from './NodeListRow';

interface NodeFilter {
  role: string;
  hardware: string;
  timePreset: string;
}

interface NodeListProps {
  nodes: Node[];
  nodesLoading?: boolean;
  favoriteIdSet: Set<string>;
  nodeActivity: Record<string, number>;
  darkMode: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  nodeFilter: NodeFilter;
  onNodeFilterChange: (next: NodeFilter) => void;
  uniqueRoles: string[];
  uniqueHardware: string[];
  favGroups: FavGroup[];
  getColorMeta: (color: string) => { bg: string };
  onSelectNode: (nodeId: string) => void;
  onAssignGroup: (nodeId: string, groupId: string) => void;
  onToggleFavorite: (nodeId: string) => void;
}

const ROW_HEIGHT = 57;
const OVERSCAN = 8;
const DEFAULT_VIEWPORT_HEIGHT = 600;

const NodeList: React.FC<NodeListProps> = React.memo(({
  nodes,
  nodesLoading = false,
  favoriteIdSet,
  nodeActivity,
  darkMode,
  searchQuery,
  onSearchQueryChange,
  nodeFilter,
  onNodeFilterChange,
  uniqueRoles,
  uniqueHardware,
  favGroups,
  getColorMeta,
  onSelectNode,
  onAssignGroup,
  onToggleFavorite
}) => {
  const [groupDropdownNodeId, setGroupDropdownNodeId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          setViewportHeight(entry.contentRect.height);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const nextTop = e.currentTarget.scrollTop;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(nextTop);
      rafRef.current = null;
    });
  }, []);

  // Reset scroll to top when search/filter changes so the user always sees top matches
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
    setScrollTop(0);
  }, [searchQuery, nodeFilter.role, nodeFilter.hardware, nodeFilter.timePreset]);

  const filteredNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const hasTimeFilter = nodeFilter.timePreset !== 'ALL';
    const maxAgeMs =
      nodeFilter.timePreset === '1h' ? 3600000 :
      nodeFilter.timePreset === '6h' ? 21600000 :
      nodeFilter.timePreset === '24h' ? 86400000 :
      nodeFilter.timePreset === '7d' ? 604800000 : 0;
    const now = hasTimeFilter ? Date.now() : 0;

    if (!query && nodeFilter.role === 'ALL' && nodeFilter.hardware === 'ALL' && !hasTimeFilter) {
      return nodes;
    }

    return nodes.filter((node) => {
      if (
        query &&
        !node.node_id.toLowerCase().includes(query) &&
        !(node.long_name || '').toLowerCase().includes(query) &&
        !(node.short_name || '').toLowerCase().includes(query)
      ) {
        return false;
      }
      if (nodeFilter.role !== 'ALL' && node.role !== nodeFilter.role) return false;
      if (nodeFilter.hardware !== 'ALL' && node.hw_model !== nodeFilter.hardware) return false;
      if (hasTimeFilter && node.last_seen) {
        const lastSeenTime = new Date(node.last_seen).getTime();
        if (now - lastSeenTime > maxAgeMs) return false;
      }
      return true;
    });
  }, [nodes, searchQuery, nodeFilter.role, nodeFilter.hardware, nodeFilter.timePreset]);

  const totalCount = filteredNodes.length;
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / ROW_HEIGHT));
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalCount, Math.floor(scrollTop / ROW_HEIGHT) + visibleCount + OVERSCAN);
  const visibleNodes = filteredNodes.slice(startIndex, endIndex);
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT);

  const handleToggleDropdown = useCallback((nodeId: string) => {
    setGroupDropdownNodeId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  const handleAssignGroupAndClose = useCallback((nodeId: string, groupId: string) => {
    onAssignGroup(nodeId, groupId);
    setGroupDropdownNodeId(null);
  }, [onAssignGroup]);

  const handleToggleFavAndClose = useCallback((nodeId: string) => {
    onToggleFavorite(nodeId);
    setGroupDropdownNodeId(null);
  }, [onToggleFavorite]);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6 text-sm">
      <div className="flex flex-col lg:flex-row gap-4 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            placeholder="快速搜尋節點 ID / 名稱..."
            className={`w-full pl-10 pr-4 py-2 rounded-lg shadow-sm focus:ring-2 focus:ring-cyan-500 outline-none text-sm transition-colors ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300'}`}
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={nodeFilter.role}
            onChange={(e) => onNodeFilterChange({ ...nodeFilter, role: e.target.value })}
            className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
          >
            <option value="ALL">👤 所有角色</option>
            {uniqueRoles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            value={nodeFilter.hardware}
            onChange={(e) => onNodeFilterChange({ ...nodeFilter, hardware: e.target.value })}
            className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
          >
            <option value="ALL">💻 所有硬體</option>
            {uniqueHardware.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          <select
            value={nodeFilter.timePreset}
            onChange={(e) => onNodeFilterChange({ ...nodeFilter, timePreset: e.target.value })}
            className={`px-3 py-2 rounded-lg border text-xs font-bold outline-none shadow-sm ${darkMode ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-white border-slate-300 text-slate-600'}`}
          >
            <option value="ALL">⏱️ 不限時間</option>
            <option value="1h">1 小時內活躍</option>
            <option value="6h">6 小時內活躍</option>
            <option value="24h">24 小時內活躍</option>
            <option value="7d">7 天內活躍</option>
          </select>
          <span className="text-xs font-mono text-slate-400 ml-2">
            共 {totalCount} 筆節點
          </span>
        </div>
      </div>

      <div className={`rounded-xl shadow-sm border overflow-hidden ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="max-h-[70vh] overflow-auto"
        >
          <table className="w-full text-left border-collapse">
            <thead className={`sticky top-0 z-10 ${darkMode ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'} border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
              <tr className="text-[10px] font-black uppercase tracking-widest">
                <th className="px-6 py-4">最愛</th>
                <th className="px-6 py-4">Node ID</th>
                <th className="px-6 py-4">角色</th>
                <th className="px-6 py-4">節點名稱 (Short)</th>
                <th className="px-6 py-4">硬體型號</th>
                <th className="px-6 py-4">頻道</th>
                <th className="px-6 py-4">24h 密度</th>
                <th className="px-6 py-4 whitespace-nowrap text-right">最後活動</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${darkMode ? 'divide-slate-800' : 'divide-slate-100'}`}>
              {nodesLoading && totalCount === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-slate-400 font-mono">
                    正在載入節點清單...
                  </td>
                </tr>
              ) : totalCount === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-slate-400 font-mono">
                    無符合條件的節點資料
                  </td>
                </tr>
              ) : (
                <>
                  {topSpacerHeight > 0 && (
                    <tr aria-hidden="true" style={{ height: `${topSpacerHeight}px` }}>
                      <td colSpan={8} style={{ padding: 0, border: 0 }} />
                    </tr>
                  )}
                  {visibleNodes.map((node, localIdx) => {
                    const globalIdx = startIndex + localIdx;
                    return (
                      <NodeListRow
                        key={node.node_id}
                        node={node}
                        isFavorite={favoriteIdSet.has(node.node_id)}
                        activityCount={nodeActivity[node.node_id] || 0}
                        darkMode={darkMode}
                        isDropdownOpen={groupDropdownNodeId === node.node_id}
                        openUpward={globalIdx >= totalCount - 3}
                        favGroups={favGroups}
                        getColorMeta={getColorMeta}
                        onSelectNode={onSelectNode}
                        onToggleDropdown={handleToggleDropdown}
                        onAssignGroup={handleAssignGroupAndClose}
                        onToggleFavorite={handleToggleFavAndClose}
                      />
                    );
                  })}
                  {bottomSpacerHeight > 0 && (
                    <tr aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }}>
                      <td colSpan={8} style={{ padding: 0, border: 0 }} />
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
});

export default NodeList;

