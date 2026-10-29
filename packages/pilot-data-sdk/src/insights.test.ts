import { describe, expect, it } from 'vitest';
import { analyze, expenseCategory, ROOMS, roomOf, summarizeRooms, type Insight } from './insights.js';
import { demoLife } from './demoLife.js';

const TODAY = '2026-10-11';

describe('洞察: 一年多的仿真生活里, 埋下的事都要被发现', () => {
  const { records, facts } = demoLife(TODAY);
  const found = analyze(records, { today: TODAY, facts });
  const get = (id: string) => found.find(i => i.id === id);

  it('打印给人看 (检查口吻)', () => {
    for (const i of found) console.log(`[${i.tone}] ${i.score.toFixed(2)} ${i.title} —— ${i.detail}${i.suggestion ? ` → ${i.suggestion}` : ''}`);
    expect(found.length).toBeGreaterThan(8);
  });

  it('钱: 花得快、哪一类多了、固定扣款、快扣款、大额、心情消费、存钱', () => {
    expect(get('money.pace')?.tone).toBe('watch');
    expect(get('money.category')?.title).toMatch(/吃饭/);
    const rec = get('money.recurring')!;
    expect(rec.detail).toMatch(/房租/);
    expect(rec.detail).toMatch(/爱奇艺/);
    expect(rec.detail).toMatch(/网易云/);
    expect(rec.detail).not.toMatch(/美团|瑞幸/);
    expect(get('money.recurring.soon')?.title).toMatch(/网易云.*2 天后|网易云/);
    expect(get('money.big')?.detail).toMatch(/Apple Store/);
    expect(get('cross.mood_spend')).toBeTruthy();
    expect(get('money.savings')).toBeTruthy();
  });

  it('身体 / 心情 / 交叉', () => {
    const w = get('body.weight')!;
    expect(w.tone).toBe('good');
    expect(Number(w.numbers?.perWeek)).toBeLessThan(-0.2);
    expect(w.suggestion).toMatch(/周到目标/);
    const s = get('body.sleep')!;
    expect(s.tone).toBe('watch');
    expect(s.detail).toMatch(/晚了/);
    expect(get('cross.sleep_mood')).toBeTruthy();
    expect(get('mood.low')).toBeTruthy();
  });

  it('人 / 习惯 / 地方', () => {
    expect(found.find(i => i.id === 'social.drift:妈妈')?.title).toBe('42 天没和妈妈联系了'); // 最后一次 08-30
    expect(found.find(i => i.id === 'social.drift:小王')).toBeUndefined();
    expect(found.find(i => i.id === 'habit.streak:跑步')?.title).toBe('跑步连续 13 天');
    expect(found.find(i => i.id === 'habit.broken:背单词')?.title).toBe('背单词断了 3 天');
    expect(get('place.new')?.detail).toMatch(/莫干山/);
  });

  it('能办的事带一键动作: 睡前提醒 / 提醒打电话 / 补打卡 / 交给 Pilot', () => {
    expect(get('body.sleep')?.action).toMatchObject({ kind: 'remind', at: '23:30' });
    expect(found.find(i => i.id === 'social.drift:妈妈')?.action).toMatchObject({ kind: 'remind', at: '20:00' });
    expect(found.find(i => i.id === 'habit.broken:背单词')?.action).toMatchObject({ kind: 'checkin', habit: '背单词' });
    expect(found.find(i => i.id === 'habit.streak:跑步')?.action).toMatchObject({ kind: 'checkin', label: '打卡，第 14 天' });
    expect(get('money.recurring.soon')?.action?.kind).toBe('ask');
  });

  it('他说最关心什么, 同样要紧时先说什么', () => {
    const a = analyze(records, { today: TODAY, facts: { ...facts, 'pilot.focus': ['habit'] } });
    const b = analyze(records, { today: TODAY, facts });
    const rank = (xs: Insight[]) => xs.findIndex(i => i.id === 'habit.broken:背单词');
    expect(rank(a)).toBeLessThan(rank(b));
  });

  it('日子: 妈妈生日 / 重阳节 (因为有妈妈) / 纪念日提前 / 每周日打电话; 七夕不提 (没对象)', () => {
    const b = found.find(i => i.id === 'day.birthday:妈妈')!;
    expect(b.title).toBe('妈妈生日还有 3 天');
    expect(b.detail).toMatch(/桂花糕/);
    expect(b.action?.kind).toBe('ask');
    expect(found.find(i => i.id === 'day.holiday:重阳节')?.title).toBe('重阳节还有 7 天 · 妈妈');
    expect(found.find(i => i.id.startsWith('day.trigger:恋爱纪念日'))?.title).toBe('9 天后：恋爱纪念日，提前订餐厅');
    expect(found.find(i => i.id.startsWith('day.trigger:给爸妈打电话'))?.action).toMatchObject({ kind: 'remind', at: '20:00' });
    expect(found.find(i => i.id.startsWith('day.trigger:前台拿快递'))).toBeUndefined();
    /* 换个日子: 8 月 14 号没对象的人不提七夕 */
    expect(analyze(records, { today: '2026-08-14', facts }).find(i => i.id === 'day.holiday:七夕')).toBeUndefined();
    expect(analyze(records, { today: '2026-08-14', facts: { ...facts, 'person.小雨.relation': '女朋友' } }).find(i => i.id === 'day.holiday:七夕')?.title).toBe('七夕还有 5 天 · 小雨');
  });

  it('家 / 钱 / 身体的新房间: 电费高了、账单快到期、车险 23 天、净资产、运动、体检', () => {
    expect(found.find(i => i.id === 'home.bill.up:electric')?.title).toMatch(/^电费比平时多/);
    const due = found.filter(i => i.id.startsWith('home.bill.due:'));
    expect(due).toHaveLength(1);
    expect(due[0].title).toBe('4 张账单 4 天后到期');
    expect(due[0].detail).toMatch(/电费 ¥\d+.*共 ¥/);
    expect(due[0].action).toMatchObject({ kind: 'remind' });
    expect(get('money.recurring')?.detail).not.toMatch(/便利蜂/);
    expect(found.find(i => i.id === 'home.expire:vehicle.小白.insurance_due')?.title).toBe('小白保险还有 23 天到期');
    expect(found.find(i => i.id === 'home.expire:me.passport_expire')).toBeUndefined(); // 还早
    expect(get('money.networth')).toBeTruthy();
    expect(get('body.workout.week')?.title).toMatch(/这周练了 \d 次/);
    expect(get('body.report')?.detail).toMatch(/尿酸偏高/);
  });

  it('八个房间的摘要: 每个房间的大数和清单都算得出来', () => {
    const s = summarizeRooms(records, { today: TODAY, facts });
    expect(s.body.weight).toBeGreaterThan(70);
    expect(s.body.workoutsWeek).toBeGreaterThanOrEqual(5);
    expect(s.money.netWorth).toBeGreaterThan(2_000_000);
    expect(s.money.accounts.map(a => a.name)).toContain('房贷');
    expect(s.money.subscriptions.map(x => x.name)).toEqual(expect.arrayContaining(['房租', '爱奇艺']));
    expect(s.home.bills.find(b => b.kind === 'electric')).toMatchObject({ label: '电费', paid: false });
    expect(s.home.vehicles[0]).toMatchObject({ name: '小白', model: '比亚迪海豚' });
    expect(s.home.vehicles[0].items[0]).toMatchObject({ what: '保险', days: 23 });
    expect(s.people.list[0]).toMatchObject({ name: '妈妈', birthdayInDays: 3, likes: '桂花糕和越剧' });
    expect(s.place.places.map(p => p.name)).toContain('西湖');
    expect(s.work.job).toBe('产品经理');
    expect(s.me.facts.map(f => f.key)).toContain('me.likes.food');
    /* 场景的数: 柱子 / 硬币堆 / 存钱罐 / 地图 */
    const ms = s.money.scene;
    expect(ms.months).toHaveLength(6);
    expect(ms.months[5].ym).toBe('2026-10');
    expect(ms.usualMonth).toBeGreaterThan(6000);
    expect(ms.pace).toBeGreaterThan(1.5);
    expect(ms.savingsRate).toBeGreaterThan(0.3);
    expect(ms.netWorth.length).toBeGreaterThanOrEqual(5);
    expect(s.body.scene.goal).toBe(70);
    expect(s.body.scene.sleep7).toHaveLength(7);
    const ps = s.place.scene;
    expect(ps.pins.map(p => p.name)).toEqual(expect.arrayContaining(['西湖', '宽窄巷子', '外婆家']));
    expect(ps.route.at(-1)?.name).toBeTruthy();
    expect(ps.home).toEqual({ lat: 31.22, lng: 121.445 });
    expect(s.me.knowledge.length).toBe(3);
    /* 洞察都能归到房间 */
    for (const i of found) expect(ROOMS.map(r => r.id)).toContain(roomOf(i));
  });

  it('数据不够时不乱说', () => {
    const few = records.filter(r => r.day >= '2026-10-05');
    const quiet = analyze(few, { today: TODAY });
    expect(quiet.find(i => i.id === 'money.pace')).toBeUndefined();
    expect(quiet.find(i => i.id === 'cross.sleep_mood')).toBeUndefined();
    expect(quiet.find(i => i.id === 'money.recurring')).toBeUndefined();
    expect(analyze([], { today: TODAY })).toEqual([]);
  });

  it('预算: 照速度会超就算出每天还能花多少', () => {
    const b = analyze(records, { today: TODAY, facts: { 'budget.monthly': 6000 } }).find(i => i.id === 'money.budget') as Insight;
    expect(b.tone).toBe('watch');
    expect(b.suggestion).toMatch(/每天控制在|已经超了/);
  });

  it('分类兜底', () => {
    expect(expenseCategory({ type: 'finance.expense', occurred_at: 0, day: TODAY, title: '支出 taxi', data: { category: 'taxi' } })).toBe('交通');
    expect(expenseCategory({ type: 'finance.expense', occurred_at: 0, day: TODAY, data: { merchant: '瑞幸咖啡' } })).toBe('吃饭');
  });
});
