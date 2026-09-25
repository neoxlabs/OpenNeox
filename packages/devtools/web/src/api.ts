import { useEffect, useRef, useState } from 'react';
import type { MonitorState } from './types';

/**
 * 订阅 node 桥接服务的 SSE 流(/api/stream),拿实时 MonitorState。
 * 断线自动由浏览器 EventSource 重连。
 */
export function useMonitorStream(): { state: MonitorState | null; live: boolean } {
  const [state, setState] = useState<MonitorState | null>(null);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    esRef.current = es;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (ev) => {
      try {
        setState(JSON.parse(ev.data) as MonitorState);
        setLive(true);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => es.close();
  }, []);

  return { state, live };
}
