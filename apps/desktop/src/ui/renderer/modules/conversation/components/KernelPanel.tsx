/**
 * KernelPanel — Agent OS 内核可视化 V2
 *
 * 重新设计：
 * - 左侧紧凑神经图 + 右侧子系统详情面板
 * - 点击子系统节点展示详细指标与事件
 * - 充分利用横向空间
 * - 动态粒子连线 + 活性指示器
 */
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useI18n, getGlobalLanguage } from '../../../hooks/useI18n';

declare const window: Window & { neox?: { getKernelDiagnostics?: () => Promise<any> } };

// ============================================================================
// Types
// ============================================================================
interface SubsystemNode {
  id: string;
  label: string;
  labelEn: string;
  color: string;
  angle: number;
  description: string;
  descriptionEn: string;
}

interface KernelDiagnostics {
  status: string;
  system?: {
    bootedAt: number;
    tickCount: number;
    activeProcessCount: number;
    shuttingDown: boolean;
  };
  scheduler?: { runningCount: number; queuedCount: number; totalScheduled: number };
  messageBus?: { totalSent: number; totalReceived: number; channelCount: number };
  perception?: { totalProcessed: number; sourceCount: number };
  context?: { totalAssembled: number; totalEvictions: number };
  cognition?: { totalProcessed: number; system1Hits: number; system2Invocations: number };
  interrupts?: { totalRaised: number; totalHandled: number };
  processes?: { pid: string; role: string; state: string; task: string }[];
}

interface SubsystemDetail {
  metrics: { label: string; value: string | number; color?: string }[];
  events: { label: string; detail?: string; status: 'active' | 'idle' | 'warn' }[];
}

// ============================================================================
// SVG Icon Paths — minimalist stroke-based line art
// Each icon is designed for a 16x16 viewBox, stroke-only, 1.3px stroke
// ============================================================================
const ICON_PATHS: Record<string, string> = {
  // Scheduler: clock with gear teeth
  scheduler:  'M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M4.1 11.9l1.4-1.4M10.5 5.5l1.4-1.4M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
  // Cognition: brain hemispheres
  cognition:  'M8 3c-1.5 0-3 .8-3 2.5S6 8 8 8M8 3c1.5 0 3 .8 3 2.5S10 8 8 8M8 8c-1.5 0-3 .8-3 2.5S6.5 13 8 13M8 8c1.5 0 3 .8 3 2.5S9.5 13 8 13M5 6.5h6M5 9.5h6',
  // Perception: eye with pupil
  perception: 'M2.5 8c1.2-2.8 3.2-4 5.5-4s4.3 1.2 5.5 4c-1.2 2.8-3.2 4-5.5 4S3.7 10.8 2.5 8ZM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  // Context: stacked layers
  context:    'M3 8l5-3 5 3-5 3ZM3 10l5 3 5-3M3 6l5 3 5-3',
  // Attention: crosshair focus
  attention:  'M8 2v3M8 11v3M2 8h3M11 8h3M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  // Interrupt: lightning bolt
  interrupt:  'M9.5 2L6 8h3l-1.5 6L11 8H8Z',
  // MessageBus: connected nodes (network)
  messageBus: 'M4 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5.3 4.2l2.3 7.3M10.7 4.2L8.4 11.5M5.5 3.5h5',
  // Core: circuit brain
  _core:      'M8 3v10M5 5h6M5 8h6M5 11h6M5 5v6M11 5v6M3 6.5h2M3 9.5h2M11 6.5h2M11 9.5h2',
};

