
export interface GuardDenial {
  code: 'app_forbidden_terminal' | 'app_forbidden_self' | 'app_forbidden_security' | 'app_forbidden_settings';
  /** 给模型的话: 说清楚为什么不行, 以及该改用什么 */
  message: string;
}

/** 名字/bundleId/进程名里带这些就当终端 (小写比较)。
 *  mac 名字与 Windows 名字并列 —— 这一层是**早拦 + 给模型一句人话**,
 *  真正权威的判定在桥里 (Guard.swift / guard.rs), 那边也同时认两套。 */
const TERMINALISH = [
  /* macOS */
  'terminal', 'iterm', 'warp', 'hyper', 'kitty', 'alacritty', 'wezterm',
  'tabby', 'termius', 'script editor', '终端', 'com.apple.terminal',
  'com.googlecode.iterm2', 'dev.warp', 'com.apple.scripteditor',
  /* Windows: 终端/解释器
   * 带 .exe 后缀地写 —— 不然 'cmd' 这种三字串会误伤一批名字里恰好含它的应用 */
  'cmd.exe', 'powershell', 'pwsh', 'windows terminal', 'wt.exe', 'conhost',
  'wsl.exe', 'mintty', 'git bash', 'git-bash', 'conemu', 'mobaxterm', 'xshell',
];

const SELFISH = ['neox', 'com.mk.neox', 'neox.exe', 'neox-os-bridge'];

const SECURITYISH = [
  /* macOS */
  'securityagent', 'keychain', '钥匙串', 'loginwindow',
  'com.apple.security', 'usernotificationcenter',
  /* Windows: UAC 同意框 / 凭据 / 系统配置工具 */
  'consent.exe', 'logonui', 'credwiz', 'regedit', 'msconfig', 'gpedit', 'secpol',
  'diskmgmt', 'certmgr', 'lsass', 'winlogon',
];

const SETTINGSISH = [
  /* macOS */
  'system settings', 'system preferences', '系统设置', '系统偏好设置',
  'com.apple.systempreferences', 'com.apple.systemsettings',
  /* Windows */
  'systemsettings', 'control panel', 'control.exe', 'ms-settings',
];

/*
 * Windows 的短名要**按词**匹配, 不能按子串 —— 模型会说 "cmd" / "powershell",
 * 不带 .exe 后缀; 而 `includes('cmd')` 会把一批名字里恰好含 cmd 的应用一起误伤。
 * mac 那些名字 (bundleId / 'System Settings') 继续走 includes: 它们的形态本来就长。
 */
const WINDOWS_TERMINAL_STEMS = [
  'cmd', 'powershell', 'pwsh', 'wt', 'windowsterminal', 'conhost', 'wsl',
  'mintty', 'conemu', 'conemu64', 'conemuc', 'mobaxterm', 'xshell', 'putty',
];
const WINDOWS_SECURITY_STEMS = [
  'consent', 'logonui', 'credwiz', 'regedit', 'msconfig', 'gpedit', 'secpol',
  'diskmgmt', 'certmgr', 'lsass', 'winlogon',
];
const WINDOWS_SETTINGS_STEMS = ['systemsettings', 'control'];

/** `C:\Windows\System32\cmd.exe` / `cmd.exe` / `cmd` → `cmd` (小写) */
function appStem(raw: string): string {
  const tail = raw.split(/[\\/]/).pop() ?? raw;
  return tail.replace(/\.exe$/i, '').trim().toLowerCase();
}

/**
 * @param app computer_snapshot / computer_run 的 app 参数 (可能是名字, 也可能是 bundleId)
 * @returns 不允许时给出拒绝理由; 允许 (含没指定 app) 返回 null
 */
export function guardComputerTarget(app?: string): GuardDenial | null {
  const raw = (app ?? '').trim().toLowerCase();
  if (!raw) return null;   /* 没指定 = 前台应用, 由桥按真实前台判 */
  const stem = appStem(raw);

  if (SELFISH.some((s) => raw === s || raw.startsWith(s + '.') || raw === 'neox')
    || ['neox', 'neox-os-bridge'].includes(stem)) {
    return {
      code: 'app_forbidden_self',
      message: 'Refused: Neox cannot drive its own windows. The approval card, settings and plugin '
        + 'pages belong to Neox itself — clicking them would be self-authorization. '
        + 'If something needs the user to confirm, say so and let the user click it.',
    };
  }
  if (TERMINALISH.some((s) => raw.includes(s)) || WINDOWS_TERMINAL_STEMS.includes(stem)) {
    return {
      code: 'app_forbidden_terminal',
      message: 'Refused: Neox cannot drive terminal apps. Typing into a terminal window is running '
        + 'arbitrary commands, which bypasses the approval, sandbox and risk checks that '
        + 'execute_shell goes through. Use execute_shell instead — it asks the user under the '
        + 'current approval mode.',
    };
  }
  if (SECURITYISH.some((s) => raw.includes(s)) || WINDOWS_SECURITY_STEMS.includes(stem)) {
    return {
      code: 'app_forbidden_security',
      message: 'Refused: Neox cannot drive system authorization or password windows. Those windows '
        + 'exist precisely so a human clicks them. Tell the user what needs granting and let them do it.',
    };
  }
  if (SETTINGSISH.some((s) => raw === s || raw.includes(s)) || WINDOWS_SETTINGS_STEMS.includes(stem)) {
    return {
      code: 'app_forbidden_settings',
      message: 'Refused: Neox cannot drive System Settings. Accessibility / Screen Recording / '
        + 'Full Disk Access all live there — clicking "Allow" would be granting itself permissions. '
        + 'To change a setting use execute_shell with `defaults write` (that path has approval, '
        + 'sandboxing and an audit trail); to grant a permission, tell the user which one and let them click it.',
    };
  }
  return null;
}
