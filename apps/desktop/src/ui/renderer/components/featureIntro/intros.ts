import { NeoxIllus } from '../../media/illus';

export type FeatureIntroId = 'skills' | 'mcp' | 'knowledge' | 'voice-mode';

export interface FeatureIntro {
  art: string;
  title: [zh: string, en: string];
  lead: [zh: string, en: string];
  steps: Array<[zh: string, en: string]>;
}

export const FEATURE_INTROS: Record<FeatureIntroId, FeatureIntro> = {
  skills: {
    art: NeoxIllus.skillHero,
    title: ['技能', 'Skills'],
    lead: ['常做的事存成一句命令。', 'Save the things you do often as one command.'],
    steps: [
      ['输入框敲 /，选一个技能，后面接要办的事', 'Type / in the composer, pick a skill, then say what to do'],
      ['碰到对口的活，Agent 也会自己调用', 'Agent also picks a matching skill on its own'],
      ['「创建」写自己的，或「导入」Claude Code / Codex 的', 'Create your own, or import from Claude Code / Codex'],
    ],
  },
  mcp: {
    art: NeoxIllus.mcpHero,
    title: ['MCP 工具', 'MCP tools'],
    lead: ['给 Agent 接上更多工具。', 'Give Agent more tools.'],
    steps: [
      ['点「添加」，填本地命令或远程地址', 'Click Add and enter a local command or a remote URL'],
      ['打开总开关', 'Turn on the main switch'],
      ['之后 Agent 需要时会直接用这些工具', 'Agent uses those tools whenever it needs them'],
    ],
  },
  knowledge: {
    art: NeoxIllus.memHero,
    title: ['知识库', 'Knowledge'],
    lead: ['把资料交给 Neox，回答时会翻出来用。', 'Hand Neox your documents; it looks them up when answering.'],
    steps: [
      ['「导入文档」或直接拖进来，只记路径不占空间', 'Import documents or drag them in; only the path is stored'],
      ['对话里让它「沉淀成知识」，条目会出现在这里', 'Ask it to save knowledge in a chat; entries show up here'],
      ['「整理」去重合并、标出过期的，可设每 7 天自动跑', 'Curate merges duplicates and flags stale entries; can run every 7 days'],
    ],
  },
  'voice-mode': {
    art: NeoxIllus.ttsHero,
    title: ['语音对话', 'Voice mode'],
    lead: ['全程动嘴，不用碰键盘。', 'Hands-free conversation.'],
    steps: [
      ['直接说，停顿一下就自动发出', 'Just talk; a short pause sends it'],
      ['它在念的时候，点中间的圆球打断', 'Click the orb to interrupt while it speaks'],
      ['Esc 结束；⌘⇧M 随时再打开', 'Esc to end; ⌘⇧M to open again'],
    ],
  },
};
