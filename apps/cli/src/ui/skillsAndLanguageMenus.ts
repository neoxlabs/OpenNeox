import chalk from 'chalk';
import { skillRegistry } from '@neoxlabs/core/skills/index.js';
import { skillInstallManager } from '@neoxlabs/core/skills/installManager.js';
import {
  t,
  getLanguage,
  saveLanguageToConfig,
  formatMessage,
  type UserLanguage,
} from '../i18n/index.js';

/** 当前语言下二选一 (FIX 4: skills 管理动作没有 i18n key, 用内联双语, 不新增 interface key) */
function bi(zh: string, en: string): string {
  return getLanguage() === 'zh' ? zh : en;
}

type MenuChoice = { label: string; value: string; description: string; isCurrent?: boolean };

interface PromptDeps {
  promptSelect: (
    question: string,
    choices: MenuChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string | undefined>;
  promptText: (label: string, options?: any) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
}

interface OnboardingDeps extends Omit<PromptDeps, 'promptText'> {
  hasSeenOnboarding: boolean;
  hasUiController: boolean;
  markOnboardingSeen: () => void;
}

interface LanguageMenuDeps extends Omit<PromptDeps, 'promptText'> {
  hasUiController: boolean;
}

interface SkillsDeps extends PromptDeps {
  hasUiController: boolean;
  workDir: string;
  executeSkillById: (skillId: string) => Promise<void>;
}

export async function runOnboardingIfNeeded(deps: OnboardingDeps): Promise<void> {
  if (deps.hasSeenOnboarding || !deps.hasUiController) {
    return;
  }

  const selectedLang = await deps.promptSelect(
    '选择界面语言 · Choose your language',
    [
      { label: '中文', value: 'zh', description: '之后可以用 /language 改' },
      { label: 'English', value: 'en', description: 'Change later with /language' },
    ],
    getLanguage(),
  );

  if (selectedLang) {
    saveLanguageToConfig(selectedLang as UserLanguage);
  }

  deps.markOnboardingSeen();

  const newTr = t();
  deps.logInfo(newTr.onboarding.setupComplete, newTr.onboarding.setupCompleteDesc);
}

export async function showLanguageMenuFlow(deps: LanguageMenuDeps): Promise<void> {
  if (!deps.hasUiController) {
    console.log(chalk.yellow('Language settings is only available in interactive mode'));
    return;
  }

  const tr = t();
  const currentLang = getLanguage();

  const selectedLang = await deps.promptSelect(
    tr.languageMenu.title,
    [
      /* 当前那项用 isCurrent (菜单统一画 ● + 高亮), 不再在描述里写 "✓ 当前语言" */
      { label: tr.languageMenu.chinese, value: 'zh', description: tr.languageMenu.chineseDesc, isCurrent: currentLang === 'zh' },
      { label: tr.languageMenu.english, value: 'en', description: tr.languageMenu.englishDesc, isCurrent: currentLang === 'en' },
    ],
    currentLang,
  );

  if (!selectedLang || selectedLang === currentLang) {
    return;
  }

  saveLanguageToConfig(selectedLang as UserLanguage);
  deps.logInfo(formatMessage(t().languageMenu.changed, { lang: selectedLang === 'zh' ? '中文' : 'English' }));
}

export async function showSkillsScreenFlow(deps: SkillsDeps): Promise<void> {
  if (!deps.hasUiController) {
    console.log(chalk.yellow('Skills list is only available in interactive mode'));
    return;
  }

  while (true) {
    const tr = t();
    const skills = skillRegistry.list();
    const action = await deps.promptSelect(
      tr.skillsMenu.title,
      [
        { label: tr.skillsMenu.viewAll, value: 'list', description: formatMessage(tr.skillsMenu.viewAllDesc, { count: skills.length }) },
        { label: bi('管理已安装', 'Manage installed'), value: 'manage', description: bi('信任 / 取消信任 / 更新 / 卸载', 'trust / untrust / update / uninstall') },
        { label: tr.skillsMenu.import, value: 'import', description: tr.skillsMenu.importDesc },
        { label: tr.skillsMenu.create, value: 'create', description: tr.skillsMenu.createDesc },
        { label: tr.skillsMenu.refresh, value: 'refresh', description: tr.skillsMenu.refreshDesc },
      ],
      undefined,
      tr.skillsMenu.hint,
    );

    if (!action) {
      break;
    }

    if (action === 'list') {
      await showSkillsListFlow(deps);
    } else if (action === 'manage') {
      await showManageSkillsFlow(deps);
    } else if (action === 'import') {
      await showImportSkillMenuFlow(deps);
    } else if (action === 'create') {
      await showCreateSkillMenuFlow(deps);
    } else if (action === 'refresh') {
      await skillRegistry.refresh(deps.workDir);
      deps.logInfo(formatMessage(tr.skillsMenu.refreshSuccess, { count: skillRegistry.size }));
    }
  }
}

/**
 * FIX 4: REPL skills 管理 — trust / untrust / update / uninstall.
 *   复用 skillInstallManager (跟 `neox skill <...>` CLI + desktop Settings 同一 backend).
 *   只作用于 ~/.neox/skills/ + workspace 安装的 skill (不含 builtin).
 */
async function showManageSkillsFlow(deps: SkillsDeps): Promise<void> {
  while (true) {
    const installed = skillInstallManager.listInstalled({ workDir: deps.workDir });
    if (installed.length === 0) {
      deps.logInfo(bi(
        '没有已安装的 skill (用 import 或 `neox skill install <url>` 安装)',
        'No installed skills (use import or `neox skill install <url>`)',
      ));
      return;
    }

    const choices: MenuChoice[] = installed.map((m) => {
      const trust = m.trustLevel === 'trusted' ? 'trusted' : 'limited';
      const ver = m.installedVersion || 'unknown';
      return {
        label: `${m.skillId}`,
        value: m.skillId,
        description: `${trust} · v${ver}`,
      };
    });
    choices.push({ label: bi('← 返回', '← Back'), value: '__back__', description: '' });

    const selected = await deps.promptSelect(
      bi('管理已安装的 skill', 'Manage installed skills'),
      choices,
      undefined,
      bi('↑↓ 选择, Enter 确认', 'Use ↑↓ then Enter'),
    );

    if (!selected || selected === '__back__') {
      return;
    }

    const meta = installed.find((m) => m.skillId === selected);
    if (!meta) {
      continue;
    }

    const isTrusted = meta.trustLevel === 'trusted';
    const action = await deps.promptSelect(
      `${selected} (${isTrusted ? 'trusted' : 'limited'})`,
      [
        isTrusted
          ? { label: bi('取消信任 (untrust)', 'Untrust'), value: 'untrust', description: bi('降回 limited, 只能调声明的 allowedTools', 'Restrict to declared allowedTools only') }
          : { label: bi('信任 (trust)', 'Trust'), value: 'trust', description: bi('允许调任意工具 (含 execute_shell)', 'Allow calling any tool (incl. execute_shell)') },
        { label: bi('更新 (update)', 'Update'), value: 'update', description: bi('从源 URL 重新拉取最新版', 'Re-fetch latest from source URL') },
        { label: bi('卸载 (uninstall)', 'Uninstall'), value: 'uninstall', description: bi('删除整个 skill 目录', 'Remove the entire skill directory') },
        { label: bi('← 返回', '← Back'), value: 'back', description: '' },
      ],
      undefined,
      bi('↑↓ 选择, Enter 确认', 'Use ↑↓ then Enter'),
    );

    if (!action || action === 'back') {
      continue;
    }

    const opts = { workDir: deps.workDir };
    if (action === 'trust') {
      const r = await skillInstallManager.trust(selected, opts);
      deps.logInfo(r.success
        ? bi(`✓ '${selected}' 已信任 (可调任意工具)`, `✓ '${selected}' is now trusted`)
        : bi(`✗ 信任失败: ${r.error}`, `✗ Trust failed: ${r.error}`));
    } else if (action === 'untrust') {
      const r = await skillInstallManager.untrust(selected, opts);
      deps.logInfo(r.success
        ? bi(`✓ '${selected}' 已取消信任 (limited)`, `✓ '${selected}' is now limited`)
        : bi(`✗ 取消信任失败: ${r.error}`, `✗ Untrust failed: ${r.error}`));
    } else if (action === 'update') {
      deps.logInfo(bi(`检查 ${selected}...`, `Checking ${selected}...`));
      const r = await skillInstallManager.update(selected, opts);
      if (!r.success) {
        deps.logInfo(bi(`✗ 更新失败: ${r.error}`, `✗ Update failed: ${r.error}`));
      } else if (r.status === 'up_to_date') {
        deps.logInfo(bi(`✓ 已是最新 (v${r.previousVersion ?? 'unknown'})`, `✓ Already up-to-date (v${r.previousVersion ?? 'unknown'})`));
      } else {
        deps.logInfo(bi(
          `✓ 已更新 ${r.previousVersion ?? 'unknown'} → ${r.newVersion ?? 'unknown'}`,
          `✓ Updated ${r.previousVersion ?? 'unknown'} → ${r.newVersion ?? 'unknown'}`,
        ));
      }
    } else if (action === 'uninstall') {
      const confirm = await deps.promptSelect(
        bi(`确认卸载 '${selected}'?`, `Uninstall '${selected}'?`),
        [
          { label: bi('取消', 'Cancel'), value: 'no', description: '' },
          { label: bi('卸载', 'Uninstall'), value: 'yes', description: '' },
        ],
        'no',
        bi('↑↓ 选择, Enter 确认', 'Use ↑↓ then Enter'),
      );
      if (confirm === 'yes') {
        const r = await skillInstallManager.uninstall(selected, opts);
        deps.logInfo(r.success
          ? bi(`✓ 已卸载 '${selected}'`, `✓ Removed '${selected}'`)
          : bi(`✗ 卸载失败: ${r.error}`, `✗ Uninstall failed: ${r.error}`));
      }
    }
  }
}

async function showSkillsListFlow(deps: SkillsDeps): Promise<void> {
  const tr = t();
  const skills = skillRegistry.list();
  if (skills.length === 0) {
    deps.logInfo(tr.skillsMenu.noSkills);
    return;
  }

  const choices: MenuChoice[] = [];
  const appendGroup = (label: string, group: typeof skills) => {
    if (group.length === 0) {
      return;
    }
    choices.push({ label, value: '', description: '' });
    for (const s of group) {
      const aliasStr = s.metadata.neox?.aliases?.length ? ` (${s.metadata.neox.aliases.join(', ')})` : '';
      choices.push({
        label: `/${s.id}${aliasStr}`,
        value: s.id,
        description: s.metadata.description,
      });
    }
  };

  appendGroup(tr.skillsMenu.builtIn, skills.filter((s) => s.source === 'builtin'));
  appendGroup(tr.skillsMenu.user, skills.filter((s) => s.source === 'user'));
  appendGroup(tr.skillsMenu.workspace, skills.filter((s) => s.source === 'workspace'));

  const selected = await deps.promptSelect(
    tr.skillsMenu.title,
    choices,
    undefined,
    tr.skillsMenu.selectToExecute,
  );

  if (selected && selected !== '') {
    await deps.executeSkillById(selected);
  }
}

async function showImportSkillMenuFlow(deps: SkillsDeps): Promise<void> {
  const tr = t();
  const method = await deps.promptSelect(
    tr.skillsMenu.importMethod,
    [
      { label: tr.skillsMenu.fromUrl, value: 'url', description: tr.skillsMenu.fromUrlDesc },
      { label: tr.skillsMenu.fromPath, value: 'path', description: tr.skillsMenu.fromPathDesc },
    ],
    undefined,
    tr.skillsMenu.importMethod,
  );
  if (!method) {
    return;
  }

  const target = await deps.promptSelect(
    tr.skillsMenu.saveLocation,
    [
      { label: tr.skillsMenu.userGlobal, value: 'user', description: '~/.neox/skills/' },
      { label: tr.skillsMenu.workspaceLocal, value: 'workspace', description: '.neox/skills/' },
    ],
    undefined,
    tr.skillsMenu.saveLocation,
  );
  if (!target) {
    return;
  }

  const source = await deps.promptText(
    method === 'url' ? tr.skillsMenu.enterUrl : tr.skillsMenu.enterPath,
    { hint: method === 'url' ? 'https://...' : './path/to/skill 或 ./SKILL.md' },
  );
  if (!source) {
    return;
  }

  deps.logInfo(tr.skillsMenu.importing);
  const result = method === 'url'
    ? await skillRegistry.importFromUrl(source, target as 'user' | 'workspace', deps.workDir)
    : await skillRegistry.importFromPath(source, target as 'user' | 'workspace', deps.workDir);

  if (result.success) {
    deps.logInfo(formatMessage(tr.skillsMenu.importSuccess, { id: result.skillId || '' }));
  } else {
    deps.logInfo(formatMessage(tr.skillsMenu.importFailed, { error: result.error || '' }));
  }
}

async function showCreateSkillMenuFlow(deps: SkillsDeps): Promise<void> {
  const tr = t();
  const id = await deps.promptText(tr.skillsMenu.enterId, { hint: 'e.g., my-tool, code-review' });
  if (!id) {
    return;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    deps.logInfo(tr.skillsMenu.idFormatError);
    return;
  }
  if (skillRegistry.has(id)) {
    deps.logInfo(formatMessage(tr.skillsMenu.skillExists, { id }));
    return;
  }

  const name = await deps.promptText(tr.skillsMenu.enterName, { hint: 'e.g., My Custom Tool' });
  if (!name) {
    return;
  }
  const description = await deps.promptText(
    tr.skillsMenu.enterDescription,
    { hint: 'e.g., Perform code review and provide suggestions' },
  );
  if (!description) {
    return;
  }

  const category = await deps.promptSelect(
    tr.skillsMenu.selectCategory,
    [
      { label: 'git', value: 'git', description: tr.skillsMenu.categoryGit },
      { label: 'code', value: 'code', description: tr.skillsMenu.categoryCode },
      { label: 'docs', value: 'docs', description: tr.skillsMenu.categoryDocs },
      { label: 'test', value: 'test', description: tr.skillsMenu.categoryTest },
      { label: 'custom', value: 'custom', description: tr.skillsMenu.categoryCustom },
    ],
    'custom',
    tr.skillsMenu.selectCategory,
  );

  const target = await deps.promptSelect(
    tr.skillsMenu.saveLocation,
    [
      { label: tr.skillsMenu.userGlobal, value: 'user', description: '~/.neox/skills/' },
      { label: tr.skillsMenu.workspaceLocal, value: 'workspace', description: '.neox/skills/' },
    ],
    undefined,
    tr.skillsMenu.saveLocation,
  );
  if (!target) {
    return;
  }

  const result = await skillRegistry.createSkill({
    id,
    name,
    description,
    category: category || 'custom',
    target: target as 'user' | 'workspace',
    workDir: deps.workDir,
  });
  if (result.success) {
    deps.logInfo(formatMessage(tr.skillsMenu.createSuccess, { path: result.path || '' }));
  } else {
    deps.logInfo(formatMessage(tr.skillsMenu.createFailed, { error: result.error || '' }));
  }
}
