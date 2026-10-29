/**
 * 国际化 Hook - 在组件中使用翻译
 */

import { useState, useEffect, useCallback } from 'react';
import { getTranslations, type Language, type Translations } from '../i18n';
import { setNeoxErrorLanguage } from '@neoxlabs/platform/utils/neoxErrorCatalogue.js';

// 全局 UI 语言状态 — 跟"助手回复语言"(setLanguagePreference) 独立,
// 这里只管 desktop UI 的中英文显示, 持久化在 localStorage.
const UI_LANG_STORAGE_KEY = 'neox-ui-language';

/* 出海双 channel — Vite build 注入的 region (见 vite.config.ui.ts / region.ts).
 * dev / 未 bake 时 typeof 安全返 'undefined'. */
declare const __NEOX_REGION__: string | undefined;

function channelDefaultLang(): Language {
  const region = (typeof __NEOX_REGION__ !== 'undefined' ? String(__NEOX_REGION__) : '').toLowerCase();
  if (region !== 'global' && region !== 'intl') return 'zh';
  try {
    const locales: string[] = [
      ...(typeof navigator !== 'undefined' && Array.isArray(navigator.languages) ? navigator.languages : []),
      (typeof navigator !== 'undefined' ? navigator.language : '') || '',
    ].filter(Boolean).map(l => l.toLowerCase());
    if (locales.some(l => l.startsWith('zh'))) return 'zh';
  } catch { /* 没有 navigator 就走 channel 默认 */ }
  return 'en';
}

function readPersistedUiLang(): Language {
  try {
    if (typeof localStorage === 'undefined') return channelDefaultLang();
    const v = localStorage.getItem(UI_LANG_STORAGE_KEY);
    if (v === 'en') return 'en';
    if (v === 'zh') return 'zh';
    return channelDefaultLang(); // 首启无偏好 → 按 channel 默认 (global=英文)
  } catch { return channelDefaultLang(); }
}

let globalLanguage: Language = readPersistedUiLang();
const listeners = new Set<(lang: Language) => void>();

// 通知所有监听者语言变化
function notifyListeners(lang: Language) {
  listeners.forEach(listener => listener(lang));
}

// 设置全局 UI 语言 — 立即落 localStorage 持久化.
//   OpenAIProvider buildResponsesInstructions) 给 LLM 的 system prompt 语言跟 UI 一致.
export function setGlobalLanguage(lang: Language) {
  globalLanguage = lang;
  /* 网关错误目录 (neox-platform/utils/neoxErrorCatalogue) 有自己的一份语言状态 ——
   * platform 层不该去猜 UI 的语言, 所以由这里推给它。
   * 不接这一步的话, CATALOGUE_EN 写了也不会生效: 英文界面上一出网关错误仍然是中文。 */
  try { setNeoxErrorLanguage(lang === 'en' ? 'en' : 'zh'); } catch { /* platform 未就绪时 noop */ }
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(UI_LANG_STORAGE_KEY, lang); } catch { /* ignore */ }
  try { if (typeof document !== 'undefined') document.documentElement.lang = lang; } catch { /* ignore */ }
  /* 通过 preload-exposed neox.setLanguagePreference 把 language 持久化到 config.json.
   * 然后 backend (buildInstructions / OpenAIProvider) 下次构建 prompt 时读 EN. fire-and-forget. */
  try {
    const api = (typeof window !== 'undefined' ? (window as any).neox : null);
    if (api?.setLanguagePreference) {
      api.setLanguagePreference(lang).catch(() => { /* ignore IPC fail */ });
    }
  } catch { /* renderer 没 neox API 时 noop */ }
  notifyListeners(lang);
}

// 获取当前全局语言
export function getGlobalLanguage(): Language {
  return globalLanguage;
}

export function defaultIsZh(): boolean {
  return globalLanguage === 'zh';
}

// 国际化 Hook
export function useI18n() {
  const [language, setLanguage] = useState<Language>(globalLanguage);
  const [t, setT] = useState<Translations>(() => getTranslations(globalLanguage));

  useEffect(() => {
    const handleLanguageChange = (lang: Language) => {
      setLanguage(lang);
      setT(getTranslations(lang));
    };

    // 订阅语言变化
    listeners.add(handleLanguageChange);

    // 初始化时同步全局状态
    if (language !== globalLanguage) {
      handleLanguageChange(globalLanguage);
    }

    return () => {
      listeners.delete(handleLanguageChange);
    };
  }, []);

  const changeLanguage = useCallback((lang: Language) => {
    setGlobalLanguage(lang);
  }, []);

  return {
    language,
    t,
    changeLanguage,
    isZh: language === 'zh',
    isEn: language === 'en',
  };
}

export type { Language, Translations };
