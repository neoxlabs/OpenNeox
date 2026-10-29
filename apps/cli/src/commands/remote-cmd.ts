/**
 * Remote Access Command Handlers
 * 远程访问相关 CLI 命令
 */

import { getLanguage, L } from '../i18n/index.js';
import type { SelectionChoice } from '../cliTypes.js';
import { saveConfig, type NeoxConfig, type RemoteAccessConfig } from '@neoxlabs/platform/utils/config.js';
import { isWSL, wslToWindowsPath } from '@neoxlabs/platform/platform/platformDetect.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDefaultServerPort } from '@neoxlabs/platform/utils/config.js';

export interface RemoteCommandContext {
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  promptText: (
    question: string,
    options?: {
      defaultValue?: string;
      hint?: string;
      allowEmpty?: boolean;
    }
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
  startRemote: () => Promise<void>;
  stopRemote: () => Promise<void>;
  regenerateToken: () => string;
  getStatus: () => {
    enabled: boolean;
    running: boolean;
    networkMode: 'lan' | 'vps';
    host: string;
    port: number;
    token?: string;
    clients: number;
    urls: string[];
  };
  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;
}

const DEFAULT_HOST = '0.0.0.0';
// 统一使用 Main Server 端口 (可被 NEOX_SERVER_PORT 覆盖 — 桌面 dev 就靠它跟 CLI 错开)
const DEFAULT_PORT = getDefaultServerPort();

// 配对 token 等同于远程控制凭证，默认在 timeline 里脱敏显示，
// 仅在用户显式 reveal 时才完整展示（参考 gh auth / tailscale 处理 pairing secret 的方式）。
const securityNote = () => L(
  '⚠ Token 是远程访问凭证，谁拿到谁就能控制本机会话，勿截图 / 勿分享。',
  '⚠ The token is a remote-access credential — whoever has it controls this machine’s sessions. Don’t screenshot or share it.',
);
const revealHint = () => L('查看完整 token: /remote reveal', 'Full token: /remote reveal');
const revealedNote = () => L('已显示完整 token，请勿截图 / 分享。', 'Full token shown — don’t screenshot or share it.');
const cancelledTitle = () => L('操作取消', 'Cancelled');

/**
 * 脱敏配对 token，仅保留首尾各 4 位，中间用圆点遮盖。
 * 例: "abcd1234efgh5678" -> "abcd••••••••5678"
 * 过短的 token 全部遮盖，避免泄露过多熵。
 */
function maskToken(token?: string): string {
  if (!token) return L('(未生成)', '(not generated)');
  if (token.length <= 8) return '•'.repeat(Math.max(token.length, 4));
  const head = token.slice(0, 4);
  const tail = token.slice(-4);
  const dots = '•'.repeat(Math.max(token.length - 8, 8));
  return `${head}${dots}${tail}`;
}

/**
 * 根据 reveal 标志返回完整 token 或脱敏 token。
 */
function displayToken(token: string | undefined, reveal: boolean): string {
  if (reveal) return token || L('(未生成)', '(not generated)');
  return maskToken(token);
}

async function renderQrCode(
  payload: string
): Promise<{ qr: string | null; error?: string }> {
  try {
    // Use uqr's renderUnicodeCompact for better terminal QR code rendering
    // It combines two rows into one using ▀▄█ characters, which fixes
    // the aspect ratio issue caused by terminal characters being ~2x tall as wide
    const { renderUnicodeCompact } = await import('uqr');
    const qr = renderUnicodeCompact(payload, {
      ecc: 'M', // Smaller terminal QR; PNG output remains high quality
      border: 1,
    });
    return { qr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { qr: null, error: message };
  }
}

/**
 * Generate a PNG QR code image file and open it with the system default viewer.
 * This allows phones to scan a real image QR code instead of terminal ASCII art.
 */
async function generateAndOpenQrImage(
  payload: string
): Promise<{ filePath: string | null; error?: string }> {
  // 这个 PNG 内嵌了完整 token（neox://pair?...&token=...），等同明文凭证。
  // 必须：1) 0600 权限避免同机其他用户读取；2) 看完后清理，不在 /tmp 长期遗留。
  let filePath: string | null = null;
  try {
    const mod = await import('qrcode');
    const qr = (mod as any).default ?? mod;
    if (!qr || typeof qr.toFile !== 'function') {
      return { filePath: null, error: 'QRCode module missing or invalid.' };
    }

    const fs = await import('fs/promises');

    // 先清理上一轮可能残留的配对二维码（best-effort），避免明文 PNG 在 /tmp 堆积。
    await cleanupStaleQrImages(fs).catch(() => undefined);

    // Generate unique filename in temp directory
    const timestamp = Date.now();
    filePath = join(tmpdir(), `neox-qr-${timestamp}.png`);

    // Generate PNG with high quality settings for easy scanning
    await qr.toFile(filePath, payload, {
      type: 'png',
      errorCorrectionLevel: 'H', // Highest error correction
      margin: 4, // Larger margin for better scanning
      scale: 10, // Large scale for clear image
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    // 收紧权限：仅当前用户可读写（0600），防止 world-readable 的 /tmp 泄露 token。
    await fs.chmod(filePath, 0o600).catch(() => undefined);

    // Open the image with system default viewer
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Detect platform and use appropriate command
    const platform = process.platform;
    let openCommand: string;
    if (platform === 'darwin') {
      openCommand = `open "${filePath}"`;
    } else if (platform === 'win32') {
      openCommand = `start "" "${filePath}"`;
    } else if (isWSL()) {
      // WSL: Use wslview (from wslu) or explorer.exe
      const windowsPath = wslToWindowsPath(filePath);
      openCommand = `explorer.exe "${windowsPath}"`;
    } else {
      // Linux and others
      openCommand = `xdg-open "${filePath}"`;
    }

    await execAsync(openCommand);

    // 系统查看器是异步加载的，open 返回时图片往往还没被读完。
    // 延迟清理：给查看器留出加载窗口后删除明文 PNG，避免长期遗留。
    // 不 await，避免阻塞 timeline 输出；删除失败由下一轮 cleanup 兜底。
    const toDelete = filePath;
    setTimeout(() => {
      void fs.unlink(toDelete).catch(() => undefined);
    }, 60_000).unref?.();

    return { filePath };
  } catch (error) {
    // 出错时也尽量清理已落盘的明文 PNG。
    if (filePath) {
      try {
        const fs = await import('fs/promises');
        await fs.unlink(filePath).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return { filePath: null, error: message };
  }
}

/**
 * 清理 /tmp 下遗留的配对二维码 PNG（neox-qr-*.png）。
 * best-effort：在每次生成新二维码前调用，确保明文 token PNG 不会长期堆积。
 */
async function cleanupStaleQrImages(
  fs: typeof import('fs/promises')
): Promise<void> {
  const dir = tmpdir();
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries
      .filter((name) => /^neox-qr-\d+\.png$/.test(name))
      .map((name) => fs.unlink(join(dir, name)).catch(() => undefined))
  );
}

function buildPairingPayload(status: ReturnType<RemoteCommandContext['getStatus']>): {
  payload: string;
  lanUrl: string;
} {
  const preferredUrl = status.urls[0];
  const host = preferredUrl
    ? new URL(preferredUrl).hostname
    : status.host && status.host !== DEFAULT_HOST
      ? status.host
      : '127.0.0.1';
  const params = new URLSearchParams({
    mode: status.networkMode,
    host,
    port: String(status.port),
    token: status.token || '',
  });
  return {
    payload: `neox://pair?${params.toString()}`,
    lanUrl: `http://${host}:${status.port}`,
  };
}

function getRemoteConfig(config: NeoxConfig): RemoteAccessConfig {
  return config.remote ?? {};
}

function normalizeNetworkMode(mode?: string): 'lan' | 'vps' {
  return mode === 'vps' ? 'vps' : 'lan';
}

export async function handleRemoteCommand(
  ctx: RemoteCommandContext,
  actionArg?: string
): Promise<void> {
  const status = ctx.getStatus();
  const remoteServer = ctx.userConfig.remoteServer;
  const isConnectedRemote = !!remoteServer?.url;
  let action = actionArg?.toLowerCase();

  // 显式 reveal：`/remote reveal` / 菜单 "Reveal token" 才完整展示 token。
  // 该标志只影响本次输出，不持久化。
  let revealToken = action === 'reveal';
  if (revealToken) {
    // reveal 复用 pair 视图，但把 token 完整打印出来。
    action = 'pair';
  }

  if (!action) {
    try {
      const zhUI = getLanguage() === 'zh';
      action = await ctx.promptSelect(
        zhUI ? '远程访问' : 'Remote access',
        [
          {
            label: isConnectedRemote
              ? `${zhUI ? '远程服务器' : 'Remote Server'} — ${remoteServer!.url}`
              : (zhUI ? '连接远程服务器' : 'Connect remote server'),
            value: 'connect',
          },
          { label: `${zhUI ? '开关' : 'Enabled'} — ${status.enabled ? (zhUI ? '已开' : 'on') : (zhUI ? '已关' : 'off')}`, value: 'toggle' },
          { label: `${zhUI ? '网络模式' : 'Network'} — ${status.networkMode.toUpperCase()}`, value: 'network' },
          { label: `${zhUI ? '端口' : 'Port'} — ${status.port}`, value: 'port' },
          { label: zhUI ? '显示二维码' : 'Show QR code', value: 'qr' },
          { label: zhUI ? '配对信息' : 'Pairing info', value: 'pair' },
          { label: zhUI ? '显示完整 token' : 'Reveal token', value: 'reveal' },
          { label: zhUI ? '重新生成 token' : 'Regenerate token', value: 'token' },
        ],
        isConnectedRemote ? 'connect' : 'toggle',
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(cancelledTitle(), error?.message);
      }
      return;
    }
  }

  if (action === 'back') {
    return;
  }

  // 菜单里选 "Reveal token" 时把 action 映射回 pair 视图，并开启完整展示。
  if (action === 'reveal') {
    revealToken = true;
    action = 'pair';
  }

  if (action === 'connect') {
    await handleConnectRemoteServer(ctx);
    return;
  }

  if (action === 'on' || action === 'off' || action === 'toggle') {
    const enabled =
      action === 'on'
        ? true
        : action === 'off'
          ? false
          : !status.enabled;

    updateRemoteConfig(ctx, { enabled });
    if (enabled) {
      await ctx.startRemote();
      const info = ctx.getStatus();
      const lines = [
        `${L('模式', 'Mode')}: ${info.networkMode.toUpperCase()}`,
        `${L('地址', 'Address')}: ${info.host}:${info.port}`,
        `Token: ${maskToken(info.token)}`,
      ];
      if (info.urls.length > 0) {
        lines.push(L('LAN 地址:', 'LAN addresses:'));
        for (const url of info.urls) {
          lines.push(`- ${url}`);
        }
      }
      lines.push(securityNote());
      lines.push(revealHint());
      ctx.logInfo(L('远程访问已开启', 'Remote access on'), lines.join('\n'));
    } else {
      await ctx.stopRemote();
      ctx.logInfo(L('远程访问已关闭', 'Remote access off'), L('已断开远程连接', 'Remote connections closed'));
    }
    return;
  }

  if (action === 'network') {
    let selected: string;
    try {
      selected = await ctx.promptSelect(
        L('选择网络模式', 'Network mode'),
        [
          { label: L('LAN — 同一局域网', 'LAN — same network'), value: 'lan' },
          { label: L('VPS — 公网中转', 'VPS — public relay'), value: 'vps' },
        ],
        status.networkMode
      );
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(cancelledTitle(), error?.message);
      }
      return;
    }
    const networkMode = normalizeNetworkMode(selected);
    updateRemoteConfig(ctx, { networkMode });
    if (networkMode === 'vps') {
      ctx.logInfo(L('已切换到 VPS 模式', 'Switched to VPS mode'), L('直接部署 Neox Server 到 VPS，手机通过公网 IP 连接', 'Run Neox Server on a VPS; the phone connects over its public IP'));
    } else {
      ctx.logInfo(L('已切换到 LAN 模式', 'Switched to LAN mode'), L('同一局域网内连接', 'Connect from the same local network'));
    }
    await ctx.startRemote();
    return;
  }

  if (action === 'port') {
    let input = '';
    try {
      input = await ctx.promptText(L('输入监听端口', 'Listen port'), {
        defaultValue: String(status.port || DEFAULT_PORT),
        allowEmpty: false,
      });
    } catch (error: any) {
      if (error?.message !== 'cancelled') {
        ctx.logInfo(cancelledTitle(), error?.message);
      }
      return;
    }
    const port = parseInt(input, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      ctx.logInfo(L('无效端口', 'Invalid port'), L('请输入 1-65535 之间的端口', 'Enter a port between 1 and 65535'));
      return;
    }
    updateRemoteConfig(ctx, { port });
    await ctx.startRemote();
    ctx.logInfo(L('端口已更新', 'Port updated'), `${L('当前端口', 'Port')}: ${port}`);
    return;
  }

  if (action === 'token') {
    const token = ctx.regenerateToken();
    ctx.logInfo(
      L('Token 已更新', 'Token regenerated'),
      [
        `${L('新的 Token', 'New token')}: ${maskToken(token)}`,
        securityNote(),
        revealHint(),
      ].join('\n')
    );
    await ctx.startRemote();
    return;
  }

  if (action === 'pair' || action === 'status') {
    let updated = ctx.getStatus();
    if (!updated.token) {
      ctx.regenerateToken();
      updated = ctx.getStatus();
    }
    const lines = [
      `${L('状态', 'Status')}: ${updated.enabled ? L('开启', 'on') : L('关闭', 'off')} / ${updated.running ? L('运行中', 'running') : L('未运行', 'not running')}`,
      `${L('模式', 'Mode')}: ${updated.networkMode.toUpperCase()}`,
      `${L('地址', 'Address')}: ${updated.host}:${updated.port}`,
      `Token: ${displayToken(updated.token, revealToken)}`,
    ];
    if (updated.urls.length > 0) {
      lines.push(L('LAN 地址:', 'LAN addresses:'));
      for (const url of updated.urls) {
        lines.push(`- ${url}`);
      }
    }
    lines.push(securityNote());
    lines.push(revealToken ? revealedNote() : revealHint());
    ctx.logInfo(L('远程配对信息', 'Pairing info'), lines.join('\n'));
    return;
  }

  if (action === 'qr') {
    let updated = ctx.getStatus();
    if (!updated.token) {
      ctx.regenerateToken();
      updated = ctx.getStatus();
    }
    const pairing = buildPairingPayload(updated);
    if (ctx.clearOutputLines) {
      ctx.clearOutputLines();
    }

    // Generate PNG QR code image and open it for phone scanning
    const imageResult = await generateAndOpenQrImage(pairing.payload);

    const qrResult = await renderQrCode(pairing.payload);
    // 二维码本身（图片 / ASCII）携带完整 token 用于扫码配对，这是预期内的。
    // 但 timeline 上的文字 token / 协议串默认脱敏，避免被截图泄露；
    // 协议串里的 token= 同样替换为脱敏值。
    const displayedToken = displayToken(updated.token, revealToken);
    const displayedPayload = revealToken
      ? pairing.payload
      : pairing.payload.replace(
          /([?&]token=)[^&]*/,
          `$1${encodeURIComponent(maskToken(updated.token))}`
        );
    const lines = [
      `${L('LAN 地址', 'LAN address')}: ${pairing.lanUrl}`,
      `Token: ${displayedToken}`,
      `${L('协议', 'Link')}: ${displayedPayload}`,
      securityNote(),
      revealToken
        ? revealedNote()
        : L('完整 token 已编入二维码; 文字查看用 /remote reveal', 'The full token is in the QR code; /remote reveal shows it as text'),
    ];

    // Add PNG file info if generated successfully
    if (imageResult.filePath) {
      lines.push(`${L('二维码图片', 'QR image')}: ${imageResult.filePath}`);
      lines.push(L('(已在新窗口打开，请使用手机扫描)', '(opened in a new window — scan it with your phone)'));
    } else if (imageResult.error) {
      lines.push(`${L('图片生成失败', 'Image failed')}: ${imageResult.error}`);
    }

    const detailLines = qrResult.qr
      ? lines
      : [
        ...lines,
        `${L('终端二维码生成失败', 'Terminal QR failed')}: ${qrResult.error || L('未知错误', 'unknown error')}`,
      ];
    if (qrResult.qr) {
      const qrLines = qrResult.qr.split('\n');
      if (qrLines[qrLines.length - 1] === '') {
        qrLines.pop();
      }
      const terminalRows = typeof process.stdout?.rows === 'number' ? process.stdout.rows : 0;
      const maxQrRows = terminalRows > 0 ? Math.max(8, terminalRows - 10) : 24;
      const qrTooLarge = qrLines.length > maxQrRows;
      const skipNote = L(`终端二维码过大(${qrLines.length}行)，已省略（请扫图片）`, `Terminal QR too tall (${qrLines.length} rows) — skipped, scan the image instead`);
      const qrTitle = L('远程配对二维码', 'Pairing QR code');
      if (ctx.outputLines) {
        if (qrTooLarge) {
          ctx.outputLines([...lines, skipNote]);
        } else {
          ctx.outputLines([...qrLines, '', ...lines]);
        }
        ctx.logInfo(qrTitle, lines.join('\n'));
      } else if (qrTooLarge) {
        ctx.logInfo(qrTitle, [...lines, skipNote].join('\n'));
      } else {
        ctx.logInfo(qrTitle, `${qrResult.qr}\n${lines.join('\n')}`);
      }
    } else {
      ctx.logInfo(L('远程配对信息', 'Pairing info'), detailLines.join('\n'));
    }
    return;
  }

  ctx.logInfo(L('无效的操作', 'Unknown action'), L('使用 /remote 查看可用操作', 'Run /remote to see what’s available'));
}

function updateRemoteConfig(
  ctx: RemoteCommandContext,
  updates: RemoteAccessConfig
): void {
  const current = getRemoteConfig(ctx.userConfig);
  const next: RemoteAccessConfig = {
    enabled: current.enabled ?? false,
    networkMode: normalizeNetworkMode(current.networkMode),
    host: current.host || DEFAULT_HOST,
    port: current.port || DEFAULT_PORT,
    token: current.token,
    allowVoice: current.allowVoice ?? true,
    autoApprove: current.autoApprove ?? true,
    ...updates,
  };

  const updatedConfig: NeoxConfig = {
    ...ctx.userConfig,
    remote: next,
  };
  ctx.updateConfig(updatedConfig);
  saveConfig(updatedConfig);
}

/**
 * 连接远程 Neox Server 交互菜单
 */
async function handleConnectRemoteServer(ctx: RemoteCommandContext): Promise<void> {
  const current = ctx.userConfig.remoteServer;
  const isConnected = !!current?.url;

  let action: string;
  try {
    if (isConnected) {
      action = await ctx.promptSelect(
        `${L('远程服务器', 'Remote server')} · ${current!.url}`,
        [
          { label: L('测试连接', 'Test connection'), value: 'test' },
          { label: L('修改地址', 'Change address'), value: 'edit-url' },
          { label: L('修改 Token', 'Change token'), value: 'edit-token' },
          { label: L('断开', 'Disconnect'), value: 'disconnect' },
        ],
        'test'
      );
    } else {
      action = await ctx.promptSelect(
        L('连接远程服务器', 'Connect remote server'),
        [
          { label: L('输入服务器地址', 'Enter server address'), value: 'setup' },
        ],
        'setup'
      );
    }
  } catch {
    return;
  }

  if (action === 'back') return;

  if (action === 'disconnect') {
    const updatedConfig: NeoxConfig = { ...ctx.userConfig };
    delete updatedConfig.remoteServer;
    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);
    ctx.logInfo(L('已断开远程服务器', 'Disconnected from remote server'), L('下次启动将使用本地 Server，请重启 CLI 生效', 'The local server is used from the next start — restart the CLI'));
    return;
  }

  if (action === 'test') {
    if (!current?.url) {
      ctx.logInfo(L('未配置', 'Not set up'), L('请先配置远程服务器地址', 'Set a remote server address first'));
      return;
    }
    try {
      const healthUrl = `${current.url.replace(/\/+$/, '')}/health`;
      const resp = await fetch(healthUrl, {
        signal: AbortSignal.timeout(5000),
        headers: current.token ? { Authorization: `Bearer ${current.token}` } : {},
      });
      if (resp.ok) {
        ctx.logInfo(L('连接成功', 'Connected'), L(`${current.url} 服务正常`, `${current.url} is healthy`));
      } else {
        ctx.logInfo(L('连接失败', 'Connection failed'), `HTTP ${resp.status}: ${resp.statusText}`);
      }
    } catch (err: any) {
      ctx.logInfo(L('连接失败', 'Connection failed'), err?.message || L('无法连接到服务器', 'Could not reach the server'));
    }
    return;
  }

  // setup / edit-url / edit-token
  let url = current?.url || '';
  let token = current?.token || '';

  if (action === 'setup' || action === 'edit-url') {
    try {
      url = await ctx.promptText(L('服务器地址 (如 http://192.168.1.100:4399)', 'Server address (e.g. http://192.168.1.100:4399)'), {
        defaultValue: url,
        allowEmpty: false,
      });
    } catch { return; }

    // 校验 URL
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.logInfo(L('URL 无效', 'Invalid URL'), L('协议必须是 http 或 https', 'Must start with http or https'));
        return;
      }
      url = `${parsed.protocol}//${parsed.host}`;
    } catch {
      ctx.logInfo(L('URL 无效', 'Invalid URL'), L('请输入有效的 URL', 'Enter a valid URL'));
      return;
    }
  }

  if (action === 'setup' || action === 'edit-token') {
    try {
      token = await ctx.promptText(L('Bearer Token (服务端 /remote 生成，可留空)', 'Bearer token (from /remote on the server, optional)'), {
        defaultValue: token,
        allowEmpty: true,
      });
    } catch { return; }
  }

  const remoteServer: { url: string; token?: string } = { url };
  if (token) remoteServer.token = token;

  const updatedConfig: NeoxConfig = {
    ...ctx.userConfig,
    remoteServer,
  };
  ctx.updateConfig(updatedConfig);
  saveConfig(updatedConfig);

  // 自动测试连接
  try {
    const healthUrl = `${url}/health`;
    const resp = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (resp.ok) {
      ctx.logInfo(L('配置已保存', 'Saved'), L(`${url} 连接正常，重启 CLI 后生效`, `${url} is reachable — restart the CLI to use it`));
    } else {
      ctx.logInfo(L('配置已保存', 'Saved'), L(`${url} 返回 HTTP ${resp.status}，请检查地址和 Token`, `${url} returned HTTP ${resp.status} — check the address and token`));
    }
  } catch (err: any) {
    ctx.logInfo(L('配置已保存', 'Saved'), L(`${url} 暂时无法连接 (${err?.message || '超时'})，请确认服务器已启动`, `${url} is unreachable right now (${err?.message || 'timeout'}) — make sure the server is running`));
  }
}
