import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

const TerminalManager = React.lazy(() => import('../../terminal/components/TerminalManager'));

export const TerminalSurfaceViewer: React.FC<{
  workspacePath?: string;
  onClose?: () => void;
}> = ({ workspacePath, onClose }) => {
  const { isZh } = useI18n();
  return (
    <div className="sfc-terminal">
      <React.Suspense
        fallback={<div className="sfc-terminal__loading" role="status" aria-busy="true"><span className="neox-text-shimmer">{isZh ? '终端启动中…' : 'Starting terminal…'}</span></div>}
      >
        <TerminalManager
          visible
          embedded
          fill
          workspacePath={workspacePath}
          onClose={() => onClose?.()}
        />
      </React.Suspense>
    </div>
  );
};

export default TerminalSurfaceViewer;
