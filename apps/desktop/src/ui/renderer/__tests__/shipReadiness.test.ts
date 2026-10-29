import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (rel: string) => readFileSync(resolve(HERE, '..', rel), 'utf8');

describe('① 界面上不许立"未完成功能"的墓碑', () => {
  it('右栏「撤销」/「整段退回」关着时整个不渲染, 而不是置灰写「暂不支持」', () => {
    /* 注释里写着"不再摆一颗写着「暂不支持」的灰按钮"是在解释历史 —— 只看声明/JSX */
    const src = R('modules/shell/RightPanel.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/暂不支持|Unavailable|Not available/);
    /* 关着时不渲染 —— 两个入口各自的写法 */
    expect(src).toMatch(/\{isSessionRewindEnabled\(\) && \(/);
    expect(src).toMatch(/if \(!rewindOn\) return null;/);
  });

  it('关着的时候也不许把坏路径打开 —— handleRollback 只在 rewindOn 时可达', () => {
    const src = R('modules/shell/RightPanel.tsx');
    expect(src.indexOf('if (!rewindOn) return null;')).toBeLessThan(src.indexOf('handleRollback(c.id'));
  });
});

describe('② 一个开关不许把整页控件锁死', () => {
  it('桌宠页的选项在桌宠关着时照常可改', () => {
    const src = R('pages/settings/tabs/PetTab.tsx');
    /* 之前 19 处 disabled={!cfg.enabled} —— 关着进这一页, 14 个控件全灰 */
    expect(src).not.toMatch(/disabled=\{!cfg\.enabled\}/);
    expect(src).not.toMatch(/disabled=\{!cfg\.enabled \|\|/);
  });
});

describe('③ 英文界面不许漏中文', () => {
  /* 判据: JSX 文本 / 文案 prop 里有中文, 而整行没有 zh 分支。
     发现时 137 处, 其中 ServicesSurfaceViewer 一个文件 103 处 (英文用户打开服务面板
     看到的是整屏中文), 且它确实在打包产物里。 */
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (!/node_modules|dist|__tests__|__harness__/.test(p)) walk(p); }
      else if (/\.tsx$/.test(e) && !/\.test\./.test(e)) files.push(p);
    }
  };
  walk(resolve(HERE, '..'));

  const bare = (src: string): string[] => {
    const out: string[] = [];
    for (const line of src.split('\n')) {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
      if (!/[一-龥]/.test(code)) continue;
      if (/\bisZh\b|\bzh\b\s*\?|language\s*===\s*'zh'|t\.|useI18n|i18n/.test(code)) continue;
      const m = code.match(/>\s*([^<>{}]*[一-龥][^<>{}]*)\s*</)
             || code.match(/(?:title|placeholder|aria-label|label|alt)=["']([^"']*[一-龥][^"']*)["']/);
      if (m) out.push(m[1].trim());
    }
    return out;
  };

  it('服务面板 (ServicesSurfaceViewer) 一条不漏 —— 它在打包版里', () => {
    expect(bare(R('modules/surface/viewers/ServicesSurfaceViewer.tsx'))).toEqual([]);
  });

  it('桌宠窗口三个组件不漏 —— 它们跑在独立窗口里, 容易被整体遗忘', () => {
    for (const f of ['modules/pet/PetPlanBar.tsx', 'modules/pet/PetWindowFrame.tsx', 'modules/pet/PetErrorBoundary.tsx']) {
      expect(bare(R(f)), f).toEqual([]);
    }
  });

  it('全局裸中文总量只许降不许升 (当前基线 29, 剩下的都在 IDE-only 文件或是误报)', () => {
    const total = files.reduce((n, f) => n + bare(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeLessThanOrEqual(29);
  });
});
