import React, { useState } from 'react';
import { useSettingsContext } from '../SettingsContext';
import { useI18n } from '../../../hooks/useI18n';
import Icons from '../../../components/Icons';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  NeoxButton,
} from '../../../components/settings-base';
import Markdown from '../../../components/Markdown';

export const SkillDetailView: React.FC = () => {
  const ctx = useSettingsContext();
  const { language } = useI18n();
  const zh = language === 'zh';

  const skill = ctx.viewingSkill;
  const [rawMode, setRawMode] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const skillId = skill?.id;
  React.useEffect(() => {
    let cancelled = false;
    setRaw(null);
    setRawError(null);
    setDraft(null);
    if (!skillId) return;
    void (window.neox as any).skillsReadRaw?.(skillId).then((r: any) => {
      if (cancelled) return;
      if (r?.success) setRaw(r.content ?? '');
      else setRawError(r?.error || 'unknown');
    });
    return () => { cancelled = true; };
  }, [skillId]);
  if (!skill) return null;

  const k4Meta = ctx.installedMetas?.[skill.id];
  const isLimited = k4Meta?.trustLevel === 'limited';
  const isTrusted = k4Meta?.trustLevel === 'trusted';
  const isBuiltin = skill.source === 'builtin';

  const handleBack = () => ctx.setViewingSkill(null);
  const handleExport = () => ctx.handleSkillExport(skill);
  const handleDelete = () => {
    ctx.handleSkillDelete(skill.id, skill.source);
    ctx.setViewingSkill(null);
  };
  const handleK4Update = () => ctx.handleSkillK4Update(skill.id);
  const handleK4Trust = () => ctx.handleSkillK4Trust(skill.id);
  const handleK4Untrust = () => ctx.handleSkillK4Untrust(skill.id);
  const handleK4Uninstall = () => {
    ctx.handleSkillK4Uninstall(skill.id);
    ctx.setViewingSkill(null);
  };

  return (
    <div className="settings-panel-content">
      {/* Title + back */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={`/${skill.id}`}
          subtitle={
            skill.metadata?.description
              ? skill.metadata.description.slice(0, 100)
              : (zh ? '技能详情' : 'Skill detail')
          }
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

      {/* 元信息 */}
      <Section>
        <SectionTitle title={zh ? '元信息' : 'Metadata'} />
        <SettingsCard>
          <SettingsRow
            title={zh ? '在哪里可用' : 'Available in'}
            control={
              <span className={`skill-source-badge ${skill.source}`}>
                {skill.source === 'user'
                  ? (zh ? '所有项目' : 'All projects')
                  : skill.source === 'workspace'
                    ? (zh ? '仅当前项目' : 'This project')
                    : skill.source === 'mcp' ? 'MCP' : (zh ? '内置' : 'Built-in')}
              </span>
            }
          />
          {/* custom = 没分类, 不单占一行 */}
          {skill.metadata?.neox?.category && skill.metadata.neox.category !== 'custom' && (
            <SettingsRow
              title={zh ? '分类' : 'Category'}
              control={<span className="skill-category-badge">{skill.metadata.neox.category}</span>}
            />
          )}
          {k4Meta && (
            <SettingsRow
              title={zh ? '工具权限' : 'Tool access'}
              desc={
                isLimited
                  ? (zh ? '只能调用它自己声明的那几个工具' : 'Only the tools this skill declares')
                  : (zh ? '可以调用任意工具, 和内置技能同权限' : 'Any tool, same as a built-in skill')
              }
              control={
                <span className={`skill-trust-badge ${isLimited ? 'is-limited' : 'is-trusted'}`}>
                  {isLimited ? (zh ? '🛡 受限' : '🛡 limited') : (zh ? '✓ 不受限' : '✓ trusted')}
                </span>
              }
            />
          )}
          {k4Meta?.installedVersion && k4Meta.installedVersion !== 'unknown' && (
            <SettingsRow
              title={zh ? '版本' : 'Version'}
              control={<code style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 12 }}>v{k4Meta.installedVersion}</code>}
            />
          )}
          {skill.path && (
            <SettingsRow
              title={zh ? '文件路径' : 'Path'}
              control={
                <code style={{
                  fontFamily: 'var(--neox-font-mono, monospace)',
                  fontSize: 11.5,
                  color: 'var(--neox-fg-secondary)',
                  maxWidth: 460,
                  wordBreak: 'break-all',
                  textAlign: 'right',
                  display: 'inline-block',
                }}>
                  {skill.path}
                </code>
              }
            />
          )}
          {skill.contentLength != null && skill.contentLength > 0 && (
            <SettingsRow
              title={zh ? '大小' : 'Size'}
              control={
                <span style={{ fontFamily: 'var(--neox-font-mono, monospace)', fontSize: 11.5, color: 'var(--neox-fg-secondary)' }}>
                  {skill.contentLength > 1024 ? `${(skill.contentLength / 1024).toFixed(1)} KB` : `${skill.contentLength} B`}
                </span>
              }
            />
          )}
        </SettingsCard>
      </Section>

      {/* 描述 */}
      {skill.metadata?.description && (
        <Section>
          <SectionTitle title={zh ? '描述' : 'Description'} />
          <SettingsCard>
            <div style={{ padding: 'var(--nx-space-3) var(--nx-space-4)', fontSize: 13, lineHeight: 1.6, color: 'var(--neox-fg-primary)' }}>
              {skill.metadata.description}
            </div>
          </SettingsCard>
        </Section>
      )}

      {/* 参数 (parametrized skill 才有) */}
      {skill.metadata?.neox?.arguments && skill.metadata.neox.arguments.length > 0 && (
        <Section>
          <SectionTitle
            title={zh ? '参数' : 'Arguments'}
          />
          <SettingsCard>
            {skill.metadata.neox.arguments.map((arg: any, i: number) => (
              <SettingsRow
                key={i}
                title={
                  <span>
                    <code style={{ fontFamily: 'var(--neox-font-mono, monospace)', color: arg.required ? 'var(--neox-primary-600)' : 'var(--neox-fg-primary)' }}>
                      {arg.name}
                    </code>
                    {arg.required && <span style={{ color: 'var(--neox-primary-600)', marginLeft: 4 }}>*</span>}
                  </span>
                }
                desc={arg.description}
              />
            ))}
          </SettingsCard>
        </Section>
      )}

      {/* SKILL.md 原文 —— 非内置直接可改, 内置只读 (它烘焙在 asar 里, 磁盘上没有明文) */}
      {(raw != null || skill.content) && (() => {
        const base = raw ?? skill.content ?? '';
        const text = draft ?? base;
        const dirty = draft != null && draft !== base;
        /* 原文还没读回来之前不给编辑 —— 否则用户在"解析后的正文"上打字, 存回去就是灾难 */
        const editable = !isBuiltin && !!skill.path && raw != null;
        const save = async () => {
          if (!skill.path || draft == null) return;
          setSaving(true);
          try {
            const res = await window.neox.skillsWriteContent(skill.id, draft);
            if (!res?.success) {
              ctx.dispatchOpFailed?.({
                op: zh ? '保存技能' : 'Save skill',
                message: res?.error || (zh ? '未知原因' : 'Unknown error'),
              });
              return;
            }
            setSaved(true);
            setTimeout(() => setSaved(false), 1800);
            /* raw 是 dirty 判定的基准, 保存后要跟上, 否则按钮一直显示"未保存" */
            setRaw(draft);
            setDraft(null);
            ctx.loadSkills?.();
          } catch (e: any) {
            ctx.dispatchOpFailed?.({ op: zh ? '保存技能' : 'Save skill', message: e?.message ?? String(e) });
          } finally {
            setSaving(false);
          }
        };
        return (
          <Section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12 }}>
              <SectionTitle
                title={editable || !isBuiltin ? 'SKILL.md' : (zh ? 'SKILL.md (内置, 只读)' : 'SKILL.md (built-in, read-only)')}
                desc={!isBuiltin && !editable
                  ? (rawError
                    ? (zh ? `读不到原文, 暂时不能编辑: ${rawError}` : `Couldn't read the file, editing is off: ${rawError}`)
                    : (zh ? '正在读取原文…' : 'Loading the file…'))
                  : undefined}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {saved && <span className="skill-saved-tip">{zh ? '已保存' : 'Saved'}</span>}
                {editable && dirty && (
                  <>
                    <NeoxButton variant="ghost" size="sm" onClick={() => setDraft(null)}>
                      {zh ? '撤销' : 'Revert'}
                    </NeoxButton>
                    <NeoxButton variant="primary" size="sm" onClick={save} disabled={saving}>
                      {saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}
                    </NeoxButton>
                  </>
                )}
                <NeoxButton variant="ghost" size="sm" onClick={() => setRawMode((v) => !v)}>
                  {rawMode ? (zh ? '预览' : 'Preview') : (editable ? (zh ? '编辑' : 'Edit') : (zh ? '原文' : 'Source'))}
                </NeoxButton>
              </div>
            </div>
            {rawMode && editable ? (
              <textarea
                className="skill-content-editor"
                value={text}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  /* ⌘S / Ctrl+S 存 —— 编辑器里这是肌肉记忆, 不给就会有人以为没保存 */
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    if (dirty) void save();
                  }
                }}
              />
            ) : rawMode ? (
              <pre className="skill-content-raw">{text}</pre>
            ) : (
              <div className="skill-content-rendered">
                {/* 预览去掉开头的 frontmatter: 那几个字段上面「元信息」已经列了, 渲染出来是一个代码块 = 框里又一个框 */}
                <Markdown content={text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')} />
              </div>
            )}
          </Section>
        );
      })()}

      {/* Actions footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 24, paddingBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* 删除 / 卸载 — 非 builtin 才有 */}
          {!isBuiltin && !k4Meta && (
            <NeoxButton variant="danger" onClick={handleDelete} leading={<Icons.Delete width={14} height={14} />}>
              {zh ? '删除' : 'Delete'}
            </NeoxButton>
          )}
          {k4Meta && (
            <NeoxButton variant="danger" onClick={handleK4Uninstall} leading={<Icons.Delete width={14} height={14} />}>
              {zh ? '卸载' : 'Uninstall'}
            </NeoxButton>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* 导出 — 所有 skill 都可以 */}
          <NeoxButton variant="ghost" onClick={handleExport} leading={<Icons.Upload />}>
            {zh ? '导出' : 'Export'}
          </NeoxButton>
          {/* K4: 信任 / 取消信任 / 更新 */}
          {k4Meta && k4Meta.source?.url && (
            <NeoxButton variant="ghost" onClick={handleK4Update} leading={<Icons.Refresh />}>
              {zh ? '检查更新' : 'Update'}
            </NeoxButton>
          )}
          {k4Meta && isLimited && (
            <NeoxButton variant="secondary" onClick={handleK4Trust}>
              {zh ? '信任' : 'Trust'}
            </NeoxButton>
          )}
          {k4Meta && isTrusted && (
            <NeoxButton variant="secondary" onClick={handleK4Untrust}>
              {zh ? '取消信任' : 'Untrust'}
            </NeoxButton>
          )}
        </div>
      </div>
    </div>
  );
};

export default SkillDetailView;
