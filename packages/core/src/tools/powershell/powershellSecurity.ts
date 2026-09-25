/**
 * PowerShell Security — 命令安全分析
 *
 * 多层安全模型:
 * 1. 危险 cmdlet 检测
 * 2. Git 内部路径保护
 * 3. 破坏性命令警告
 * 4. 下载执行链检测
 * 5. 动态命令名检测
 */

// ============================================================================
// 常见别名 → 规范 cmdlet 映射
// ============================================================================

const COMMON_ALIASES: Record<string, string> = Object.create(null);
Object.assign(COMMON_ALIASES, {
  // 文件系统
  ls: 'Get-ChildItem', dir: 'Get-ChildItem', gci: 'Get-ChildItem',
  cd: 'Set-Location', sl: 'Set-Location', chdir: 'Set-Location',
  cat: 'Get-Content', gc: 'Get-Content', type: 'Get-Content',
  cp: 'Copy-Item', cpi: 'Copy-Item', copy: 'Copy-Item',
  mv: 'Move-Item', mi: 'Move-Item', move: 'Move-Item',
  rm: 'Remove-Item', ri: 'Remove-Item', del: 'Remove-Item',
  rd: 'Remove-Item', rmdir: 'Remove-Item', erase: 'Remove-Item',
  ni: 'New-Item', md: 'New-Item', mkdir: 'New-Item',
  ren: 'Rename-Item', rni: 'Rename-Item',
  pwd: 'Get-Location', gl: 'Get-Location',
  // 搜索
  sls: 'Select-String',
  // 进程
  ps: 'Get-Process', gps: 'Get-Process',
  spps: 'Stop-Process', kill: 'Stop-Process',
  // 服务
  gsv: 'Get-Service', sasv: 'Start-Service', spsv: 'Stop-Service',
  // 输出
  echo: 'Write-Output', write: 'Write-Output',
  oh: 'Out-Host', ogv: 'Out-GridView',
  // 格式化
  fl: 'Format-List', ft: 'Format-Table', fw: 'Format-Wide',
  // Web
  iwr: 'Invoke-WebRequest', curl: 'Invoke-WebRequest', wget: 'Invoke-WebRequest',
  irm: 'Invoke-RestMethod',
  // 执行
  iex: 'Invoke-Expression',
  icm: 'Invoke-Command',
  saps: 'Start-Process', start: 'Start-Process',
  // 变量/别名
  sal: 'Set-Alias', nal: 'New-Alias',
  sv: 'Set-Variable', nv: 'New-Variable', gv: 'Get-Variable',
  // 对象操作
  '?': 'Where-Object', where: 'Where-Object',
  '%': 'ForEach-Object', foreach: 'ForEach-Object',
  sort: 'Sort-Object', measure: 'Measure-Object',
  select: 'Select-Object', group: 'Group-Object',
  // 历史
  h: 'Get-History', ghy: 'Get-History', history: 'Get-History',
  // 其他
  cls: 'Clear-Host', clear: 'Clear-Host',
  sc: 'Set-Content', ac: 'Add-Content',
  tee: 'Tee-Object',
  clc: 'Clear-Content',
});

/**
 * 将别名或 cmdlet 解析为规范名称 (小写)
 */
export function resolveToCanonical(name: string): string {
  const lower = name.toLowerCase().replace(/\.exe$/, '');
  // 先查别名表
  const alias = COMMON_ALIASES[lower];
  if (alias) return alias.toLowerCase();
  // 去掉模块前缀 (Microsoft.PowerShell.Utility\Invoke-Expression → Invoke-Expression)
  if (lower.includes('\\') && !lower.includes('/') && !lower.includes(':')) {
    const afterSlash = lower.split('\\').pop() ?? lower;
    return afterSlash;
  }
  return lower;
}

// ============================================================================
// 危险 Cmdlet 集合
// ============================================================================

/** 需要用户确认的危险 cmdlet */
const DANGEROUS_CMDLETS = new Set([
  // 代码执行
  'invoke-expression',
  'invoke-command',
  'start-job',
  'import-module',
  'start-process',
  // 网络
  'invoke-webrequest',
  'invoke-restmethod',
  'start-bitstransfer',
  // 别名劫持
  'set-alias', 'new-alias',
  'set-variable', 'new-variable',
  // WMI/CIM
  'invoke-wmimethod', 'invoke-cimmethod',
  // 系统
  'stop-computer', 'restart-computer',
  'clear-recyclebin',
  'format-volume', 'clear-disk',
]);

