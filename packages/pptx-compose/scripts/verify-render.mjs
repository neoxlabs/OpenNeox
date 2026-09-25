#!/usr/bin/env node
/* eslint-disable */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, '..', 'pptx-renderer', 'dist', 'index.js');
const { Presentation, exportPptx } = await import(pathToFileURL(RENDERER).href);
const STYLE = await import(pathToFileURL(join(ROOT, 'dist', 'style', 'index.js')).href);
const T = await import(pathToFileURL(join(ROOT, 'dist', 'templates', 'index.js')).href);
const DVB = await import(pathToFileURL(join(ROOT, 'dist', 'templates', 'dataviz-bits.js')).href);

let failures = 0;
const fail = (msg) => { console.log(`  ✗ ${msg}`); failures++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

/* 收集 render() 的 overlap 告警 —— 它走 console.warn */
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

const P = ['大模型不是替换现有系统, 而是补上人机之间那层一直缺的翻译。',
           '试点先挑"错了也不致命"的场景: 运维问答、质检初筛、报告草稿。'];

/** 一份覆盖全部 20 个模板的 deck */
function buildAll(ppt) {
  const s = () => ppt.slides.add();
  T.coverHero(s(), { tag: 'KICKER', title: '国产大模型在制造业的落地路径', subtitle: '副标题', footerText: 'MK-CO' });
  T.sectionDivider(s(), { sectionNumber: '01', title: '现状与问题', subtitle: '卡在哪一步' });
  T.titleBody(s(), { kicker: 'CONTEXT', title: '为什么现在动手', body: P });
  T.bulletList(s(), { kicker: 'ISSUES', title: '三个卡点', items: ['知识散在老师傅脑子里', '质检报告靠手写', '术语不统一'] });
  T.twoColumn(s(), { kicker: 'COMPARE', title: '自建还是采购', leftTitle: '自建', leftBody: P, rightTitle: '采购', rightBody: P });
  T.threeColumn(s(), { kicker: 'PILLARS', title: '三条主线', columns: [{ title: '算力', body: P[0] }, { title: '数据', body: P[1] }, { title: '场景', body: P[0] }] });
  T.timeline(s(), { kicker: 'ROADMAP', title: '路线图', steps: [{ label: 'Q1 · 基建', detail: '部署算力' }, { label: 'Q2 · 试点', detail: '两场景上线' }, { label: 'Q3 · 回流', detail: '数据回流' }, { label: 'H1 · 复制', detail: '多厂推广' }] });
  T.kpiCards(s(), { kicker: 'RESULTS', title: '关键成效', cards: [{ value: '82%', label: '定位提速', subLabel: '45→8min' }, { value: '¥680万', label: '成本节省', subLabel: '3 厂区' }, { value: '+2.3pt', label: '良品率', subLabel: '96→98' }, { value: '5.2×', label: 'ROI', subLabel: '6 个月' }] });
  T.featureGrid(s(), { kicker: 'CAPABILITY', title: '六项能力', items: [1, 2, 3, 4, 5, 6].map((i) => ({ title: `能力 ${i}`, desc: P[i % 2] })) });
  T.dataTable(s(), { kicker: 'DETAIL', title: '投入产出', headers: ['厂区', '产线', '投入'], rows: [['华东', '5', '¥240万'], ['华南', '4', '¥180万']] });
  T.dataFocus(s(), { kicker: 'HEADLINE', label: '耗时下降', number: '82', unit: '%', story: P });
  T.numbersHero(s(), { kicker: 'GLANCE', headline: '一眼看完', numbers: [{ value: '82%', label: '提速' }, { value: '¥680万', label: '节省' }, { value: '5.2×', label: 'ROI' }] });
  T.chartFocus(s(), { kicker: 'TREND', title: '工单时长', chartType: 'line', data: [{ label: '1月', value: 45 }, { label: '2月', value: 38 }, { label: '3月', value: 24 }], unit: 'min' });
  T.contrast(s(), { left: { label: '过去', headline: '经验在人身上', body: P[0] }, right: { label: '现在', headline: '经验在系统里', body: P[1] } });
  T.quotePage(s(), { kicker: 'VOICE', quote: '真正难的不是模型选型。', attribution: '设备科长' });
  T.manifesto(s(), { kicker: 'STANCE', text: '先解决一个真问题, 再谈平台。', attribution: 'MK-CO' });
  T.editorialSplit(s(), { kicker: 'CASE', title: '华东一厂的六个月', body: P });
  T.heroImageQuote(s(), { kicker: 'VOICE', quote: '夜班第一次没打电话给我。', attribution: '设备科长' });
  T.imageGallery(s(), { kicker: 'GALLERY', title: '现场', images: [null, null, null] });
  T.photoSpread(s(), { kicker: 'SPREAD', title: '厂区', images: [null, null, null] });
}

console.log('1. 全模板 × 全风格 · 重叠断言');
for (const spec of Object.values(STYLE.STYLE_SPECS)) {
  warnings.length = 0;
  const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  try {
    await T.withActiveStyle(spec, () => buildAll(ppt));
  } catch (e) {
    fail(`${spec.id} 抛异常: ${e.message}`);
    continue;
  }
  const overlaps = warnings.filter((w) => w.includes('unintended overlap'));
  /* 溢出和重叠是两回事: overlap 断言只管"叠没叠", 内容画到版面外它一个都抓不到。
   * 20 个模板在正常内容下不该有任何一条 —— 有就是模板把内容排到看不见的地方了。 */
  const overflow = warnings.filter((w) => w.includes('画到版面外'));
  if (ppt.slides.length !== 20) fail(`${spec.id} 只画出 ${ppt.slides.length}/20 页`);
  else if (overlaps.length) fail(`${spec.id} 有 ${overlaps.length} 处重叠`);
  else if (overflow.length) fail(`${spec.id} 有内容画到版面外:\n${overflow[0]}`);
  else ok(`${spec.id} · 20 页 · 0 重叠 · 0 溢出`);
}

console.log('2. 图表边界数据');
const chartCases = [
  ['负值混合', { chartType: 'column', data: [{ label: 'A', value: 12 }, { label: 'B', value: -5 }] }],
  ['全负值', { chartType: 'column', data: [{ label: 'A', value: -3 }, { label: 'B', value: -9 }] }],
  ['缺失(null)', { chartType: 'line', categories: ['1', '2', '3'], series: [{ name: 'S', values: [4, null, 6] }] }],
  ['真零与缺失并存', { chartType: 'column', categories: ['1', '2'], series: [{ name: 'S', values: [0, null] }] }],
  ['多系列分组', { chartType: 'column', categories: ['Q1', 'Q2'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [3, 4] }] }],
  ['堆叠', { chartType: 'stacked', categories: ['Q1', 'Q2'], series: [{ name: 'A', values: [1, 2] }, { name: 'B', values: [3, 4] }] }],
  ['单点', { chartType: 'column', data: [{ label: '唯一', value: 7 }] }],
  ['系列长度不齐', { chartType: 'column', categories: ['1', '2', '3'], series: [{ name: 'A', values: [1] }] }],
  ['空数据', { chartType: 'column', data: [] }],
  ['超长数字', { chartType: 'bar', data: [{ label: '很长的类目名称在这里', value: 1234567 }], unit: '人次' }],
];
for (const [name, slots] of chartCases) {
  warnings.length = 0;
  const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  try {
    await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => {
      T.chartFocus(ppt.slides.add(), { title: name, ...slots });
    });
    const overlaps = warnings.filter((w) => w.includes('unintended overlap'));
    if (overlaps.length) fail(`图表「${name}」有重叠`);
    else ok(`图表「${name}」`);
  } catch (e) {
    fail(`图表「${name}」抛异常: ${e.message}`);
  }
}

