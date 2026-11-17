import React from 'react';
import { Star } from 'lucide-react';
import type { Node } from '../App';

export interface FavGroup {
  id: string;
  name: string;
  color: string;
}

export interface NodeListRowProps {
  node: Node;
  isFavorite: boolean;
  activityCount: number;
  darkMode: boolean;
  isDropdownOpen: boolean;
  openUpward: boolean;
  favGroups: FavGroup[];
  getColorMeta: (color: string) => { bg: string };
  onSelectNode: (nodeId: string) => void;
  onToggleDropdown: (nodeId: string) => void;
  onAssignGroup: (nodeId: string, groupId: string) => void;
  onToggleFavorite: (nodeId: string) => void;
}

function resolveChannelDisplay(channel?: string, lastTopic?: string): string {
  const rawChannel = channel || '';
  const isInvalid = /^\d+$/.test(rawChannel) || ['c', 'json', 'e', 'stat', ''].includes(rawChannel);
  const channelName = isInvalid
    ? (lastTopic || '')
        .split('/')
        .find((p) => !/^\d+$/.test(p) && !['msh', 'TW', 'c', 'json', 'e', 'stat', ''].includes(p) && !p.startsWith('!')) || '-'
    : rawChannel;
  return channelName === 'MediumFast' ? '⚡ ' + channelName : channelName;
}

const NodeListRow: React.FC<NodeListRowProps> = React.memo(({
  node,
  isFavorite,
  activityCount,
  darkMode,
  isDropdownOpen,
  openUpward,
  favGroups,
  getColorMeta,
  onSelectNode,
  onToggleDropdown,
  onAssignGroup,
  onToggleFavorite
}) => {
  const roleStr = String(node.role || '');
  const isRouter = roleStr.includes('ROUTER');
  const isBase = roleStr.includes('BASE');
  const isRepeater = roleStr.includes('REPEATER');
  const isTracker = roleStr.includes('TRACKER');
  const roleLabel = typeof node.role === 'string' ? node.role.replace('_', ' ') : String(node.role || 'CLIENT');
  const hwLabel = typeof node.hw_model === 'string' ? node.hw_model.replace(/_/g, ' ') : String(node.hw_model || 'UNKNOWN');
  const channelDisplay = resolveChannelDisplay(node.channel, node.last_topic);
  const lastSeenDisplay = node.last_seen ? new Date(node.last_seen).toLocaleString() : '--';

  return (
    <tr
      onClick={() => onSelectNode(node.node_id)}
      className={`cursor-pointer transition-colors group text-sm h-[57px] ${darkMode ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50'}`}
    >
      <td className="px-6 py-3 relative" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onToggleDropdown(node.node_id)}
          className={`p-1.5 rounded-full transition-all ${isFavorite ? 'text-yellow-500 hover:bg-yellow-500/20' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-200'}`}
        >
          <Star fill={isFavorite ? 'currentColor' : 'none'} size={18} />
        </button>
        {isDropdownOpen && (
          <div
            className={`absolute ${openUpward ? 'bottom-full mb-1' : 'top-full mt-1'} left-4 w-32 rounded-lg shadow-xl border z-50 overflow-hidden ${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
          >
            <div className="max-h-48 overflow-y-auto">
              {favGroups.map((g) => (
                <div
                  key={g.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAssignGroup(node.node_id, g.id);
                  }}
                  className={`px-3 py-2 text-xs cursor-pointer flex items-center gap-2 transition-colors ${darkMode ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-50 text-slate-700'}`}
                >
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getColorMeta(g.color).bg }} />
                  {g.name}
                </div>
              ))}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onAssignGroup(node.node_id, 'ungrouped');
                }}
                className={`px-3 py-2 text-xs cursor-pointer transition-colors border-t ${darkMode ? 'hover:bg-slate-700 text-slate-300 border-slate-700' : 'hover:bg-slate-50 text-slate-700 border-slate-100'}`}
              >
                未分組
              </div>
              {isFavorite ? (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(node.node_id);
                  }}
                  className={`px-3 py-2 text-xs cursor-pointer transition-colors border-t text-red-500 ${darkMode ? 'hover:bg-slate-700 border-slate-700' : 'hover:bg-slate-50 border-slate-100'}`}
                >
                  ❌ 移除最愛
                </div>
              ) : null}
            </div>
          </div>
        )}
      </td>
      <td className="px-6 py-3 font-mono font-bold text-cyan-600 text-xs whitespace-nowrap">
        {node.node_id}
      </td>
      <td className="px-6 py-3 whitespace-nowrap">
        <span
          className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
            isRouter
              ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
              : isBase
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : isRepeater
                  ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                  : isTracker
                    ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                    : darkMode
                      ? 'bg-slate-800 text-slate-400'
                      : 'bg-slate-100 text-slate-600'
          }`}
        >
          {roleLabel}
        </span>
      </td>
      <td className="px-6 py-3 text-xs">
        <div className="flex items-center gap-1.5">
          <span className={`font-black truncate max-w-[120px] ${darkMode ? 'text-slate-100' : 'text-slate-900'}`}>
            {node.long_name || 'Unknown'}
          </span>
          <span className="text-[10px] font-bold text-cyan-500 bg-cyan-500/10 px-1 rounded">
            ({node.short_name || 'N/A'})
          </span>
        </div>
      </td>
      <td className="px-6 py-3 whitespace-nowrap">
        <span
          className={`px-2 py-0.5 rounded text-[9px] font-mono border uppercase tracking-tighter ${darkMode ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}
        >
          {hwLabel}
        </span>
      </td>
      <td className="px-6 py-3 text-xs">
        <div className={`text-[10px] max-w-[120px] truncate font-bold ${darkMode ? 'text-cyan-400/80' : 'text-cyan-700'}`} title={node.last_topic}>
          {channelDisplay}
        </div>
      </td>
      <td className="px-6 py-3 whitespace-nowrap">
        <div className="flex flex-col">
          <span className={`text-[11px] font-black ${activityCount > 50 ? 'text-orange-500' : 'text-slate-400'}`}>
            {activityCount} <span className="text-[9px] font-normal opacity-60">pkts</span>
          </span>
          <div className="w-12 h-1 bg-slate-200 dark:bg-slate-800 rounded-full mt-1 overflow-hidden">
            <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, activityCount * 2)}%` }} />
          </div>
        </div>
      </td>
      <td className="px-6 py-3 text-xs font-medium text-slate-500 whitespace-nowrap text-right">
        {lastSeenDisplay}
      </td>
    </tr>
  );
});

export default NodeListRow;