/** 永远不应自动允许的 cmdlet */
const NEVER_AUTO_ALLOW = new Set([
  'invoke-expression', 'iex',
  'invoke-command', 'icm',
  'start-process', 'saps',
]);

// ============================================================================
// 只读 Cmdlet 白名单
// ============================================================================

const READ_ONLY_CMDLETS = new Set([
  'get-childitem', 'get-content', 'get-item', 'get-itemproperty',
  'get-location', 'get-process', 'get-service', 'get-date',
  'get-host', 'get-member', 'get-command', 'get-help',
  'get-alias', 'get-variable', 'get-history', 'get-culture',
  'get-module', 'get-psdrive', 'get-psprovider',
  'get-eventlog', 'get-winevent', 'get-counter',
  'get-computerinfo', 'get-timezone', 'get-hotfix',
  'get-netadapter', 'get-netipaddress', 'get-netroute',
  'get-disk', 'get-volume', 'get-partition',
  'test-path', 'test-connection', 'test-netconnection',
  'select-string', 'select-object', 'select-xml',
  'where-object', 'foreach-object', 'sort-object',
  'group-object', 'measure-object', 'compare-object',
  'format-list', 'format-table', 'format-wide', 'format-hex', 'format-custom',
  'out-string', 'out-null', 'out-host',
  'write-output', 'write-host', 'write-verbose', 'write-debug', 'write-warning',
  'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv',
  'convertto-xml', 'convertto-html',
  'split-path', 'join-path', 'resolve-path', 'convert-path',
]);

// ============================================================================
// Git 内部路径保护
// ============================================================================

/** NTFS 8.3 短名称 */
const GIT_SHORT_NAMES = ['git~1', 'git~2', 'git~3', 'git~4'];

/** 写入类 cmdlet (需要路径验证) */
const WRITE_CMDLETS = new Set([
  'new-item', 'set-content', 'add-content', 'out-file',
  'copy-item', 'move-item', 'rename-item',
  'expand-archive', 'invoke-webrequest', 'invoke-restmethod',
  'tee-object', 'export-csv', 'export-clixml',
]);

/**
 * 检查参数是否指向 .git 内部路径
 */