console.log('3. 导出 XML 的结构不变量 (这些都曾经缺失过)');
{
  const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => {
    T.sectionDivider(ppt.slides.add(), { sectionNumber: '01', title: '标题', subtitle: '副标题' });
    T.chartFocus(ppt.slides.add(), { title: '零值', chartType: 'column', categories: ['A', 'B'], series: [{ name: 'S', values: [0, 5] }] });
  });
  const dir = mkdtempSync(join(tmpdir(), 'neox-verify-'));
  const out = join(dir, 'v.pptx');
  await (await exportPptx(ppt)).save(out);
  /* 不解 zip: 直接在二进制里找特征串会被压缩打散, 所以用 renderer 的 XML 生成器复查 */
  const { writeSlideXml } = await import(pathToFileURL(join(ROOT, '..', 'pptx-renderer', 'dist', 'exporter', 'writeSlide.js')).href);
  const xml1 = writeSlideXml(ppt.model.slides[0], []);
  const xml2 = writeSlideXml(ppt.model.slides[1], []);
  /* 换页动画: StyleSpec.motion 接线前这里一条都没有 */
  if (!xml1.includes('<p:transition')) fail('slide1 缺 <p:transition> (风格动画没接上)');
  else ok('换页动画写进了 XML');
  /* 元素顺序: transition 必须在 clrMapOvr 之后, 否则 PowerPoint 判文件损坏 */
  if (xml1.indexOf('<p:transition') < xml1.indexOf('clrMapOvr')) fail('<p:transition> 位置在 clrMapOvr 之前 (PowerPoint 会拒绝打开)');
  else ok('transition 元素顺序正确');
  /* singleLine → wrap="none": 章节号折行压标题的那个修复 */
  if (!xml1.includes('wrap="none"')) fail('singleLine 没有写成 wrap="none"');
  else ok('singleLine → wrap="none"');
  /* 零值桩: 值是 0 时要画一条 3px 的桩, 否则和"没数据"长得一样 */
  const bars = (xml2.match(/<p:sp>/g) || []).length;
  if (bars < 4) fail(`零值页形状数偏少 (${bars}), 零值桩可能没画`);
  else ok('零值桩存在');
  /* 所有 srgbClr 的 val 必须是 6 位十六进制。rgba(...) 曾经被直塞进去 ——
   * 输出 val="RGBA(250, 250, 250, 0.72)", 渲染器退回黑色, 深底上整行文字隐形。
   * 这一条覆盖全部 20 个模板 (下面用整份 deck 复查), 因为半透明色到处在用。 */
  {
    const full = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    await T.withActiveStyle(STYLE.STYLE_SPECS['bold-ribbon'], () => buildAll(full));
    const bad = new Set();
    for (const sl of full.model.slides) {
      for (const m of writeSlideXml(sl, []).matchAll(/<a:srgbClr val="([^"]*)"/g)) {
        if (!/^[0-9A-Fa-f]{6}$/.test(m[1])) bad.add(m[1]);
      }
    }
    if (bad.size) fail(`srgbClr val 非法 (rgba 没被拆成 alpha): ${[...bad].slice(0, 3).join(' / ')}`);
    else ok('全部 srgbClr val 都是合法的 6 位十六进制');

  {
    const MOTIF = await import(pathToFileURL(join(ROOT, 'dist', 'templates', 'motif-bits.js')).href);
    const bad = [];
    for (const t of [-1, -0.2, 0, 0.5, 1, 1.02, 1.5, 3]) {
      const c = MOTIF.mixHex('#FAF7F1', '#8B0000', t);
      if (!/^#[0-9A-Fa-f]{6}$/.test(c)) bad.push(`t=${t} → ${c}`);
    }
    if (bad.length) fail(`mixHex 越界时吐出非法颜色: ${bad.join(' / ')}`);
    else ok('mixHex 对越界插值系数仍然吐合法颜色 (通道已夹紧)');
  }

  {
    const bad = new Set();
    for (const sid of Object.keys(STYLE.STYLE_SPECS)) {
      for (const inten of ['subtle', 'normal', 'bold']) {
        const p2 = Presentation.create({ slideSize: { width: 1280, height: 720 } });
        await T.withActiveStyle(STYLE.STYLE_SPECS[sid], () => {
          for (const corner of ['tr', 'br', 'bl', 'tl']) {
            T.pageDecor(p2.slides.add(), { intensity: inten, corner, seed: 3 });
          }
        });
        for (const sl of p2.model.slides) {
          for (const m of writeSlideXml(sl, []).matchAll(/<a:srgbClr val="([^"]*)"/g)) {
            if (!/^[0-9A-Fa-f]{6}$/.test(m[1])) bad.add(`${sid}/${inten}: ${m[1]}`);
          }
        }
      }
    }
    if (bad.size) fail(`装饰层 srgbClr 非法: ${[...bad].slice(0, 3).join(' / ')}`);
    else ok('装饰层 4 风格 × 3 强度 × 4 角的颜色全部合法');
  }

  {
    const worst = [];
    for (const sid of Object.keys(STYLE.STYLE_SPECS)) {
      const p3 = Presentation.create({ slideSize: { width: 1280, height: 720 } });
      await T.withActiveStyle(STYLE.STYLE_SPECS[sid], () => {
        T.coverHero(p3.slides.add(), { tag: 'T', title: '标题', subtitle: '副标题' });
        T.sectionDivider(p3.slides.add(), { sectionNumber: '01', title: '章节' });
      });
      for (const sl of p3.model.slides) {
        for (const m of writeSlideXml(sl, []).matchAll(
          /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/g)) {
          const [x, y, w, h] = [1, 2, 3, 4].map((i) => Number(m[i]) / 9525);
          const over = Math.max(-x, -y, x + w - 1280, y + h - 720);
          if (over > 1280 * 0.12) worst.push(`${sid}: 超出 ${Math.round(over)}px`);
        }
      }
    }
    if (worst.length) fail(`装饰出血过量 (>12% 版面): ${[...new Set(worst)].slice(0, 3).join(' / ')}`);
    else ok('封面/章节页的装饰出血都在 12% 以内 (编辑态不会看到悬空形状)');
  }

  /* 【数值形状必须和数值一致】这两条抓的是同一类事故: 图形画出来和数字说的是
   * 反的。overlap 断言看不到, 求解器不管, 肉眼也容易放过 —— 一个 82% 的环
   * 画成 18% 那一段, 谁都不会去量它。 */
  {
    const DV = await import(pathToFileURL(join(ROOT, 'dist', 'templates', 'dataviz-bits.js')).href);
    const bad = [];
    /* frac > 0.5 必须置 large-arc-flag, 否则画的是**补角**那一段 (82% 显示成 18%) */
    for (const [frac, wantLarge] of [[0.18, '0'], [0.49, '0'], [0.51, '1'], [0.82, '1']]) {
      const d = DV.arcPath(120, 12, frac).d;
      const m = d.match(/A[\d.]+,[\d.]+ 0 (\d) 1/);
      if (!m || m[1] !== wantLarge) bad.push(`frac=${frac} large-arc=${m ? m[1] : '?'} 应为 ${wantLarge}`);
    }
    /* frac=1 起终点重合, 单段弧会退化成什么都不画 —— 必须是两段 */
    if ((DV.arcPath(120, 12, 1).d.match(/A/g) ?? []).length !== 2) bad.push('frac=1 没拆成两段半弧');
    if (DV.arcPath(120, 12, 0).d !== '') bad.push('frac=0 应该是空路径');
    if (bad.length) fail(`进度环弧线和数值不一致: ${bad.join(' / ')}`);
    else ok('进度环: 大弧标志/满圈/空圈的边界都和数值一致');
  }

  {
    const bad = [];
    await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => {
      const miss = JSON.stringify(DVB.bulletBar({ value: 214, target: 200, width: 200, lowerIsBetter: true }));
      const hit = JSON.stringify(DVB.bulletBar({ value: 180, target: 200, width: 200, lowerIsBetter: true }));
      if (miss === hit) bad.push('lowerIsBetter 下达标与未达标画得一模一样');
      const up = JSON.stringify(DVB.bulletBar({ value: 214, target: 200, width: 200 }));
      if (up === miss) bad.push('lowerIsBetter 没有改变达标判据');
    });
    if (bad.length) fail(`目标条方向: ${bad.join(' / ')}`);
    else ok('目标条: 越小越好的指标不会被画成达标色');
  }

  {
    /* null = 这期没数据, 折线必须**断开** —— 连过去等于凭空补观测值 */
    let broke = false;
    await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => {
      const withGap = JSON.stringify(DVB.sparkline({ values: [1, 2, null, 8, 9], width: 200, height: 60 }));
      const solid = JSON.stringify(DVB.sparkline({ values: [1, 2, 5, 8, 9], width: 200, height: 60 }));
      const mCount = (s2) => ((s2.match(/M/g) ?? []).length);
      broke = mCount(withGap) > mCount(solid);
    });
    if (!broke) fail('sparkline 把 null 连过去了 (缺数据被画成趋势)');
    else ok('迷你趋势线: null 处折线断开, 没有凭空补观测值');
  }

    /* 文字 run 里不许出现 <a:alpha> —— 三个渲染器三种结果:
     * LibreOffice 吃掉行尾字符 / Keynote 直接忽略 / 预览端按 CSS 画。
     * 而且对比度守卫算的是那个实色, 和画出去的不是一个颜色。
     * 深底上要柔化白字, 用 softInk() 预先合成 (见 motif-bits.ts)。 */
    const alphaRuns = new Set();
    for (const sl of full.model.slides) {
      for (const r of writeSlideXml(sl, []).matchAll(/<a:rPr[^>]*>.*?<\/a:rPr>/gs)) {
        if (r[0].includes('<a:alpha')) alphaRuns.add(r[0].match(/val="([0-9A-Fa-f]{6})"/)?.[1] ?? '?');
      }
    }
    if (alphaRuns.size) fail(`文字 run 带 <a:alpha> (LibreOffice 会截字): ${[...alphaRuns].join(' / ')}`);
    else ok('文字 run 没有 <a:alpha> (半透明白字已合成为实色)');

    /* 预览端: 设了 line-height 的段落必须同时设 font-size。
     * 只设 line-height 的话, 这个块的 strut 会用继承来的默认 16px 字体去算半行距,
     * 行盒被撑高约 20px —— 三行封面标题在预览里多占 60px, 标题记号压到最后一行上,
     * 而导出的 pptx 里没有。行高是"钉死值", 两个渲染器必须给出同一个数。 */
    const { renderSlideToHtml } = await import(
      pathToFileURL(join(ROOT, '..', 'pptx-renderer', 'dist', 'renderer', 'slide-html.js')).href);
    let naked = 0;
    for (const sl of full.model.slides) {
      for (const d of renderSlideToHtml(full.model, sl).matchAll(/<div style="([^"]*line-height:[^"]*)"/g)) {
        if (!/font-size:/.test(d[1])) naked++;
      }
    }
    if (naked) fail(`预览有 ${naked} 个段落只设 line-height 没设 font-size (strut 会把行盒撑高)`);
    else ok('预览端行高与字号成对出现 (行盒高度等于钉死值)');
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('4. 主题字体都有烘焙 metrics');
{
  const { hasFontMetrics } = await import(pathToFileURL(join(ROOT, 'dist', 'layout', 'font-metrics.js')).href);
  for (const spec of Object.values(STYLE.STYLE_SPECS)) {
    const bad = Object.entries(spec.theme.fonts).filter(([, f]) => !hasFontMetrics(f));
    if (bad.length) fail(`${spec.id} 字体缺 metrics: ${bad.map(([r, f]) => `${r}=${f}`).join(', ')}`);
    else ok(`${spec.id} 五个字体齐备`);
  }
}

