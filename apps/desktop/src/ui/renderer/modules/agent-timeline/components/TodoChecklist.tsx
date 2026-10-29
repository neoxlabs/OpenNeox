import React from 'react';

type TodoState = 'done' | 'now' | 'todo' | 'skip';
const MARKS: Array<[RegExp, TodoState]> = [
  [/^[✓✔☑]\s*/, 'done'],
  [/^[◐●▶➤]\s*/, 'now'],
  [/^[○◯☐·•]\s*/, 'todo'],
  [/^[–—✗×-]\s+/, 'skip'],
];

export function parseTodoLines(lines: string[]): Array<{ state: TodoState; text: string }> {
  const items: Array<{ state: TodoState; text: string }> = [];
  for (const raw of lines) {
    const t = raw.trim();
    for (const [re, state] of MARKS) {
      if (re.test(t)) {
        const text = t.replace(re, '').trim();
        if (text) items.push({ state, text });
        break;
      }
    }
  }
  return items;
}

export const TodoChecklist: React.FC<{ lines: string[] }> = ({ lines }) => {
  const items = parseTodoLines(lines);
  if (items.length === 0) return null;
  const rows = Math.ceil(items.length / 2);
  return (
    <div className="nx-todo" style={{ gridTemplateRows: `repeat(${rows}, 26px)` }}>
      {items.map((it, i) => (
        <div key={i} className={`nx-todo__i is-${it.state}`}>
          {it.state === 'done' ? (
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
          ) : (
            <span className="nx-todo__dot" aria-hidden="true" />
          )}
          <span className="nx-todo__t">{it.text}</span>
        </div>
      ))}
    </div>
  );
};