/** Render an SVG icon inline in an HTML context (detail panel, quick cards) */
function renderHtmlIcon(nodeId: string, color: string, size = 14): React.ReactElement {
  const d = ICON_PATHS[nodeId] || ICON_PATHS._core;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
      <path d={d} stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Render an SVG icon at position (x,y) inside parent SVG (neural graph nodes) */
function renderSvgIcon(nodeId: string, x: number, y: number, color: string, opacity: number, size = 12): React.ReactElement {
  const d = ICON_PATHS[nodeId] || ICON_PATHS._core;
  const half = size / 2;
  return (
    <g transform={`translate(${x - half},${y - half}) scale(${size / 16})`} opacity={opacity}
      style={{ pointerEvents: 'none' }}>
      <path d={d} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </g>
  );
}

// ============================================================================
// Subsystem Definitions
// ============================================================================
const SUBSYSTEMS: SubsystemNode[] = [
  { id: 'scheduler',  label: '调度器',   labelEn: 'Scheduler',   color: '#38bdf8', angle: -Math.PI / 2,                          description: '负责进程调度、任务分配与队列管理',        descriptionEn: 'Process scheduling, task dispatch and queue management' },
  { id: 'cognition',  label: '认知引擎', labelEn: 'Cognition',   color: '#4ade80', angle: -Math.PI / 2 + (2 * Math.PI / 7),      description: '思维推理核心，System 1/2 双通道处理',     descriptionEn: 'Reasoning core with dual System 1/2 channels' },
  { id: 'perception', label: '感知系统', labelEn: 'Perception',  color: '#a78bfa', angle: -Math.PI / 2 + 2 * (2 * Math.PI / 7),  description: '接收外部信号、用户输入与环境感知',        descriptionEn: 'Receives external signals, user input and environment awareness' },
  { id: 'context',    label: '上下文',   labelEn: 'Context',     color: '#60a5fa', angle: -Math.PI / 2 + 3 * (2 * Math.PI / 7),  description: '管理对话上下文的组装、裁剪与驱逐',        descriptionEn: 'Assembles, trims and evicts conversation context' },
  { id: 'attention',  label: '注意力',   labelEn: 'Attention',   color: '#f472b6', angle: -Math.PI / 2 + 4 * (2 * Math.PI / 7),  description: '注意力分配与焦点管理',                    descriptionEn: 'Attention allocation and focus management' },
  { id: 'interrupt',  label: '中断控制', labelEn: 'Interrupts',  color: '#fbbf24', angle: -Math.PI / 2 + 5 * (2 * Math.PI / 7),  description: '异步中断信号的产生与处理',                descriptionEn: 'Raises and handles async interrupt signals' },
  { id: 'messageBus', label: '消息总线', labelEn: 'Message Bus', color: '#34d399', angle: -Math.PI / 2 + 6 * (2 * Math.PI / 7),  description: '进程间通信的消息收发与频道管理',          descriptionEn: 'Inter-process messaging and channel management' },
];

/** 双语 node 文案 — SVG 图 / 详情面板 / 概览卡共用. */
function nodeLabel(node: SubsystemNode, isZh: boolean): string {
  return isZh ? node.label : node.labelEn;
}
function nodeDescription(node: SubsystemNode, isZh: boolean): string {
  return isZh ? node.description : node.descriptionEn;
}

// ============================================================================
// Helpers
// ============================================================================

function getNodeActivity(diagnostics: KernelDiagnostics | null, id: string): number {
  if (!diagnostics || diagnostics.status !== 'active') return 0;
  switch (id) {
    case 'scheduler': return (diagnostics.scheduler?.runningCount || 0) > 0 ? 1 : 0.3;
    case 'cognition': return (diagnostics.cognition?.system1Hits || 0) > 0 ? 1 : 0.3;
    case 'perception': return (diagnostics.perception?.totalProcessed || 0) > 0 ? 0.8 : 0.2;
    case 'context': return (diagnostics.context?.totalAssembled || 0) > 0 ? 0.7 : 0.2;
    case 'attention': return 0.3;
    case 'interrupt': return (diagnostics.interrupts?.totalRaised || 0) > 0 ? 0.9 : 0.2;
    case 'messageBus': return (diagnostics.messageBus?.totalSent || 0) > 0 ? 0.8 : 0.2;
    default: return 0.2;
  }
}

function getSubsystemDetail(diagnostics: KernelDiagnostics | null, id: string): SubsystemDetail {
  const d = diagnostics;
  const EMPTY: SubsystemDetail = { metrics: [], events: [] };
  if (!d || d.status !== 'active') return EMPTY;
  /* 模块级函数拿不到 hook — 按项目惯例读全局 UI 语言 (调用方都是订阅了 useI18n 的组件, 切语言会重渲). */
  const zh = getGlobalLanguage() === 'zh';

  switch (id) {
    case 'scheduler':
      return {
        metrics: [
          { label: zh ? '运行中' : 'Running', value: d.scheduler?.runningCount || 0, color: '#4ade80' },
          { label: zh ? '队列中' : 'Queued', value: d.scheduler?.queuedCount || 0, color: '#fbbf24' },
          { label: zh ? '总调度' : 'Scheduled', value: d.scheduler?.totalScheduled || 0 },
        ],
        events: [
          { label: zh ? `${d.scheduler?.runningCount || 0} 个进程活跃` : `${d.scheduler?.runningCount || 0} active process(es)`, status: (d.scheduler?.runningCount || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `${d.scheduler?.queuedCount || 0} 个任务排队` : `${d.scheduler?.queuedCount || 0} task(s) queued`, status: (d.scheduler?.queuedCount || 0) > 0 ? 'warn' : 'idle' },
        ],
      };
    case 'cognition':
      return {
        metrics: [
          { label: zh ? '总处理' : 'Processed', value: d.cognition?.totalProcessed || 0 },
          { label: zh ? 'S1 命中' : 'S1 hits', value: d.cognition?.system1Hits || 0, color: '#4ade80' },
          { label: zh ? 'S2 调用' : 'S2 calls', value: d.cognition?.system2Invocations || 0, color: '#a78bfa' },
        ],
        events: [
          { label: zh ? `System 1 快速路径: ${d.cognition?.system1Hits || 0} 次` : `System 1 fast path: ${d.cognition?.system1Hits || 0} time(s)`, status: (d.cognition?.system1Hits || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `System 2 深度推理: ${d.cognition?.system2Invocations || 0} 次` : `System 2 deep reasoning: ${d.cognition?.system2Invocations || 0} time(s)`, status: (d.cognition?.system2Invocations || 0) > 0 ? 'active' : 'idle' },
        ],
      };
    case 'perception':
      return {
        metrics: [
          { label: zh ? '已处理' : 'Processed', value: d.perception?.totalProcessed || 0 },
          { label: zh ? '信号源' : 'Sources', value: d.perception?.sourceCount || 0, color: '#a78bfa' },
        ],
        events: [
          { label: zh ? `${d.perception?.sourceCount || 0} 个感知信号源在线` : `${d.perception?.sourceCount || 0} perception source(s) online`, status: (d.perception?.sourceCount || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `累计处理 ${d.perception?.totalProcessed || 0} 条信号` : `${d.perception?.totalProcessed || 0} signal(s) processed in total`, status: 'idle' },
        ],
      };
    case 'context':
      return {
        metrics: [
          { label: zh ? '已组装' : 'Assembled', value: d.context?.totalAssembled || 0 },
          { label: zh ? '已驱逐' : 'Evicted', value: d.context?.totalEvictions || 0, color: '#f87171' },
        ],
        events: [
          { label: zh ? `上下文组装 ${d.context?.totalAssembled || 0} 次` : `Context assembled ${d.context?.totalAssembled || 0} time(s)`, status: (d.context?.totalAssembled || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `驱逐策略触发 ${d.context?.totalEvictions || 0} 次` : `Eviction triggered ${d.context?.totalEvictions || 0} time(s)`, status: (d.context?.totalEvictions || 0) > 0 ? 'warn' : 'idle' },
        ],
      };
    case 'attention':
      return {
        metrics: [],
        events: [
          { label: zh ? '注意力焦点管理模块' : 'Attention focus management module', status: 'idle' },
          { label: zh ? '等待任务激活' : 'Waiting for task activation', status: 'idle' },
        ],
      };
    case 'interrupt':
      return {
        metrics: [
          { label: zh ? '已产生' : 'Raised', value: d.interrupts?.totalRaised || 0, color: '#fbbf24' },
          { label: zh ? '已处理' : 'Handled', value: d.interrupts?.totalHandled || 0, color: '#4ade80' },
        ],
        events: [
          { label: zh ? `${d.interrupts?.totalRaised || 0} 个中断已产生` : `${d.interrupts?.totalRaised || 0} interrupt(s) raised`, status: (d.interrupts?.totalRaised || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `${d.interrupts?.totalHandled || 0} 个中断已处理` : `${d.interrupts?.totalHandled || 0} interrupt(s) handled`, status: 'idle' },
        ],
      };
    case 'messageBus':
      return {
        metrics: [
          { label: zh ? '已发送' : 'Sent', value: d.messageBus?.totalSent || 0 },
          { label: zh ? '已接收' : 'Received', value: d.messageBus?.totalReceived || 0 },
          { label: zh ? '频道数' : 'Channels', value: d.messageBus?.channelCount || 0, color: '#34d399' },
        ],
        events: [
          { label: zh ? `${d.messageBus?.channelCount || 0} 个活跃频道` : `${d.messageBus?.channelCount || 0} active channel(s)`, status: (d.messageBus?.channelCount || 0) > 0 ? 'active' : 'idle' },
          { label: zh ? `累计 ${d.messageBus?.totalSent || 0} 发 / ${d.messageBus?.totalReceived || 0} 收` : `${d.messageBus?.totalSent || 0} sent / ${d.messageBus?.totalReceived || 0} received in total`, status: 'idle' },
        ],
      };
    default:
      return EMPTY;
  }
}

function formatUptime(bootedAt: number): string {
  const s = Math.floor((Date.now() - bootedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ============================================================================
// Compact Neural Graph (SVG) — Premium V2 with hex grid, gradients, particles
// ============================================================================

/** Generate hex grid background pattern coordinates */
function hexGridPoints(w: number, h: number, size: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const dx = size * 1.5;
  const dy = size * Math.sqrt(3);
  for (let row = -1; row * dy < h + dy; row++) {
    for (let col = -1; col * dx < w + dx; col++) {
      const x = col * dx;
      const y = row * dy + (col % 2 === 0 ? 0 : dy / 2);
      pts.push({ x, y });
    }
  }
  return pts;
}

/** Single hex path for pattern */
function hexPath(cx: number, cy: number, r: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  });
  return `M${pts.join('L')}Z`;
}

/** Stable ambient particles — positions seeded once */
const AMBIENT_PARTICLES = Array.from({ length: 12 }, (_, i) => ({
  angle: (Math.PI * 2 / 12) * i + Math.random() * 0.5,
  rFactor: 0.3 + Math.random() * 0.7,
  size: 0.8 + Math.random() * 1.2,
  dur: 4 + Math.random() * 3,
  delay: Math.random() * 3,
  opacity: 0.15 + Math.random() * 0.25,
}));

const NeuralGraph: React.FC<{
  diagnostics: KernelDiagnostics | null;
  width: number;
  height: number;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  isLight?: boolean;
}> = ({ diagnostics, width, height, selectedId, onSelectNode, isLight = false }) => {
  const { isZh } = useI18n();
  const isActive = diagnostics?.status === 'active';
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(cx, cy) * 0.60;
  const coreR = 18;
  const nodeR = 13;
  const tickCount = diagnostics?.system?.tickCount || 0;

  // Theme-aware fill colors
  const nodeFill = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(14,14,26,0.92)';
  const coreFill = isLight ? 'rgba(255,255,255,0.98)' : 'rgba(14,14,26,0.95)';
  const hexStroke = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.03)';
  const labelColor = isLight ? '#475569' : 'rgba(255,255,255,0.6)';
  const labelDim = isLight ? '#94a3b8' : 'rgba(255,255,255,0.2)';
  const tickColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.12)';
  const orbitStroke = isLight
    ? (isActive ? 'rgba(96,165,250,0.08)' : 'rgba(100,116,139,0.05)')
    : (isActive ? 'rgba(96,224,255,0.06)' : 'rgba(100,116,139,0.04)');
  const meshStroke = isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)';
  const meshStrokeDim = isLight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.025)';
  const coreGlowActive = isLight ? '#3b82f6' : '#60e0ff';
  const coreGlowIdle = isLight ? '#94a3b8' : '#607090';
  const coreStroke = isActive ? coreGlowActive : coreGlowIdle;
  const innerGlowFill = isLight
    ? (isActive ? 'rgba(96,165,250,0.06)' : 'rgba(100,116,139,0.03)')
    : (isActive ? 'rgba(96,224,255,0.06)' : 'rgba(100,116,139,0.03)');

  // Hex grid (only generate if big enough)
  const hexPts = useMemo(() => width > 100 ? hexGridPoints(width, height, 20) : [], [width, height]);

  return (
    <svg width={width} height={height} className="kp2-graph-svg">
      <defs>
        {/* Core radial glow */}
        <radialGradient id="kp2-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={coreStroke} stopOpacity="0.6" />
          <stop offset="40%" stopColor={coreStroke} stopOpacity="0.15" />
          <stop offset="100%" stopColor={coreStroke} stopOpacity="0" />
        </radialGradient>
        {/* Full-area ambient glow */}
        <radialGradient id="kp2-ambient-glow" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor={coreStroke} stopOpacity={isLight ? '0.04' : '0.06'} />
          <stop offset="100%" stopColor="transparent" stopOpacity="0" />
        </radialGradient>
        {/* Gradient for each subsystem connection */}
        {SUBSYSTEMS.map(node => (
          <linearGradient key={`grad-${node.id}`} id={`kp2-grad-${node.id}`}
            x1={cx} y1={cy}
            x2={cx + Math.cos(node.angle) * radius}
            y2={cy + Math.sin(node.angle) * radius}
            gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={isActive ? coreGlowActive : coreGlowIdle} stopOpacity="0.6" />
            <stop offset="100%" stopColor={node.color} stopOpacity="1" />
          </linearGradient>
        ))}
        {/* Node inner radial glow */}
        {SUBSYSTEMS.map(node => (
          <radialGradient key={`nglow-${node.id}`} id={`kp2-node-glow-${node.id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={node.color} stopOpacity="0.15" />
            <stop offset="100%" stopColor={node.color} stopOpacity="0" />
          </radialGradient>
        ))}
        {/* Blur filters */}
        <filter id="kp2-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <filter id="kp2-blur-strong" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id="kp2-blur-xl" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      {/* ──── Layer 0: Hex grid background ──── */}
      <g opacity={isActive ? 0.4 : 0.15}>
        {hexPts.map((pt, i) => (
          <path key={i} d={hexPath(pt.x, pt.y, 10)}
            fill="none" stroke={hexStroke} strokeWidth="0.5" />
        ))}
      </g>

      {/* ──── Layer 1: Ambient glow ──── */}
      <circle cx={cx} cy={cy} r={radius * 1.2} fill="url(#kp2-ambient-glow)" />

      {/* ──── Layer 2: Orbital rings ──── */}
      {[0.35, 0.55, 0.78, 1.0].map((f, i) => (
        <circle key={`orbit-${i}`} cx={cx} cy={cy} r={radius * f}
          fill="none"
          stroke={orbitStroke}
          strokeWidth="0.6"
          strokeDasharray={i % 2 === 0 ? '2 6' : '4 8'}>
          {isActive && (
            <animate attributeName="r"
              values={`${radius * f};${radius * f + 2};${radius * f}`}
              dur={`${5 + i * 1.5}s`} repeatCount="indefinite" />
          )}
        </circle>
      ))}

      {/* ──── Layer 3: Ambient floating particles ──── */}
      {isActive && AMBIENT_PARTICLES.map((p, i) => {
        const px = cx + Math.cos(p.angle) * radius * p.rFactor;
        const py = cy + Math.sin(p.angle) * radius * p.rFactor;
        return (
          <circle key={`ambient-${i}`} r={p.size}
            fill={coreGlowActive} opacity={0}>
            <animate attributeName="opacity"
              values={`0;${p.opacity};0`}
              dur={`${p.dur}s`} begin={`${p.delay}s`} repeatCount="indefinite" />
            <animate attributeName="cx"
              values={`${px};${px + (Math.random() - 0.5) * 20};${px}`}
              dur={`${p.dur}s`} begin={`${p.delay}s`} repeatCount="indefinite" />
            <animate attributeName="cy"
              values={`${py};${py + (Math.random() - 0.5) * 20};${py}`}
              dur={`${p.dur}s`} begin={`${p.delay}s`} repeatCount="indefinite" />
          </circle>
        );
      })}

      {/* ──── Layer 4: Cross-connections (ring mesh) ──── */}
      {SUBSYSTEMS.map((node, i) => {
        const next = SUBSYSTEMS[(i + 1) % SUBSYSTEMS.length];
        const skip = SUBSYSTEMS[(i + 2) % SUBSYSTEMS.length];
        const nx1 = cx + Math.cos(node.angle) * radius;
        const ny1 = cy + Math.sin(node.angle) * radius;
        const nx2 = cx + Math.cos(next.angle) * radius;
        const ny2 = cy + Math.sin(next.angle) * radius;
        const nx3 = cx + Math.cos(skip.angle) * radius;
        const ny3 = cy + Math.sin(skip.angle) * radius;
        return (
          <g key={`mesh-${node.id}`}>
            {/* Adjacent connection */}
            <line x1={nx1} y1={ny1} x2={nx2} y2={ny2}
              stroke={meshStroke} strokeWidth="0.5"
              strokeDasharray="2 5" />
            {/* Skip connection (every other) — creates the mesh */}
            {i % 2 === 0 && (
              <line x1={nx1} y1={ny1} x2={nx3} y2={ny3}
                stroke={meshStrokeDim} strokeWidth="0.4"
                strokeDasharray="1 6" />
            )}
          </g>
        );
      })}

      {/* ──── Layer 5: Gradient connection lines core → subsystem ──── */}
      {SUBSYSTEMS.map(node => {
        const nx = cx + Math.cos(node.angle) * radius;
        const ny = cy + Math.sin(node.angle) * radius;
        const activity = getNodeActivity(diagnostics, node.id);
        const isSelected = selectedId === node.id;
        const pathId = `kp2-path-${node.id}`;
        const revPathId = `kp2-rpath-${node.id}`;

        return (
          <g key={`conn-${node.id}`}>
            {/* Wide glow line */}
            <line x1={cx} y1={cy} x2={nx} y2={ny}
              stroke={node.color}
              strokeWidth={isSelected ? 8 : activity > 0.5 ? 4 : 2}
              opacity={isSelected ? 0.2 : activity * 0.08}
              style={{ filter: 'url(#kp2-blur-strong)' }} />
            {/* Main gradient line */}
            <line x1={cx} y1={cy} x2={nx} y2={ny}
              stroke={`url(#kp2-grad-${node.id})`}
              strokeWidth={isSelected ? 2 : activity > 0.5 ? 1.2 : 0.6}
              opacity={isSelected ? 0.9 : isActive ? 0.25 + activity * 0.45 : 0.1}
              strokeDasharray={activity > 0.5 || isSelected ? undefined : '3 5'}
              strokeLinecap="round" />
            {/* Forward flow particle */}
            <path id={pathId} d={`M${cx},${cy} L${nx},${ny}`} fill="none" stroke="none" />
            {isActive && activity > 0.2 && (
              <circle r={isSelected ? 3 : activity > 0.5 ? 2 : 1.2}
                fill={node.color} opacity={isSelected ? 0.95 : 0.65}>
                <animateMotion dur={`${1.8 + Math.random() * 0.6}s`} repeatCount="indefinite">
                  <mpath href={`#${pathId}`} />
                </animateMotion>
              </circle>
            )}
            {/* Reverse return particle (data feedback) — only for active connections */}
            <path id={revPathId} d={`M${nx},${ny} L${cx},${cy}`} fill="none" stroke="none" />
            {isActive && activity > 0.5 && (
              <circle r={1}
                fill={coreGlowActive} opacity={0.4}>
                <animateMotion dur={`${2.5 + Math.random() * 0.5}s`} repeatCount="indefinite">
                  <mpath href={`#${revPathId}`} />
                </animateMotion>
              </circle>
            )}
          </g>
        );
      })}

      {/* ──── Layer 6: Core node ──── */}
      {/* Outer halo */}
      <circle cx={cx} cy={cy} r={coreR + 14} fill="url(#kp2-core-glow)" />
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={coreR + 3}
        fill="none"
        stroke={isActive ? (isLight ? 'rgba(59,130,246,0.12)' : 'rgba(96,224,255,0.12)') : (isLight ? 'rgba(100,116,139,0.1)' : 'rgba(100,116,139,0.08)')}
        strokeWidth="0.5" />
      {/* Main circle */}
      <circle cx={cx} cy={cy} r={coreR}
        fill={coreFill}
        stroke={coreStroke}
        strokeWidth="2"
        style={{ cursor: 'pointer' }}
        onClick={() => onSelectNode(null)} />
      {/* Inner glow fill */}
      <circle cx={cx} cy={cy} r={coreR - 2}
        fill={innerGlowFill}
        style={{ pointerEvents: 'none' }} />
      {/* Spinning dashed ring */}
      {isActive && (
        <circle cx={cx} cy={cy} r={coreR + 1.5}
          fill="none" stroke={coreGlowActive} strokeWidth="1.3"
          strokeDasharray={`${coreR * 1.2} ${coreR * 0.8}`}
          strokeLinecap="round" opacity="0.6">
          <animateTransform attributeName="transform" type="rotate"
            from={`0 ${cx} ${cy}`} to={`360 ${cx} ${cy}`}
            dur="4s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Counter-rotating ring */}
      {isActive && (
        <circle cx={cx} cy={cy} r={coreR + 6}
          fill="none" stroke={isLight ? 'rgba(59,130,246,0.08)' : 'rgba(96,224,255,0.08)'} strokeWidth="0.8"
          strokeDasharray={`${coreR * 0.4} ${coreR * 1.6}`}
          strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate"
            from={`360 ${cx} ${cy}`} to={`0 ${cx} ${cy}`}
            dur="8s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Core icon — circuit brain SVG */}
      {renderSvgIcon('_core', cx, cy, coreStroke, isActive ? 0.9 : 0.4, 16)}

      {/* ──── Layer 7: Subsystem nodes — clickable ──── */}
      {SUBSYSTEMS.map(node => {
        const nx = cx + Math.cos(node.angle) * radius;
        const ny = cy + Math.sin(node.angle) * radius;
        const activity = getNodeActivity(diagnostics, node.id);
        const isSelected = selectedId === node.id;

        return (
          <g key={`node-${node.id}`}
            className={`kp2-node ${isSelected ? 'selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelectNode(isSelected ? null : node.id); }}
            style={{ cursor: 'pointer' }}>
            {/* Selection ring — breathing animation */}
            {isSelected && (
              <>
                <circle cx={nx} cy={ny} r={nodeR + 12}
                  fill={node.color} opacity={0.08}
                  style={{ filter: 'url(#kp2-blur-xl)' }}>
                  <animate attributeName="r"
                    values={`${nodeR + 8};${nodeR + 14};${nodeR + 8}`}
                    dur="2.5s" repeatCount="indefinite" />
                </circle>
                <circle cx={nx} cy={ny} r={nodeR + 5}
                  fill="none" stroke={node.color} strokeWidth="0.6"
                  opacity="0.25" strokeDasharray="3 3">
                  <animateTransform attributeName="transform" type="rotate"
                    from={`0 ${nx} ${ny}`} to={`360 ${nx} ${ny}`}
                    dur="6s" repeatCount="indefinite" />
                </circle>
              </>
            )}
            {/* Node glow (soft halo) */}
            <circle cx={nx} cy={ny} r={nodeR + 5}
              fill={node.color} opacity={isSelected ? 0.25 : activity * 0.12}
              style={{ filter: 'url(#kp2-blur)' }} />
            {/* Outer ring */}
            <circle cx={nx} cy={ny} r={nodeR + 2}
              fill="none"
              stroke={node.color}
              strokeWidth="0.4"
              opacity={isSelected ? 0.4 : activity > 0.5 ? 0.2 : 0.08} />
            {/* Main node circle */}
            <circle cx={nx} cy={ny} r={nodeR}
              fill={nodeFill}
              stroke={node.color}
              strokeWidth={isSelected ? 2.2 : activity > 0.5 ? 1.5 : 0.8}
              opacity={isActive ? (isSelected ? 1 : 0.5 + activity * 0.5) : 0.25} />
            {/* Inner glow fill */}
            <circle cx={nx} cy={ny} r={nodeR - 2}
              fill={`url(#kp2-node-glow-${node.id})`}
              opacity={isActive ? (isSelected ? 1 : 0.6) : 0.2}
              style={{ pointerEvents: 'none' }} />
            {/* Active spinner */}
            {isActive && activity > 0.5 && (
              <circle cx={nx} cy={ny} r={nodeR + 1}
                fill="none" stroke={node.color} strokeWidth="0.8"
                strokeDasharray={`${nodeR * 0.6} ${nodeR * 1.4}`}
                strokeLinecap="round" opacity={isSelected ? 0.7 : 0.35}>
                <animateTransform attributeName="transform" type="rotate"
                  from={`0 ${nx} ${ny}`} to={`360 ${nx} ${ny}`}
                  dur="3s" repeatCount="indefinite" />
              </circle>
            )}
            {/* Icon — stroke SVG */}
            {renderSvgIcon(node.id, nx, ny, node.color, isActive ? (isSelected ? 1 : 0.85) : 0.35, 12)}
            {/* Label */}
            <text x={nx} y={ny + nodeR + 13} textAnchor="middle"
              fill={isSelected ? node.color : isActive ? labelColor : labelDim}
              fontSize="8" fontWeight={isSelected ? '700' : '500'}
              fontFamily="'Inter','SF Pro',sans-serif"
              style={{ pointerEvents: 'none' }}>{nodeLabel(node, isZh)}</text>
          </g>
        );
      })}

      {/* ──── Layer 8: Tick counter ──── */}
      <text x={width - 6} y={height - 6} textAnchor="end"
        fill={tickColor} fontSize="7"
        fontFamily="'JetBrains Mono','SF Mono',monospace"
        style={{ pointerEvents: 'none' }}>
        tick: {tickCount}
      </text>
    </svg>
  );
};

// ============================================================================
// Subsystem Detail Panel — 右侧/下方详情
// ============================================================================
const SubsystemDetailPanel: React.FC<{
  node: SubsystemNode;
  detail: SubsystemDetail;
  diagnostics: KernelDiagnostics | null;
  onClose: () => void;
}> = ({ node, detail, diagnostics, onClose }) => {
  const { isZh } = useI18n();
  const activity = getNodeActivity(diagnostics, node.id);
  const activityLabel = activity >= 0.8 ? (isZh ? '高' : 'High') : activity >= 0.4 ? (isZh ? '中' : 'Medium') : (isZh ? '低' : 'Low');
  const activityColor = activity >= 0.8 ? '#4ade80' : activity >= 0.4 ? '#fbbf24' : '#64748b';

  return (
    <div className="kp2-detail-panel" style={{ '--node-color': node.color } as React.CSSProperties}>
      {/* Header */}
      <div className="kp2-detail-header">
        <div className="kp2-detail-title-row">
          <span className="kp2-detail-icon" style={{ color: node.color, borderColor: `${node.color}40` }}>{renderHtmlIcon(node.id, node.color, 16)}</span>
          <div className="kp2-detail-titles">
            <span className="kp2-detail-name" style={{ color: node.color }}>{nodeLabel(node, isZh)}</span>
            <span className="kp2-detail-desc">{nodeDescription(node, isZh)}</span>
          </div>
          <button type="button" className="kp2-detail-close" onClick={onClose} title={isZh ? '关闭' : 'Close'} aria-label={isZh ? '关闭' : 'Close'}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {/* Activity Badge */}
        <div className="kp2-detail-activity">
          <span className="kp2-detail-activity-dot" style={{ backgroundColor: activityColor }} />
          <span className="kp2-detail-activity-label">{isZh ? '活性' : 'Activity'}: {activityLabel}</span>
          <div className="kp2-detail-activity-bar">
            <div className="kp2-detail-activity-fill" style={{ width: `${activity * 100}%`, backgroundColor: activityColor }} />
          </div>
        </div>
      </div>

      {/* Metrics Grid */}
      {detail.metrics.length > 0 && (
        <div className="kp2-detail-metrics">
          {detail.metrics.map((m, i) => (
            <div key={i} className="kp2-metric-card">
              <div className="kp2-metric-value" style={{ color: m.color || '#e2e8f0' }}>{m.value}</div>
              <div className="kp2-metric-label">{m.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Events */}
      {detail.events.length > 0 && (
        <div className="kp2-detail-events">
          <div className="kp2-events-title">{isZh ? '事件与状态' : 'Events & status'}</div>
          {detail.events.map((evt, i) => (
            <div key={i} className={`kp2-event-item ${evt.status}`}>
              <span className={`kp2-event-dot ${evt.status}`} />
              <span className="kp2-event-label">{evt.label}</span>
              {evt.detail && <span className="kp2-event-detail">{evt.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Process list if scheduler is selected */}
      {node.id === 'scheduler' && diagnostics?.processes && diagnostics.processes.length > 0 && (
        <div className="kp2-detail-processes">
          <div className="kp2-events-title">{isZh ? '活跃进程' : 'Active processes'}</div>
          {diagnostics.processes.slice(-6).map(p => (
            <div key={p.pid} className="kp2-process-row">
              <span className={`kp2-proc-dot ${p.state}`} />
              <span className="kp2-proc-role">{p.role}</span>
              <span className="kp2-proc-task">{p.task.slice(0, 35)}</span>
              <span className="kp2-proc-state">{p.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Subsystem Quick Cards — 无选择时的全局概览卡片
// ============================================================================
const SubsystemQuickCards: React.FC<{
  diagnostics: KernelDiagnostics | null;
  onSelect: (id: string) => void;
}> = ({ diagnostics, onSelect }) => {
  const { isZh } = useI18n();
  const isActive = diagnostics?.status === 'active';

  const cards = SUBSYSTEMS.map(node => {
    const activity = getNodeActivity(diagnostics, node.id);
    const detail = getSubsystemDetail(diagnostics, node.id);
    const mainMetric = detail.metrics[0];

    return (
      <div key={node.id}
        className={`kp2-quick-card ${activity > 0.5 ? 'active' : ''}`}
        style={{ '--card-color': node.color } as React.CSSProperties}
        onClick={() => onSelect(node.id)}>
        <div className="kp2-qc-header">
          <span className="kp2-qc-icon" style={{ color: node.color }}>{renderHtmlIcon(node.id, node.color, 12)}</span>
          <span className="kp2-qc-name">{nodeLabel(node, isZh)}</span>
          {activity > 0.5 && <span className="kp2-qc-active-dot" style={{ backgroundColor: node.color }} />}
        </div>
        {mainMetric && (
          <div className="kp2-qc-metric" style={{ color: mainMetric.color || node.color }}>
            {mainMetric.value}
          </div>
        )}
        {mainMetric && <div className="kp2-qc-metric-label">{mainMetric.label}</div>}
        {!mainMetric && <div className="kp2-qc-metric-label" style={{ opacity: 0.4 }}>—</div>}
      </div>
    );
  });

  return (
    <div className="kp2-quick-cards">
      {/* System overview header */}
      {isActive && diagnostics?.system && (
        <div className="kp2-sys-overview">
          <div className="kp2-sys-item">
            <span className="kp2-sys-label">{isZh ? '运行时间' : 'Uptime'}</span>
            <span className="kp2-sys-value">{formatUptime(diagnostics.system.bootedAt)}</span>
          </div>
          <div className="kp2-sys-item">
            <span className="kp2-sys-label">{isZh ? '活跃进程' : 'Processes'}</span>
            <span className="kp2-sys-value" style={{ color: '#38bdf8' }}>{diagnostics.system.activeProcessCount}</span>
          </div>
          <div className="kp2-sys-item">
            <span className="kp2-sys-label">Tick</span>
            <span className="kp2-sys-value">{diagnostics.system.tickCount}</span>
          </div>
        </div>
      )}
      <div className="kp2-qc-grid">
        {cards}
      </div>
      {/* Processes */}
      {diagnostics?.processes && diagnostics.processes.length > 0 && (
        <div className="kp2-detail-processes" style={{ marginTop: 4 }}>
          <div className="kp2-events-title">{isZh ? '活跃进程' : 'Active processes'}</div>
          {diagnostics.processes.slice(-4).map(p => (
            <div key={p.pid} className="kp2-process-row">
              <span className={`kp2-proc-dot ${p.state}`} />
              <span className="kp2-proc-role">{p.role}</span>
              <span className="kp2-proc-task">{p.task.slice(0, 30)}</span>
              <span className="kp2-proc-state">{p.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Panel
// ============================================================================
const KernelPanel: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { isZh } = useI18n();
  const [diagnostics, setDiagnostics] = useState<KernelDiagnostics | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [graphSize, setGraphSize] = useState({ w: 200, h: 200 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isLightTheme, setIsLightTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') === 'light'
  );

  // Watch for theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLightTheme(document.documentElement.getAttribute('data-theme') === 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Poll diagnostics every 3s
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await window.neox?.getKernelDiagnostics?.();
        if (!cancelled && data) setDiagnostics(data);
      } catch { /* ignore */ }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [visible]);

  // Resize observer for graph container
  useEffect(() => {
    if (!graphContainerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = e.contentRect.width;
        const h = e.contentRect.height;
        setGraphSize({ w: Math.max(w, 100), h: Math.max(h, 100) });
      }
    });
    ro.observe(graphContainerRef.current);
    return () => ro.disconnect();
  }, []);

  const selectedNode = selectedNodeId ? SUBSYSTEMS.find(n => n.id === selectedNodeId) : null;
  const selectedDetail = selectedNode ? getSubsystemDetail(diagnostics, selectedNode.id) : null;

  if (!visible) return null;

  const isActive = diagnostics?.status === 'active';

  return (
    <div className="kp2-panel" ref={containerRef}>
      {/* Left: Neural Graph */}
      <div className="kp2-graph-column" ref={graphContainerRef}>
        <NeuralGraph
          diagnostics={diagnostics}
          width={graphSize.w}
          height={graphSize.h}
          selectedId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          isLight={isLightTheme}
        />
        {/* Status badge */}
        <div className={`kp2-status-badge ${isActive ? 'active' : 'idle'}`}>
          <span className="kp2-status-dot" />
          <span>{isActive ? (isZh ? '内核活跃' : 'Kernel active') : (isZh ? '内核待机' : 'Kernel idle')}</span>
        </div>
      </div>

      {/* Right: Detail or Quick Cards */}
      <div className="kp2-info-column">
        {selectedNode && selectedDetail ? (
          <SubsystemDetailPanel
            node={selectedNode}
            detail={selectedDetail}
            diagnostics={diagnostics}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : (
          <SubsystemQuickCards
            diagnostics={diagnostics}
            onSelect={setSelectedNodeId}
          />
        )}
      </div>
    </div>
  );
};

export default KernelPanel;
