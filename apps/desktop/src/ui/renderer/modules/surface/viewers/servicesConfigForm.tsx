
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { interactionDoc } from '../../../utils/ownerDoc';
import { CustomSelect } from '../../../components/CustomSelect';
import { ServiceKindIcon } from '../../../components/ServiceKindIcon';
import { useI18n } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';
import { copyToClipboard } from '../../../utils/copyToClipboard';
import { buildCommandLine, type ConfigSpec } from './buildCommandLineClient';
import { AiSparkIcon, ServiceAiPanel, autoServiceId, requestAiConfig, type AiState, type ServiceConfigProposal } from './servicesAiFix';
import type { ServiceConfig } from './ServicesSurfaceViewer';
import './servicesConfigForm.css';

type ConfigKind =
  | 'shell' | 'maven' | 'npm' | 'gradle' | 'docker-compose' | 'python'
  | 'go' | 'cargo' | 'make' | 'dotnet' | 'bun' | 'deno' | 'flutter';

const KIND_OPTIONS: Array<{ value: ConfigKind; label: string; hint: string }> = [
  { value: 'shell',          label: 'Shell',       hint: '通用命令' },
  { value: 'maven',          label: 'Maven',       hint: 'mvn / spring-boot' },
  { value: 'gradle',         label: 'Gradle',      hint: './gradlew / bootRun' },
  { value: 'npm',            label: 'npm',         hint: 'npm / yarn / pnpm' },
  { value: 'bun',            label: 'Bun',         hint: 'bun run' },
  { value: 'deno',           label: 'Deno',        hint: 'deno task / run' },
  { value: 'python',         label: 'Python',      hint: 'python -m / 脚本' },
  { value: 'go',             label: 'Go',          hint: 'go run' },
  { value: 'cargo',          label: 'Rust',        hint: 'cargo run' },
  { value: 'dotnet',         label: '.NET',        hint: 'dotnet run' },
  { value: 'flutter',        label: 'Flutter',     hint: 'flutter run' },
  { value: 'make',           label: 'Make',        hint: 'make <target>' },
  { value: 'docker-compose', label: 'Docker',      hint: 'docker compose up' },
];

interface ProjectInfo {
  spring?: { available: string[]; active: string[] };
  java?: { declared: number | null; installed: Array<{ major: number; home: string; javafx: boolean }>; autoHome?: string; defaultVersion?: string };
  node?: { version: string; required?: string; depsInstalled: boolean };
}

function splitTokens(s: string): string[] { return s.trim().split(/\s+/).filter(Boolean); }
function splitCsv(s: string): string[] { return s.split(',').map(x => x.trim()).filter(Boolean); }
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/** 只有命令的 Maven 配置 (老版本 AI 回填 / 手写) 认回 Maven 结构, 好让 profile / JDK 能点选。
 *  解析后再拼一遍必须跟原命令一字不差, 对不上就还按 Shell —— 宁可不认, 不能改掉用户的命令。 */
function parseMavenCommand(command: string): Extract<ConfigSpec, { kind: 'maven' }> | null {
  const cmd = norm(command);
  const m = cmd.match(/^(?:mvn -q -pl (\S+) -am install -DskipTests && )?mvn (.+)$/);
  if (!m) return null;
  const spec: Extract<ConfigSpec, { kind: 'maven' }> = { kind: 'maven', goals: [], module: m[1], skipTests: false };
  const tokens = m[2].split(' ');
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk === '-DskipTests') spec.skipTests = true;
    else if (tk.startsWith('-Dspring-boot.run.profiles=')) spec.springProfiles = tk.slice('-Dspring-boot.run.profiles='.length).split(',').filter(Boolean);
    else if (tk === '-pl' && m[1] && tokens[i + 1] === m[1]) i++;
    else if (tk === '-P' && tokens[i + 1]) spec.profiles = tokens[++i].split(',');
    else if (!tk.startsWith('-')) spec.goals.push(tk);
    else return null;
  }
  /* mvn 的参数顺序不影响含义 (AI 常写成 goal 在前 -D 在后): 每一步按词集合比 */
  const steps = (c: string) => norm(c).split(' && ').map((x) => x.split(' ').sort().join(' '));
  return spec.goals.length && JSON.stringify(steps(buildCommandLine(spec))) === JSON.stringify(steps(cmd)) ? spec : null;
}

interface EnvEntry { k: string; v: string; id: string; }
const toEntries = (rec?: Record<string, string>): EnvEntry[] => Object.entries(rec ?? {}).map(([k, v], i) => ({ k, v, id: `env-${i}-${k}` }));
const toRecord = (entries: EnvEntry[]): Record<string, string> => Object.fromEntries(entries.filter(e => e.k.trim()).map(e => [e.k.trim(), e.v]));

