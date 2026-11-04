import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ModelInfo } from '../../shared/ipc';
import { isChatModelInfo } from '../utils/modelKind';
import { isNeoxCloudProviderId } from '../../shared/neoxCloud';
import { readLastModelId } from './runtimeBridgePrefs';

const LOGGED_OUT_GRACE_MS = 3000;

export function useLoggedOutModelFallback(args: {
  isAuthenticated: boolean;
  planId: string | undefined;
  availableModels: ModelInfo[];
  selectedModel: ModelInfo | null | undefined;
  /** 不落 lastModelId 的那个 setter */
  setSelectedModel: (m: ModelInfo) => void;
  /** 兜底挑的记号 —— 订阅段迟到时据此允许改回 */
  autoPickedRef: MutableRefObject<boolean>;
  /** 切回后把会话绑定也改掉, 否则会话还原 effect 又会还原成临时模型 */
  onRestored: (m: ModelInfo) => void;
}): void {
  const { isAuthenticated, planId, availableModels, selectedModel, setSelectedModel, autoPickedRef, onRestored } = args;
  const tempIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedModel) return;
    if (isAuthenticated) {
      const tempId = tempIdRef.current;
      if (!tempId) return;
      if (selectedModel.id !== tempId) { tempIdRef.current = null; return; }   /* 用户自己又换过了 */
      const saved = readLastModelId();
      const back = saved ? availableModels.find((m) => m.id === saved) : undefined;
      if (back) {
        tempIdRef.current = null;
        setSelectedModel(back);
        onRestored(back);
      }
      return;
    }
    if (!isNeoxCloudProviderId(selectedModel.providerId)) return;
    const timer = window.setTimeout(() => {
      const fallback = availableModels.find((m) => !isNeoxCloudProviderId(m.providerId) && isChatModelInfo(m));
      if (fallback && fallback.id !== selectedModel.id) {
        tempIdRef.current = fallback.id;
        autoPickedRef.current = true;
        setSelectedModel(fallback);
      }
    }, LOGGED_OUT_GRACE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setter / ref / 回调都是稳定引用
  }, [isAuthenticated, planId, availableModels, selectedModel]);
}