export function isGitInternalPath(arg: string): boolean {
  const normalized = arg
    .replace(/['"]/g, '')
    .replace(/`(.)/g, '$1')  // PowerShell 反引号转义
    .replace(/^FileSystem::/i, '')
    .toLowerCase()
    .replace(/\\/g, '/');

  // 标准 .git/ 路径
  if (normalized.includes('/.git/') || normalized.endsWith('/.git')) return true;
  if (normalized.startsWith('.git/') || normalized === '.git') return true;

  // 裸仓库路径
  const gitInternals = ['head', 'objects/', 'refs/', 'hooks/', 'config', 'description', 'info/'];
  if (gitInternals.some(p => normalized.endsWith('/' + p) || normalized.startsWith(p))) return true;

  // NTFS 8.3 短名称攻击
  const segments = normalized.split('/');
  if (segments.some(s => GIT_SHORT_NAMES.includes(s))) return true;

  return false;
}

// ============================================================================
// 安全分析
// ============================================================================

export interface SecurityCheckResult {
  behavior: 'allow' | 'ask' | 'deny';
  reason?: string;
}

/**
 * 分析 PowerShell 命令的安全性
 */
export function analyzePowerShellSecurity(command: string): SecurityCheckResult {
  const trimmed = command.trim();

  // 1. 提取命令段（简化解析 — 按 ; 和管道分段）
  const segments = splitPowerShellSegments(trimmed);

  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    if (tokens.length === 0) continue;

    const cmdName = tokens[0];
    const canonical = resolveToCanonical(cmdName);

    // 2. Invoke-Expression 检测 (高危)
    if (canonical === 'invoke-expression') {
      return { behavior: 'ask', reason: 'Invoke-Expression 可执行任意代码' };
    }

    // 3. 编码命令检测 (pwsh -EncodedCommand)
    if ((canonical === 'pwsh' || canonical === 'powershell') &&
        tokens.some(t => /^-e(ncodedcommand)?$/i.test(t.replace(/^[-–—―/]/, '-')))) {
      return { behavior: 'ask', reason: '编码命令 (-EncodedCommand) 不可审计' };
    }

    // 4. PowerShell 嵌套调用
    if (canonical === 'pwsh' || canonical === 'powershell') {
      return { behavior: 'ask', reason: '嵌套 PowerShell 进程' };
    }

    // 5. 下载执行链检测 (IWR | IEX)
    if (isDownloadExecuteChain(segments)) {
      return { behavior: 'ask', reason: '下载并执行模式 (download cradle)' };
    }

    // 6. 下载工具检测
    if (['start-bitstransfer', 'certutil', 'bitsadmin'].includes(canonical)) {
      return { behavior: 'ask', reason: `下载工具: ${cmdName}` };
    }

    // 7. 危险 cmdlet
    if (DANGEROUS_CMDLETS.has(canonical)) {
      return { behavior: 'ask', reason: `危险命令: ${cmdName}` };
    }

    // 8. Git 内部路径保护
    if (WRITE_CMDLETS.has(canonical)) {
      for (let i = 1; i < tokens.length; i++) {
        if (isGitInternalPath(tokens[i])) {
          return { behavior: 'deny', reason: `写入 Git 内部路径: ${tokens[i]}` };
        }
      }
    }
  }

  return { behavior: 'allow' };
}

/**
 * 检查命令是否为只读 (沙箱模式用)
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitPowerShellSegments(command.trim());

  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    if (tokens.length === 0) continue;

    const canonical = resolveToCanonical(tokens[0]);
    if (!READ_ONLY_CMDLETS.has(canonical)) return false;
  }

  return segments.length > 0;
}

/**
 * 获取破坏性命令警告
 */
export function getDestructiveCommandWarning(command: string): string | null {
  const patterns: [RegExp, string][] = [
    // Remove-Item -Recurse -Force
    [/\b(remove-item|rm|del|rd|rmdir|ri)\b.*(-recurse|-force)/i, 'Remove-Item with -Recurse/-Force: 递归删除文件'],
    // Clear-Content 广泛匹配
    [/\b(clear-content|clc)\b.*[\\/\*]/i, 'Clear-Content on broad path: 清空文件内容'],
    // 磁盘操作
    [/\b(format-volume|clear-disk)\b/i, '磁盘格式化/清除'],
    // Git 危险操作
    [/\bgit\s+(reset\s+--hard|push\s+--force|push\s+-f|clean\s+-f|stash\s+drop)\b/i, 'Git 破坏性操作'],
    // 数据库
    [/\b(DROP\s+(TABLE|DATABASE|SCHEMA))\b/i, '数据库 DROP 操作'],
    // 系统
    [/\b(stop-computer|restart-computer)\b/i, '系统关机/重启'],
    [/\bclear-recyclebin\b/i, '清空回收站'],
  ];

  for (const [pattern, warning] of patterns) {
    if (pattern.test(command)) return warning;
  }

  return null;
}

/**
 * 命令是否不应自动允许
 */
export function shouldNeverAutoAllow(cmdName: string): boolean {
  return NEVER_AUTO_ALLOW.has(resolveToCanonical(cmdName));
}

// ============================================================================
// 内部辅助
// ============================================================================

/**
 * 简化的 PowerShell 命令分段 (按 ; | && || 拆分)
 */
function splitPowerShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inHereStringSingle = false;
  let inHereStringDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    // Here-string 检测
    if (!inSingle && !inDouble && !inHereStringSingle && !inHereStringDouble) {
      if (ch === '@' && next === "'" && command[i + 2] === '\n') { inHereStringSingle = true; current += ch; continue; }
      if (ch === '@' && next === '"' && command[i + 2] === '\n') { inHereStringDouble = true; current += ch; continue; }
    }
    if (inHereStringSingle && ch === '\n' && command.slice(i + 1, i + 3) === "'@") {
      current += ch + "'@"; i += 2; inHereStringSingle = false; continue;
    }
    if (inHereStringDouble && ch === '\n' && command.slice(i + 1, i + 3) === '"@') {
      current += ch + '"@'; i += 2; inHereStringDouble = false; continue;
    }
    if (inHereStringSingle || inHereStringDouble) { current += ch; continue; }

    // 引号
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    // 反引号转义
    if (ch === '`') { current += ch + (next || ''); i++; continue; }

    // 分隔符
    if (ch === ';') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '|') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      // 跳过 ||
      if (next === '|') i++;
      continue;
    }
    if (ch === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * 检测下载执行链 (IWR | IEX 模式)
 */
function isDownloadExecuteChain(segments: string[]): boolean {
  let hasDownload = false;
  let hasExec = false;

  for (const seg of segments) {
    const canonical = resolveToCanonical(seg.trim().split(/\s+/)[0]);
    if (['invoke-webrequest', 'invoke-restmethod'].includes(canonical)) hasDownload = true;
    if (canonical === 'invoke-expression') hasExec = true;
  }

  return hasDownload && hasExec;
}
