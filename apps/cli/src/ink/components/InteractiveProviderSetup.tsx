import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from '../../../vendor/ink/src/index.js';
import {
  modelRegistry,
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  DEEPSEEK_MODELS,
  type ModelMetadata,
} from '@neoxlabs/platform/models/registry/index.js';
import { t, formatMessage } from '../../i18n/index.js';

export interface ProviderConfigResult {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface InteractiveProviderSetupProps {
  onComplete: (config: ProviderConfigResult) => void;
  onCancel: () => void;
}

type SetupStep = 'name' | 'protocol' | 'baseUrl' | 'apiKey' | 'model' | 'confirm';

interface ProtocolOption {
  value: string;
  label: string;
  defaultUrl: string;
  providerKey: string; // 用于从注册表获取模型
}

const PROTOCOLS: ProtocolOption[] = [
  { value: 'openai', label: 'OpenAI (Chat Completions)', defaultUrl: 'https://api.openai.com/v1', providerKey: 'openai' },
  { value: 'openai-responses', label: 'OpenAI (Responses API)', defaultUrl: 'https://api.openai.com/v1', providerKey: 'openai' },
  { value: 'kimi', label: 'Kimi (Moonshot)', defaultUrl: 'https://api.moonshot.cn/v1', providerKey: 'kimi' },
  { value: 'anthropic', label: 'Anthropic (Claude)', defaultUrl: 'https://api.anthropic.com', providerKey: 'anthropic' },
  { value: 'anthropic-openai', label: 'Anthropic (OpenAI 格式)', defaultUrl: 'https://api.anthropic.com/v1', providerKey: 'anthropic' },
  { value: 'gemini', label: 'Gemini', defaultUrl: 'https://generativelanguage.googleapis.com', providerKey: 'gemini' },
  { value: 'doubao', label: '豆包 (Doubao)', defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3', providerKey: 'doubao' },
  { value: 'glm', label: 'GLM (智谱 AI)', defaultUrl: 'https://open.bigmodel.cn/api/paas/v4', providerKey: 'glm' },
  { value: 'deepseek', label: 'DeepSeek', defaultUrl: 'https://api.deepseek.com/v1', providerKey: 'deepseek' },
];

async function probeApiKey(opts: { baseUrl: string; apiKey: string; protocol: string }): Promise<
  { ok: true; modelCount?: number } | { ok: false; status?: number; reason: string }
> {
  const base = (opts.baseUrl || '').replace(/\/+$/, '');
  if (!base || !opts.apiKey) return { ok: false, reason: 'baseUrl 或 apiKey 为空' };
  /* anthropic native uses x-api-key, openai-compat uses Authorization Bearer.
   * gemini 走 ?key=xxx query — 用 Bearer 多数 cn 镜像也兼容, 不严格 */
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.protocol === 'anthropic') {
    headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['authorization'] = `Bearer ${opts.apiKey}`;
  }
  const url = `${base}/models`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, status: resp.status, reason: `HTTP ${resp.status}` };
    }
    let count = 0;
    try {
      const j: any = await resp.json();
      const list = j?.data ?? j?.models ?? [];
      if (Array.isArray(list)) count = list.length;
    } catch { /* 不 fatal, count 留 0 */ }
    return { ok: true, modelCount: count };
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

/**
 * 交互式 Provider 配置向导
 * 使用 Ink 实现原地刷新渲染
 */
