import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { NeoxIllus } from '../../media/illus';
import { ChoiceDialog, type ChoiceOption } from './ChoiceDialog';

type StyleRow = { id: string; name: string; description: string; builtin: boolean };

const EVENT = 'neox:output-style';
let cachedCurrent: string | null = null;

async function fetchStyles(): Promise<{ styles: StyleRow[]; current: string }> {
  const r = await (window as any).neox?.outputStyleList?.();
  const current = typeof r?.current === 'string' ? r.current : 'standard';
  cachedCurrent = current;
  return { styles: Array.isArray(r?.styles) ? r.styles : [], current };
}

async function setOutputStyle(id: string): Promise<void> {
  const r = await (window as any).neox?.outputStyleSet?.(id);
  if (!r || r.success === false) throw new Error(r?.error || 'save failed');
  cachedCurrent = id;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

export function useOutputStyle(): string {
  const [current, setCurrent] = React.useState(cachedCurrent ?? 'standard');
  React.useEffect(() => {
    let alive = true;
    if (cachedCurrent === null) void fetchStyles().then((r) => { if (alive) setCurrent(r.current); }).catch(() => {});
    const on = (e: Event) => setCurrent((e as CustomEvent<string>).detail);
    window.addEventListener(EVENT, on);
    return () => { alive = false; window.removeEventListener(EVENT, on); };
  }, []);
  return current;
}

/** 菜单行上的当前档名 (自定义风格显示它自己的名字) */
export function outputStyleLabel(id: string, isZh: boolean): string {
  const builtin: Record<string, [string, string]> = {
    standard: ['标准', 'Standard'],
    concise: ['简洁', 'Concise'],
    detailed: ['详细', 'Detailed'],
    code_only: ['只要代码', 'Code only'],
  };
  const hit = builtin[id];
  if (hit) return isZh ? hit[0] : hit[1];
  return id.startsWith('custom:') ? id.slice('custom:'.length) : id;
}

export const OutputStyleDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { isZh } = useI18n();
  const [rows, setRows] = React.useState<StyleRow[] | null>(null);
  const current = useOutputStyle();

  React.useEffect(() => {
    let alive = true;
    void fetchStyles().then((r) => { if (alive) setRows(r.styles); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  const builtinCards: Record<string, Omit<ChoiceOption<string>, 'id'>> = {
    standard: {
      art: NeoxIllus.styleStandard,
      name: isZh ? '标准' : 'Standard',
      lead: isZh ? '结果 + 关键理由' : 'Result plus key reasoning',
      points: isZh ? ['说清改了什么、为什么', '长短看问题'] : ['What changed and why', 'Length fits the question'],
    },
    concise: {
      art: NeoxIllus.styleConcise,
      name: isZh ? '简洁' : 'Concise',
      lead: isZh ? '先说结果, 不复述' : 'Result first, no recap',
      points: isZh ? ['只报结论和要你做的事', '报错和风险照样说全'] : ['Outcomes and your next step only', 'Errors and risks stay complete'],
    },
    detailed: {
      art: NeoxIllus.styleDetailed,
      name: isZh ? '详细' : 'Detailed',
      lead: isZh ? '讲清为什么' : 'Explains the why',
      points: isZh ? ['每个决定附理由', '有别的做法会对比'] : ['Reasoning behind each decision', 'Compares real alternatives'],
    },
    code_only: {
      art: NeoxIllus.styleCode,
      name: isZh ? '只要代码' : 'Code only',
      lead: isZh ? '代码和路径, 几乎不写字' : 'Code and paths, almost no prose',
      points: isZh ? ['一个文件一段代码', '出错和提问仍用正常话'] : ['One block per file', 'Errors and questions in plain words'],
    },
  };

  const options: Array<ChoiceOption<string>> = (rows ?? []).map((r) => (r.builtin && builtinCards[r.id]
    ? { id: r.id, ...builtinCards[r.id] }
    : {
        id: r.id,
        art: NeoxIllus.fitNote,
        name: r.name,
        lead: isZh ? '你自己写的风格' : 'Your own style',
        points: r.description ? [r.description] : [],
      }));

  if (rows === null) return null;
  return (
    <ChoiceDialog<string>
      title={isZh ? '回复风格' : 'Reply style'}
      sub={isZh ? 'Agent 回你消息时怎么写。下一句生效。' : 'How the agent writes its replies. Applies from your next message.'}
      options={options}
      current={options.some((o) => o.id === current) ? current : 'standard'}
      cols={4}
      onPick={async (id) => { await setOutputStyle(id); onClose(); }}
      onClose={onClose}
      foot={isZh
        ? '自定义: 在 ~/.neox/output-styles/ 放一个 .md 文件, 正文就是要求。'
        : 'Custom: drop a .md file into ~/.neox/output-styles/ — its body is the instruction.'}
    />
  );
};
