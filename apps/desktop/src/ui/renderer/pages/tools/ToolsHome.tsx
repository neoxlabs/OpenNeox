import React, { useEffect, useState } from 'react';
import { TOOL_ICONS } from '../../modules/shell/sidebarToolIcons';
import { loadMcp, loadSkills } from '../../modules/shell/sidebarDockActions';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { isTeamEnabled, teamUnavailableReason } from '../team/teamAvailability';
import { useI18n } from '../../hooks/useI18n';
import '../../components/tool-page.css';
import './tools-home.css';

export type ToolId = 'skills' | 'mcp' | 'knowledge' | 'image' | 'plugins' | 'library' | 'team';

interface Status { text: string; tone?: 'warn' | 'accent' }

export const ToolsHome: React.FC<{
  onOpen: (id: ToolId) => void;
  onBack?: () => void;
  hasLibrary?: boolean;
}> = ({ onOpen, onBack, hasLibrary }) => {
  const { isZh } = useI18n();
  const mode = useAgentModeVariant();
  const [status, setStatus] = useState<Partial<Record<ToolId, Status>>>({});

  /* 现状一行: 各读各的, 谁先到谁先显示, 读不到就不写 */
  useEffect(() => {
    let alive = true;
    const put = (id: ToolId, s: Status | undefined) => { if (alive && s) setStatus((p) => ({ ...p, [id]: s })); };
    void loadSkills().then((s) => put('skills', s.length ? { text: isZh ? `${s.length} 个可用` : `${s.length} available` } : undefined)).catch(() => {});
    void loadMcp().then(({ rows }) => {
      const on = rows.filter((r) => r.enabled);
      const bad = on.filter((r) => r.ok === false).length;
      put('mcp', rows.length
        ? bad
          ? { text: isZh ? `${on.length} 台开着 · ${bad} 台连不上` : `${on.length} on · ${bad} failing`, tone: 'warn' }
          : { text: isZh ? `${on.length} 台开着` : `${on.length} on` }
        : undefined);
    }).catch(() => {});
    void window.neox.knowledgeListCards?.().then((r: any) => {
      if (!r?.ok) return;
      const drafts = r.cards.filter((c: any) => c.trust === 'draft').length;
      put('knowledge', drafts
        ? { text: isZh ? `${r.cards.length} 条 · ${drafts} 条等你确认` : `${r.cards.length} entries · ${drafts} to review`, tone: 'warn' }
        : { text: isZh ? `${r.cards.length} 条知识` : `${r.cards.length} entries` });
    }).catch(() => {});
    void (window as any).neox?.pluginList?.().then((r: any) => {
      const n = Array.isArray(r?.plugins) ? r.plugins.length : 0;
      put('plugins', n ? { text: isZh ? `${n} 个已安装` : `${n} installed` } : undefined);
    }).catch(() => {});
    return () => { alive = false; };
  }, [isZh]);

  const teamOpen = isTeamEnabled();
  /* 团队只在 Code 里用 (见 NeoxShellHost handleOpenTeam) —— 别的模式里点它会先切过去, 卡上先说清 */
  const teamHint: Status | undefined = teamOpen && !mode.isCode
    ? { text: isZh ? '在 Code 里用 · 点了会切过去' : 'Runs in Code — switches mode' }
    : undefined;
  const tools: Array<{ id: ToolId; name: string; desc: string; disabled?: boolean; reason?: string }> = [
    { id: 'skills', name: isZh ? '技能' : 'Skills', desc: isZh ? '一套做法存成技能，说一声就照着干' : 'Saved playbooks the agent follows on request' },
    ...(!mode.isWork ? [{ id: 'mcp' as const, name: 'MCP', desc: isZh ? '接上外部服务的工具：数据库、浏览器、云平台…' : 'Tools from external services: databases, browsers, clouds…' }] : []),
    { id: 'knowledge', name: isZh ? '知识库' : 'Knowledge', desc: isZh ? '项目里攒下的结论和约定，Agent 做事前先查' : 'Conclusions and conventions the agent checks first' },
    { id: 'image', name: isZh ? '图片' : 'Images', desc: isZh ? '说一句出一组图，接着说就接着改' : 'Describe it, get a set, keep refining' },
    { id: 'plugins', name: isZh ? '插件' : 'Plugins', desc: isZh ? '给 Agent 装新本事：GitHub、Cloudflare、查论文…' : 'New skills: GitHub, Cloudflare, papers…' },
    ...(hasLibrary ? [{ id: 'library' as const, name: isZh ? '成品架' : 'Shelf', desc: isZh ? '所有任务做出来的文件都在这' : 'Everything your tasks have produced' }] : []),
    { id: 'team', name: isZh ? '团队' : 'Team', desc: isZh ? '大目标交给几个 Agent 分头做，你拍板' : 'Several agents split a big goal; you sign off',
      disabled: !teamOpen, reason: teamOpen ? undefined : teamUnavailableReason(isZh) },
  ];

  return (
    <div className="tools-home">
      <div className="tools-home__inner">
        {onBack && (
          <button type="button" className="tp-back" onClick={onBack}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
            {isZh ? '返回任务' : 'Back to tasks'}
          </button>
        )}
        <h1 className="tools-home__title">{isZh ? '工具' : 'Tools'}</h1>
        <p className="tools-home__desc">{isZh ? '给 Agent 加本事、攒知识、出图、组团队。点进去用完，左上角回到这里。' : 'Extend the agent, keep knowledge, make images, run teams.'}</p>
        <div className="tools-home__grid">
          {tools.map((t) => {
            const s = t.id === 'team' ? (teamHint ?? status.team) : status[t.id];
            return (
              <button
                key={t.id}
                type="button"
                className={`tools-home__card${t.disabled ? ' is-disabled' : ''}`}
                onClick={() => { if (!t.disabled) onOpen(t.id); }}
                aria-disabled={t.disabled || undefined}
                title={t.reason}
              >
                <img className="tools-home__icon" src={TOOL_ICONS[t.id]} alt="" draggable={false} />
                <span className="tools-home__text">
                  <span className="tools-home__name">{t.name}</span>
                  <span className="tools-home__card-desc">{t.desc}</span>
                  {(s || t.disabled) && (
                    <span className={`tools-home__status${s?.tone ? ` is-${s.tone}` : ''}`}>
                      {t.disabled ? (isZh ? '暂未开放' : 'Not available yet') : s!.text}
                    </span>
                  )}
                </span>
                <svg className="tools-home__chev" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ToolsHome;
