import React, { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useEscClose } from '../../../hooks/useEscClose';
import Icons from '../../../components/Icons';
import { PageTitle } from '../../../components/settings-base';

interface ProcessEntry {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  pid?: number;
  startTime?: number;
  cpu?: number;
  memory?: number;
}

const ProcessesTab: React.FC = () => {
  const { language } = useI18n();
  const [processes, setProcesses] = useState<ProcessEntry[]>([]);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [processOutput, setProcessOutput] = useState('');
  const [showProcessOutput, setShowProcessOutput] = useState(false);

  /* Esc 关掉进程输出弹窗 — capture 层拦截, 不会穿透把整个设置页关掉 */
  useEscClose(showProcessOutput, () => setShowProcessOutput(false));

  const loadProcesses = useCallback(async () => {
    setProcessesLoading(true);
    try {
      const list = await window.neox.processList?.() || [];
      setProcesses(list.map((p: any) => ({
        id: p.id,
        pid: p.pid,
        name: p.name,
        command: p.command,
        status: p.status,
        startTime: p.startTime,
        cwd: p.cwd,
      })));
    } catch (error) {
      console.error('Failed to load processes:', error);
    } finally {
      setProcessesLoading(false);
    }
  }, []);

  const handleKillProcess = useCallback(async (pid: number) => {
    try {
      await window.neox.processKill?.(pid);
      loadProcesses();
    } catch (error) {
      console.error('Failed to kill process:', error);
    }
  }, [loadProcesses]);

  useEffect(() => {
    loadProcesses();
  }, [loadProcesses]);

  return (
    <div className="settings-panel-content">
      <PageTitle
        title={language === 'zh' ? '进程管理' : 'Process Management'}
      />

      <div className="settings-sections">
        <div className="settings-section">
          <div className="section-header-row">
            <h3 className="section-title">
              {language === 'zh' ? '运行中的进程' : 'Running Processes'}
            </h3>
            <button className="refresh-btn" onClick={loadProcesses} title={language === 'zh' ? '刷新进程列表' : 'Refresh process list'} aria-label={language === 'zh' ? '刷新进程列表' : 'Refresh process list'}>
              <Icons.Refresh />
            </button>
          </div>

          {processesLoading ? (
            <div className="loading-state">
              <Icons.Loader />
              <span className="neox-text-shimmer">{language === 'zh' ? '加载中...' : 'Loading...'}</span>
            </div>
          ) : processes.length === 0 ? (
            <div className="empty-state">
              {language === 'zh' ? '暂无运行中的进程' : 'No running processes'}
            </div>
          ) : (
            <div className="processes-list">
              {processes.map((proc) => (
                <div key={proc.id} className="process-item">
                  <div className="process-info">
                    <span className="process-name">{proc.name}</span>
                    <span className={`process-status ${proc.status}`}>
                      {proc.status}
                    </span>
                    {proc.pid && <span className="process-pid">PID: {proc.pid}</span>}
                  </div>
                  <div className="process-stats">
                    {proc.cpu !== undefined && (
                      <span className="process-cpu">CPU: {proc.cpu}%</span>
                    )}
                    {proc.memory !== undefined && (
                      <span className="process-mem">Mem: {(proc.memory / 1024 / 1024).toFixed(1)}MB</span>
                    )}
                  </div>
                  <button
                    className="process-output-btn"
                    onClick={async () => {
                      setSelectedProcessId(proc.id);
                      setProcessOutput('');
                      setShowProcessOutput(true);
                      try {
                        const result = await (window as any).neox.processGetOutput(proc.pid);
                        if (result?.success && result.output) {
                          setProcessOutput(result.output);
                        }
                      } catch (err) {
                        console.error('Failed to fetch process output:', err);
                      }
                    }}
                    title={language === 'zh' ? '查看输出' : 'View Output'}
                  >
                    <Icons.Terminal />
                  </button>
                  <button
                    className="process-kill-btn"
                    onClick={() => proc.pid != null && handleKillProcess(proc.pid)}
                    title={language === 'zh' ? '终止' : 'Kill'}
                  >
                    <Icons.XCircle />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showProcessOutput && selectedProcessId && (
        <div className="modal-overlay" onClick={() => setShowProcessOutput(false)}>
          <div className="modal-content process-output-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{language === 'zh' ? '进程输出' : 'Process Output'}</h3>
              <button className="modal-close" onClick={() => setShowProcessOutput(false)} title={language === 'zh' ? '关闭' : 'Close'} aria-label={language === 'zh' ? '关闭' : 'Close'}>
                <Icons.Close />
              </button>
            </div>
            <div className="modal-body">
              <pre className="process-output-content">
                {processOutput || (language === 'zh' ? '暂无输出' : 'No output')}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProcessesTab;