export const InteractiveProviderSetup: React.FC<InteractiveProviderSetupProps> = ({
  onComplete,
  onCancel,
}) => {
  const { exit } = useApp();
  const { write } = useStdout();
  const [step, setStep] = useState<SetupStep>('name');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prevStepRef = useRef<SetupStep>('name');

  // 表单数据
  const [name, setName] = useState('My Provider');
  const [protocol, setProtocol] = useState('');
  const [protocolProviderKey, setProtocolProviderKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  /* apiKey 验证状态 — 进 confirm 页时自动探针, 不阻塞用户 Enter 保存. */
  const [probeState, setProbeState] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [probeMsg, setProbeMsg] = useState<string>('');

  // 文本输入状态
  const [inputValue, setInputValue] = useState('My Provider');
  const [cursorVisible, setCursorVisible] = useState(true);

  /* 进 confirm 页自动跑 probe — 失败 / 成功都不阻塞, 只显结果让用户判断. */
  useEffect(() => {
    if (step !== 'confirm') return;
    setProbeState('running');
    setProbeMsg('正在验证 API Key (可按 Enter 跳过, 直接保存)...');
    probeApiKey({ baseUrl, apiKey, protocol })
      .then((r) => {
        if (r.ok) {
          setProbeState('ok');
          setProbeMsg(r.modelCount ? `API Key 有效 · 远端 ${r.modelCount} 个模型可见` : 'API Key 有效');
        } else {
          setProbeState('fail');
          /* 401/403 = 钥匙错 / 网络/其他 = 连不上 — 分类提示 */
          const hint = r.status === 401 || r.status === 403 ? 'API Key 可能错或权限不足'
            : r.status ? `远端返 ${r.status} (端点可能不支持 /models, 不一定是 key 错)`
            : `网络问题或端点不支持: ${r.reason.slice(0, 60)}`;
          setProbeMsg(hint);
        }
      })
      .catch((e) => {
        setProbeState('fail');
        setProbeMsg(`验证失败: ${e?.message ?? e}`.slice(0, 80));
      });
  }, [step, baseUrl, apiKey, protocol]);

  useEffect(() => {
    if (prevStepRef.current !== step) {
      // Clear screen: move cursor up and clear lines
      // Use ANSI escape codes to clear the screen area
      write('\x1b[2J\x1b[H'); // Clear entire screen and move cursor to home
      prevStepRef.current = step;
    }
  }, [step, write]);

  // 光标闪烁
  React.useEffect(() => {
    const timer = setInterval(() => setCursorVisible(v => !v), 500);
    return () => clearInterval(timer);
  }, []);

  // 从注册表获取当前协议的模型列表
  const currentModels = useMemo(() => {
    if (!protocolProviderKey) return [];
    const models = modelRegistry.getModelsByProvider(protocolProviderKey);
    // 按评分排序，过滤掉已弃用的
    return models
      .filter(m => !m.deprecated)
      .sort((a, b) => (b.scores?.coding ?? 0) - (a.scores?.coding ?? 0));
  }, [protocolProviderKey]);

  useInput((input, key) => {
    // ESC 取消
    if (key.escape) {
      onCancel();
      exit();
      return;
    }

    // 菜单式步骤
    if (step === 'protocol' || step === 'model') {
      const options = step === 'protocol' ? PROTOCOLS : currentModels;

      if (key.upArrow) {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : options.length - 1));
      }
      if (key.downArrow) {
        setSelectedIndex(prev => (prev < options.length - 1 ? prev + 1 : 0));
      }
      if (key.return) {
        if (step === 'protocol') {
          const selected = PROTOCOLS[selectedIndex];
          setProtocol(selected.value);
          setProtocolProviderKey(selected.providerKey);
          setInputValue(selected.defaultUrl);
          setStep('baseUrl');
          setSelectedIndex(0);
        } else {
          const selectedModel = currentModels[selectedIndex];
          setModel(selectedModel.id);
          setStep('confirm');
        }
      }
      return;
    }

    // 确认步骤
    if (step === 'confirm') {
      if (key.return) {
        onComplete({ name, protocol, baseUrl, apiKey, model });
        exit();
      }
      return;
    }

    // 文本输入步骤
    if (key.return) {
      if (step === 'name') {
        setName(inputValue || 'My Provider');
        setInputValue('');
        setStep('protocol');
        setSelectedIndex(0);
      } else if (step === 'baseUrl') {
        const p = PROTOCOLS.find(p => p.value === protocol);
        setBaseUrl(inputValue || p?.defaultUrl || '');
        setInputValue('');
        setStep('apiKey');
      } else if (step === 'apiKey') {
        if (inputValue.trim().length > 0) {
          setApiKey(inputValue);
          setInputValue('');
          setStep('model');
          setSelectedIndex(0);
        }
      }
      return;
    }

    // 退格
    if (key.backspace || key.delete) {
      setInputValue(prev => prev.slice(0, -1));
      return;
    }

    // 普通字符输入
    if (input && !key.ctrl && !key.meta) {
      setInputValue(prev => prev + input);
    }
  });

  // 渲染文本输入框
  const renderTextInput = (label: string, placeholder: string, isPassword = false) => {
    const displayValue = isPassword ? '*'.repeat(inputValue.length) : inputValue;
    const cursor = cursorVisible ? '█' : ' ';

    return (
      <Box flexDirection="column">
        <Text bold>{label}</Text>
        <Box marginTop={1}>
          <Text color="cyan">{'> '}</Text>
          <Text>{displayValue}</Text>
          <Text color="gray">{cursor}</Text>
        </Box>
        {placeholder && !inputValue && (
          <Box marginLeft={2}><Text dimColor>({placeholder})</Text></Box>
        )}
      </Box>
    );
  };

  // 渲染协议菜单
  const renderProtocolMenu = () => {
    return (
      <Box flexDirection="column">
        <Text bold>{t().ui.selectProtocol}</Text>
        <Box flexDirection="column" marginTop={1}>
          {PROTOCOLS.map((opt, idx) => {
            const sel = idx === selectedIndex;
            return (
              <Box key={opt.value}>
                <Text backgroundColor={sel ? 'cyan' : undefined} color={sel ? 'black' : 'white'} bold={sel}>
                  {' '}{opt.label}{' '}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  };

  // 渲染模型菜单（从注册表读取）
  const renderModelMenu = () => {
    const displayModels = currentModels.slice(0, 10);
    const hasMore = currentModels.length > 10;
    return (
      <Box flexDirection="column">
        <Text bold>{t().ui.selectDefaultModel}</Text>
        <Text dimColor>{formatMessage(t().ui.modelsAvailable, { count: currentModels.length })}</Text>
        <Box flexDirection="column" marginTop={1}>
          {displayModels.map((m, idx) => {
            const sel = idx === selectedIndex;
            const scoreInfo = m.scores?.coding ? `[code:${m.scores.coding}]` : '';
            return (
              <Box key={m.id}>
                <Text backgroundColor={sel ? 'cyan' : undefined} color={sel ? 'black' : 'white'} bold={sel}>
                  {' '}{m.id.padEnd(30)}{' '}
                </Text>
                <Text dimColor> {scoreInfo}</Text>
              </Box>
            );
          })}
          {hasMore && selectedIndex < 10 && (
            <Box marginTop={1}><Text dimColor>  ... {formatMessage(t().ui.moreModels, { count: currentModels.length - 10 })}</Text></Box>
          )}
        </Box>
      </Box>
    );
  };

  // 渲染确认页面
  const renderConfirm = () => {
    const selectedModel = modelRegistry.getModel(model);
    /* 验证状态徽章 — 颜色按结果, 但 Enter 都能保存 (非阻塞验证) */
    const probeBadge =
      probeState === 'running' ? <Text color="cyan">⟳ {probeMsg}</Text>
      : probeState === 'ok'    ? <Text color="green">✓ {probeMsg}</Text>
      : probeState === 'fail'  ? <Text color="yellow">⚠ {probeMsg}</Text>
      : null;
    return (
      <Box flexDirection="column">
        <Text bold color="green">{t().ui.configConfirm}</Text>
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>{t().ui.name}:     <Text color="cyan">{name}</Text></Text>
          <Text>{t().ui.protocol}:     <Text color="cyan">{PROTOCOLS.find(p => p.value === protocol)?.label}</Text></Text>
          <Text>Base URL: <Text color="cyan">{baseUrl}</Text></Text>
          <Text>API Key:  <Text color="cyan">{'*'.repeat(Math.min(apiKey.length, 20))}...</Text></Text>
          <Text>{t().ui.model}:     <Text color="cyan">{model}</Text></Text>
          {selectedModel && (
            <Text dimColor>
              (in: {(selectedModel.maxInputTokens / 1000).toFixed(0)}K, out: {(selectedModel.maxOutputTokens / 1000).toFixed(0)}K)
            </Text>
          )}
        </Box>
        {probeBadge && (
          <Box marginTop={1} marginLeft={2}>{probeBadge}</Box>
        )}
        <Box marginTop={1}>
          <Text color="yellow">{t().ui.pressEnterToConfirm}</Text>
        </Box>
      </Box>
    );
  };

  // 渲染进度指示
  const steps = ['name', 'protocol', 'baseUrl', 'apiKey', 'model', 'confirm'];
  const currentStepIndex = steps.indexOf(step);
  const progress = `${currentStepIndex + 1}/${steps.length}`;

  const width = process.stdout.columns || 80;
  const isLegacyWindows = process.platform === 'win32' && !process.env.WT_SESSION;
  const LOGO_ANSI = [
    '███╗   ██╗███████╗ ██████╗ ██╗  ██╗',
    '████╗  ██║██╔════╝██╔═══██╗╚██╗██╔╝',
    '██╔██╗ ██║█████╗  ██║   ██║ ╚███╔╝ ',
    '██║╚██╗██║██╔══╝  ██║   ██║ ██╔██╗ ',
    '██║ ╚████║███████╗╚██████╔╝██╔╝ ██╗',
    '╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝',
  ];
  const LOGO_SMALL = [
    ' _   _ ___ _____  __',
    '| \\ | | __|  _  \\ \\/ /',
    '|  \\| | _|| |_| |>  < ',
    '|_|\\__|___|_____/_/\\_\\',
  ];
  const GRADIENT = ['#00E5D9', '#00B5E6', '#5478E6', '#9966FF', '#D946C9', '#FF3B9A', '#FF6FB5'];
  const logo = width < 60 || isLegacyWindows ? LOGO_SMALL : LOGO_ANSI;
  const colorAt = (p: number) => GRADIENT[Math.min(GRADIENT.length - 1, Math.max(0, Math.round(p * (GRADIENT.length - 1))))];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      {/* NEOX logo (gradient) */}
      <Box flexDirection="column">
        {logo.map((line, i) => (
          <Text key={i} color={colorAt(i / Math.max(logo.length - 1, 1))} bold>{line}</Text>
        ))}
      </Box>

      {/* 进度指示 */}
      <Box marginTop={1}>
        <Text dimColor>Provider 配置 · 第 {progress} 步</Text>
      </Box>

      {/* 当前步骤内容 */}
      <Box marginTop={1}>
        {step === 'name' && renderTextInput('Provider Name', 'Default: My Provider')}
        {step === 'protocol' && renderProtocolMenu()}
        {step === 'baseUrl' && renderTextInput(
          'Base URL (回车 = 用官方地址; 自定义 = 代理 / 自建 API)',
          `默认: ${PROTOCOLS.find(p => p.value === protocol)?.defaultUrl || ''}`,
        )}
        {step === 'apiKey' && renderTextInput('API Key', '', true)}
        {step === 'model' && renderModelMenu()}
        {step === 'confirm' && renderConfirm()}
      </Box>

      {/* 操作提示 */}
      <Box marginTop={1}>
        <Text dimColor>
          {(step === 'protocol' || step === 'model') ? '↑↓ 选择 · ' : ''}
          enter 确认 · esc 取消 · ctrl+c 退出
        </Text>
      </Box>
    </Box>
  );
};