console.log('5. 正文色对比度 (WCAG AA 4.5)');
{
  const lum = (h) => { const x = h.replace('#', ''); const c = [0, 2, 4].map((i) => { const v = parseInt(x.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const cr = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  /* muted 承载的全是小字 (图注 12pt / 时间轴说明 15pt / KPI 副标 / 图表刻度),
   * 恰恰是最需要对比度的地方 —— minimal-line 的 muted 曾经只有 3.95。 */
  for (const spec of Object.values(STYLE.STYLE_SPECS)) {
    const t = spec.theme;
    for (const [name, fg, bg] of [['muted/paper', t.muted, t.paper], ['ink/paper', t.ink, t.paper], ['onInk/ink', t.onInk, t.ink]]) {
      const v = cr(fg, bg);
      if (v < 4.5) fail(`${spec.id} ${name} 对比度 ${v.toFixed(2)} < 4.5`);
    }
  }
  ok('四套主题的 muted / ink / onInk 都达到 AA');
  /* readableAccent 是深底上 accent 的唯一出口 (封面 kicker / 章节号 / contrast label /
   * KPI 首卡数字 / photoSpread kicker)。它服务的最小字号是 12pt, 门槛就是 4.5。 */
  const M = await import(pathToFileURL(join(ROOT, 'dist', 'templates', 'motif-bits.js')).href);
  for (const spec of Object.values(STYLE.STYLE_SPECS)) {
    await T.withActiveStyle(spec, () => {
      const v = cr(M.readableAccent(spec.theme.ink), spec.theme.ink);
      if (v < 4.5) fail(`${spec.id} readableAccent(ink) 对比度 ${v.toFixed(2)} < 4.5`);
    });
  }
  ok('readableAccent 在四套 ink 底上都达到 AA');
  for (const spec of Object.values(STYLE.STYLE_SPECS)) {
    await T.withActiveStyle(spec, () => {
      for (const [alpha, where] of [[0.62, '页脚 11pt'], [0.7, 'KPI 副标 12pt'],
                                    [0.72, '深区 muted 16pt'], [0.86, 'contrast 正文 16pt']]) {
        const v = cr(M.softInk(alpha), spec.theme.ink);
        if (v < 4.5) fail(`${spec.id} softInk(${alpha}) [${where}] 对比度 ${v.toFixed(2)} < 4.5`);
      }
    });
  }
  ok('softInk 的四档柔化白字在四套 ink 底上都达到 AA');
  for (const spec of Object.values(STYLE.STYLE_SPECS)) {
    await T.withActiveStyle(spec, () => {
      for (const n of [2, 3, 4, 5, 6]) {
        const a = M.__seriesPaletteAudit(n);
        const adj = Math.min(...a.adjacent);
        const paper = Math.min(...a.vsPaper);
        if (adj < 2.0) fail(`${spec.id} ${n} 系列相邻对比度 ${adj} < 2.0 (两条折线会分不出)`);
        if (paper < 1.6) fail(`${spec.id} ${n} 系列有颜色 vs 纸底 ${paper} < 1.6 (浅底上会消失)`);
      }
    });
  }
  ok('四套风格 × 2~6 系列的配色: 相邻 ≥ 2.0 · vs 纸底 ≥ 1.6');
}

console.log('6. 极端输入 (真实使用里最容易崩的地方)');
{
  const LONG = '国产大规模预训练语言模型在离散制造业典型场景中的规模化落地路径与分阶段实施方案研究';
  const PARA = '大模型不是替换现有系统，而是补上人机之间那层一直缺的翻译。'.repeat(4);
  const MIX = 'Q3-Q4 AI-Ops Copilot 上线 & RAG 检索增强 (MTTR ↓62%)';
  const extreme = [
    ['超长封面标题', (s) => T.coverHero(s, { tag: LONG, title: LONG, subtitle: LONG })],
    ['章节页长标题', (s) => T.sectionDivider(s, { sectionNumber: 'PART 07', title: LONG, subtitle: LONG })],
    ['要点 8 条长文', (s) => T.bulletList(s, { title: LONG, items: Array.from({ length: 8 }, () => LONG.slice(0, 40)) })],
    ['KPI 8 张卡', (s) => T.kpiCards(s, { title: LONG, cards: Array.from({ length: 8 }, () => ({ value: '¥1,280万', label: LONG.slice(0, 12), subLabel: LONG.slice(0, 20) })) })],
    ['表格 8 行 6 列', (s) => T.dataTable(s, { title: LONG, headers: ['厂区', '产线', '投入', '周期', '负责人', '备注'], rows: Array.from({ length: 8 }, () => ['华东第一制造基地', '12', '¥2,480万', '5 个月', '张工', '已完成一期改造']) })],
    ['图表 12 类目', (s) => T.chartFocus(s, { title: LONG, chartType: 'column', data: Array.from({ length: 12 }, (_, i) => ({ label: `第 ${i + 1} 季度`, value: (i * 7) % 50 + 3 })) })],
    ['图表 5 系列', (s) => T.chartFocus(s, { title: LONG, chartType: 'column', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: Array.from({ length: 5 }, (_, i) => ({ name: LONG.slice(0, 8) + i, values: [1 + i, 3 + i, 5 + i, 7 + i] })) })],
    ['中英混排', (s) => T.titleBody(s, { kicker: 'AI-OPS · RAG', title: MIX, body: [MIX + ' ' + MIX] })],
    ['空字符串', (s) => T.titleBody(s, { kicker: '', title: '', body: [''] })],
    ['单字标题', (s) => T.coverHero(s, { title: '一' })],
  ];
  let extremeBad = 0;
  for (const [name, fn] of extreme) {
    warnings.length = 0;
    const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    try {
      await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => fn(ppt.slides.add()));
      const o = warnings.filter((w) => w.includes('unintended overlap'));
      if (o.length) { fail(`极端输入「${name}」有重叠`); extremeBad++; }
    } catch (e) { fail(`极端输入「${name}」抛异常: ${e.message}`); extremeBad++; }
  }
  if (extremeBad === 0) ok(`${extreme.length} 种极端输入全部无重叠无异常`);
}

console.log('7. 文本测量精度 (对着 LibreOffice 实测宽度)');
{
  const fx = JSON.parse(readFileSync(join(ROOT, 'scripts', 'text-metrics-fixture.json'), 'utf8'));
  const { measureText } = await import(pathToFileURL(join(ROOT, 'dist', 'layout', 'text-metrics.js')).href);
  const LOW = -0.01, HIGH = 0.13;
  let worstLow = 0, worstHigh = 0, bad = 0;
  for (const c of fx.cases) {
    const p = measureText(c.text, c.fontSizePt, Infinity,
      { singleLine: true, fontLatin: c.fontLatin, fontEast: c.fontEast }).width;
    const e = (p - c.inkWidthPx) / c.inkWidthPx;
    if (e < worstLow) worstLow = e;
    if (e > worstHigh) worstHigh = e;
    if (e < LOW) { fail(`测量偏窄 (会溢出): ${c.id} / ${c.fontLatin}+${c.fontEast} ${(e * 100).toFixed(1)}%`); bad++; }
    else if (e > HIGH) { fail(`测量偏宽 (提前折行): ${c.id} / ${c.fontLatin}+${c.fontEast} ${(e * 100).toFixed(1)}%`); bad++; }
  }
  if (!bad) ok(`${fx.cases.length} 组字体×脚本组合都在 [${LOW * 100}%, ${HIGH * 100}%] 内 `
    + `(最窄 ${(worstLow * 100).toFixed(1)}% · 最宽 ${(worstHigh * 100).toFixed(1)}%)`);
}

console.log('8. 导出 pptx 的结构合法性 (PowerPoint 严格 · LibreOffice 宽容)');
{
  /* 【为什么要有这一节】排版问题看图能发现, **结构问题看不出来**:
   * LibreOffice 会容忍很多不合规的东西, 而 PowerPoint 直接拒绝打开。
   * 这仓库已经栽过一次 —— p:transition 放在 clrMapOvr 之前, LO 照常渲染,
   * PowerPoint 报文件损坏。那种 bug 靠"逐页看图"永远发现不了。 */
  const { default: JSZip } = await import('jszip');
  const ppt = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => buildAll(ppt));
  const dir = mkdtempSync(join(tmpdir(), 'neox-struct-'));
  const out = join(dir, 's.pptx');
  await (await exportPptx(ppt)).save(out);
  const zip = await JSZip.loadAsync(readFileSync(out));
  /* zip 里的目录条目不是部件 —— 不排除掉会报一堆假问题 */
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));
  const read = async (n) => (zip.files[n] ? await zip.files[n].async('string') : '');
  const norm = (base, target) => {
    const parts = (base ? base.split('/') : []).concat(target.split('/'));
    const st = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') st.pop(); else st.push(p);
    }
    return st.join('/');
  };
  const problems = [];
  const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));

  for (const n of slides) {
    const xml = await read(n);
    /* rId 必须在同名 .rels 里声明 */
    const relsName = `ppt/slides/_rels/${n.split('/').pop()}.rels`;
    const rels = await read(relsName);
    const have = new Set([...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of xml.matchAll(/r:(?:id|embed|link)="([^"]+)"/g)) {
      if (!have.has(m[1])) problems.push(`${n} 引用了未声明的 rId ${m[1]}`);
    }
    /* shape id 不能重复, 也不能是 0 (PowerPoint 会报文件损坏) */
    const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    const seen = new Set(); const dup = new Set();
    for (const i of ids) { if (seen.has(i)) dup.add(i); seen.add(i); }
    if (dup.size) problems.push(`${n} 有重复 shape id: ${[...dup].join(',')}`);
    if (ids.includes('0')) problems.push(`${n} 有 id=0 的 shape`);
    /* transition 必须排在 clrMapOvr 之后 —— 放错 PowerPoint 拒绝打开 */
    if (xml.includes('<p:transition')) {
      if (!xml.includes('<p:clrMapOvr')) problems.push(`${n} 有 transition 却没有 clrMapOvr`);
      else if (xml.indexOf('<p:transition') < xml.indexOf('<p:clrMapOvr')) {
        problems.push(`${n} transition 排在 clrMapOvr 之前 (PowerPoint 会拒绝打开)`);
      }
    }
  }
  /* 所有 .rels 的 Target 必须真实存在 */
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const ownerDir = n.split('/').slice(0, -2).join('/');
    for (const m of (await read(n)).matchAll(/<Relationship\b[^>]*>/g)) {
      if (m[0].includes('TargetMode="External"')) continue;
      const t = /Target="([^"]+)"/.exec(m[0]);
      if (t && !names.includes(norm(ownerDir, t[1]))) problems.push(`${n} 指向不存在的部件 ${t[1]}`);
    }
  }
  /* [Content_Types] 必须覆盖每个部件 */
  const ct = await read('[Content_Types].xml');
  const defaults = new Set([...ct.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/PartName="([^"]+)"/g)].map((m) => m[1]));
  for (const n of names) {
    if (n === '[Content_Types].xml' || n.endsWith('.rels')) continue;
    const ext = n.split('.').pop().toLowerCase();
    if (!overrides.has(`/${n}`) && !defaults.has(ext)) problems.push(`${n} 没有 content-type 声明`);
  }
  /* presentation.xml 的每个 sldId 都要解析到真实 slide */
  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  const tgt = new Map([...presRels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  for (const m of pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
    const t = tgt.get(m[1]);
    if (!t || !names.includes(norm('ppt', t))) problems.push(`sldId ${m[1]} 解析不到 slide`);
  }

  {
    const { writeSlideXml: wsx } = await import(
      pathToFileURL(join(ROOT, '..', 'pptx-renderer', 'dist', 'exporter', 'writeSlide.js')).href);
    const evil = Presentation.create({ slideSize: { width: 1280, height: 720 } });
    const CTRL = '\u0007\u001F\u000B';
    const INJECT = '</a:t></a:r><a:r><a:t>INJECTED';
    const EMOJI = '\u2705\u{1F6A7}\u{1D400}';   /* 合法字符, 不能被误删 */
    await T.withActiveStyle(STYLE.STYLE_SPECS['corporate-chevron'], () => {
      T.bulletList(evil.slides.add(), {
        kicker: `R&D <${CTRL}>`, title: `特殊字符 & 转义 ${INJECT}`,
        items: [`控制字符 a${CTRL}b`, INJECT, EMOJI, 'x]]> y'],
      });
      T.dataTable(evil.slides.add(), {
        title: `表格 & <${CTRL}>`, headers: ['名称', '值 & 单位'],
        rows: [[`a${CTRL}b`, INJECT], [EMOJI, 'x]]> y']],
      });
    });
    const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
    for (const sl of evil.model.slides) {
      const xml = wsx(sl, []);
      if (ILLEGAL.test(xml)) problems.push('导出的 XML 里有 XML 1.0 非法字符 (控制字符没被剔除)');
      if (xml.includes('<a:t></a:t></a:r><a:r><a:t>INJECTED')) problems.push('XML 注入没被转义');
      for (const ch of [...EMOJI]) if (!xml.includes(ch)) problems.push(`合法字符 ${ch} 被误删`);
    }
  }

  if (problems.length) {
    fail(`pptx 结构有 ${problems.length} 处问题:\n    ${problems.slice(0, 5).join('\n    ')}`);
  } else {
    ok(`${slides.length} 页 · ${names.length} 个部件 · rels/content-types/shape-id/transition 顺序 · `
      + `对抗性文本 (控制字符/XML 注入/emoji) 全部合法`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.warn = realWarn;
console.log(failures === 0
  ? '\n全部通过。注意: 这个脚本判不了"好不好看" —— 排版仍需导出 PDF 逐页看。'
  : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
