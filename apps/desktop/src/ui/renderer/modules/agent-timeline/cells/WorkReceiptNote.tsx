import React, { useMemo } from 'react';
import type { Row } from '../timelineRows';
import { buildReceiptNote, collectReceiptEvidence, turnRowsBefore, type ReceiptNote } from '../workReceipt';
import './work-receipt.css';

const basename = (p: string): string => (p.split(/[/\\]/).pop() ?? p).trim();

function sourceLabel(src: { file?: string; cell?: string }): string {
  return [src.file ? basename(src.file) : '', src.cell ?? ''].filter(Boolean).join(' · ');
}

export const WorkReceiptNote: React.FC<{ note: ReceiptNote; zh: boolean }> = ({ note, zh }) => {
  if (note.failure) {
    const { failedStep, tried, suggestion } = note.failure;
    return (
      <div className="nx-receipt nx-receipt--failed" role="status">
        <ul className="nx-receipt__rows">
          <li className="nx-receipt__row">
            <span className="nx-receipt__k">{zh ? '哪一步没过' : 'Where it stopped'}</span>
            <span className="nx-receipt__v">{failedStep}</span>
          </li>
          <li className="nx-receipt__row">
            <span className="nx-receipt__k">{zh ? '我试了什么' : 'What I tried'}</span>
            <span className="nx-receipt__v">{tried}</span>
          </li>
          <li className="nx-receipt__row">
            <span className="nx-receipt__k">{zh ? '建议你怎么走' : 'What you can do'}</span>
            <span className="nx-receipt__v">{suggestion}</span>
          </li>
        </ul>
      </div>
    );
  }

  const unmatched = [...note.unmatchedNumbers, ...note.unmatchedPaths];
  if (note.verifiedNumbers.length === 0 && unmatched.length === 0) return null;

  return (
    <div className="nx-receipt" role="status">
      {note.verifiedNumbers.length > 0 && (
        <div className="nx-receipt__line nx-receipt__line--ok">
          <span className="nx-receipt__k">{zh ? '数字核对过' : 'Numbers checked'}</span>
          <span className="nx-receipt__v">
            {note.verifiedNumbers.map((n, i) => {
              const src = sourceLabel(n.source);
              return (
                <React.Fragment key={`${n.raw}-${i}`}>
                  {i > 0 && <span className="nx-receipt__sep" aria-hidden>、</span>}
                  <span className="nx-receipt__num">{n.raw}</span>
                  {src && <span className="nx-receipt__src">{src}</span>}
                </React.Fragment>
              );
            })}
          </span>
        </div>
      )}
      {unmatched.length > 0 && (
        <div
          className="nx-receipt__line nx-receipt__line--warn"
          title={zh
            ? '这些数字 / 文件在这一轮的工具结果里没找到出处。可能是我自己算的, 也可能是写错了 —— 用到对外汇报前建议核一下。'
            : 'These numbers / files were not found in this turn\'s tool results. They may be my own calculation or a mistake — check before reporting them upward.'}
        >
          <span className="nx-receipt__k">{zh ? '没找到出处' : 'No source found'}</span>
          <span className="nx-receipt__v">{unmatched.join(zh ? '、' : ', ')}</span>
        </div>
      )}
    </div>
  );
};

export default WorkReceiptNote;

/**
 * 挂到时间线用的一层 —— 自己按这一轮的行算出旁注, 省得调用方每帧重算。
 * `rows` 是整条时间线的行, `index` 是回执那条消息的下标: 证据只取**这一轮**
 * (上一条用户消息之后) 的工具结果。
 */
export const WorkReceiptForTurn: React.FC<{
  rows: readonly Row[];
  index: number;
  text: string;
  zh: boolean;
}> = ({ rows, index, text, zh }) => {
  const note = useMemo(
    () => buildReceiptNote(text ?? '', collectReceiptEvidence(turnRowsBefore(rows, index)), zh),
    [rows, index, text, zh],
  );
  return note ? <WorkReceiptNote note={note} zh={zh} /> : null;
};
