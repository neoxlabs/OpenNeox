
/** neox-asset 在工作区外也放行的扩展名 —— 只有「拿来看」的类型 */
const PREVIEWABLE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.heic', '.tif', '.tiff',
  '.mp4', '.m4v', '.mov', '.webm', '.mkv',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
  '.pdf',
]);

export function isPreviewableExt(ext: string): boolean {
  return PREVIEWABLE_EXT.has(ext.toLowerCase());
}

/** home 之下的敏感目录 (相对 home, 用 / 写; 比较时统一分隔符) */
const SENSITIVE_HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh',
  '.password-store', '.neox-secrets',
  'Library/Keychains', 'Library/Cookies',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware', 'Library/Application Support/Firefox',
  'Library/Application Support/com.apple.TCC',
  /* Neox 自己的浏览器 profile (登录态 Cookie 在里面) */
  '.neox/chrome-profiles',
  /* Windows */
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect', 'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
];

/** home 之下的敏感文件 */
const SENSITIVE_HOME_FILES = [
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.my.cnf',
  '.neox/config.json', '.neox/permissions.json',
];

/** 任意位置都算敏感的文件名 / 扩展名 */
const SENSITIVE_BASENAME = /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;

function norm(p: string, win: boolean): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (win) s = s.toLowerCase();
  return s;
}

/**
 * 这个绝对路径是不是敏感文件 (不许读来显示)。
 * @param abs     已 resolve 的绝对路径 (最好是 realpath 之后的, 防软链绕过)
 * @param home    os.homedir()
 * @param platform process.platform
 */
export function isSensitiveReadPath(abs: string, home: string, platform: string): boolean {
  const win = platform === 'win32';
  const p = norm(abs, win);
  const h = norm(home, win);
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (SENSITIVE_BASENAME.test(base)) return true;
  const under = (rel: string): boolean => {
    const r = norm(`${h}/${rel}`, win);
    return p === r || p.startsWith(r + '/');
  };
  if (SENSITIVE_HOME_DIRS.some(under)) return true;
  if (SENSITIVE_HOME_FILES.some((f) => p === norm(`${h}/${f}`, win))) return true;
  /* 系统级凭证 */
  if (!win && (p.startsWith('/etc/ssh/') || p === '/etc/shadow' || p === '/etc/sudoers' || p.startsWith('/private/etc/ssh/')
    || p.startsWith('/Library/Keychains') || p.startsWith('/private/var/db/'))) return true;
  return false;
}
