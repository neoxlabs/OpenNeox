import React, { useState } from 'react';
import Markdown from '../../../components/Markdown';
import { useI18n } from '../../../hooks/useI18n';
import '../toolCards/tool-cards.css';


interface Props {
  skillId: string;
  skillName: string;
  trustLevel?: 'trusted' | 'limited';
  allowedTools?: string[];
  model?: string;
  body: string;
  saved?: { description?: string; whenToUse?: string; scope?: 'user' | 'workspace'; path?: string; steps?: number };
}

const Bolt: React.FC = () => (
  <span className="nx-sk__bolt" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="14" height="14"><path d="M9.2 1.5 3.6 9h3.6l-.9 5.5L12.4 7H8.6z" fill="currentColor" /></svg>
  </span>
);

export const SkillCardView: React.FC<Props> = ({ skillId, skillName, trustLevel, allowedTools, model, body, saved }) => {
  const { isZh: zh } = useI18n();
  const [open, setOpen] = useState(false);
  const restricted = trustLevel === 'limited' ? (allowedTools?.length ?? 0) : 0;
  const head = (
    <div className="nx-sk__head">
      <Bolt />
      <span className="nx-sk__name">{skillName}</span>
      <code className="nx-sk__id">/{skillId}</code>
      {saved && <span className="nx-sk__tag is-new">{zh ? '已保存' : 'Saved'}</span>}
      {saved && <span className="nx-sk__tag">{saved.scope === 'workspace' ? (zh ? '本项目' : 'This project') : (zh ? '所有项目' : 'All projects')}</span>}
      {model && <span className="nx-sk__tag">{model}</span>}
      {restricted > 0 && <span className="nx-sk__tag is-warn" title={allowedTools!.join(', ')}>{zh ? `限 ${restricted} 个工具` : `${restricted} tools only`}</span>}
    </div>
  );

  if (saved) {
    return (
      <div className="nx-tc nx-sk is-saved">
        {head}
        {saved.description && <div className="nx-sk__desc">{saved.description}</div>}
        {saved.whenToUse && (
          <div className="nx-sk__when"><span>{zh ? '什么时候用' : 'When'}</span>{saved.whenToUse}</div>
        )}
        <div className="nx-tc__foot">
          <span className="nx-tc__foot-tx">
            {saved.steps ? (zh ? `${saved.steps} 步 · ` : `${saved.steps} steps · `) : ''}
            {zh ? `输入 /${skillId} 或直接说需求` : `Type /${skillId} or just ask`}
          </span>
          <span className="nx-tc__foot-acts">
            <button type="button" className="nx-tc__act" onClick={() => {
              try { window.dispatchEvent(new CustomEvent('neox:open-settings', { detail: { tab: 'skills' } })); } catch { /* ignore */ }
            }}>{zh ? '在设置里看' : 'View'}</button>
            <button type="button" className="nx-tc__primary" onClick={() => {
              try { window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: `/${skillId} `, focus: true } })); } catch { /* ignore */ }
            }}>{zh ? '试一下' : 'Try it'}</button>
          </span>
        </div>
      </div>
    );
  }

  const text = body.trim();
  const long = text.split('\n').length > 6 || text.length > 360;
  return (
    <div className="nx-tc nx-sk">
      {head}
      {text && (
        <div className={`nx-sk__body${long && !open ? ' is-clipped' : ''}`}>
          <Markdown content={text} />
        </div>
      )}
      {long && (
        <div className="nx-tc__foot">
          <span className="nx-tc__foot-tx">{zh ? '按这份说明做' : 'Following these instructions'}</span>
          <span className="nx-tc__foot-acts">
            <button type="button" className="nx-tc__act" onClick={() => setOpen((v) => !v)}>{open ? (zh ? '收起' : 'Less') : (zh ? '展开全部' : 'Show all')}</button>
          </span>
        </div>
      )}
    </div>
  );
};
