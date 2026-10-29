import { describe, it, expect } from 'vitest';
import { isSensitiveReadPath, isPreviewableExt } from './localReadPolicy';

const HOME = '/Users/me';
const mac = (p: string) => isSensitiveReadPath(p, HOME, 'darwin');

describe('工作区外的普通文件能显示', () => {
  it.each([
    '/Users/me/Documents/Neox/工作/2026-10-03-贺卡/贺卡.png',
    '/Users/me/Desktop/screenshot.png',
    '/Users/me/projects/other-repo/docs/arch.svg',
    '/Volumes/Data/video.mp4',
    '/tmp/neox-shots/a.png',
    '/Users/me/.neox/run/shots/w1.png',
  ])('%s', (p) => { expect(mac(p)).toBe(false); });
});

describe('敏感文件无论在哪都拦', () => {
  it.each([
    '/Users/me/.ssh/id_ed25519',
    '/Users/me/.ssh/config',
    '/Users/me/.aws/credentials',
    '/Users/me/.config/gcloud/application_default_credentials.json',
    '/Users/me/.kube/config',
    '/Users/me/Library/Keychains/login.keychain-db',
    '/Users/me/Library/Application Support/Google/Chrome/Default/Cookies',
    '/Users/me/.neox/config.json',
    '/Users/me/.neox-secrets/image-gen.env',
    '/Users/me/.neox/chrome-profiles/neox/Default/Cookies',
    '/Users/me/projects/app/.env',
    '/Users/me/projects/app/.env.production',
    '/Users/me/Downloads/server.pem',
    '/Users/me/Downloads/release.keystore',
    '/Users/me/.npmrc',
    '/Users/me/.git-credentials',
    '/etc/ssh/ssh_host_rsa_key',
  ])('%s', (p) => { expect(mac(p)).toBe(true); });
});

describe('Windows: 大小写 / 反斜杠', () => {
  const win = (p: string) => isSensitiveReadPath(p, 'C:\\Users\\Me', 'win32');
  it('凭证目录拦', () => {
    expect(win('c:\\users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\x')).toBe(true);
    expect(win('C:\\Users\\Me\\.SSH\\id_rsa')).toBe(true);
  });
  it('普通图片放行', () => {
    expect(win('D:\\work\\out\\chart.png')).toBe(false);
  });
});

describe('neox-asset 工作区外只放行能预览的类型', () => {
  it.each(['.png', '.JPG', '.svg', '.mp4', '.mp3', '.pdf', '.heic'])('%s 放行', (e) => { expect(isPreviewableExt(e)).toBe(true); });
  it.each(['.txt', '.json', '.ts', '.sh', '', '.html'])('%s 不放行', (e) => { expect(isPreviewableExt(e)).toBe(false); });
});
