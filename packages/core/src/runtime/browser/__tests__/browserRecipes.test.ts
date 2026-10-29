/**
 * 录制 / 回放 / 自愈。
 *
 * 这一层最贵的失效是**静默的**: SKILL.md 还在, 但机器读的那块被改坏了 —— 如果这时
 * 回放"成功"地跑了 0 步, 用户会以为自己每天的活干完了。所以这里逐条钉死。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ESM 下 spyOn(os,'homedir') 是不行的 (module namespace 不可配置), 所以整个 mock 掉。
 * 真实 homedir 仍然要能用 —— mkdtemp 就靠它。 */
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return { ...real, default: real, homedir: () => process.env.__NEOX_TEST_HOME__ || real.homedir() };
});

import {
  renderSkillMd, parseSkillMd, healingVariants, slugify,
  saveRecipe, loadRecipe, listRecipes, recipePath, type Recipe,
} from '../browserRecipes.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neox-recipe-'));
  process.env.__NEOX_TEST_HOME__ = home;
});
afterEach(() => {
  delete process.env.__NEOX_TEST_HOME__;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const RECIPE: Recipe = {
  name: '导报表',
  description: '每天去后台导一张日报',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  steps: [
    { action: 'navigate', args: { url: 'https://admin.example/login' } },
    { action: 'click', args: { selector: '.btn-x7f2' }, label: '登录', anchors: [{ text: '登录' }] },
  ],
};

describe('SKILL.md 往返', () => {
  it('存下来的能原样读回去', () => {
    const back = parseSkillMd(renderSkillMd(RECIPE));
    expect(back?.steps).toEqual(RECIPE.steps);
    expect(back?.description).toBe(RECIPE.description);
  });

  it('文件里写明白了"只有代码块说了算" —— 不写的话用户会改上面的中文以为改了行为', () => {
    const md = renderSkillMd(RECIPE);
    expect(md).toContain('回放只读下面这个代码块');
    /* 人读的步骤清单也得在, 否则这文件对人没有价值 */
    expect(md).toContain('点击');
  });

  it('录制不进 `/` 菜单 —— frontmatter 里写明 user-invocable: false', () => {
    expect(renderSkillMd(RECIPE)).toMatch(/^user-invocable: false$/m);
  });

  it('代码块被改坏时返回 null —— 绝不能当"空脚本"跑过去', () => {
    const md = renderSkillMd(RECIPE).replace('"steps"', '"steps"broken');
    expect(parseSkillMd(md)).toBeNull();
    /* 块整个没了也一样 */
    expect(parseSkillMd('# 一个普通技能\n\n没有录制块')).toBeNull();
  });

  it('slug 只留能当目录名的字符, 中文名不会变成空目录', () => {
    expect(slugify('Daily Report!!')).toBe('daily-report');
    expect(slugify('导 报表')).toBe('导-报表');
    expect(slugify('***')).toMatch(/^recipe-\d+$/);
  });
});

describe('落盘', () => {
  it('存 → 读 → 列, 三者一致', () => {
    const p = saveRecipe(RECIPE);
    expect(p).toBe(recipePath('导报表'));
    expect(loadRecipe('导报表')?.steps).toHaveLength(2);
    expect(listRecipes()).toEqual([
      { name: slugify('导报表'), description: '每天去后台导一张日报', steps: 2, updatedAt: RECIPE.updatedAt },
    ]);
  });

  it('没录过就是 null / 空数组, 不抛', () => {
    expect(loadRecipe('不存在')).toBeNull();
    expect(listRecipes()).toEqual([]);
  });

  it('用户手写的普通技能不会混进"能复跑的脚本"列表', () => {
    mkdirSync(join(home, '.neox', 'skills', 'my-notes'), { recursive: true });
    writeFileSync(join(home, '.neox', 'skills', 'my-notes', 'SKILL.md'), '---\nname: my-notes\n---\n# 随手记\n');
    saveRecipe(RECIPE);
    expect(listRecipes().map((r) => r.name)).toEqual([slugify('导报表')]);
  });

  it('存盘内容就是 SKILL.md, 用户能直接改', () => {
    saveRecipe(RECIPE);
    const text = readFileSync(recipePath('导报表'), 'utf8');
    expect(text.startsWith('---\nname: ')).toBe(true);
    expect(text).toContain('browser_replay');
  });
});

describe('healingVariants', () => {
  it('换定位时把旧的定位字段清掉 —— 留着 selector 的话备选等于没换', () => {
    const v = healingVariants({
      action: 'click',
      args: { selector: '.btn-x7f2', surfaceId: 's1', button: 'left' },
      anchors: [{ text: '登录' }],
    });
    expect(v).toEqual([{ text: '登录', surfaceId: 's1', button: 'left' }]);
  });

  it('**type 的 text 是要输入的内容, 不是定位** —— 换定位不能把它删掉或覆盖掉', () => {
    const v = healingVariants({
      action: 'type',
      args: { selector: '#u', text: 'zhangsan', surfaceId: 's1' },
      anchors: [{ role: 'textbox', name: '用户名' }],
    });
    /* 删掉 text → 什么都没输入; 用 anchor 的文字覆盖 → 用户名被填成"用户名" */
    expect(v).toEqual([{ role: 'textbox', name: '用户名', text: 'zhangsan', surfaceId: 's1' }]);
  });

  it('文字锚点对 type 这类动作直接跳过 —— 它没有"按文字找元素"这条路', () => {
    expect(healingVariants({
      action: 'type', args: { selector: '#u', text: 'zhangsan' }, anchors: [{ text: '用户名' }],
    })).toEqual([]);
  });

  it('click 的 text 就是定位, 该换的时候要换', () => {
    expect(healingVariants({
      action: 'click', args: { selector: '.gone', surfaceId: 's1' }, anchors: [{ text: '登录' }],
    })).toEqual([{ text: '登录', surfaceId: 's1' }]);
  });

  it('跟原参数一模一样的备选被丢掉 —— 试它只是白等一次超时', () => {
    expect(healingVariants({
      action: 'click', args: { selector: '.a' }, anchors: [{ selector: '.a' }],
    })).toEqual([]);
  });

  it('没有 anchors 就没有备选', () => {
    expect(healingVariants({ action: 'click', args: { selector: '.a' } })).toEqual([]);
  });
});
