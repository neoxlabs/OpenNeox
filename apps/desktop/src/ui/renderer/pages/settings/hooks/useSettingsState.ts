/**
 * Shared settings state hook - encapsulates provider state, health checks, and
 * utility functions that are needed by multiple tabs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProviderConfig,
  ProviderProtocol,
  UserLanguage,
  ProviderHealth,
  HealthCheckRequest,
  HealthRecord,
  HealthStatus,
} from '../types';
import { MAX_HEALTH_HISTORY } from '../types';
import { useI18n, setGlobalLanguage } from '../../../hooks/useI18n';
import {
  getNormalizedModelOptionsByProtocol,
  searchNormalizedModelOptions,
  normalizeModelId,
  type ProtocolModelOption,
} from '@neoxlabs/core/models/protocolModels';
import { isProviderHealthCheckSkipped } from '../providerHealthPrefs';
import { NEOX_CLOUD_PROVIDER_ID } from '../../../../shared/neoxCloud';

export function useSettingsState(onProvidersUpdated?: () => void) {
  const { t, language } = useI18n();

  // ==================== Provider State ====================
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);

  // Health state
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({});
  const [healthDataLoaded, setHealthDataLoaded] = useState(false);
  const healthCheckTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [healthCheckIntervalMinutes, setHealthCheckIntervalMinutes] = useState<number>(1);
  const [showHealthIntervalPopover, setShowHealthIntervalPopover] = useState(false);
  const [autoHealthCheckEnabled, setAutoHealthCheckEnabled] = useState<boolean>(true);

  const cancelledChecksRef = useRef<Set<string>>(new Set());
  const providersRef = useRef<ProviderConfig[]>([]);
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthPopoverRef = useRef<HTMLDivElement | null>(null);
  const autoHealthCheckRef = useRef<boolean>(true);

  // Language state
  const [userLanguage, setUserLanguage] = useState<UserLanguage>('zh');

  // ==================== Health Functions ====================
  const loadHealthData = useCallback(async () => {
    try {
      const data = await window.neox.getHealthData();
      setHealthMap(data);
      setHealthDataLoaded(true);
    } catch (e) {
      console.error('[HealthCheck] Failed to load health data:', e);
      setHealthDataLoaded(true);
    }
  }, []);

  const cancelHealthCheck = useCallback((providerId: string) => {
    cancelledChecksRef.current.add(providerId);
    setHealthMap(prev => {
      const existing = prev[providerId];
      const lastStatus = existing?.history?.length ? existing.history[existing.history.length - 1].status : 'error';
      const lastLatency = existing?.history?.length ? existing.history[existing.history.length - 1].latency : 0;
      return {
        ...prev,
        [providerId]: {
          ...existing,
          current: lastStatus,
          latency: lastLatency,
          history: existing?.history || []
        }
      };
    });
  }, []);

  const checkProviderHealth = useCallback(async (
    provider: ProviderConfig,
    opts?: { model?: string },
  ) => {
    cancelledChecksRef.current.delete(provider.id);
    setHealthMap(prev => {
      const existing = prev[provider.id] || { current: 'testing', history: [] };
      return { ...prev, [provider.id]: { ...existing, current: 'testing' } };
    });

    /* baseUrl 兜底按 protocol 派生 — 选 deepseek 留空也不能拿 openai 当默认.
     *   跟 SettingsPage.getDefaultBaseUrl + electron/ipc/providerModelHandlers.DEFAULT_MODEL_LIST_BASE_URL
     *   保持同源 — 三处都要改. */
    /* 优先挑非图片模型做连通性探测; 图片协议/图片默认模型由后端走鉴权探测分流. */
    const modelNames = (provider.models || []).map((m) => m.name).filter(Boolean);
    const preferredChat = modelNames.find((name) => {
      const n = String(name).toLowerCase();
      return !/image|dall-?e|imagen|gpt-image|imagine|flux|sdxl/.test(n);
    });
    const probeModel = (opts?.model || '').trim()
      || preferredChat
      || provider.defaultModel
      || provider.lastSelectedModel
      || provider.models[0]?.name
      || 'gpt-4o';

    try {
      const request: HealthCheckRequest = {
        providerId: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl || protocolDefaultBaseUrl(provider.protocol),
        urlSuffix: provider.urlSuffix,
        apiKey: provider.apiKey || '',
        model: probeModel,
      };

      const result = await window.neox.checkProviderHealth(request);
      if (cancelledChecksRef.current.has(provider.id)) {
        cancelledChecksRef.current.delete(provider.id);
        return;
      }

      const newRecord: HealthRecord = {
        status: result.status,
        latency: result.latency,
        timestamp: result.timestamp,
        /* 保留探测原始错误 — 供卡片状态弹窗展示"最近几次错误". */
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        model: probeModel,
      };

      setHealthMap(prev => {
        const existing = prev[provider.id] || { current: result.status, history: [] };
        const newHistory = [...existing.history, newRecord].slice(-MAX_HEALTH_HISTORY);
        return {
          ...prev,
          [provider.id]: { current: result.status, latency: result.latency, history: newHistory }
        };
      });

      try {
        await window.neox.updateHealthData(provider.id, result.status, result.latency, result.errorMessage, result.httpStatus, probeModel);
      } catch (persistErr) {
        console.error('[HealthCheck] Failed to persist health data:', persistErr);
      }
    } catch (err: any) {
      if (cancelledChecksRef.current.has(provider.id)) {
        cancelledChecksRef.current.delete(provider.id);
        return;
      }

      const errText = err?.message ? String(err.message) : 'Unknown error';
      const newRecord: HealthRecord = { status: 'offline', latency: 0, timestamp: Date.now(), error: errText, model: probeModel };
      setHealthMap(prev => {
        const existing = prev[provider.id] || { current: 'offline', history: [] };
        const newHistory = [...existing.history, newRecord].slice(-MAX_HEALTH_HISTORY);
        return {
          ...prev,
          [provider.id]: { current: 'offline', latency: 0, history: newHistory }
        };
      });

      try {
        await window.neox.updateHealthData(provider.id, 'offline', 0, errText, undefined, probeModel);
      } catch (persistErr) {
        console.error('[HealthCheck] Failed to persist health data:', persistErr);
      }
    }
  }, []);

  const runHealthCheck = useCallback(() => {
    const list = providersRef.current.filter(provider =>
      provider.id !== NEOX_CLOUD_PROVIDER_ID && !isProviderHealthCheckSkipped(provider.id),
    );
    if (list.length === 0) return;
    list.forEach((provider, index) => {
      setTimeout(() => {
        if (!isProviderHealthCheckSkipped(provider.id)) checkProviderHealth(provider);
      }, index * 500);
    });
  }, [checkProviderHealth]);

  const startHealthCheckInterval = useCallback((intervalMinutes?: number, forceRun?: boolean) => {
    const minutes = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : (healthCheckIntervalMinutes || 1);
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }
    if (autoHealthCheckRef.current || forceRun) {
      runHealthCheck();
    }
    healthCheckIntervalRef.current = setInterval(() => {
      if (autoHealthCheckRef.current) {
        runHealthCheck();
      }
    }, minutes * 60 * 1000);
  }, [runHealthCheck, healthCheckIntervalMinutes]);

  // ==================== Notify ====================
  const notifyProvidersChanged = useCallback(() => {
    try {
      onProvidersUpdated?.();
    } catch (error) {
      console.error('[Settings] Failed to notify provider change', error);
    }
  }, [onProvidersUpdated]);

  // ==================== Load Functions ====================
  const loadProviders = async () => {
    setLoading(true);
    try {
      const list = await window.neox.getProviders();
      setProviders(list);
      providersRef.current = list;
      if (!healthCheckIntervalRef.current) {
        try {
          const autoEnabled = await window.neox.getAutoHealthCheck();
          autoHealthCheckRef.current = autoEnabled;
          setAutoHealthCheckEnabled(autoEnabled);
        } catch { }
        setTimeout(() => startHealthCheckInterval(), 500);
      }
    } catch (err) {
      console.error('Failed to load providers:', err);
    }
    setLoading(false);
  };

  const loadLanguagePreference = async () => {
    try {
      const lang = await window.neox.getLanguagePreference();
      setUserLanguage(lang);
      setGlobalLanguage(lang);
    } catch (err) {
      console.error('Failed to load language preference:', err);
    }
  };

  const handleLanguageChange = async (lang: UserLanguage) => {
    try {
      setGlobalLanguage(lang);
      await window.neox.setLanguagePreference(lang);
      setUserLanguage(lang);
    } catch (err) {
      console.error('Failed to save language preference:', err);
    }
  };

  const handleAssistantLanguageChange = async (lang: UserLanguage) => {
    try {
      await window.neox.setLanguagePreference(lang);
      setUserLanguage(lang);
    } catch (err) {
      console.error('Failed to save assistant language preference:', err);
    }
  };

  const loadHealthCheckInterval = async () => {
    try {
      const minutes = await window.neox.getHealthCheckInterval();
      if (minutes && minutes > 0) {
        setHealthCheckIntervalMinutes(minutes);
      }
    } catch (err) {
      console.error('Failed to load health check interval:', err);
    }
  };

  const loadAutoHealthCheckSetting = async () => {
    try {
      const enabled = await window.neox.getAutoHealthCheck();
      setAutoHealthCheckEnabled(enabled);
      autoHealthCheckRef.current = enabled;
    } catch (err) {
      console.error('Failed to load auto health check setting:', err);
    }
  };

  const handleAutoHealthCheckToggle = async () => {
    const newValue = !autoHealthCheckEnabled;
    setAutoHealthCheckEnabled(newValue);
    autoHealthCheckRef.current = newValue;
    try {
      await window.neox.setAutoHealthCheck(newValue);
      if (newValue && providersRef.current.length > 0) {
        runHealthCheck();
      }
    } catch (err) {
      console.error('Failed to save auto health check setting:', err);
    }
  };

  // ==================== Utility Functions ====================
  /* 协议默认 base URL — 选 deepseek 留空时 health-check 兜底走 deepseek 而非 openai.
   *   跟 SettingsPage.getDefaultBaseUrl + electron/ipc/providerModelHandlers.DEFAULT_MODEL_LIST_BASE_URL
   *   保持同源 — 三处都要改. */
  const protocolDefaultBaseUrl = (protocol: ProviderProtocol): string => {
    switch (protocol) {
      case 'openai':
      case 'openai-responses': return 'https://api.openai.com/v1';
      case 'anthropic': return 'https://api.anthropic.com';
      case 'doubao': return 'https://ark.cn-beijing.volces.com/api/v3';
      case 'gemini': return 'https://generativelanguage.googleapis.com';
      case 'kimi': return 'https://api.moonshot.cn/v1';
      case 'deepseek': return 'https://api.deepseek.com';
      case 'minimax': return 'https://api.minimax.chat/v1';
      case 'qwen': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      case 'glm': return 'https://open.bigmodel.cn/api/paas/v4';
      default: return 'https://api.openai.com/v1';
    }
  };

  const getDefaultUrlSuffix = (protocol: ProviderProtocol): string => {
    switch (protocol) {
      case 'openai': return '/chat/completions';
      case 'openai-responses': return '/responses';
      case 'anthropic': return '/v1/messages';
      case 'anthropic-openai': return '/v1/messages';
      case 'doubao': return '/chat/completions';
      case 'gemini': return '/v1beta/models';
      case 'kimi': return '/chat/completions';
      case 'deepseek': return '/chat/completions';
      case 'minimax': return '/chat/completions';
      case 'qwen': return '/chat/completions';
      case 'glm': return '/chat/completions';
      default: return '/chat/completions';
    }
  };

  const getHealthLabel = (status: HealthStatus | 'testing'): string => {
    switch (status) {
      case 'excellent': return t.settings.providers.health.excellent;
      case 'good': return t.settings.providers.health.good;
      case 'poor': return t.settings.providers.health.slow;
      case 'testing': return t.settings.providers.health.testing;
      case 'offline': return t.settings.providers.health.offline;
      case 'error': return t.settings.providers.health.error;
      default: return t.settings.providers.health.unknown;
    }
  };

  const getHealthPercent = (status: HealthStatus | 'testing'): number => {
    switch (status) {
      case 'excellent': return 100;
      case 'good': return 75;
      case 'poor': return 40;
      case 'testing': return 50;
      case 'offline': return 10;
      case 'error': return 5;
      default: return 0;
    }
  };

  const formatHealthIntervalLabel = (minutes: number): string => {
    if (minutes < 60) {
      return language === 'zh' ? `${minutes} 分钟` : `${minutes} min`;
    }
    const hours = minutes / 60;
    return language === 'zh' ? `${hours} 小时` : `${hours} h`;
  };

  const handleHealthIntervalChange = async (minutes: number) => {
    try {
      setHealthCheckIntervalMinutes(minutes);
      await window.neox.setHealthCheckInterval(minutes);
      startHealthCheckInterval(minutes);
      setShowHealthIntervalPopover(false);
    } catch (err) {
      console.error('Failed to update health check interval:', err);
    }
  };

  const getProviderHealthStatus = (providerId: string): { status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'; latency?: number } => {
    const health = healthMap[providerId];
    if (!health) return { status: 'unknown' };
    const current = health.current ?? (health as any).status;
    if (!current) return { status: 'unknown' };
    if (current === 'excellent' || current === 'good') {
      return { status: 'healthy', latency: health.latency };
    }
    if (current === 'poor' || current === 'testing') {
      return { status: 'degraded', latency: health.latency };
    }
    return { status: 'unhealthy', latency: health.latency };
  };

  const formatTime = (timestamp: number): string => {
    if (!timestamp) return '-';
    const now = new Date();
    const diffMs = now.getTime() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return language === 'zh' ? '刚刚' : 'Just now';
    if (diffMins < 60) return language === 'zh' ? `${diffMins} 分钟前` : `${diffMins}m ago`;
    if (diffHours < 24) return language === 'zh' ? `${diffHours} 小时前` : `${diffHours}h ago`;
    if (diffDays < 7) return language === 'zh' ? `${diffDays} 天前` : `${diffDays}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTokenCount = (count: number): string => {
    if (count >= 1000000) {
      const value = count / 1000000;
      const nearest = Math.round(value);
      if (nearest >= 1 && Math.abs(value - nearest) <= 0.11) return `${nearest}M`;
      const formatted = value >= 10 ? `${Math.round(value)}` : value.toFixed(1).replace(/\.0$/, '');
      return `${formatted}M`;
    }
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
  };

  const openInFinder = async (filePath: string) => {
    try {
      await window.neox.openInFinder(filePath);
    } catch (err) {
      console.error('Failed to open in Finder:', err);
    }
  };

  // ==================== Initialization ====================
  useEffect(() => {
    loadProviders();
    loadLanguagePreference();
    loadHealthCheckInterval();
    loadAutoHealthCheckSetting();
    loadHealthData();
    return () => {
      if (healthCheckTimerRef.current) {
        clearTimeout(healthCheckTimerRef.current);
      }
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showHealthIntervalPopover) return undefined;
    const handlePointerOutside = (event: PointerEvent) => {
      if (showHealthIntervalPopover && healthPopoverRef.current && !healthPopoverRef.current.contains(event.target as Node)) {
        setShowHealthIntervalPopover(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHealthIntervalPopover(false);
    };
    document.addEventListener('pointerdown', handlePointerOutside, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerOutside, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [showHealthIntervalPopover]);

  return {
    // i18n
    t,
    language,

    // providers
    providers,
    setProviders,
    loading,
    setLoading,
    loadProviders,

    // health
    healthMap,
    setHealthMap,
    healthDataLoaded,
    healthCheckIntervalMinutes,
    setHealthCheckIntervalMinutes,
    showHealthIntervalPopover,
    setShowHealthIntervalPopover,
    autoHealthCheckEnabled,
    setAutoHealthCheckEnabled,
    healthPopoverRef,
    cancelHealthCheck,
    checkProviderHealth,
    runHealthCheck,
    startHealthCheckInterval,
    handleAutoHealthCheckToggle,
    handleHealthIntervalChange,
    getProviderHealthStatus,
    getHealthLabel,
    getHealthPercent,
    formatHealthIntervalLabel,

    // language
    userLanguage,
    setUserLanguage,
    handleLanguageChange,
    handleAssistantLanguageChange,

    // utilities
    getDefaultUrlSuffix,
    formatTime,
    formatSize,
    formatTokenCount,
    openInFinder,
    notifyProvidersChanged,
    providersRef,
  };
}

export type UseSettingsStateReturn = ReturnType<typeof useSettingsState>;
