import React from 'react';
import { Box, Text } from '../../../../vendor/ink/src/index.js';
import type { Message } from '@neoxlabs/kernel/types/index.js';
import { NeoxTheme } from '../../theme.js';
import { Step, type StepTone } from './step.js';

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
type Pill = BgTaskPill | WakeupPill | AgentCompletionPill;

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

  return { pills, residual: out.trim() };
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
      {residual && (
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
