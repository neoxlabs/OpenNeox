import React, { useEffect, useRef } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { SkillScanImport } from './SkillScanImport';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import { CustomSelect } from '../../../components/CustomSelect';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  NeoxInput,
  NeoxTextarea,
  NeoxButton,
  Segmented,
} from '../../../components/settings-base';


export const SkillEditForm: React.FC = () => {
  const ctx = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';
  const t = ctx.t;

  /* 两态 mode:
   *   import: 从 URL/路径导入 (showSkillImportForm)
   *   create: 新建 skill (showSkillAddForm)
   */
  const mode: 'create' | 'import' =
    ctx.showSkillImportForm ? 'import'
    : 'create';

  /* 扫描独占一屏 —— true 时这一页只剩扫描组件 (见下面的早返) */
  const [scanMode, setScanMode] = React.useState(false);
  /* 创建页: 一句话交给 Neox 写 (主路径) / 自己写 (展开才出现) */
  const [aiBrief, setAiBrief] = React.useState('');
  const [manualOpen, setManualOpen] = React.useState(false);
  const idTouchedRef = useRef(false);
  const [idEditing, setIdEditing] = React.useState(false);
  const handleSkillIdChange = (val: string) => {
    idTouchedRef.current = true;
    ctx.setSkillFormId(val.toLowerCase().replace(/[^a-z0-9-]/g, ''));
  };
  const deriveIdFromName = (name: string): string => {
    const ascii = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (ascii) return ascii;
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `skill-${h.toString(36).slice(0, 6)}`;
  };
  useEffect(() => {
    if (mode !== 'create') return;
    if (idTouchedRef.current) return;
    if (!ctx.skillFormName) return;
    const derived = deriveIdFromName(ctx.skillFormName);
    if (derived && derived !== ctx.skillFormId) {
      ctx.setSkillFormId(derived);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.skillFormName, mode]);

  const handleBack = () => {
    if (mode === 'create') {
      ctx.setShowSkillAddForm(false);
    } else {
      ctx.setShowSkillImportForm(false);
      ctx.setSkillPreview(null);
    }
  };

  if (mode === 'create') {
    return (
      <div className="settings-panel-content skills-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
          <PageTitle
            title={zh ? '创建技能' : 'Create Skill'}
            subtitle={zh ? '把你的做法教给 Neox, 以后遇到同样的事它就照着做' : 'Teach Neox how you do something, so it follows the same steps next time'}
          />
          <NeoxButton
            variant="ghost"
            size="sm"
            onClick={handleBack}
            leading={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            }
          >
            {zh ? '返回' : 'Back'}
          </NeoxButton>
        </div>

        <Section>
          <div className="skill-create-ai">
            <div className="skill-create-ai__head">
              <span className="skill-create-ai__title">{zh ? '说说你想要什么' : 'Describe what you want'}</span>
              <span className="skill-create-ai__hint">
                {zh
                  ? '用大白话写就行: 什么时候用、要做哪几步、有什么讲究。Neox 会新开一个对话帮你写好。'
                  : 'Plain words are fine: when to use it, the steps, anything to watch for. Neox writes it in a new chat.'}
              </span>
            </div>
            <NeoxTextarea
              value={aiBrief}
              onChange={(e) => setAiBrief(e.target.value)}
              placeholder={zh
                ? '例如: 每次我说"发版"时, 先跑测试和 lint, 有失败就停下来告诉我原因; 都通过了再打 tag, 更新日志用中文写三行以内。'
                : 'e.g. When I say "release", run tests and lint first and stop with the reason on failure; if all pass, tag it and write a changelog of at most three lines.'}
              rows={4}
            />
            <div className="skill-create-ai__foot">
              <Segmented
                aria-label={zh ? '保存位置' : 'Save to'}
                value={ctx.skillFormTarget}
                onChange={(v) => ctx.setSkillFormTarget(v)}
                options={[
                  { value: 'user', label: zh ? '所有项目可用' : 'All projects' },
                  { value: 'workspace', label: zh ? '仅当前项目' : 'This project only' },
                ]}
              />
              <NeoxButton
                variant="primary"
                disabled={!aiBrief.trim()}
                onClick={() => {
                  const brief = aiBrief.trim();
                  const where = ctx.skillFormTarget === 'workspace'
                    ? (zh ? '当前项目的 .neox/skills/<技能id>/SKILL.md' : '.neox/skills/<skill-id>/SKILL.md in the current project')
                    : '~/.neox/skills/<skill-id>/SKILL.md';
                  const prompt = zh
                    ? [
                        '帮我创建一个 Neox 技能。我的需求:',
                        '',
                        brief,
                        '',
                        `要求: 写到 ${where}。技能 id 用小写字母和连字符, 跟用途相关。`,
                        '文件开头是 YAML frontmatter: name (简短中文名)、description (一句话说清什么时候该用它 —— Agent 靠这句判断何时调用)、user-invocable: true。',
                        '正文写成可以直接照做的步骤, 别写空话。需求里有说不清、会影响做法的地方, 先问我一句再写; 写完告诉我怎么调用。',
                      ].join('\n')
                    : [
                        'Create a Neox skill for me. What I want:',
                        '',
                        brief,
                        '',
                        `Write it to ${where}. Use a lowercase-hyphen skill id that matches its purpose.`,
                        'Start with YAML frontmatter: name (short), description (one sentence on when to use it — the agent decides from this), user-invocable: true.',
                        'Make the body concrete, followable steps. If something ambiguous would change the approach, ask me first; when done, tell me how to invoke it.',
                      ].join('\n');
                  window.dispatchEvent(new CustomEvent('neox:start-task-session', {
                    detail: { name: zh ? `创建技能 · ${brief.slice(0, 16)}` : `New skill · ${brief.slice(0, 20)}`, prompt },
                  }));
                  setAiBrief('');
                  handleBack();
                }}
              >
                {zh ? '让 Neox 帮我写' : 'Let Neox write it'}
              </NeoxButton>
            </div>
          </div>
        </Section>

        <button
          type="button"
          className={`skill-create-manual-toggle${manualOpen ? ' is-open' : ''}`}
          onClick={() => setManualOpen((v) => !v)}
          aria-expanded={manualOpen}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 6l6 6-6 6" />
          </svg>
          {zh ? '我自己写' : 'Write it myself'}
        </button>

        {manualOpen && (
          <>
            {/* 标签在上、控件满宽的竖排 (不用 SettingsRow 左标题右控件: 做表单时左缘对不齐, 输入区被挤窄) */}
            <Section>
              <div className="nx-form">
                <label className="nx-field">
                  <span className="nx-field__label">{zh ? '名字' : 'Name'} <em>*</em></span>
                  <NeoxInput
                    value={ctx.skillFormName}
                    onChange={(e) => ctx.setSkillFormName(e.target.value)}
                    placeholder={zh ? '例如: 发版检查' : 'e.g. Release check'}
                  />
                  {/* 命令名从名字自动推出, 平时是一行小字, 点「改」才变输入框 */}
                  <span className="skill-form-cmd">
                    {zh ? '调用方式' : 'Invoke with'}
                    {idEditing ? (
                      <NeoxInput
                        autoFocus
                        value={ctx.skillFormId}
                        onChange={(e) => handleSkillIdChange(e.target.value)}
                        onBlur={() => setIdEditing(false)}
                        placeholder="my-skill"
                      />
                    ) : (
                      <>
                        <code>/{ctx.skillFormId || (zh ? '…' : '…')}</code>
                        {ctx.skillFormId && (
                          <button type="button" className="skill-form-cmd__edit" onClick={() => setIdEditing(true)}>
                            {/* 中文名推不出英文命令名, 只能给个哈希 (skill-xh5c9v) —— 这时直接请他起一个 */}
                            {!idTouchedRef.current && !/[a-z0-9]/i.test(ctx.skillFormName)
                              ? (zh ? '起个好记的英文名' : 'Pick a memorable name')
                              : (zh ? '改' : 'Edit')}
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </label>

                <label className="nx-field">
                  <span className="nx-field__label">{zh ? '什么时候用' : 'When to use'}</span>
                  <span className="nx-field__hint">{zh ? 'Agent 靠这一句判断什么时候自动用它' : 'The agent reads this to decide when to use it'}</span>
                  <NeoxTextarea
                    value={ctx.skillFormDesc}
                    onChange={(e) => ctx.setSkillFormDesc(e.target.value)}
                    placeholder={zh ? '例如: 用户说"发版"或要打 tag 时' : 'e.g. When the user says "release" or wants to tag a version'}
                    rows={2}
                  />
                </label>

                <label className="nx-field">
                  <span className="nx-field__label">{zh ? '怎么做' : 'How to do it'}</span>
                  <span className="nx-field__hint">{zh ? '一步一步写清楚, 支持 Markdown' : 'Step by step; Markdown supported'}</span>
                  <NeoxTextarea
                    value={ctx.skillFormInstructions}
                    onChange={(e) => ctx.setSkillFormInstructions(e.target.value)}
                    placeholder={zh
                      ? '1. 先跑测试和 lint, 失败就停下来告诉用户原因\n2. 都通过后打 tag\n3. 更新日志用中文写三行以内'
                      : '1. Run tests and lint; stop and report on failure\n2. Tag the version once both pass\n3. Write a changelog of at most three lines'}
                    rows={10}
                  />
                </label>

                <div className="nx-field">
                  <span className="nx-field__label">{zh ? '在哪里可用' : 'Available in'}</span>
                  <Segmented
                    aria-label={zh ? '保存位置' : 'Save to'}
                    value={ctx.skillFormTarget}
                    onChange={(v) => ctx.setSkillFormTarget(v)}
                    options={[
                      { value: 'user', label: zh ? '所有项目' : 'All projects' },
                      { value: 'workspace', label: zh ? '仅当前项目' : 'This project only' },
                    ]}
                  />
                </div>
              </div>
            </Section>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8, paddingBottom: 12 }}>
              <NeoxButton variant="secondary" onClick={handleBack}>
                {t?.common?.cancel ?? (zh ? '取消' : 'Cancel')}
              </NeoxButton>
              <NeoxButton
                variant="primary"
                onClick={ctx.handleSkillCreate}
                disabled={!ctx.skillFormId?.trim() || !ctx.skillFormName?.trim()}
              >
                {zh ? '保存技能' : 'Save skill'}
              </NeoxButton>
            </div>
          </>
        )}
      </div>
    );
  }

  /* mode === 'import' */
  const preview = ctx.skillPreview;
  const previewLoading = ctx.skillPreviewLoading;

  const handlePreview = async () => {
    if (!ctx.skillImportUrl?.trim()) return;
    ctx.setSkillPreviewLoading(true);
    try {
      const p = await (window.neox as any).skillsPreviewInstall(ctx.skillImportUrl.trim());
      ctx.setSkillPreview(p);
    } catch (e: any) {
      ctx.setSkillPreview({ success: false, error: e?.message ?? String(e) });
    } finally {
      ctx.setSkillPreviewLoading(false);
    }
  };

  if (scanMode) {
    return (
      <div className="settings-panel-content skills-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
          <PageTitle
            title={zh ? '导入技能' : 'Import Skill'}
            subtitle={zh ? '从本机已有的 Claude Code / Codex 技能里挑' : 'Pick from the skills already on this Mac'}
          />
          <NeoxButton variant="ghost" size="sm" onClick={() => setScanMode(false)}>
            {zh ? '← 换一种方式' : '← Change method'}
          </NeoxButton>
        </div>
        <Section>
          <SkillScanImport
            zh={zh}
            target={ctx.skillImportTarget}
            onImported={() => { void ctx.loadSkills?.(); }}
          />
        </Section>
      </div>
    );
  }

  return (
    <div className="settings-panel-content skills-panel">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={zh ? '导入技能' : 'Import Skill'}
          subtitle={zh ? '从本机扫描，或填 URL / 本地路径' : 'Scan this Mac, or paste a URL / local path'}
        />
        <NeoxButton
          variant="ghost"
          size="sm"
          onClick={handleBack}
          leading={
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          }
        >
          {zh ? '返回' : 'Back'}
        </NeoxButton>
      </div>

      <Section>
        <button
          type="button"
          className="apiv2__add-path-card"
          onClick={() => setScanMode(true)}
          style={{ width: '100%' }}
        >
          <span className="apiv2__add-path-card__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <path d="M7 12h10" />
            </svg>
          </span>
          <span className="apiv2__add-path-card__title">
            {zh ? '从本机扫描技能' : 'Scan this Mac for skills'}
          </span>
          <span className="apiv2__add-path-card__desc">
            {zh
              ? 'Claude Code / Codex 里写过的技能，扫出来勾选批量导入'
              : 'Skills you already wrote in Claude Code / Codex — scan, pick, import'}
          </span>
        </button>
      </Section>

      <Section>
        <SectionTitle title={zh ? '从 URL / 路径导入' : 'From URL / path'} />
        <SettingsCard>
          <SettingsRow
            title={zh ? 'URL 或本地路径' : 'URL or local path'}
            desc={zh ? '支持 GitHub raw URL / 直接链接 / 本地文件路径' : 'GitHub raw URL / direct link / local file path'}
            control={
              <div style={{ width: 360 }}>
                <NeoxInput
                  value={ctx.skillImportUrl}
                  onChange={(e) => { ctx.setSkillImportUrl(e.target.value); ctx.setSkillPreview(null); }}
                  placeholder="https://example.com/skill.md  或  /path/to/SKILL.md"
                />
              </div>
            }
          />
          <SettingsRow
            title={zh ? '保存位置' : 'Save To'}
            desc={zh ? '「所有项目」只放行技能自己声明的工具；「仅当前项目」工具不受限。' : '"All projects" only allows the tools the skill declares; "This project only" leaves tools unrestricted.'}
            control={
              <div style={{ width: 280 }}>
                <CustomSelect
                  value={ctx.skillImportTarget}
                  onChange={(v: string) => ctx.setSkillImportTarget(v as 'user' | 'workspace')}
                  options={[
                    { value: 'user', label: zh ? '所有项目' : 'All projects' },
                    { value: 'workspace', label: zh ? '仅当前项目' : 'This project only' },
                  ]}
                />
              </div>
            }
          />
        </SettingsCard>
      </Section>

      {/* Preview 卡片 — Preview 成功 / 失败 / 无 */}
      {preview?.success && (
        <Section>
          <SectionTitle title={zh ? '预览' : 'Preview'} desc={zh ? '装之前看清作者和它要用的工具' : 'Check the author and the tools it wants before installing'} />
          <SettingsCard>
            <SettingsRow title={zh ? '名称' : 'Name'} control={<strong>{preview.name} <span style={{color: 'var(--neox-fg-secondary)', marginLeft: 8, fontWeight: 400}}>({preview.skillId})</span></strong>} />
            <SettingsRow title={zh ? '版本' : 'Version'} control={<span>{preview.version}</span>} />
            <SettingsRow title={zh ? '作者' : 'Author'} control={<span>{preview.author ?? <em style={{color: 'var(--neox-fg-hint)'}}>{zh ? '未指定' : '(unspecified)'}</em>}</span>} />
            <SettingsRow title={zh ? '描述' : 'Description'} desc={preview.description ?? '(none)'} />
            <SettingsRow
              title={zh ? '可用工具' : 'Allowed Tools'}
              control={
                preview.allowedTools && preview.allowedTools.length > 0
                  ? <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>{preview.allowedTools.map((tt: string) => <code key={tt} className="skill-preview-tool">{tt}</code>)}</span>
                  : <span style={{ color: 'var(--neox-warn)' }}>⚠ {zh ? '未声明 — 装成「所有项目」后它一个工具都调不了' : 'None declared — installed at user level it can call no tools'}</span>
              }
            />
            {preview.bodyPreview && (
              <div style={{ padding: 'var(--nx-space-3) var(--nx-space-4)' }}>
                <details className="skill-preview-body">
                  <summary>{zh ? 'Body 预览 (前 8 行)' : 'Body preview (first 8 lines)'}</summary>
                  <pre>{preview.bodyPreview}</pre>
                </details>
              </div>
            )}
          </SettingsCard>
        </Section>
      )}
      {preview && !preview.success && (
        <Section>
          <div className="skill-preview-error">
            ❌ {preview.error}
          </div>
        </Section>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingBottom: 12 }}>
        <NeoxButton variant="secondary" onClick={handleBack}>
          {t?.common?.cancel ?? (zh ? '取消' : 'Cancel')}
        </NeoxButton>
        <NeoxButton
          variant="ghost"
          onClick={handlePreview}
          disabled={!ctx.skillImportUrl?.trim() || previewLoading}
        >
          {previewLoading ? (zh ? '查看中...' : 'Loading...') : (zh ? '查看' : 'Preview')}
        </NeoxButton>
        <NeoxButton
          variant="primary"
          onClick={ctx.handleSkillImport}
          disabled={!ctx.skillImportUrl?.trim() || !preview?.success}
          title={!preview?.success ? (zh ? '请先点查看, 看清 author/allowedTools 再装' : 'Click Preview first') : undefined}
          leading={<Icons.Download />}
        >
          {zh ? '安装' : 'Install'}
        </NeoxButton>
      </div>
    </div>
  );
};

export default SkillEditForm;
