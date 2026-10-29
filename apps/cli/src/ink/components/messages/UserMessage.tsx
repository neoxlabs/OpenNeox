import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { NeoxTheme } from '../../theme.js';
import { Step, StepResult, type StepTone } from './step.js';
import { getLanguage } from '../../../i18n/index.js';

/** 时间线里你说的话最多露几行 (大段粘贴不整段写进回滚区) */
const USER_MSG_MAX_LINES = 12;
const USER_MSG_HEAD_LINES = 4;

export interface UserMessageProps {
  message: Message;
  timestamp?: Date;
  sourceLabel?: string;
}

/** 抽出 system 注入 XML → 紧凑 pill 文本 */
type BgTaskPill = { kind: 'bg-task'; pid: number; status: string; exitCode?: number; command: string };
type WakeupPill = { kind: 'wakeup'; reason: string; elapsedSeconds: number };
type AgentCompletionPill = {
  kind: 'agent';
  agentId: string;
  name?: string;
  status: string;
  elapsedSeconds: number;
  toolCount: number;
};
/** 本机别的会话用 send_to_session 发来的话 (core runtime/peers/sessionPeers.ts) */
type SessionMessagePill = { kind: 'session'; fromName: string; fromSessionId: string; fromCwd: string; fromClient: string; body: string };
type Pill = BgTaskPill | WakeupPill | AgentCompletionPill | SessionMessagePill;

