import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useAgentModeVariant } from '../../../hooks/useAgentModeVariant';
import Icons from '../../../components/Icons';
import { CustomSelect } from '../../../components/CustomSelect';
import {
  PageTitle,
  Section,
  SectionTitle,
  SettingsCard,
  SettingsRow,
  NeoxInput,
  NeoxButton,
} from '../../../components/settings-base';
import './ProfileTab.clay.css';


interface ProfileSection {
  name: string;
  entries: string[];
}

/** CustomSelect 里代表「自定义…」那一项的哨兵值 —— 不可能跟真实分区名撞 */
const CUSTOM_SECTION = '__neox_custom_section__';
const SUGGESTED_SECTIONS_ZH = ['基本', '岗位与职责', '公司与团队', '常用联系人', '文档与格式偏好', '重要日期', '其他'];
const SUGGESTED_SECTIONS_EN = ['Basics', 'Role & duties', 'Company & team', 'Key contacts', 'Document & format preferences', 'Key dates', 'Other'];

function parseProfile(content: string): ProfileSection[] {
  const sections: ProfileSection[] = [];
  let current: ProfileSection | null = null;
  const orphan: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('## ')) {
      current = { name: line.slice(3).trim(), entries: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith('- ')) {
      const entry = line.slice(2).trim();
      if (!entry) continue;
      if (current) current.entries.push(entry);
      else orphan.push(entry);
    }
    /* 其余行 (# 大标题 / 说明文字 / 空行) 不进结构 — 序列化时重建规范骨架 */
  }
  if (orphan.length > 0) {
    const other = sections.find(s => s.name === '其他');
    if (other) other.entries.unshift(...orphan);
    else sections.unshift({ name: '其他', entries: orphan });
  }
  return sections.filter(s => s.entries.length > 0);
}

function serializeProfile(sections: ProfileSection[]): string {
  const parts: string[] = ['# User profile · work', ''];
  for (const s of sections) {
    if (s.entries.length === 0) continue;
    parts.push(`## ${s.name}`);
    for (const e of s.entries) parts.push(`- ${e}`);
    parts.push('');
  }
  return parts.join('\n');
}

type ProfileApi = {
  profileGet?: (scope: string) => Promise<{ content?: string }>;
  profileSet?: (scope: string, content: string) => Promise<{ success?: boolean; error?: string }>;
};

const ProfileTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const suggestedSections = zh ? SUGGESTED_SECTIONS_ZH : SUGGESTED_SECTIONS_EN;
  const { isWork } = useAgentModeVariant();
  const scope = 'work';

  const [sections, setSections] = useState<ProfileSection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [newEntry, setNewEntry] = useState('');
  const [newSection, setNewSection] = useState('');
  /* 选了「自定义…」才展开自由输入 —— 平时是一个干净的下拉 */
  const [customSection, setCustomSection] = useState(false);
  /* 保存串行化: 快速连点删除时避免旧内容覆盖新内容 */
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    void (async () => {
      try {
        const api = window.neox as unknown as ProfileApi;
        const r = await api.profileGet?.(scope);
        setSections(parseProfile(r?.content || ''));
      } catch { /* 读不到 = 空档案 */ }
      setLoaded(true);
    })();
  }, [scope]);

  const persist = useCallback((next: ProfileSection[]) => {
    setSections(next);
    const api = window.neox as unknown as ProfileApi;
    saveChain.current = saveChain.current.then(() =>
      api.profileSet?.(scope, serializeProfile(next))?.catch(() => { /* 下次写会带上全量 */ }),
    );
  }, [scope]);

  const removeEntry = useCallback((sectionName: string, index: number) => {
    persist(
      sections
        .map(s => s.name === sectionName ? { ...s, entries: s.entries.filter((_, i) => i !== index) } : s)
        .filter(s => s.entries.length > 0),
    );
  }, [sections, persist]);

  const addEntry = useCallback(() => {
    const entry = newEntry.trim();
    if (!entry) return;
    const target = newSection.trim() || '其他';
    const existing = sections.find(s => s.name === target);
    persist(existing
      ? sections.map(s => s.name === target ? { ...s, entries: [...s.entries, entry] } : s)
      : [...sections, { name: target, entries: [entry] }]);
    setNewEntry('');
  }, [newEntry, newSection, sections, persist]);

  const total = useMemo(() => sections.reduce((n, s) => n + s.entries.length, 0), [sections]);

  return (
    <div className="settings-panel-content pf3">
      <PageTitle
        title={zh ? '个人信息' : 'About You'}
        subtitle={zh ? '让 Neox 知道你是谁 · 每次对话都会参考' : 'Tell Neox who you are · used in every chat'}
      />

      {/* UI 3.0 (set-profile3): 所有分区的条目合进同一张「已保存的个人事实」卡, 分区名作左侧小标签 */}
      <Section>
        <div className="pf3-card-head">
          <span className="pf3-card-head__title">{zh ? '已保存的个人事实' : 'Saved facts'}</span>
          <span className="pf3-card-head__count">{!loaded ? '' : total === 0 ? (zh ? '还没有记录' : 'Nothing yet') : (zh ? `已记 ${total} 条` : `${total} saved`)}</span>
        </div>
        <SettingsCard>
          {total === 0 && loaded && (
            <div className="pf3-empty">{zh ? '还没有记录' : 'Nothing yet'}</div>
          )}
          {sections.flatMap(section => section.entries.map((entry, i) => (
            <SettingsRow key={`${section.name}-${i}-${entry}`} className="pf3-row">
              <span className="pf3-chip">{section.name}</span>
              <span className="pf3-row__text">{entry}</span>
              <NeoxButton
                variant="ghost"
                size="sm"
                onClick={() => removeEntry(section.name, i)}
                title={zh ? '删除这条' : 'Remove'}
                aria-label={zh ? '删除这条' : 'Remove'}
              >
                <Icons.Trash />
              </NeoxButton>
            </SettingsRow>
          )))}
        </SettingsCard>
      </Section>

      <Section>
        <SectionTitle title={zh ? '添加一条' : 'Add a fact'} />
        <SettingsCard>
          <div className="pf-add pf3-add">
              <div className="pf-add__section">
                {customSection ? (
                  <NeoxInput
                    autoFocus
                    value={newSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    onBlur={() => { if (!newSection.trim()) setCustomSection(false); }}
                    placeholder={zh ? '自己起一个' : 'Name your own'}
                  />
                ) : (
                  <CustomSelect
                    value={newSection}
                    onChange={(v) => {
                      if (v === CUSTOM_SECTION) { setNewSection(''); setCustomSection(true); return; }
                      setNewSection(v);
                    }}
                    placeholder={zh ? '分类' : 'Section'}
                    options={[
                      ...suggestedSections.map(sec => ({ value: sec, label: sec })),
                      { value: CUSTOM_SECTION, label: zh ? '自定义…' : 'Custom…' },
                    ]}
                  />
                )}
              </div>
              <div className="pf-add__entry">
                <NeoxInput
                  value={newEntry}
                  onChange={(e) => setNewEntry(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addEntry(); }}
                  placeholder={zh ? '一句话一个事实，如「市场部经理」' : 'One fact, e.g. "marketing manager"'}
                />
              </div>
              <NeoxButton variant="primary" size="sm" onClick={addEntry} disabled={!newEntry.trim()}>
                {zh ? '添加' : 'Add'}
              </NeoxButton>
          </div>
        </SettingsCard>
        {isWork && (
          <p className="pf3-hint">{zh ? '也可以直接在对话里告诉它，它会自己记下。' : 'You can also just tell Neox in a chat and it will note it.'}</p>
        )}
      </Section>
    </div>
  );
};

export default ProfileTab;
