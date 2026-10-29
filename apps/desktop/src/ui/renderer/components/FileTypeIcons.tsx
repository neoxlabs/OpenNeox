/**
 * FileTypeIcons - 像素级使用 IntelliJ IDEA New UI (expUI) 真图标
 *
 * 所有 svg 直接从 /Applications/IntelliJ IDEA.app 的 jar 里抽取,
 * 通过 scripts/build-jb-icons.cjs 转成 iconify collection,
 * 完全离线、无品牌差异。
 *
 * 命名: jb:{category}-{name}[-dark]
 *   - jb:nodes-folder, jb:nodes-folder-dark
 *   - jb:fileTypes-yaml, jb:fileTypes-yaml-dark
 *   - jb:vcs-...
 *
 * Apache 2.0 License (JetBrains)
 */

import React from 'react';
import { Icon, addCollection } from '@iconify/react';
import { jbIcons } from './jbIconRegistry.generated';
// fallback set: 用 vscode-icons 补 IDEA Community 没有的 (python/go/rust/sql 等)
import { fallbackIconCollections } from './iconRegistry.generated';

/* 离线注册所有 icon collection — 模块加载时一次性完成,
   显式调用而不是依赖 side-effect import,确保 vite/tsup 不会 tree-shake */
let __registered = false;
function ensureRegistered() {
  if (__registered) return;
  addCollection(jbIcons as any);
  for (const c of fallbackIconCollections) {
    addCollection(c as any);
  }
  __registered = true;
}
ensureRegistered();

/* ==================== 通用渲染 ==================== */

interface IIProps {
  name: string;
  size?: number;
}

/**
 * 主题感知 hook:监听 documentElement[data-theme] 变化,
 * Neox 默认 dark mode → 用 -dark 图标变体。
 */
const useIsDark = (): boolean => {
  const [dark, setDark] = React.useState(() => {
    if (typeof document === 'undefined') return true;
    return document.documentElement.getAttribute('data-theme') !== 'light';
  });
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const update = () => setDark(root.getAttribute('data-theme') !== 'light');
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    update();
    return () => obs.disconnect();
  }, []);
  return dark;
};

/** 检查 jb-icons 注册表里是否真有这个 icon (含 prefix 和不含 prefix 都试一下) */
const hasJbIcon = (fullName: string): boolean => {
  // fullName 例如 "jb:fileTypes-markdown-dark"
  if (!fullName.startsWith('jb:')) return true; // 非 jb 直接交给 iconify
  const stripped = fullName.slice(3); // "fileTypes-markdown-dark"
  const icons = (jbIcons as any).icons || {};
  return Boolean(icons[stripped]);
};

const II: React.FC<IIProps> = ({ name, size = 16 }) => {
  const dark = useIsDark();
  // jb:fileTypes-yaml → 在 dark 模式下试 jb:fileTypes-yaml-dark；
  // 若 dark 变体不存在 (例如 markdown 只有 markdown.svg)，回退到 light 版本
  let finalName = name;
  if (dark && name.startsWith('jb:') && !name.endsWith('-dark')) {
    const darkName = `${name}-dark`;
    finalName = hasJbIcon(darkName) ? darkName : name;
  }
  return (
    <Icon
      key={finalName}
      icon={finalName}
      width={size}
      height={size}
      className="ft-icon"
    />
  );
};

/* ==================== 文件类型 (用真 IDEA expUI) ==================== */