/** 会话消息正文在时间线里最多露几行, 多的折成「还有 N 行」 */
const SESSION_MSG_MAX_LINES = 6;

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseBgTaskPills(input: string): { pills: Pill[]; residual: string } {
  const pills: Pill[] = [];
  let out = input;

  out = out.replace(/<background-task-notification>([\s\S]*?)<\/background-task-notification>/g, (_f, body: string) => {
    const pid = Number((body.match(/<pid>(.*?)<\/pid>/) || [])[1]) || 0;
    const status = (body.match(/<status>(.*?)<\/status>/) || [])[1] || 'unknown';
    const exit = (body.match(/<exit-code>(.*?)<\/exit-code>/) || [])[1];
    const cmd = unescapeXml((body.match(/<command>([\s\S]*?)<\/command>/) || [])[1] || '');
    pills.push({ kind: 'bg-task', pid, status, exitCode: exit ? Number(exit) : undefined, command: cmd });
    return '';
  });

  out = out.replace(/<scheduled-wakeup>([\s\S]*?)<\/scheduled-wakeup>/g, (_f, body: string) => {
    const reason = unescapeXml((body.match(/<reason>([\s\S]*?)<\/reason>/) || [])[1] || '');
    const elapsed = Number((body.match(/<elapsed-seconds>(.*?)<\/elapsed-seconds>/) || [])[1]) || 0;
    pills.push({ kind: 'wakeup', reason, elapsedSeconds: elapsed });
    return '';
  });

  out = out.replace(/<agent-completion>([\s\S]*?)<\/agent-completion>/g, (_f, body: string) => {
    const agentId = unescapeXml((body.match(/<agent-id>([\s\S]*?)<\/agent-id>/) || [])[1] || '');
    const name = (body.match(/<name>([\s\S]*?)<\/name>/) || [])[1];
    const status = (body.match(/<status>(.*?)<\/status>/) || [])[1] || 'completed';
    const elapsed = Number((body.match(/<elapsed-seconds>(.*?)<\/elapsed-seconds>/) || [])[1]) || 0;
    const toolCount = Number((body.match(/<tool-use-count>(.*?)<\/tool-use-count>/) || [])[1]) || 0;
    pills.push({
      kind: 'agent',
      agentId,
      name: name ? unescapeXml(name) : undefined,
      status,
      elapsedSeconds: elapsed,
      toolCount,
    });
    return '';
  });

  out = out.replace(/<session-message>([\s\S]*?)<\/session-message>/g, (_f, body: string) => {
    const tag = (t: string) => unescapeXml((body.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '').trim();
    pills.push({
      kind: 'session',
      fromName: tag('from'),
      fromSessionId: tag('from-session'),
      fromCwd: tag('from-cwd'),
      fromClient: tag('from-client'),
      body: tag('body'),
    });
    return '';
  });

  return { pills, residual: out.trim() };
}

/** 工作目录只露最后两段 —— 认得出是哪个项目就够 */
function shortDir(p: string): string {
  const parts = (p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

export const UserMessage: React.FC<UserMessageProps> = ({ message, timestamp, sourceLabel }) => {
  let rawContent = '';
  let imageCount = 0;

  if (typeof message.content === 'string') {
    rawContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text') {
        rawContent += block.text;
      } else if (block.type === 'image_url') {
        imageCount++;
      }
    }
  }

  /* Screenshots returned by a tool are handed to the model as a user-role message whose text is
   * the marker built in kernel imageToolResult.ts. It is not something the user said; on session
   * resume it used to replay as a user turn ("› [系统注入] 以下 1 张图片是工具 browser_run …"). */
  const injectedImages = /^\[系统注入\] 以下 (\d+) 张图片是工具 (\S+) 的返回内容, 不是用户的新消息:\s*([\s\S]*)$/.exec(rawContent.trim());
  if (injectedImages) {
    const caption = injectedImages[3].split('\n')[0].trim();
    const captionTrim = caption.length > 60 ? caption.slice(0, 60) + '…' : caption;
    return (
      <Step tone="muted" title={
        <Text wrap="wrap"><Text bold>Screenshot</Text><Text color={NeoxTheme.text.secondary}>({injectedImages[2]})</Text>{captionTrim ? <Text color={NeoxTheme.text.dim}> {captionTrim}</Text> : null}</Text>
      } />
    );
  }

  const { pills, residual } = parseBgTaskPills(rawContent);

  return (
    <Box flexDirection="column">
      {pills.map((p, i) => {
        const dim = NeoxTheme.text.dim;
        const elapsed = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
        const toneOf = (status: string): StepTone =>
          status === 'completed' ? 'success'
          : status === 'failed' ? 'error'
          : status === 'aborted' || status === 'killed' ? 'warning'
          : 'muted';
        if (p.kind === 'session') {
          /* 别的会话发来的话 —— 这一轮的起因, 跟你说的话同一个分量: 钴蓝圆点 + 谁发的, 正文照原样 (不是灰色细节) */
          const zh = (() => { try { return getLanguage() === 'zh'; } catch { return false; } })();
          const who = p.fromName || p.fromSessionId.slice(0, 8);
          const app = p.fromClient === 'cli' ? (zh ? '终端' : 'CLI') : p.fromClient === 'desktop' ? (zh ? '桌面' : 'Desktop') : '';
          const where = [app, shortDir(p.fromCwd)].filter(Boolean).join(' · ');
          const lines = p.body.split('\n');
          const shown = lines.slice(0, SESSION_MSG_MAX_LINES);
          const more = lines.length - shown.length;
          return (
            <Step key={i} tone="running" title={
              <Text wrap="wrap"><Text bold>{zh ? '来自' : 'Message from'}</Text><Text color={NeoxTheme.text.secondary}> {who}</Text>{where ? <Text color={dim}> · {where}</Text> : null}</Text>
            }>
              <StepResult color={NeoxTheme.text.primary} lines={[
                ...shown,
                ...(more > 0 ? [<Text key="more" color={NeoxTheme.text.faint}>{zh ? `… 还有 ${more} 行` : `… +${more} lines`}</Text>] : []),
              ]} />
            </Step>
          );
        }
        if (p.kind === 'wakeup') {
          const reasonTrim = p.reason.length > 60 ? p.reason.slice(0, 60) + '…' : p.reason;
          return (
            <Step key={i} tone="muted" title={
              <Text wrap="wrap"><Text bold>Woke up</Text><Text color={dim}> after {elapsed(p.elapsedSeconds)} · {reasonTrim}</Text></Text>
            } />
          );
        }
        if (p.kind === 'agent') {
          const label = p.name || p.agentId.slice(0, 10);
          return (
            <Step key={i} tone={toneOf(p.status)} title={
              <Text wrap="wrap"><Text bold>Agent</Text><Text color={NeoxTheme.text.secondary}>({label})</Text><Text color={dim}> {p.status} · {p.toolCount} tools · {elapsed(p.elapsedSeconds)}</Text></Text>
            } />
          );
        }
        const cmdTrim = p.command.length > 60 ? p.command.slice(0, 60) + '…' : p.command;
        const exitLabel = typeof p.exitCode === 'number' && p.exitCode !== 0 ? ` · exit ${p.exitCode}` : '';
        return (
          <Step key={i} tone={toneOf(p.status)} title={
            <Text wrap="wrap"><Text bold>Background</Text><Text color={NeoxTheme.text.secondary}>({cmdTrim})</Text><Text color={dim}> {p.status}{exitLabel}</Text></Text>
          } />
        );
      })}
      {/* 陶土: 你说的话坐在一块淡底板上 (整行宽), › 用最淡灰 —— 跟模型的回答、工具步骤一眼分开 */}
      {residual && residual.split('\n').length > USER_MSG_MAX_LINES ? (
        /* 很长的消息 (大段粘贴) 在时间线里只露头几行 + 「还有 N 行」, 不把几千行写进终端回滚区; 全文 ctrl+o 看 */
        (() => {
          const all = residual.split('\n');
          const head = all.slice(0, USER_MSG_HEAD_LINES).join('\n');
          const zh = (() => { try { return getLanguage() === 'zh'; } catch { return false; } })();
          return (
            <Box backgroundColor={NeoxTheme.surface.slab}>
              <Box width={2} flexShrink={0}><Text color={NeoxTheme.text.dim} bold>❯</Text></Box>
              <Box flexGrow={1} flexShrink={1} flexDirection="column">
                <Text wrap="truncate-end">{head}</Text>
                <Text color={NeoxTheme.text.faint}>{zh ? `… 还有 ${all.length - USER_MSG_HEAD_LINES} 行 · ctrl+o 看全文` : `… +${all.length - USER_MSG_HEAD_LINES} lines · ctrl+o for all`}</Text>
              </Box>
            </Box>
          );
        })()
      ) : residual && NeoxTheme.surface.slab ? (
        <Box backgroundColor={NeoxTheme.surface.slab}>
          <Box width={2} flexShrink={0}><Text color={NeoxTheme.text.dim} bold>❯</Text></Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">
              {sourceLabel ? <Text color={NeoxTheme.text.dim}>{sourceLabel} · </Text> : null}
              <Text>{residual}</Text>
              {imageCount > 0 ? <Text color={NeoxTheme.text.dim}>  ▣ {imageCount} image{imageCount > 1 ? 's' : ''}</Text> : null}
            </Text>
          </Box>
        </Box>
      ) : residual && (
        <Box>
          <Box width={2} flexShrink={0}><Text color={NeoxTheme.brand.purple} bold>›</Text></Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="wrap">
              {sourceLabel ? <Text color={NeoxTheme.text.dim}>{sourceLabel} · </Text> : null}
              <Text color={NeoxTheme.text.secondary}>{residual}</Text>
              {imageCount > 0 ? <Text color={NeoxTheme.text.dim}>  [{imageCount} image{imageCount > 1 ? 's' : ''}]</Text> : null}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
