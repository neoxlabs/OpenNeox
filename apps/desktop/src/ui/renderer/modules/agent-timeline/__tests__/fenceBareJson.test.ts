import { describe, it, expect } from 'vitest';
import { fenceBareJson } from '../fenceBareJson';

const REQ = JSON.stringify([
  {
    domain: 'auth',
    requirements: [
      {
        title: '用户与角色数据模型 + scrypt 密码哈希',
        detail: '实体 User: {id, username, role, status:"active"|"disabled"}; 密码绝不落明文。',
        acceptance: 'node --test 断言: createUser 重复用户名抛 DUPLICATE',
        dependsOn: ['REQ-A1'],
      },
    ],
  },
]);

describe('fenceBareJson', () => {
  it('把裸 JSON 数组包成 json 代码块', () => {
    const out = fenceBareJson(`现按7视角逐域深挖完毕, 输出最终需求 JSON。\n\n${REQ}\n`);
    expect(out).toContain('```json');
    expect(out).toContain('现按7视角逐域深挖完毕');
    const body = out.split('```json\n')[1].split('\n```')[0];
    expect(JSON.parse(body)).toHaveLength(1);
  });

  it('⭐️ 从中间开始的 JSON 碎片也要包起来', () => {
    const frag = 'worker_model":"deepseek-v4-flash","model_source":"configured","model_kind":"byok"'
      + ',"sources":306,"domains":197,"claims":637,"supported":211,"singleSource":352'
      + ',"disputed":74,"unverified":0,"archivedChars":2679107,"stopReason":"worker-cap"';
    const out = fenceBareJson(`这是本次调用的回执原文：\n\n${frag}\n`);
    expect(out).toContain('```json');
    expect(out).toContain('这是本次调用的回执原文');
  });

  it('⚠️ 碎片兜底不误伤中文正文 —— 引号少、冒号少的段落一律不动', () => {
    const prose = '这一轮的结论是：折叠屏目前只占全球手机销量约 2%~3%，且以亚洲为主。'.repeat(6)
      + '苹果是最后一个入场的头部玩家，它的首批机构预期与首批口碑已经出现高度分歧。';
    expect(fenceBareJson(prose)).toBe(prose);
  });

  it('⚠️ 带少量引用的长段落也不动 —— 判据要的是 "key": 的密度, 不是有没有引号', () => {
    const src = '官方新闻稿只写 "minimizes crease visibility"，"平整光滑" 出自产品页而非新闻稿；'
      + '中文区与英文区引用的是同一批现场素材，两边的差异来自拍摄角度而不是结论本身。'.repeat(3);
    expect(fenceBareJson(src)).toBe(src);
  });

  it('已经有围栏的不重复包', () => {
    const src = `看结果:\n\n\`\`\`json\n${REQ}\n\`\`\`\n`;
    expect(fenceBareJson(src)).toBe(src);
  });

  it('正文里的花括号/短对象不动', () => {
    for (const src of [
      '路径写成 {workspace}/finance/ledger.js 即可, 不要硬编码绝对路径。',
      '返回 {"ok": true} 就算通过。',
      '实体 User: {id, username, role} —— 这一行只是描述, 不是 JSON。',
    ]) {
      expect(fenceBareJson(src)).toBe(src);
    }
  });

  it('解析不了但明摆着是 JSON (中段被结果卡掐掉) → 原样进代码块, 不重排', () => {
    const truncated = `[{"domain":"auth","requirements":[\n{"title":"${'长'.repeat(60)}","detail":"d","acceptance":"a"}\n[...output truncated — skipped 4766 chars from middle.]\n{"title":"t2","detail":"d","acceptance":"a"}\n]}]`;
    const out = fenceBareJson(`现按7视角逐域深挖完毕。\n\n${truncated}`);
    expect(out).toContain('```json');
    expect(out).toContain('output truncated');
    expect(out).toContain('现按7视角逐域深挖完毕');
  });

  it('形状不像 JSON 的长段落不动 (免得把正文吃进代码块)', () => {
    const src = `{注意: 这一段是中文说明, 里面有冒号和"引号", 但它不是 JSON。${'详述内容。'.repeat(40)}}`;
    expect(fenceBareJson(src)).toBe(src);
  });

  it('流式未闭合时也先按代码块渲染', () => {
    const half = REQ.slice(0, 200);
    expect(fenceBareJson(`输出:\n\n${half}`, true)).toContain('```json');
    expect(fenceBareJson(`输出:\n\n${half}`, false)).not.toContain('```json');
  });

  it('外层不闭合时整段不动, 绝不退化成逐个小对象包框', () => {
    const chopped = `输出最终需求 JSON。\n[{"domain":"auth","requirements":[\n${JSON.stringify({ title: 'x'.repeat(150), detail: 'd', acceptance: 'a' })},\n${JSON.stringify({ title: 'y'.repeat(150), detail: 'd', acceptance: 'a' })}`;
    expect(fenceBareJson(chopped)).toBe(chopped);
  });

  it('包起来时重排缩进', () => {
    const out = fenceBareJson(`结果:\n${REQ}`);
    expect(out).toContain('```json\n[\n  {\n');
  });

  it('多段裸 JSON 各包各的, 中间文字保留', () => {
    const out = fenceBareJson(`第一域:\n${REQ}\n中间说明\n${REQ}\n收尾`);
    expect(out.match(/```json/g)).toHaveLength(2);
    expect(out).toContain('中间说明');
    expect(out).toContain('收尾');
  });
});