export const TypeScriptIcon = () => <II name="jb:fileTypes-typeScript" />;
export const TsxIcon = () => <II name="jb:fileTypes-tsx" />;
export const JavaScriptIcon = () => <II name="jb:fileTypes-javaScript" />;
export const JsxIcon = () => <II name="jb:fileTypes-jsx" />;
export const JsonIcon = () => <II name="jb:fileTypes-json" />;
export const YamlIcon = () => <II name="jb:fileTypes-yaml" />;
export const XmlIcon = () => <II name="jb:fileTypes-xml" />;
export const XhtmlIcon = () => <II name="jb:fileTypes-xhtml" />;
export const XsdIcon = () => <II name="jb:fileTypes-xsd" />;
export const CssIcon = () => <II name="jb:fileTypes-css" />;
export const ScssIcon = () => <II name="jb:fileTypes-css" />;
export const HtmlIcon = () => <II name="jb:fileTypes-html" />;
export const JspIcon = () => <II name="jb:fileTypes-jsp" />;
export const MarkdownIcon = () => <II name="jb:fileTypes-markdown" />;
export const JavaIcon = () => <II name="jb:fileTypes-java" />;
export const ClassIcon = () => <II name="jb:fileTypes-javaClass" />;
export const KotlinIcon = () => <II name="jb:fileTypes-kotlin" />;
export const PropertiesIcon = () => <II name="jb:fileTypes-properties" />;
export const ShellIcon = () => <II name="jb:fileTypes-shell" />;
export const ImageFileIcon = () => <II name="jb:fileTypes-image" />;
export const ArchiveIcon = () => <II name="jb:fileTypes-archive" />;
export const TextFileIcon = () => <II name="jb:fileTypes-text" />;
export const ConfigIcon = () => <II name="jb:fileTypes-config" />;
export const EditorConfigIcon = () => <II name="jb:fileTypes-editorConfig" />;
export const GitignoreIcon = () => <II name="jb:fileTypes-gitignore" />;
export const I18nIcon = () => <II name="jb:fileTypes-i18n" />;
export const FontIcon = () => <II name="jb:fileTypes-font" />;
export const CsvIcon = () => <II name="jb:fileTypes-csv" />;
export const PerlIcon = () => <II name="jb:fileTypes-perl" />;
export const RegexIcon = () => <II name="jb:fileTypes-regexp" />;
export const SvgFileIcon = () => <II name="jb:fileTypes-image" />;

/* Spring Boot — 真 IDEA Spring leaf */
export const SpringYamlIcon = () => <II name="jb:fileTypes-springBoot" />;
export const SpringYamlAltIcon = () => <II name="jb:fileTypes-springBoot" />;

/* Maven pom.xml — 真 IDEA mavenProject icon */
export const MavenPomIcon = () => <II name="jb:fileTypes-mavenProject" />;
export const MavenModuleIcon = () => <II name="jb:fileTypes-mavenModule" />;

/* Docker — IDEA Community 没有,用 vscode-icons fallback */
export const DockerIcon = () => <II name="vscode-icons:file-type-docker" />;

/* IDEA Community 没有的语言 — 退到 vscode-icons */
export const PythonIcon = () => <II name="vscode-icons:file-type-python" />;
export const GoIcon = () => <II name="vscode-icons:file-type-go" />;
export const RustIcon = () => <II name="vscode-icons:file-type-rust" />;
export const SqlIcon = () => <II name="vscode-icons:file-type-sql" />;
export const TomlIcon = () => <II name="vscode-icons:file-type-toml" />;
export const LogFileIcon = () => <II name="jb:fileTypes-text" />;
export const IniIcon = () => <II name="jb:fileTypes-properties" />;

/* lockfile / lock — 用 IDEA nodes-locked */
export const LockFileIcon = () => <II name="jb:nodes-locked" />;

/* ignored 类文件 (.gitignore / .dockerignore / .npmignore / .eslintignore...)
   IDEA 真用 nodes/ignored 的 ⊘ 圆环禁止符，所有 ignore 类共用 */
export const IgnoreFileIcon = () => <II name="jb:nodes-ignored" />;

/* IntelliJ IDEA 模块文件 (.iml) — IDEA 橙色项目模块图标 */
export const ImlFileIcon = () => <II name="jb:fileTypes-ideaModule" />;

/* 通用 fallback — IDEA 的 unknown / text */
export const GenericFileIcon = () => <II name="jb:fileTypes-text" />;

/* ==================== 文件夹 (用真 IDEA nodes) ==================== */

export const Folder = ({ size = 16 }: { size?: number } = {}) => <II name="jb:nodes-folder" size={size} />;
export const FolderOpen = ({ size = 16 }: { size?: number } = {}) => <II name="jb:nodes-folder" size={size} />;

/* sources root (java/src/main/java) — IDEA 蓝色 sourceRoot */
export const FolderSources = () => <II name="jb:nodes-sourceRoot" />;
export const FolderSourcesOpen = () => <II name="jb:nodes-sourceRoot" />;

/* test root */
export const FolderTest = () => <II name="jb:nodes-testRoot" />;
export const FolderTestOpen = () => <II name="jb:nodes-testRoot" />;

/* test sources */
export const FolderTestSources = () => <II name="jb:nodes-testSourceFolder" />;