const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; error?: string; wide?: boolean; children: React.ReactNode }> = ({ label, hint, error, wide, children }) => (
  <label className={`svc-cfg__field${wide ? ' is-wide' : ''}`}>
    <span className="svc-cfg__label">{label}</span>
    {children}
    {error ? <span className="svc-cfg__err">{error}</span> : hint ? <span className="svc-cfg__hint">{hint}</span> : null}
  </label>
);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; desc?: React.ReactNode }> = ({ checked, onChange, label, desc }) => (
  <button type="button" role="switch" aria-checked={checked} className={`svc-cfg__toggle${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
    <span className="svc-cfg__toggle-text"><span>{label}</span>{desc && <em>{desc}</em>}</span>
    <span className="svc-cfg__switch" aria-hidden="true"><span /></span>
  </button>
);

const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="svc-cfg__section">
    <header className="svc-cfg__section-head"><h4>{title}</h4>{aside}</header>
    <div className="svc-cfg__section-body">{children}</div>
  </section>
);

const EnvEditor: React.FC<{ entries: EnvEntry[]; onChange: (next: EnvEntry[]) => void; isZh: boolean }> = ({ entries, onChange, isZh }) => {
  const update = (id: string, patch: Partial<EnvEntry>) => onChange(entries.map(e => e.id === id ? { ...e, ...patch } : e));
  return (
    <div className="svc-cfg__env">
      {entries.map(e => (
        <div key={e.id} className="svc-cfg__env-row">
          <input value={e.k} placeholder="KEY" spellCheck={false} onChange={(ev) => update(e.id, { k: ev.target.value })} />
          <span aria-hidden="true">=</span>
          <input value={e.v} placeholder="value" spellCheck={false} onChange={(ev) => update(e.id, { v: ev.target.value })} />
          <button type="button" className="svc-cfg__icon-btn" onClick={() => onChange(entries.filter(x => x.id !== e.id))} aria-label={isZh ? '删除' : 'Delete'}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      ))}
      <button type="button" className="svc-cfg__add" onClick={() => onChange([...entries, { k: '', v: '', id: `env-${Date.now().toString(36)}` }])}>
        + {isZh ? '添加变量' : 'Add variable'}
      </button>
    </div>
  );
};

/** Spring profile 点选: 模块里有哪些就列哪些, application.yml 默认激活的打个点; 多选, 顺序按点选 */
const ProfileChips: React.FC<{ available: string[]; active: string[]; value: string[]; onChange: (v: string[]) => void; isZh: boolean }> = ({ available, active, value, onChange, isZh }) => {
  const all = [...new Set([...available, ...value])];
  return (
    <div className="svc-cfg__chips" role="group" aria-label="Spring profile">
      {all.map(p => {
        const on = value.includes(p);
        return (
          <button key={p} type="button" aria-pressed={on} className={`svc-cfg__chip${on ? ' is-on' : ''}`}
            onClick={() => onChange(on ? value.filter(x => x !== p) : [...value, p])}
            title={active.includes(p) ? (isZh ? 'application.yml 默认激活' : 'Active by default in application.yml') : undefined}>
            {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
            {p}{active.includes(p) && <i aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
};

export const ServiceConfigForm: React.FC<{
  workspacePath: string;
  /** 编辑模式: id 锁定, 保存用同 id upsert */
  initial?: ServiceConfig;
  onClose: () => void;
  /** run = 点的是「保存并运行」 */
  onSaved: (id: string, run: boolean) => void;
}> = ({ workspacePath, initial, onClose, onSaved }) => {
  const { isZh } = useI18n();
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const initialSpec = initial?.spec?.kind === 'shell' || (!initial?.spec && initial?.command)
    ? (parseMavenCommand(initial?.command ?? '') ?? initial?.spec)
    : initial?.spec;
  const isEdit = !!initial;
  const [kind, setKind] = useState<ConfigKind>((initialSpec?.kind as ConfigKind) ?? 'shell');
  const [id, setId] = useState(initial?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '.');
  const [port, setPort] = useState(initial?.port ? String(initial.port) : '');
  const sp = <K extends ConfigSpec['kind']>(k: K) => (initialSpec?.kind === k ? initialSpec as Extract<ConfigSpec, { kind: K }> : undefined);
  const [command, setCommand] = useState(sp('shell')?.command ?? initial?.command ?? '');
  /* maven */
  const mvn = sp('maven');
  const [mvnGoals, setMvnGoals] = useState(mvn?.goals?.filter(g => g !== 'spring-boot:run').join(' ') ?? '');
  const [mvnSpringBoot, setMvnSpringBoot] = useState(mvn ? mvn.goals.includes('spring-boot:run') : true);
  const [mvnProfiles, setMvnProfiles] = useState(mvn?.profiles?.join(',') ?? '');
  const [mvnModule, setMvnModule] = useState(mvn?.module ?? '');
  const [mvnSkipTests, setMvnSkipTests] = useState(mvn?.skipTests ?? true);
  const [springProfiles, setSpringProfiles] = useState<string[]>(mvn?.springProfiles ?? []);
  /* npm */
  const npm = sp('npm');
  const [npmScript, setNpmScript] = useState(npm?.script ?? '');
  const [npmPm, setNpmPm] = useState<'npm' | 'yarn' | 'pnpm'>(npm?.packageManager ?? 'npm');
  const [npmArgs, setNpmArgs] = useState(npm?.args?.join(' ') ?? '');
  const [npmInspectPort, setNpmInspectPort] = useState(npm?.inspectPort ? String(npm.inspectPort) : '');
  const [npmNodeOptions, setNpmNodeOptions] = useState(npm?.nodeOptions ?? '');
  /* gradle */
  const [gradleTasks, setGradleTasks] = useState(sp('gradle')?.tasks.join(' ') ?? '');
  const [gradleWrapper, setGradleWrapper] = useState(sp('gradle')?.useWrapper !== false);
  /* docker */
  const dc = sp('docker-compose');
  const [composeFile, setComposeFile] = useState(dc?.composeFile ?? 'docker-compose.yml');
  const [composeServices, setComposeServices] = useState(dc?.services?.join(',') ?? '');
  const [composeDetach, setComposeDetach] = useState(dc?.detach ?? false);
  /* python */
  const py = sp('python');
  const [pyMode, setPyMode] = useState<'module' | 'script'>(py?.script ? 'script' : 'module');
  const [pyTarget, setPyTarget] = useState(py?.module ?? py?.script ?? '');
  const [pyArgs, setPyArgs] = useState(py?.args?.join(' ') ?? '');
  /* go / cargo / make / dotnet */
  const [goTarget, setGoTarget] = useState(sp('go')?.target ?? '.');
  const [goTags, setGoTags] = useState(sp('go')?.tags?.join(',') ?? '');
  const [cargoBin, setCargoBin] = useState(sp('cargo')?.bin ?? '');
  const [cargoRelease, setCargoRelease] = useState(sp('cargo')?.release ?? false);
  const [cargoFeatures, setCargoFeatures] = useState(sp('cargo')?.features?.join(',') ?? '');
  const [makeTargets, setMakeTargets] = useState(sp('make')?.targets.join(' ') ?? '');
  const [makeFile, setMakeFile] = useState(sp('make')?.makefile ?? '');
  const [dotnetProject, setDotnetProject] = useState(sp('dotnet')?.project ?? '');
  const [dotnetConfig, setDotnetConfig] = useState<'' | 'Debug' | 'Release'>(sp('dotnet')?.configuration ?? '');
  const [dotnetCommand, setDotnetCommand] = useState<'run' | 'watch' | 'build' | 'test'>(sp('dotnet')?.command ?? 'run');
  /* bun / deno / flutter */
  const bun = sp('bun');
  const [bunMode, setBunMode] = useState<'script' | 'entry'>(bun?.entry ? 'entry' : 'script');
  const [bunTarget, setBunTarget] = useState(bun?.script ?? bun?.entry ?? '');
  const [bunArgs, setBunArgs] = useState(bun?.args?.join(' ') ?? '');
  const [bunInspectPort, setBunInspectPort] = useState(bun?.inspectPort ? String(bun.inspectPort) : '');
  const deno = sp('deno');
  const [denoMode, setDenoMode] = useState<'task' | 'run'>(deno?.entry ? 'run' : 'task');
  const [denoTarget, setDenoTarget] = useState(deno?.task ?? deno?.entry ?? '');
  const [denoAllowAll, setDenoAllowAll] = useState(deno?.allowAll ?? true);
  const fl = sp('flutter');
  const [flutterDevice, setFlutterDevice] = useState(fl?.device ?? '');
  const [flutterFlavor, setFlutterFlavor] = useState(fl?.flavor ?? '');
  const [flutterMode, setFlutterMode] = useState<'debug' | 'profile' | 'release'>(fl?.mode ?? 'debug');
  /* 环境变量: 配置级 env 一处编辑; npm / bun 旧 spec.env 并进来, 保存时统一落在配置级 (整个进程都生效) */
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() => toEntries({ ...(npm?.env ?? bun?.env ?? {}), ...(initial?.env ?? {}) }));
  const [moreOpen, setMoreOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(initial?.autoOpenSurface ?? false);
  const [autoRestart, setAutoRestart] = useState(initial?.autoRestart ?? false);
  const [group, setGroup] = useState(initial?.group ?? '');
  const [startOrder, setStartOrder] = useState(typeof initial?.startOrder === 'number' ? String(initial.startOrder) : '');
  const [busy, setBusy] = useState<false | 'save' | 'run'>(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [ai, setAi] = useState<AiState>({ phase: 'idle' });
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [copied, setCopied] = useState(false);

  /* 运行环境: 目录 / 模块变了重新读 (防抖, 敲路径时不每个字读一次盘) */
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void (window as any).neox?.serviceProjectInfo?.(workspacePath, { cwd: cwd || '.', module: kind === 'maven' ? mvnModule || undefined : undefined, command: initial?.command })
        .then((r: any) => { if (alive && r?.success) setInfo(r.info ?? null); })
        .catch(() => { /* 读不到就不显示这一栏 */ });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [workspacePath, cwd, kind, mvnModule, initial?.command]);

  /* Esc: AI 面板开着先关面板, 否则关弹窗 (挂 window: 焦点不在表单里时也要生效) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      e.stopPropagation();
      if (ai.phase !== 'idle') setAi({ phase: 'idle' }); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ai.phase, busy, onClose]);

  const portNum = port.trim() ? Number(port) : NaN;
  const { spec, errors: rawErrors } = useMemo(() => {
    const errs: Record<string, string> = {};
    const badPort = (v: string) => v.trim() !== '' && (Number.isNaN(Number(v)) || Number(v) < 1 || Number(v) > 65535);
    if (id.trim() && !/^[A-Za-z0-9._-]+$/.test(id.trim())) errs.id = t('只允许字母、数字和 . - _', 'Letters, digits and . - _ only');
    if (badPort(port)) errs.port = t('端口是 1-65535 的整数', 'Port must be 1-65535');
    if (kind === 'npm' && badPort(npmInspectPort)) errs.npmInspectPort = t('端口是 1-65535 的整数', 'Port must be 1-65535');
    if (kind === 'bun' && badPort(bunInspectPort)) errs.bunInspectPort = t('端口是 1-65535 的整数', 'Port must be 1-65535');
    let s: ConfigSpec | null = null;
    switch (kind) {
      case 'shell':
        if (!command.trim()) errs.command = t('填启动命令, 比如 npm run dev', 'Enter a command, e.g. npm run dev');
        else s = { kind: 'shell', command: command.trim() };
        break;
      case 'maven': {
        const goals = splitTokens(mvnGoals);
        const finalGoals = mvnSpringBoot && !goals.includes('spring-boot:run') ? [...goals, 'spring-boot:run'] : goals;
        if (finalGoals.length === 0) errs.mvnGoals = t('至少一个 goal, 或打开 Spring Boot', 'Add a goal or turn on Spring Boot');
        /* 表单没有的字段 (properties / jvmArgs…) 沿用原值 */
        else s = { ...(mvn ?? {}), kind: 'maven', goals: finalGoals, profiles: splitCsv(mvnProfiles), springProfiles, skipTests: mvnSkipTests, module: mvnModule.trim() || undefined };
        break;
      }
      case 'npm':
        if (!npmScript.trim()) errs.npmScript = t('填 package.json 里的脚本名', 'Enter a package.json script');
        else s = {
          kind: 'npm', script: npmScript.trim(), packageManager: npmPm,
          args: splitTokens(npmArgs).length ? splitTokens(npmArgs) : undefined,
          inspectPort: Number(npmInspectPort) > 0 ? Number(npmInspectPort) : undefined,
          nodeOptions: npmNodeOptions.trim() || undefined,
        };
        break;
      case 'gradle':
        if (!splitTokens(gradleTasks).length) errs.gradleTasks = t('至少一个 task', 'Add a task');
        else s = { kind: 'gradle', tasks: splitTokens(gradleTasks), useWrapper: gradleWrapper };
        break;
      case 'docker-compose':
        s = { kind: 'docker-compose', composeFile: composeFile.trim() || undefined, services: splitCsv(composeServices), detach: composeDetach };
        break;
      case 'python':
        if (!pyTarget.trim()) errs.pyTarget = pyMode === 'module' ? t('填模块名', 'Enter a module') : t('填脚本路径', 'Enter a script path');
        else s = { kind: 'python', ...(pyMode === 'module' ? { module: pyTarget.trim() } : { script: pyTarget.trim() }), args: splitTokens(pyArgs) };
        break;
      case 'go': s = { kind: 'go', target: goTarget.trim() || '.', tags: splitCsv(goTags) }; break;
      case 'cargo': s = { kind: 'cargo', bin: cargoBin.trim() || undefined, release: cargoRelease, features: splitCsv(cargoFeatures) }; break;
      case 'make':
        if (!splitTokens(makeTargets).length) errs.makeTargets = t('至少一个 target', 'Add a target');
        else s = { kind: 'make', targets: splitTokens(makeTargets), makefile: makeFile.trim() || undefined };
        break;
      case 'dotnet': s = { kind: 'dotnet', command: dotnetCommand, project: dotnetProject.trim() || undefined, configuration: dotnetConfig || undefined }; break;
      case 'bun':
        if (!bunTarget.trim()) errs.bunTarget = bunMode === 'script' ? t('填脚本名', 'Enter a script') : t('填入口文件', 'Enter an entry file');
        else s = {
          kind: 'bun', ...(bunMode === 'script' ? { script: bunTarget.trim() } : { entry: bunTarget.trim() }),
          args: splitTokens(bunArgs).length ? splitTokens(bunArgs) : undefined,
          inspectPort: Number(bunInspectPort) > 0 ? Number(bunInspectPort) : undefined,
        };
        break;
      case 'deno':
        if (!denoTarget.trim()) errs.denoTarget = denoMode === 'task' ? t('填 task 名', 'Enter a task') : t('填入口文件', 'Enter an entry file');
        else s = denoMode === 'task' ? { kind: 'deno', task: denoTarget.trim() } : { kind: 'deno', entry: denoTarget.trim(), allowAll: denoAllowAll };
        break;
      case 'flutter': s = { kind: 'flutter', command: 'run', mode: flutterMode, device: flutterDevice.trim() || undefined, flavor: flutterFlavor.trim() || undefined }; break;
    }
    return { spec: Object.keys(errs).length === 0 ? s : null, errors: errs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, port, kind, command, mvnGoals, mvnSpringBoot, mvnProfiles, mvnModule, mvnSkipTests, springProfiles,
    npmScript, npmPm, npmArgs, npmInspectPort, npmNodeOptions, gradleTasks, gradleWrapper, composeFile, composeServices, composeDetach,
    pyMode, pyTarget, pyArgs, goTarget, goTags, cargoBin, cargoRelease, cargoFeatures, makeTargets, makeFile,
    dotnetProject, dotnetConfig, dotnetCommand, bunMode, bunTarget, bunArgs, bunInspectPort, denoMode, denoTarget, denoAllowAll,
    flutterDevice, flutterFlavor, flutterMode, isZh]);

  /* 空着的必填项不一打开就标红, 点保存才提示; 填错的立刻标 */
  const filled: Record<string, string> = { id, command, mvnGoals, npmScript, gradleTasks, pyTarget, makeTargets, bunTarget, denoTarget, port, npmInspectPort, bunInspectPort };
  const errors = showAllErrors ? rawErrors : Object.fromEntries(Object.entries(rawErrors).filter(([k]) => (filled[k] ?? 'x').trim() !== ''));
  const preview = useMemo(() => { try { return spec ? buildCommandLine(spec) : ''; } catch { return ''; } }, [spec]);
  const env = toRecord(envEntries);
  const javaHome = env.JAVA_HOME ?? '';
  const isJava = kind === 'maven' || kind === 'gradle' || !!info?.java;

  const askAi = async () => {
    setAi({ phase: 'loading', startedAt: Date.now() });
    setAi(await requestAiConfig(workspacePath, initial?.id, {
      name, command: preview || command, cwd, env, springProfiles: kind === 'maven' ? springProfiles : undefined,
    }, isZh));
  };

  /* 能用 Maven 字段表达的建议 (只换 profile) 留在 Maven 里; 表达不了才换成 Shell 命令 */
  const applyProposal = (p: ServiceConfigProposal) => {
    let keptStructured = false;
    if (kind === 'maven' && spec?.kind === 'maven') {
      const next: ConfigSpec = { ...spec, springProfiles: p.springProfiles ?? spec.springProfiles };
      if (norm(buildCommandLine(next)) === norm(p.command)) {
        if (p.springProfiles) setSpringProfiles(p.springProfiles);
        keptStructured = true;
      }
    }
    if (!keptStructured && norm(p.command) !== norm(preview)) { setKind('shell'); setCommand(p.command); }
    setCwd(p.cwd || '.');
    if (p.env) setEnvEntries(toEntries({ ...env, ...p.env }));
    setAi({ phase: 'idle' });
  };

  const save = async (run: boolean) => {
    if (!spec) {
      setShowAllErrors(true);
      setErr(Object.values(rawErrors)[0] ?? t('还有必填项没填', 'Some required fields are empty'));
      return;
    }
    setBusy(run ? 'run' : 'save'); setErr(null);
    const finalId = id.trim() || autoServiceId(name, kind);
    let r: { success?: boolean; error?: string } | undefined;
    try {
      r = await (window as any).neox?.serviceUpsertConfig?.(workspacePath, {
        id: finalId,
        name: name.trim() || finalId,
        spec,
        cwd: cwd.trim() || '.',
        port: port.trim() ? portNum : undefined,
        env: Object.keys(env).length ? env : undefined,
        autoOpenSurface: autoOpen,
        autoRestart,
        group: group.trim() || undefined,
        startOrder: startOrder.trim() && !Number.isNaN(Number(startOrder)) ? Number(startOrder) : undefined,
        /* upsert 是整体替换 —— 表单没暴露的既有字段要带上 */
        pinned: initial?.pinned,
        healthcheck: initial?.healthcheck,
        createdBy: initial?.createdBy ?? 'user',
      });
    } catch (e) {
      /* IPC 自己挂了 (拒绝而不是返回错误对象) —— 不能把按钮一直转下去 */
      setBusy(false);
      setErr(String((e as Error)?.message ?? e) || t('保存失败', 'Save failed'));
      return;
    }
    setBusy(false);
    if (r?.success) onSaved(finalId, run);
    else setErr(r?.error || t('保存失败', 'Save failed'));
  };

  const jdkOptions = [
    { value: '', label: info?.java?.autoHome
      ? t(`自动 · JDK ${info.java.declared} (按工程声明)`, `Auto · JDK ${info.java.declared} (from the project)`)
      : t(`自动 · 系统默认${info?.java?.defaultVersion ? ` ${info.java.defaultVersion}` : ''}`, `Auto · system default${info?.java?.defaultVersion ? ` ${info.java.defaultVersion}` : ''}`) },
    ...(info?.java?.installed ?? []).map(j => ({ value: j.home, label: `JDK ${j.major}${j.javafx ? ' · JavaFX' : ''} — ${j.home}` })),
    ...(javaHome && !(info?.java?.installed ?? []).some(j => j.home === javaHome) ? [{ value: javaHome, label: javaHome }] : []),
  ];
  const setJavaHome = (home: string) => {
    const rest = envEntries.filter(e => e.k.trim() !== 'JAVA_HOME');
    setEnvEntries(home ? [...rest, { k: 'JAVA_HOME', v: home, id: `env-jdk-${Date.now()}` }] : rest);
  };
  const kindLabel = KIND_OPTIONS.find(k => k.value === kind)?.label ?? kind;

  return createPortal(
    <div className="svc-cfg-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form className="svc-cfg" onSubmit={(e) => { e.preventDefault(); void save(false); }}>
        <header className="svc-cfg__head">
          <ServiceKindIcon kind={kind} command={preview || command} size={44} tile />
          <div className="svc-cfg__head-main">
            <input className="svc-cfg__name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t('给服务起个名字', 'Name this service')} autoFocus={!isEdit} aria-label={t('名称', 'Name')} />
            <div className="svc-cfg__meta">
              <span>{isEdit ? t('编辑服务', 'Edit service') : t('新建服务', 'New service')}</span>
              <span>{kindLabel}</span>
              {isEdit
                ? <span title={t('ID 是主键, 不能改', 'The id is the key and cannot change')}>ID {initial?.id}</span>
                : <input className="svc-cfg__id" value={id} onChange={(e) => setId(e.target.value)} placeholder={t('ID 可不填, 按名称生成', 'ID optional')} aria-label="ID" />}
            </div>
            {errors.id && <span className="svc-cfg__err">{errors.id}</span>}
          </div>
          <img className="svc-cfg__head-illus" src={NeoxIllus.agentTerminal} alt="" draggable={false} />
          <button type="button" className="svc-cfg__icon-btn svc-cfg__close" onClick={onClose} aria-label={t('关闭', 'Close')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>
        {err && <div className="svc-cfg__banner">{err}</div>}

        <div className="svc-cfg__body">
          <nav className="svc-cfg__rail" aria-label={t('服务类型', 'Service type')}>
            {KIND_OPTIONS.map(opt => (
              <button key={opt.value} type="button" title={opt.hint} aria-pressed={kind === opt.value}
                className={`svc-cfg__rail-item${kind === opt.value ? ' is-active' : ''}`} onClick={() => setKind(opt.value)}>
                <ServiceKindIcon kind={opt.value} size={22} tile />
                <span>{opt.label}</span>
              </button>
            ))}
          </nav>

          <div className="svc-cfg__main">
            <div className="svc-cfg__scroll" aria-hidden={ai.phase !== 'idle'}>
              <Section title={t('启动方式', 'How it starts')}>
                {kind === 'shell' && (
                  <Field wide label={t('启动命令', 'Command')} error={errors.command}>
                    <textarea className="is-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run dev" rows={3} spellCheck={false} />
                  </Field>
                )}
                {kind === 'maven' && (<>
                  <Field label={t('模块', 'Module')} hint={t('多模块工程里要跑的那个, 会先装它依赖的兄弟模块', 'In a multi-module build; its sibling modules are installed first')}>
                    <input className="is-mono" value={mvnModule} onChange={(e) => setMvnModule(e.target.value)} placeholder={t('单模块留空', 'Empty for single-module')} />
                  </Field>
                  <Field label="goals" error={errors.mvnGoals} hint={mvnSpringBoot ? t('Spring Boot 已自动加 spring-boot:run', 'spring-boot:run is added for Spring Boot') : undefined}>
                    <input className="is-mono" value={mvnGoals} onChange={(e) => setMvnGoals(e.target.value)} placeholder={mvnSpringBoot ? t('可留空', 'Optional') : 'clean install'} />
                  </Field>
                  <div className="svc-cfg__toggles is-wide">
                    <Toggle checked={mvnSpringBoot} onChange={setMvnSpringBoot} label="Spring Boot" desc="spring-boot:run" />
                    <Toggle checked={mvnSkipTests} onChange={setMvnSkipTests} label={t('跳过测试', 'Skip tests')} desc="-DskipTests" />
                  </div>
                </>)}
                {kind === 'npm' && (<>
                  <Field label={t('脚本', 'Script')} error={errors.npmScript} hint={t('package.json scripts 里的名字', 'A package.json script')}>
                    <input className="is-mono" value={npmScript} onChange={(e) => setNpmScript(e.target.value)} placeholder="dev" />
                  </Field>
                  <Field label={t('包管理器', 'Package manager')}>
                    <CustomSelect className="svc-cfg__select" value={npmPm} onChange={(v) => setNpmPm(v as any)} options={[{ value: 'npm', label: 'npm' }, { value: 'yarn', label: 'yarn' }, { value: 'pnpm', label: 'pnpm' }]} />
                  </Field>
                  <Field label={t('参数', 'Arguments')} hint={t('自动加 -- 传给脚本', 'Passed after --')}>
                    <input className="is-mono" value={npmArgs} onChange={(e) => setNpmArgs(e.target.value)} placeholder="--port 3000" />
                  </Field>
                  <Field label="NODE_OPTIONS">
                    <input className="is-mono" value={npmNodeOptions} onChange={(e) => setNpmNodeOptions(e.target.value)} placeholder="--max-old-space-size=4096" />
                  </Field>
                  <Field label={t('调试端口', 'Debug port')} error={errors.npmInspectPort} hint={t('填了就带 --inspect-brk 启动', 'Starts with --inspect-brk')}>
                    <input value={npmInspectPort} onChange={(e) => setNpmInspectPort(e.target.value.replace(/\D/g, ''))} placeholder="9229" inputMode="numeric" />
                  </Field>
                </>)}
                {kind === 'gradle' && (<>
                  <Field wide label="tasks" error={errors.gradleTasks}>
                    <input className="is-mono" value={gradleTasks} onChange={(e) => setGradleTasks(e.target.value)} placeholder="bootRun" />
                  </Field>
                  <div className="svc-cfg__toggles is-wide"><Toggle checked={gradleWrapper} onChange={setGradleWrapper} label={t('用 ./gradlew', 'Use ./gradlew')} desc={t('关掉用系统 gradle', 'Off = system gradle')} /></div>
                </>)}
                {kind === 'docker-compose' && (<>
                  <Field label={t('compose 文件', 'Compose file')}><input className="is-mono" value={composeFile} onChange={(e) => setComposeFile(e.target.value)} placeholder="docker-compose.yml" /></Field>
                  <Field label="services" hint={t('逗号分隔, 留空启动全部', 'Comma-separated; empty = all')}><input className="is-mono" value={composeServices} onChange={(e) => setComposeServices(e.target.value)} placeholder="db,redis" /></Field>
                  <div className="svc-cfg__toggles is-wide"><Toggle checked={composeDetach} onChange={setComposeDetach} label={t('后台运行', 'Detached')} desc="up -d" /></div>
                </>)}
                {kind === 'python' && (<>
                  <Field label={t('方式', 'Mode')}>
                    <CustomSelect className="svc-cfg__select" value={pyMode} onChange={(v) => setPyMode(v as any)} options={[{ value: 'module', label: '-m module' }, { value: 'script', label: 'script.py' }]} />
                  </Field>
                  <Field label={pyMode === 'module' ? t('模块', 'Module') : t('脚本', 'Script')} error={errors.pyTarget}>
                    <input className="is-mono" value={pyTarget} onChange={(e) => setPyTarget(e.target.value)} placeholder={pyMode === 'module' ? 'uvicorn' : 'app.py'} />
                  </Field>
                  <Field wide label={t('参数', 'Arguments')}><input className="is-mono" value={pyArgs} onChange={(e) => setPyArgs(e.target.value)} placeholder="main:app --reload" /></Field>
                </>)}
                {kind === 'go' && (<>
                  <Field label="target" hint={t('包路径或 main.go', 'Package or main.go')}><input className="is-mono" value={goTarget} onChange={(e) => setGoTarget(e.target.value)} placeholder="./cmd/server" /></Field>
                  <Field label="build tags"><input className="is-mono" value={goTags} onChange={(e) => setGoTags(e.target.value)} placeholder="integration" /></Field>
                </>)}
                {kind === 'cargo' && (<>
                  <Field label="--bin"><input className="is-mono" value={cargoBin} onChange={(e) => setCargoBin(e.target.value)} placeholder="server" /></Field>
                  <Field label="features"><input className="is-mono" value={cargoFeatures} onChange={(e) => setCargoFeatures(e.target.value)} placeholder="tokio,tls" /></Field>
                  <div className="svc-cfg__toggles is-wide"><Toggle checked={cargoRelease} onChange={setCargoRelease} label="--release" desc={t('优化构建', 'Optimised build')} /></div>
                </>)}
                {kind === 'make' && (<>
                  <Field label="targets" error={errors.makeTargets}><input className="is-mono" value={makeTargets} onChange={(e) => setMakeTargets(e.target.value)} placeholder="dev" /></Field>
                  <Field label="Makefile"><input className="is-mono" value={makeFile} onChange={(e) => setMakeFile(e.target.value)} placeholder="Makefile" /></Field>
                </>)}
                {kind === 'dotnet' && (<>
                  <Field label={t('命令', 'Command')}>
                    <CustomSelect className="svc-cfg__select" value={dotnetCommand} onChange={(v) => setDotnetCommand(v as any)} options={['run', 'watch', 'build', 'test'].map(v => ({ value: v, label: v }))} />
                  </Field>
                  <Field label="configuration">
                    <CustomSelect className="svc-cfg__select" value={dotnetConfig} onChange={(v) => setDotnetConfig(v as any)} options={[{ value: '', label: t('默认', 'Default') }, { value: 'Debug', label: 'Debug' }, { value: 'Release', label: 'Release' }]} />
                  </Field>
                  <Field wide label="--project"><input className="is-mono" value={dotnetProject} onChange={(e) => setDotnetProject(e.target.value)} placeholder="src/Api/Api.csproj" /></Field>
                </>)}
                {kind === 'bun' && (<>
                  <Field label={t('方式', 'Mode')}>
                    <CustomSelect className="svc-cfg__select" value={bunMode} onChange={(v) => setBunMode(v as any)} options={[{ value: 'script', label: 'package.json script' }, { value: 'entry', label: t('直接跑文件', 'Run a file') }]} />
                  </Field>
                  <Field label={bunMode === 'script' ? t('脚本', 'Script') : t('入口文件', 'Entry')} error={errors.bunTarget}>
                    <input className="is-mono" value={bunTarget} onChange={(e) => setBunTarget(e.target.value)} placeholder={bunMode === 'script' ? 'dev' : 'index.ts'} />
                  </Field>
                  <Field label={t('参数', 'Arguments')}><input className="is-mono" value={bunArgs} onChange={(e) => setBunArgs(e.target.value)} placeholder="--port 3000" /></Field>
                  <Field label={t('调试端口', 'Debug port')} error={errors.bunInspectPort}>
                    <input value={bunInspectPort} onChange={(e) => setBunInspectPort(e.target.value.replace(/\D/g, ''))} placeholder="9229" inputMode="numeric" />
                  </Field>
                </>)}
                {kind === 'deno' && (<>
                  <Field label={t('方式', 'Mode')}>
                    <CustomSelect className="svc-cfg__select" value={denoMode} onChange={(v) => setDenoMode(v as any)} options={[{ value: 'task', label: 'deno task' }, { value: 'run', label: 'deno run' }]} />
                  </Field>
                  <Field label={denoMode === 'task' ? 'task' : t('入口文件', 'Entry')} error={errors.denoTarget}>
                    <input className="is-mono" value={denoTarget} onChange={(e) => setDenoTarget(e.target.value)} placeholder={denoMode === 'task' ? 'dev' : 'main.ts'} />
                  </Field>
                  {denoMode === 'run' && <div className="svc-cfg__toggles is-wide"><Toggle checked={denoAllowAll} onChange={setDenoAllowAll} label="--allow-all" desc={t('开发时建议开', 'Recommended while developing')} /></div>}
                </>)}
                {kind === 'flutter' && (<>
                  <Field label="device (-d)"><input className="is-mono" value={flutterDevice} onChange={(e) => setFlutterDevice(e.target.value)} placeholder="chrome" /></Field>
                  <Field label="flavor"><input className="is-mono" value={flutterFlavor} onChange={(e) => setFlutterFlavor(e.target.value)} placeholder="dev" /></Field>
                  <Field label="mode">
                    <CustomSelect className="svc-cfg__select" value={flutterMode} onChange={(v) => setFlutterMode(v as any)} options={['debug', 'profile', 'release'].map(v => ({ value: v, label: v }))} />
                  </Field>
                </>)}
              </Section>

              <Section title={t('运行环境', 'Environment')}>
                {kind === 'maven' && (
                  <Field wide label={t('Spring 运行环境', 'Spring profile')}
                    hint={info?.spring?.active.length
                      ? t(`application.yml 默认激活 ${info.spring.active.join(', ')} (带点的); 这里选的会整体替换它`, `application.yml activates ${info.spring.active.join(', ')} (dotted); your pick replaces it`)
                      : t('读 application-<名字>.yml', 'Loads application-<name>.yml')}>
                    {info?.spring
                      ? <ProfileChips available={info.spring.available} active={info.spring.active} value={springProfiles} onChange={setSpringProfiles} isZh={isZh} />
                      : <input className="is-mono" value={springProfiles.join(',')} onChange={(e) => setSpringProfiles(splitCsv(e.target.value))} placeholder="dev" />}
                  </Field>
                )}
                {isJava && (
                  <Field wide label="JDK" hint={info?.java?.declared ? t(`工程声明 Java ${info.java.declared}`, `Project declares Java ${info.java.declared}`) : undefined}>
                    <CustomSelect className="svc-cfg__select" value={javaHome} onChange={setJavaHome} options={jdkOptions} />
                  </Field>
                )}
                {info?.node && (kind === 'npm' || kind === 'bun' || kind === 'shell') && (
                  <div className="svc-cfg__facts is-wide">
                    <span className={`svc-cfg__fact${info.node.depsInstalled ? '' : ' is-warn'}`}>
                      {info.node.depsInstalled ? t('依赖已安装', 'Dependencies installed') : t('还没装依赖 · AI 配置会补上安装步骤', 'Dependencies missing · AI config adds an install step')}
                    </span>
                    <span className="svc-cfg__fact">Node {info.node.version || '?'}{info.node.required ? t(` · 工程要求 ${info.node.required}`, ` · requires ${info.node.required}`) : ''}</span>
                  </div>
                )}
                <Field wide label={t('环境变量', 'Environment variables')} hint={envEntries.length ? t('对整条命令生效, && 后面的步骤也一样', 'Applies to every step of the command') : undefined}>
                  <EnvEditor entries={envEntries} onChange={setEnvEntries} isZh={isZh} />
                </Field>
              </Section>

              <Section title={t('将执行', 'Will run')} aside={preview && (
                <button type="button" className="svc-cfg__text-btn" onClick={() => { void copyToClipboard(preview); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
                  {copied ? t('已复制', 'Copied') : t('复制', 'Copy')}
                </button>
              )}>
                <div className="svc-cfg__preview is-wide">
                  {preview && kind !== 'shell'
                    ? <code>{preview.split(' && ').map((step, i) => <span key={i}>{i > 0 && <b>&amp;&amp; </b>}{step}</span>)}</code>
                    : kind !== 'shell' && <span className="svc-cfg__hint">{t('填好上面的字段后这里显示最终命令', 'The final command shows here')}</span>}
                  <div className="svc-cfg__preview-cwd">{t('目录', 'in')} <code>{cwd || '.'}</code>{javaHome || info?.java?.autoHome ? <> · JAVA_HOME <code>{javaHome || info?.java?.autoHome}</code></> : null}</div>
                </div>
              </Section>

              <section className="svc-cfg__section">
                <button type="button" className={`svc-cfg__more${moreOpen ? ' is-open' : ''}`} onClick={() => setMoreOpen(v => !v)} aria-expanded={moreOpen}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18" /></svg>
                  {t('更多 · 目录、端口、分组、自动重启', 'More · directory, port, group, restart')}
                </button>
                {moreOpen && (
                  <div className="svc-cfg__section-body">
                    <Field label={t('工作目录', 'Directory')} hint={t('相对工程根', 'Relative to the workspace')}>
                      <input className="is-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="." />
                    </Field>
                    <Field label={t('端口', 'Port')} error={errors.port} hint={t('填了会显示 :端口 并探活', 'Shown as :port and probed')}>
                      <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder={kind === 'maven' || kind === 'gradle' ? '8080' : '3000'} inputMode="numeric" />
                    </Field>
                    {kind === 'maven' && (<>
                      <Field label={t('Maven profile (-P)', 'Maven profile (-P)')} hint={t('构建期 profile, 跟 Spring profile 不是一回事', 'Build-time; not the Spring profile')}>
                        <input className="is-mono" value={mvnProfiles} onChange={(e) => setMvnProfiles(e.target.value)} placeholder="local" />
                      </Field>
                    </>)}
                    <Field label={t('服务组', 'Group')} hint={t('同组可一键按顺序起停', 'Start / stop a group in order')}>
                      <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="backend" />
                    </Field>
                    <Field label={t('组内顺序', 'Order')} hint={t('小的先起', 'Lower starts first')}>
                      <input value={startOrder} onChange={(e) => setStartOrder(e.target.value.replace(/[^\d-]/g, ''))} placeholder="0" inputMode="numeric" />
                    </Field>
                    <div className="svc-cfg__toggles is-wide">
                      <Toggle checked={autoRestart} onChange={setAutoRestart} label={t('异常退出自动重启', 'Restart on crash')} desc={t('非 0 退出时', 'On a non-zero exit')} />
                      <Toggle checked={autoOpen} onChange={setAutoOpen} label={t('起来后打开页面', 'Open the page when up')} desc="localhost:port" />
                    </div>
                  </div>
                )}
              </section>
            </div>
            <ServiceAiPanel isZh={isZh} state={ai} onDiscard={() => setAi({ phase: 'idle' })} onApply={applyProposal} onRetry={() => { void askAi(); }} />
          </div>
        </div>

        <footer className="svc-cfg__foot">
          <button type="button" className="svc-cfg__ai-btn" onClick={() => { void askAi(); }} disabled={ai.phase === 'loading' || !!busy}
            title={t('AI 看工程结构和最近一次报错, 给出能跑起来的配置; 你确认后才填进表单', 'AI reads the project and the last error and proposes a working config; you confirm before it fills the form')}>
            <AiSparkIcon />{ai.phase === 'loading' ? t('AI 正在看…', 'AI is reading…') : t('AI 配置', 'AI config')}
          </button>
          <span className="svc-cfg__foot-gap" />
          <button type="button" className="svc-cfg__btn" onClick={onClose} disabled={!!busy}>{t('取消', 'Cancel')}</button>
          <button type="submit" className="svc-cfg__btn" disabled={!!busy || ai.phase !== 'idle'}>{busy === 'save' ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
          <button type="button" className="svc-cfg__btn is-primary" disabled={!!busy || ai.phase !== 'idle'} onClick={() => { void save(true); }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
            {busy === 'run' ? t('启动中…', 'Starting…') : t('保存并运行', 'Save & run')}
          </button>
        </footer>
      </form>
    </div>,
    interactionDoc().body,
  );
};
