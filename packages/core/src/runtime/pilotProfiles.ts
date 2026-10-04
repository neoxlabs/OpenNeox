
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export type PilotAvatar = 'cat' | 'corgi';

export interface PilotProfile {
  name: string;
  avatar: PilotAvatar;
  /** TTS 音色 id; 不填 = 跟全局语音设置 */
  voice?: string;
  /** 用户写的分工 / 性格, 原样进 prompt */
  persona?: string;
  /** 定时巡检间隔 (分钟), 0 / 不填 = 不巡检。宿主按它往会话里投 <pilot-patrol> */
  patrolMinutes?: number;
  lastPatrolAt?: number;
  createdAt: number;
}

type ProfileMap = Record<string, PilotProfile>;

export function pilotProfilesPath(): string {
  return join(homedir(), NEOX_HOME_DIRNAME, 'pilots.json');
}

export function readPilotProfiles(): ProfileMap {
  try {
    const raw = JSON.parse(readFileSync(pilotProfilesPath(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as ProfileMap : {};
  } catch {
    return {};
  }
}

export function getPilotProfile(sessionId: string | undefined | null): PilotProfile | null {
  if (!sessionId) return null;
  return readPilotProfiles()[sessionId] ?? null;
}

function writeAll(map: ProfileMap): void {
  const file = pilotProfilesPath();
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  /* 先写临时文件再换名: 写一半崩了不会留下半个 JSON 把所有 Pilot 的档案一起读丢 */
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function savePilotProfile(sessionId: string, patch: Partial<PilotProfile> & { name?: string }): PilotProfile {
  const map = readPilotProfiles();
  const prev = map[sessionId];
  const next: PilotProfile = {
    name: (patch.name ?? prev?.name ?? 'Pilot').trim() || 'Pilot',
    avatar: patch.avatar ?? prev?.avatar ?? 'cat',
    voice: patch.voice !== undefined ? (patch.voice || undefined) : prev?.voice,
    persona: patch.persona !== undefined ? (patch.persona.trim() || undefined) : prev?.persona,
    patrolMinutes: patch.patrolMinutes !== undefined ? (patch.patrolMinutes > 0 ? Math.round(patch.patrolMinutes) : undefined) : prev?.patrolMinutes,
    lastPatrolAt: patch.lastPatrolAt ?? prev?.lastPatrolAt,
    createdAt: prev?.createdAt ?? Date.now(),
  };
  map[sessionId] = next;
  writeAll(map);
  return next;
}

export function removePilotProfile(sessionId: string): void {
  const map = readPilotProfiles();
  if (!(sessionId in map)) return;
  delete map[sessionId];
  writeAll(map);
}

/**
 * 进 system prompt 的那段: 这个 Pilot 叫什么、管什么。
 * brief=true 给聊天 / 轻档 —— 那两档用精简 prompt, 不带 Pilot 正文, 所以口吻规则要在这里补上。
 */
export function buildPilotPersonaPrompt(sessionId: string | undefined, language: 'zh' | 'en', brief: boolean): string | null {
  const p = getPilotProfile(sessionId);
  const zh = language === 'zh';
  const lines: string[] = [];
  if (p) {
    lines.push(zh ? `## 你是「${p.name}」` : `## You are "${p.name}"`);
    lines.push(zh
      ? `用户给你起的名字是「${p.name}」, 被问起就这么称呼自己。`
      : `The user named you "${p.name}"; use that name when asked.`);
    if (p.persona) {
      lines.push(zh ? `用户给你的分工和要求:\n${p.persona}` : `What the user wants from you:\n${p.persona}`);
    }
  }
  if (brief) {
    lines.push(zh
      ? '你的回复会被念出来: 一次一到三句, 口语, 不用 markdown、列表、代码和链接。'
      : 'Your replies are read aloud: one to three sentences, conversational, no markdown, lists, code or links.');
  }
  return lines.length ? lines.join('\n\n') : null;
}