/* resources root (Spring/Java 项目特别) */
export const FolderResources = () => <II name="jb:nodes-resourcesRoot" />;
export const FolderResourcesOpen = () => <II name="jb:nodes-resourcesRoot" />;

/* test resources root */
export const FolderTestResources = () => <II name="jb:nodes-testResourcesRoot" />;

/* generated source — 蓝边 + 笔标 */
export const FolderGeneratedSource = () => <II name="jb:nodes-generatedSource" />;

/* generated test root */
export const FolderGeneratedTestRoot = () => <II name="jb:nodes-generatedTestRoot" />;

/* mapper / mappings — IDEA 没有专门的,用普通 folder */
export const FolderMappings = () => <II name="jb:nodes-folder" />;
export const FolderMappingsOpen = () => <II name="jb:nodes-folder" />;

/* Maven module (Maven plugin 提供的真图标) */
export const FolderModule = () => <II name="jb:fileTypes-mavenModule" />;
export const FolderModuleOpen = () => <II name="jb:fileTypes-mavenModule" />;

/* excluded - target/dist/build/release/... — IDEA excludeRoot */
export const FolderExcluded = () => <II name="jb:nodes-excludeRoot" />;
export const FolderExcludedOpen = () => <II name="jb:nodes-excludeRoot" />;

/* dist / build — IDEA 没有专门图标,用 excludeRoot 棕色 */
export const FolderDist = () => <II name="jb:nodes-excludeRoot" />;
export const FolderDistOpen = () => <II name="jb:nodes-excludeRoot" />;

/* node_modules — IDEA 把它当 library */
export const FolderNodeModules = () => <II name="jb:nodes-libraryFolder" />;
export const FolderNodeModulesOpen = () => <II name="jb:nodes-libraryFolder" />;

/* docs — IDEA 没专门图标 */
export const FolderDocs = () => <II name="jb:nodes-folder" />;
export const FolderDocsOpen = () => <II name="jb:nodes-folder" />;

/* .git */
export const FolderGit = () => <II name="jb:nodes-folder" />;
export const FolderGitOpen = () => <II name="jb:nodes-folder" />;

/* package — Java package 图标 */
export const FolderPackage = () => <II name="jb:nodes-package" />;

export function pickFileIcon(name: string, size = 16): React.ReactNode {
  const base = (name || '').split(/[/\\]/).pop() || name || '';
  const lower = base.toLowerCase();
  if (lower === 'package.json' || lower === 'package-lock.json') return <JsonIcon />;
  if (lower === 'pnpm-lock.yaml' || lower === 'yarn.lock') return <LockFileIcon />;
  if (/^\.[a-z]+ignore$/i.test(lower)) return <IgnoreFileIcon />;
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'docker-compose.yml' || lower === 'docker-compose.yaml') {
    return <DockerIcon />;
  }
  const ext = (lower.split('.').pop() || '').toLowerCase();
  const icon = (() => {
    switch (ext) {
      case 'ts': case 'mts': case 'cts': return <TypeScriptIcon />;
      case 'tsx': return <TsxIcon />;
      case 'js': case 'mjs': case 'cjs': return <JavaScriptIcon />;
      case 'jsx': return <JsxIcon />;
      case 'json': case 'jsonc': return <JsonIcon />;
      case 'yaml': case 'yml': return <YamlIcon />;
      case 'md': case 'mdx': return <MarkdownIcon />;
      case 'css': case 'scss': case 'sass': case 'less': return <CssIcon />;
      case 'html': case 'htm': return <HtmlIcon />;
      case 'py': return <PythonIcon />;
      case 'go': return <GoIcon />;
      case 'java': return <JavaIcon />;
      case 'xml': return <XmlIcon />;
      case 'svg': return <SvgFileIcon />;
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico': return <ImageFileIcon />;
      case 'txt': case 'log': case 'text': return <TextFileIcon />;
      default: return <TextFileIcon />;
    }
  })();
  /* size 通过外层 CSS 控; 这里保留节点本身 */
  void size;
  return icon;
}

/** 标题是否像文件名 (带扩展名) —— 用来决定 tab 用类型 logo 还是 kind 线框图标 */
export function looksLikeFileName(title: string): boolean {
  const base = (title || '').split(/[/\\]/).pop() || '';
  return /\.[a-z0-9]{1,8}$/i.test(base);
}
