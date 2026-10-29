import { ipcMain } from './ipcMainBridged.js';
/* 类型是纯类型导入, 编译后完全擦除 —— 不会在运行时把 electron 拉进来。
 * 值 (ipcMain) 走桥的替身, 于是这个文件在纯 Node 后端里也 import 得动。 */
import type { IpcMainInvokeEvent } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import { normalizeAgentMode } from '@neoxlabs/platform/runtime/agentMode.js';
import { wrapApiKey, unwrapApiKey } from '@neoxlabs/platform/utils/apiKeyCrypto.js';
import { getUserProfilePath } from '@neoxlabs/core/runtime/modeHome.js';
import { OrganizationConfigService } from '@neoxlabs/core/runtime/store/OrganizationConfigService.js';
import { askJev, JEV_DEFAULT_MODEL } from '@neoxlabs/core';
import type { ProjectManager } from '../context/ProjectManager.js';
import { makeOptionalBridgeResolver, makeWorkspaceResolver } from './scopeResolvers.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

/** 设置页回显用: 只露末 4 位。没 key → ''。 */
function maskJevKey(plain: string): string {
  const key = plain.trim();
  return key ? `…${key.slice(-4)}` : '';
}

interface RegisterFeatureConfigIpcHandlersOptions {
  projectManager: ProjectManager;
}

