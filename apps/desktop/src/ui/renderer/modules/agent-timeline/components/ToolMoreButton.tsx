import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

export const ToolMoreButton: React.FC<{
  expanded: boolean;
  hiddenCount: number;
  onToggle: () => void;
  className?: string;
}> = ({ expanded, hiddenCount, onToggle, className }) => {
  const { isZh } = useI18n();
  return (
    <button
      type="button"
      className={className ? `atl-explore__more ${className}` : 'atl-explore__more'}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {expanded ? (isZh ? '收起' : 'Show less') : (isZh ? `+${hiddenCount} 更多` : `+${hiddenCount} more`)}
    </button>
  );
};