export function registerFeatureConfigIpcHandlers(options: RegisterFeatureConfigIpcHandlersOptions): void {
  try {
    const bootTts = loadConfig().tts?.provider;
    void import('../services/localVoiceService.js')
      .then(m => {
        if (bootTts === 'local' || (!bootTts && m.resolveDefaultTtsProvider() === 'local')) {
          return m.ensureLocalTtsServer();
        }
        return undefined;
      })
      .catch(err => console.warn('[localvoice] TTS bridge boot failed:', err?.message ?? err));
  } catch { /* config 读不到 — 跳过 */ }

  const resolveWorkspace = makeWorkspaceResolver(options.projectManager);
  const bridgeOf = makeOptionalBridgeResolver(options.projectManager);

  const workdirOf = (event: IpcMainInvokeEvent | undefined): string => {
    if (event) {
      const wp = resolveWorkspace(event);
      if (wp) return wp;
    }
    return process.env.NEOX_WORKDIR || process.cwd();
  };

  const buildOrganizationStatus = (event?: IpcMainInvokeEvent) => {
    const workDir = workdirOf(event);
    const service = new OrganizationConfigService(workDir);
    const config = service.loadConfig();
    const departments = Object.keys(config?.departments || {}).length;
    const members = Object.values(config?.departments || {}).reduce((total, dept: any) => {
      const leadCount = dept?.lead ? 1 : 0;
      const memberCount = Array.isArray(dept?.members) ? dept.members.length : 0;
      return total + leadCount + memberCount;
    }, 0);
    return {
      exists: service.hasConfig(),
      configPath: service.getConfigPath(),
      name: config?.name,
      departments,
      members,
    };
  };

  ipcMain.handle('profile:get', () => {
    try {
      return { content: readFileSync(getUserProfilePath('work'), 'utf8') };
    } catch {
      return { content: '' };
    }
  });

  ipcMain.handle('profile:set', (_event, _scope: string, content: string) => {
    try {
      const path = getUserProfilePath('work');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof content === 'string' ? content : '', 'utf8');
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  const localVoiceDefault = async (kind: 'stt' | 'tts'): Promise<'local' | null> => {
    try {
      const m = await import('../services/localVoiceService.js');
      return kind === 'stt' ? m.resolveDefaultSttProvider() : m.resolveDefaultTtsProvider();
    } catch { return null; }
  };

  ipcMain.handle('tts:get-config', async () => {
    const config = loadConfig();
    /* apiKey 盘上是 enc:v1 密文 (旧配置可能仍是明文, unwrap 透传) — 解出真值再打码回显,
     * 尾 4 位才对得上用户自己的 key */
    const ttsPlainKey = unwrapApiKey(config.tts?.apiKey);
    return {
      enabled: config.tts?.enabled ?? false,
      provider: config.tts?.provider ?? (await localVoiceDefault('tts')) ?? 'edge',
      voice: config.tts?.voice ?? '',
      model: config.tts?.model ?? '',
      speed: config.tts?.speed ?? 1.0,
      format: config.tts?.format ?? 'mp3',
      autoSummarize: config.tts?.autoSummarize ?? true,
      maxSummaryChars: config.tts?.maxSummaryChars ?? 200,
      apiUrl: config.tts?.apiUrl ?? '',
      apiKey: ttsPlainKey ? '***' + ttsPlainKey.slice(-4) : '',
      voiceChatModel: config.voiceChatModel ?? '',
      localModel: config.tts?.localModel ?? '',
      dashscopeApiHost: config.tts?.dashscopeApiHost ?? '',
    };
  });

  ipcMain.handle('tts:set-config', async (event, updates: {
    enabled?: boolean;
    provider?: 'edge' | 'neoxcloud' | 'openai' | 'custom' | 'local' | 'dashscope' | 'volc' | 'xfyun';
    voice?: string;
    model?: string;
    speed?: number;
    format?: 'mp3' | 'opus' | 'pcm';
    autoSummarize?: boolean;
    maxSummaryChars?: number;
    apiUrl?: string;
    apiKey?: string;
    voiceChatModel?: string;
    localModel?: string;
    dashscopeApiHost?: string;
  }) => {
    try {
      const config = loadConfig();
      /* voiceChatModel 是顶层字段, 从 tts patch 里摘出去, 与 tts 一次合并落盘 */
      let voiceChatModel = config.voiceChatModel;
      if (typeof updates.voiceChatModel === 'string') {
        voiceChatModel = updates.voiceChatModel.trim() || undefined;
        delete (updates as Record<string, unknown>).voiceChatModel;
      }
      /* 跟 stt:set-config 同规矩: 打码回显值(***last4)不覆盖真 Key; 字符串字段去首尾空格
       * (用户粘贴 URL/Key 带尾空格曾致 BYOK STT 404) */
      const patch = { ...updates };
      if (typeof patch.apiKey === 'string' && patch.apiKey.startsWith('***')) delete patch.apiKey;
      for (const k of ['apiUrl', 'apiKey', 'model', 'voice'] as const) {
        if (typeof patch[k] === 'string') patch[k] = patch[k]!.trim();
      }
      /* dashscopeApiHost: 剥掉 https:// 前缀 + 结尾 / 和 /path — 只留主机名 */
      if (typeof patch.dashscopeApiHost === 'string') {
        patch.dashscopeApiHost = patch.dashscopeApiHost.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      }
      const tts = { ...(config.tts || {}), ...patch };
      if (typeof patch.provider === 'string' && config.tts?.provider && patch.provider !== config.tts.provider) {
        if (typeof patch.voice !== 'string') tts.voice = '';
        if (typeof patch.apiUrl !== 'string') tts.apiUrl = '';
        if (typeof patch.model !== 'string') tts.model = '';
        const FIELDS = ['voice', 'apiUrl', 'model', 'apiKey', 'dashscopeApiHost'] as const;
        const prevTts = config.tts as Record<string, unknown>;
        const byProvider: Record<string, Record<string, unknown>> = { ...((prevTts.byProvider as Record<string, Record<string, unknown>>) ?? {}) };
        const snapshot: Record<string, unknown> = {};
        for (const f of FIELDS) if (prevTts[f] !== undefined && prevTts[f] !== '') snapshot[f] = prevTts[f];
        byProvider[config.tts.provider] = snapshot;
        const saved = byProvider[patch.provider] ?? {};
        for (const f of FIELDS) {
          if (typeof patch[f] === 'string') continue;
          (tts as Record<string, unknown>)[f] = saved[f] ?? '';
        }
        (tts as Record<string, unknown>).byProvider = byProvider;
      }
      if (tts.enabled && !tts.provider) {
        const d = await localVoiceDefault('tts');
        if (d) tts.provider = d;
      }
      if (tts.provider === 'local') {
        const { ensureLocalTtsServer } = await import('../services/localVoiceService.js');
        await ensureLocalTtsServer();
        tts.format = 'wav';
      }
      if (typeof tts.apiKey === 'string' && tts.apiKey) tts.apiKey = wrapApiKey(tts.apiKey);
      saveConfig({ ...config, tts, voiceChatModel });
      // sender scope 的 bridge (没 scope 就跳过 runtime 通知)
      const client = await bridgeOf(event)?.getClientAsync();
      let runtimeWarning: string | undefined;
      if (client) {
        /* 全量同步到运行中 daemon —— 关着也要推 (曾"仅启用时同步省 RPC":用户关着播报
         *  配好 BYOK 字段, 语音对话进场只强开 {enabled}, daemon 拿内存旧字段 init 回落
         *  Edge, "配置了也没切换"). updateTTSConfig 内部按字段变化决定是否 re-init, 不贵.
         *  P0-5: 落盘成功但 runtime push 失败回传 warning, 不返 success:false. */
        runtimeWarning = await client.updateTTSConfig(tts)
          .then(() => undefined)
          .catch((err: unknown) => err instanceof Error ? err.message : String(err));
      }
      return { success: true, ...(runtimeWarning ? { runtimeWarning } : {}) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('tts:set-enabled', async (event, enabled: boolean) => {
    try {
      const config = loadConfig();
      let provider = config.tts?.provider;
      if (!provider) provider = (await localVoiceDefault('tts')) ?? 'edge';
      const tts = { ...(config.tts || {}), enabled, provider };
      if (provider === 'local') {
        const { ensureLocalTtsServer } = await import('../services/localVoiceService.js');
        await ensureLocalTtsServer().catch(() => { /* 桥起不来 — daemon 合成时报具体错 */ });
        tts.format = 'wav';
      }
      saveConfig({ ...config, tts });
      const client = await bridgeOf(event)?.getClientAsync();
      let runtimeWarning: string | undefined;
      if (client) {
        /* 缺省档刚被解析成 local — daemon 内存里还是启动时的旧 provider (edge),
         * 只 setTTSEnabled 会用错引擎, 推全量配置让 updateTTSConfig 按需 re-init */
        const push = (!config.tts?.provider && provider !== 'edge')
          ? client.updateTTSConfig(tts)
          : client.setTTSEnabled(enabled);
        runtimeWarning = await push
          .then(() => undefined)
          .catch((err: unknown) => err instanceof Error ? err.message : String(err));
      }
      return { success: true, ...(runtimeWarning ? { runtimeWarning } : {}) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  /* TTS 重播 —— 消息脚注"重新朗读": 文本 → daemon 合成 → base64 音频回渲染端播 */
  /* voice: 这一句换个音色 (Pilot 分身抽屉的「试听」/ 通话开场用分身自己的声音); 不传跟设置 */
  ipcMain.handle('tts:speak', async (event, text: string, voice?: string) => {
    try {
      const client = await bridgeOf(event)?.getClientAsync();
      if (!client) return { error: 'daemon 未就绪' };
      const v = typeof voice === 'string' && voice ? voice : undefined;
      return await (client as unknown as { ttsSpeak: (t: string, v?: string) => Promise<unknown> }).ttsSpeak(text, v);
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
  });

  /* STT —— 输入框语音按钮: 渲染端录音 base64 → daemon → 网关 ASR → 文本. */
  ipcMain.handle('stt:transcribe', async (event, audioBase64: string, format?: string) => {
    try {
      const sttCfg = loadConfig().stt;
      const effProvider = sttCfg?.provider ?? (await localVoiceDefault('stt')) ?? undefined;
      if (effProvider === 'local') {
        const { transcribeLocal } = await import('../services/localVoiceService.js');
        const buf = Buffer.from(audioBase64, 'base64');
        const raw = format === 'wav' && buf.length > 44 ? buf.subarray(44) : buf;
        const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
        const text = await transcribeLocal(pcm);
        return { success: true, text };
      }
      if (effProvider === 'xfyun') {
        const { getXfyunCreds, xfyunTranscribeOnce } = await import('../services/sttStreamManager.js');
        const creds = getXfyunCreds();
        if (!creds) return { success: false, error: '讯飞识别未配置齐 APPID/APIKey/APISecret' };
        const buf = Buffer.from(audioBase64, 'base64');
        const pcm = format === 'wav' && buf.length > 44 ? buf.subarray(44) : buf;
        const text = await xfyunTranscribeOnce(pcm, creds);
        return { success: true, text };
      }
      if (effProvider === 'custom' && sttCfg?.apiUrl?.trim()) {
        const buf = Buffer.from(audioBase64, 'base64');
        const mime = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : 'audio/webm';
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: mime }), `audio.${format || 'webm'}`);
        fd.append('model', sttCfg.customModel || 'whisper-1');
        if (sttCfg.language) fd.append('language', sttCfg.language);
        const base = sttCfg.apiUrl.trim().replace(/\/+$/, '');
        const url = /\/audio\/transcriptions/.test(base)
          ? base
          : /\/v\d+$/.test(base)
            ? `${base}/audio/transcriptions`
            : `${base}/v1/audio/transcriptions`;
        /* 盘上 apiKey 是 enc:v1 密文, 解出真值发请求 (旧明文配置 unwrap 透传) */
        const sttBearer = unwrapApiKey(sttCfg.apiKey);
        const resp = await fetch(url, {
          method: 'POST',
          headers: sttBearer ? { Authorization: `Bearer ${sttBearer}` } : undefined,
          body: fd,
          signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => '');
          return { success: false, error: `STT HTTP ${resp.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
        }
        const j = await resp.json().catch(() => null) as { text?: string } | null;
        return { success: true, text: j?.text ?? '' };
      }
      /* 订阅 (官方网关): 走流式识别一次性转写 —— 非流式 /audio/transcriptions 生产没有能用的模型 */
      const { gatewayTranscribeOnce } = await import('../services/sttStreamManager.js');
      const buf = Buffer.from(audioBase64, 'base64');
      const pcm = format === 'wav' && buf.length > 44 ? buf.subarray(44) : buf;
      const text = await gatewayTranscribeOnce(pcm);
      return { success: true, text };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  const maskSecret = (v: unknown): string => {
    const plain = typeof v === 'string' ? unwrapApiKey(v) : '';
    return plain ? '***' + plain.slice(-4) : '';
  };
  const maskProfile = (p: any): any => {
    if (!p || typeof p !== 'object') return p;
    const out: any = { ...p };
    if (out.apiKey) out.apiKey = maskSecret(out.apiKey);
    if (out.apiSecret) out.apiSecret = maskSecret(out.apiSecret);
    if (out.accessToken) out.accessToken = maskSecret(out.accessToken);
    return out;
  };
  /* 设置 → 语音的 Key 框: 点小眼睛 / 复制时才把真值给渲染层 (平时读到的都是 ***尾号)。
   * 只放语音这几个字段, 不做成「任意配置路径都能读」的口子。 */
  const REVEALABLE: Record<'stt' | 'tts', ReadonlySet<string>> = {
    stt: new Set(['apiKey', 'apiSecret', 'volcAccessToken']),
    tts: new Set(['apiKey']),
  };
  ipcMain.handle('voice:reveal-secret', (_event, section: 'stt' | 'tts', field: string) => {
    if ((section !== 'stt' && section !== 'tts') || !REVEALABLE[section].has(field)) return { ok: false };
    const raw = (loadConfig() as any)?.[section]?.[field];
    const value = typeof raw === 'string' ? unwrapApiKey(raw) : '';
    return value ? { ok: true, value } : { ok: false };
  });

  ipcMain.handle('stt:get-config', async () => {
    const config = loadConfig();
    const stt = config.stt ?? {};
    /* TLS 预热: VoiceMode 打开时恰好读一次配置 — 趁机把 BYOK 识别端点的
     * DNS+握手付掉, undici keep-alive 连接池给首次转写直接复用 (~省 200-300ms) */
    if (stt.provider === 'custom' && stt.apiUrl) {
      try {
        const origin = new URL(/^https?:\/\//.test(stt.apiUrl) ? stt.apiUrl : `https://${stt.apiUrl}`).origin;
        void fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(3000) }).catch(() => { /* noop */ });
      } catch { /* 不合法 URL — 转写时报错更清楚 */ }
    }
    return {
      enabled: stt.enabled !== false,
      provider: stt.provider ?? (await localVoiceDefault('stt')) ?? 'custom',
      /* 设置页据此判「订阅用户没选过 → 显示成走订阅」(上面那行没选过时会显示成 custom / local) */
      providerExplicit: !!stt.provider,
      apiUrl: stt.apiUrl ?? '',
      /* 盘上是 enc:v1 密文 — maskSecret 内部先 unwrap 再打码, 尾 4 位才有辨识度 */
      apiKey: maskSecret(stt.apiKey),
      customModel: stt.customModel ?? '',
      language: stt.language ?? '',
      appId: stt.appId ?? '',
      apiSecret: maskSecret(stt.apiSecret),
      volcAccessToken: maskSecret(stt.volcAccessToken),
      volcResourceId: stt.volcResourceId ?? '',
      dashscopeApiHost: stt.dashscopeApiHost ?? '',
      dashscopeConnMode: (stt as any).dashscopeConnMode ?? 'ws',
      voiceLockEnabled: stt.voiceLockEnabled ?? false,
      localModel: stt.localModel ?? '',
      localFinalizer: stt.localFinalizer ?? '',
      hotwords: stt.hotwords ?? '',
      termFix: stt.termFix ?? '',
      profiles: (stt.profiles || []).map(maskProfile),
      activeProfileId: stt.activeProfileId ?? '',
    };
  });

  ipcMain.handle('notify:set-life-prefs', async (
    _event,
    prefs: { quietHours?: { enabled: boolean; start: string; end: string } },
  ) => {
    const config = loadConfig();
    if (prefs.quietHours) config.lifeQuietHours = { ...prefs.quietHours };
    saveConfig(config);
    return { ok: true };
  });

  ipcMain.handle('voiceprint:status', async () => {
    const { voiceprintStatus } = await import('../services/voiceprintService.js');
    return { ...voiceprintStatus(), enabled: loadConfig().stt?.voiceLockEnabled ?? false };
  });
  ipcMain.handle('voiceprint:enroll', async (_event, pcmBase64: string) => {
    const { enrollVoiceprint } = await import('../services/voiceprintService.js');
    return enrollVoiceprint(pcmBase64);
  });
  ipcMain.handle('voiceprint:verify', async (_event, pcmBase64: string) => {
    const cfg = loadConfig().stt;
    if (!cfg?.voiceLockEnabled) return { match: true, score: 1 };
    const { verifyVoiceprint } = await import('../services/voiceprintService.js');
    return verifyVoiceprint(pcmBase64, cfg.voiceLockThreshold);
  });
  ipcMain.handle('voiceprint:clear', async () => {
    const { clearVoiceprint } = await import('../services/voiceprintService.js');
    clearVoiceprint();
    return { ok: true };
  });

  ipcMain.handle('localvoice:status', async () => {
    const m = await import('../services/localVoiceService.js');
    const { isPackInstalled, isPackAvailable } = await import('../services/assetPackService.js');
    return {
      supported: m.isPlatformSupported(),
      models: m.modelsStatus(),
      engineAvailable: isPackAvailable('voice-engine'),
      engineInstalled: isPackInstalled('voice-engine'),
    };
  });

  ipcMain.handle('assetpack:status', async () => {
    const { packsStatus } = await import('../services/assetPackService.js');
    return { packs: packsStatus() };
  });
  ipcMain.handle('assetpack:download', async (event, id: string) => {
    const { downloadPack } = await import('../services/assetPackService.js');
    try {
      await downloadPack(id, (pct, received, total) => {
        if (!event?.sender.isDestroyed()) {
          try { event?.sender.send('assetpack:progress', { packId: id, pct, received, total }); } catch { /* noop */ }
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('assetpack:cancel', async (_event, id: string) => {
    const { cancelPackDownload } = await import('../services/assetPackService.js');
    cancelPackDownload(id);
    return { ok: true };
  });
  ipcMain.handle('assetpack:remove', async (_event, id: string) => {
    const { removePack } = await import('../services/assetPackService.js');
    removePack(id);
    return { ok: true };
  });
  ipcMain.handle('localvoice:download', async (event, id: string, source: 'auto' | 'cn' | 'global') => {
    const m = await import('../services/localVoiceService.js');
    return m.downloadModel(id, source || 'auto', event?.sender);
  });
  ipcMain.handle('localvoice:pause', async (_event, id: string) => {
    const m = await import('../services/localVoiceService.js');
    return m.pauseDownload(id);
  });
  /* 导入用户自己的识别模型: 主进程弹选文件夹 → localAsr 认类型 + 拷进 models/custom-* */
  ipcMain.handle('localvoice:import-model', async (event) => {
    try {
      /* electron 在调用时才取 (本文件也会在纯 Node 的桥里加载, 顶层 import 会让整包起不来) */
      const { dialog, BrowserWindow } = await import('electron');
      const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
      const opts = { properties: ['openDirectory' as const], title: '选择模型文件夹 (sherpa-onnx 格式)' };
      const picked = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
      const { importCustomModel } = await import('../services/localAsr.js');
      return importCustomModel(picked.filePaths[0]);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('localvoice:remove', async (_event, id: string) => {
    const m = await import('../services/localVoiceService.js');
    m.removeModel(id);
    return { ok: true };
  });
  ipcMain.handle('stt:set-config', (_event, updates: {
    enabled?: boolean;
    provider?: 'official' | 'custom' | 'xfyun' | 'dashscope' | 'volc' | 'local';
    apiUrl?: string;
    apiKey?: string;
    customModel?: string;
    language?: string;
    appId?: string;
    apiSecret?: string;
    volcAccessToken?: string;
    volcResourceId?: string;
    dashscopeApiHost?: string;
    dashscopeConnMode?: 'ws' | 'http';
    voiceLockEnabled?: boolean;
    voiceLockThreshold?: number;
    localModel?: string;
    localFinalizer?: string;
    hotwords?: string;
    termFix?: string;
    profiles?: any[];
    activeProfileId?: string;
  }) => {
    try {
      const config = loadConfig();
      const prev = config.stt ?? {};
      const next: any = { ...prev, ...updates };
      /* 全字段 trim — 网页复制粘贴常带首尾空格 (URL 尾空格曾直接 404) */
      if (typeof next.apiUrl === 'string') next.apiUrl = next.apiUrl.trim();
      if (typeof next.customModel === 'string') next.customModel = next.customModel.trim();
      if (typeof next.language === 'string') next.language = next.language.trim();
      if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim();
      if (typeof next.appId === 'string') next.appId = next.appId.trim();
      if (typeof next.apiSecret === 'string') next.apiSecret = next.apiSecret.trim();
      if (typeof next.volcAccessToken === 'string') next.volcAccessToken = next.volcAccessToken.trim();
      if (typeof next.volcResourceId === 'string') next.volcResourceId = next.volcResourceId.trim();
      if (typeof next.dashscopeApiHost === 'string') {
        /* 剥掉 https:// 前缀 + 结尾 / 和 /path — apiHost 只留主机名 */
        next.dashscopeApiHost = next.dashscopeApiHost.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      }
      if (typeof updates.provider === 'string' && prev.provider && updates.provider !== prev.provider) {
        const FIELDS = ['apiUrl', 'apiKey', 'customModel', 'appId', 'apiSecret', 'volcAccessToken', 'volcResourceId', 'dashscopeApiHost', 'dashscopeConnMode', 'language'] as const;
        const byProvider: Record<string, Record<string, unknown>> = { ...((prev as any).byProvider ?? {}) };
        const snapshot: Record<string, unknown> = {};
        for (const f of FIELDS) if ((prev as any)[f] !== undefined && (prev as any)[f] !== '') snapshot[f] = (prev as any)[f];
        byProvider[prev.provider] = snapshot;
        const saved = byProvider[updates.provider] ?? {};
        for (const f of FIELDS) {
          if (f in updates) continue;   /* 同一次提交显式带了值的不动 */
          next[f] = saved[f] ?? (f === 'dashscopeConnMode' ? undefined : '');
        }
        next.byProvider = byProvider;
      }
      /* 打码回显值不覆盖真 key */
      const isMasked = (s: unknown) => typeof s === 'string' && s.trim().startsWith('***');
      if (isMasked(updates.apiKey)) next.apiKey = prev.apiKey;
      if (isMasked(updates.apiSecret)) next.apiSecret = prev.apiSecret;
      if (isMasked(updates.volcAccessToken)) next.volcAccessToken = (prev as any).volcAccessToken;
      if (Array.isArray(updates.profiles)) {
        const prevProfiles: any[] = (prev as any).profiles || [];
        const prevById = new Map(prevProfiles.map(p => [p.id, p]));
        next.profiles = updates.profiles.map((p: any) => {
          const cur = { ...p };
          if (cur.name) cur.name = String(cur.name).trim();
          const oldP = prevById.get(cur.id);
          if (oldP) {
            if (isMasked(cur.apiKey)) cur.apiKey = oldP.apiKey;
            if (isMasked(cur.apiSecret)) cur.apiSecret = oldP.apiSecret;
            if (isMasked(cur.accessToken)) cur.accessToken = oldP.accessToken;
          } else {
            /* 新 profile: 若字段是打码, 说明前端"另存当前单档" — 从 prev 单档拷真值 */
            const pv = prev as any;
            if (isMasked(cur.apiKey)) cur.apiKey = pv.apiKey || '';
            if (isMasked(cur.apiSecret)) cur.apiSecret = pv.apiSecret || '';
            if (isMasked(cur.accessToken)) cur.accessToken = pv.volcAccessToken || '';
          }
          /* trim 各字段 */
          for (const k of ['apiKey', 'apiSecret', 'accessToken', 'apiUrl', 'appId', 'model', 'language', 'resourceId']) {
            if (typeof cur[k] === 'string') cur[k] = cur[k].trim();
          }
          return cur;
        });
      }
      const wrapField = (obj: any, key: string) => {
        if (typeof obj[key] === 'string' && obj[key]) obj[key] = wrapApiKey(obj[key]);
      };
      wrapField(next, 'apiKey');
      wrapField(next, 'apiSecret');
      wrapField(next, 'volcAccessToken');
      if (Array.isArray(next.profiles)) {
        for (const p of next.profiles) {
          if (!p || typeof p !== 'object') continue;
          wrapField(p, 'apiKey');
          wrapField(p, 'apiSecret');
          wrapField(p, 'accessToken');
        }
      }
      saveConfig({ ...config, stt: next });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('voice-config:get', () => {
    const config = loadConfig();
    const voice = (config as unknown as { voice?: { wakeWord?: { enabled?: boolean; provider?: string; endpoint?: string; keyword?: string } } }).voice ?? {};
    return {
      wakeWord: {
        enabled: voice.wakeWord?.enabled ?? false,
        provider: voice.wakeWord?.provider ?? 'official',
        endpoint: voice.wakeWord?.endpoint ?? '',
        keyword: voice.wakeWord?.keyword ?? 'Hey Neox',
      },
    };
  });
  ipcMain.handle('voice-config:set', (_event, patch: {
    wakeWord?: { enabled?: boolean; provider?: 'official' | 'local-http' | 'custom'; endpoint?: string; keyword?: string };
  }) => {
    const config = loadConfig() as unknown as Record<string, unknown> & {
      voice?: { wakeWord?: { enabled?: boolean; provider?: string; endpoint?: string; keyword?: string } };
    };
    const voice = config.voice ?? {};
    const cur = voice.wakeWord ?? {};
    voice.wakeWord = {
      enabled: patch.wakeWord?.enabled ?? cur.enabled ?? false,
      provider: patch.wakeWord?.provider ?? cur.provider ?? 'official',
      endpoint: patch.wakeWord?.endpoint ?? cur.endpoint ?? '',
      keyword: (patch.wakeWord?.keyword ?? cur.keyword ?? 'Hey Neox').slice(0, 32),
    };
    config.voice = voice;
    saveConfig(config as unknown as Parameters<typeof saveConfig>[0]);
    return { success: true, wakeWord: voice.wakeWord };
  });

  ipcMain.handle('experimental:get-config', () => {
    const config = loadConfig();
    return {
      enableFGTS: config.experimental?.enableFGTS ?? true,
      enablePTC: config.experimental?.enablePTC ?? false,
      enableCheckpoint: config.experimental?.enableCheckpoint ?? false,
      documentParseMode: config.experimental?.documentParseMode ?? 'local',
      /* key 不回传明文, 只告诉界面有没有、尾巴几位 */
      jevEnabled: config.experimental?.jev?.enabled ?? false,
      jevKeyHint: maskJevKey(unwrapApiKey(config.experimental?.jev?.apiKey)),
    };
  });

  ipcMain.handle('experimental:set-config', (_event, updates: {
    enableFGTS?: boolean;
    enablePTC?: boolean;
    enableCheckpoint?: boolean;
    documentParseMode?: 'local' | 'cloud';
    jevEnabled?: boolean;
    /** 明文, 空串 = 清除 */
    jevApiKey?: string;
  }) => {
    try {
      const config = loadConfig();
      const { jevEnabled, jevApiKey, ...flat } = updates;
      const experimental = { ...(config.experimental || {}), ...flat };
      if (jevEnabled !== undefined || jevApiKey !== undefined) {
        const jev = { ...(experimental.jev || {}) };
        if (jevEnabled !== undefined) jev.enabled = jevEnabled;
        if (jevApiKey !== undefined) jev.apiKey = jevApiKey.trim() ? wrapApiKey(jevApiKey.trim()) : undefined;
        experimental.jev = jev;
      }
      saveConfig({ ...config, experimental });
      return { success: true, needsRestart: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  /* Jev 草稿预判: 输入框停顿时发来, 转给本窗口的 runtime。尽力而为, 永远返回。 */
  ipcMain.handle('jev:prefetch', async (event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) return;
    try {
      /* 没开就不往 runtime 递 —— 输入框每次停顿都会来一发 */
      if (!loadConfig().experimental?.jev?.enabled) return;
      await bridgeOf(event)?.jevPrefetch(text);
    } catch { /* 预判失败不影响发送 */ }
  });

  /* Jev 连通测试: 真发一道题, 回延迟和模型版本。不传 key 就用已存的。 */
  ipcMain.handle('experimental:jev-test', async (_event, apiKey?: string) => {
    const stored = unwrapApiKey(loadConfig().experimental?.jev?.apiKey);
    const key = (apiKey ?? '').trim() || stored.trim();
    if (!key) return { success: false, error: 'no_key' };
    try {
      const r = await askJev(
        { apiKey: key, model: JEV_DEFAULT_MODEL },
        { request: 'open github.com in the browser' },
        { probe: { type: 'noul', instructions: 'Does `request` ask to use a web browser?' } },
        { timeoutMs: 8000 },
      );
      const probe = r.answers.probe;
      return { success: true, ms: r.ms, model: r.model, ok: probe?.type === 'noul' && probe.noul > 0.5 };
    } catch (e: any) {
      return { success: false, error: e?.message ?? String(e), status: e?.status };
    }
  });

  ipcMain.handle('agent-mode:get-default', () => {
    const config = loadConfig();
    return { defaultAgentMode: config.defaultAgentMode ?? 'code' };
  });

  ipcMain.handle('agent-mode:set-default', (_event, mode: string) => {
    try {
      const applied = normalizeAgentMode(mode);
      const config = loadConfig();
      if (config.defaultAgentMode !== applied) {
        console.info(`[agent-mode] default ${config.defaultAgentMode ?? '-'} → ${applied}`);
      }
      saveConfig({ ...config, defaultAgentMode: applied });
      void import('../services/applicationMenu.js')
        .then(m => m.applyApplicationMenuForMode(applied))
        .catch(() => { /* 菜单重建失败不影响模式切换 */ });
      return { success: true, defaultAgentMode: applied };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('agent-mode:ensure-home', async (_event, mode: string) => {
    try {
      if (mode !== 'assistant' && mode !== 'work' && mode !== 'code' && mode !== 'pilot') {
        return { success: false, error: 'invalid mode' };
      }
      const { ensureModeHome } = await import('@neoxlabs/core/runtime/modeHome.js');
      const path = ensureModeHome(normalizeAgentMode(mode));
      return { success: true, path };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  /* 读用户画像文件 (Dashboard 展示) — 无需鉴权, 用户自己写自己的画像 */
  ipcMain.handle('agent-mode:read-profile', async (_event, mode: string) => {
    try {
      if (mode !== 'work') return { success: false, content: '' };
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const file = join(homedir(), NEOX_HOME_DIRNAME, `user_profile_${mode}.md`);
      const content = await readFile(file, 'utf8').catch(() => '');
      return { success: true, content };
    } catch (e: any) {
      return { success: false, content: '', error: e.message };
    }
  });

  /* 建档问卷结果 → ~/.neox/user_profile_<mode>.md (用户级, 跨 workspace)。
   * Phase 3 接 prompt 注入; 现在先落盘, 设置页/引导页都能重写。 */
  ipcMain.handle('agent-mode:save-profile', async (_event, mode: string, markdown: string) => {
    try {
      if (mode !== 'assistant' && mode !== 'work') return { success: false, error: 'invalid mode' };
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = join(homedir(), NEOX_HOME_DIRNAME);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `user_profile_${mode}.md`);
      await writeFile(file, String(markdown ?? ''), 'utf8');
      return { success: true, path: file };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('supervisor:get-config', () => {
    const config = loadConfig();
    return {
      enabled: config.supervisor?.enabled ?? false,
      collaborationMode: config.supervisor?.collaborationMode ?? false,
      language: config.supervisor?.language ?? 'zh',
      model: config.supervisor?.model ?? 'claude-haiku-4-5-20251001',
      providerId: config.supervisor?.providerId ?? '',
    };
  });

  ipcMain.handle('supervisor:set-config', (_event, updates: {
    enabled?: boolean;
    collaborationMode?: boolean;
    language?: 'zh' | 'en';
    model?: string;
    providerId?: string;
  }) => {
    try {
      const config = loadConfig();
      const supervisor = { ...(config.supervisor || {}), ...updates };
      saveConfig({ ...config, supervisor });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('runconfig:get', () => {
    const config = loadConfig();
    return {
      runMode: config.runMode ?? 'agentic',
      modes: config.runConfig?.modes ?? {},
    };
  });

  ipcMain.handle('runconfig:set-mode-config', (_event, mode: string, modeConfig: any) => {
    try {
      const config = loadConfig();
      const runConfig = config.runConfig || { modes: {} };
      const prevMode = (runConfig.modes as any)?.[mode] || {};
      // sideAgent 是嵌套对象,要做 deep merge,避免一次只传 features.explore 时把 providerId/model 擦掉
      const mergedSideAgent = modeConfig?.sideAgent !== undefined
        ? {
          ...(prevMode.sideAgent || {}),
          ...modeConfig.sideAgent,
          features: {
            ...((prevMode.sideAgent || {}).features || {}),
            ...((modeConfig.sideAgent || {}).features || {}),
          },
        }
        : prevMode.sideAgent;
      const merged = {
        ...prevMode,
        ...modeConfig,
        ...(mergedSideAgent !== undefined ? { sideAgent: mergedSideAgent } : {}),
        updatedAt: new Date().toISOString(),
      };
      const modes = { ...(runConfig.modes || {}), [mode]: merged };
      saveConfig({ ...config, runConfig: { ...runConfig, modes } });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('organization:get-status', (event) => {
    try {
      return buildOrganizationStatus(event);
    } catch (e: any) {
      return {
        exists: false,
        configPath: '',
        departments: 0,
        members: 0,
        error: e.message,
      };
    }
  });

  ipcMain.handle('organization:create-default-config', (event) => {
    try {
      const workDir = workdirOf(event);
      const service = new OrganizationConfigService(workDir);
      const alreadyExists = service.hasConfig();
      if (!alreadyExists) {
        service.createDefaultConfig();
      }
      return { success: true, created: !alreadyExists, status: buildOrganizationStatus(event) };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });
}
