/**
 * 一个普通人一年多的生活流水 (仿真, 固定种子): 测洞察准不准、给演示账号铺数据用。不进 SDK 导出。
 *
 * 小林, 29 岁, 上海上班族。埋了这些「该被发现的事」:
 *   钱   每月 1 号房租 3500 / 5 号话费 58 / 13 号网易云 15 / 18 号爱奇艺 25; 10 号发工资 15000;
 *        这个月外卖和下馆子明显多了; 10-07 买了台 6999 的手机; 心情差的日子会网购
 *   身体 7 月中起体重每周掉 0.35 kg (目标 70); 最近一周熬夜, 一点多才睡、只睡 5 个多小时
 *   心情 跟睡眠挂钩; 周一最低; 最近两周整体偏低
 *   人   妈妈平时一周一个电话, 9 月初以后没打; 小王两周见一次, 一直在见
 *   习惯 跑步从 9-28 起天天跑; 背单词连了一个多月, 10-08 起断了
 *   地方 国庆去了莫干山、西湖、乌镇
 */

export type DemoRecord = {
  type: string;
  occurred_at: number;
  ended_at?: number;
  day: string;
  tz: string;
  value?: number;
  unit?: string;
  title: string;
  data: Record<string, unknown>;
};

const TZ = 'Asia/Shanghai';

/** 仿真地点的坐标 (大致即可) */
const PLACES: Record<string, [number, number]> = {
  '静安大悦城': [31.2436, 121.4590], '外婆家': [31.1890, 121.4370], '前滩太古里': [31.1555, 121.4710],
  '莫干山': [30.6090, 119.8790], '西湖': [30.2460, 120.1540], '乌镇': [30.7440, 120.4870],
  '宽窄巷子': [30.6640, 104.0560], '大熊猫基地': [30.7330, 104.1460], '平江路': [31.3170, 120.6300], '迪士尼': [31.1440, 121.6570],
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 上海当地 y-m-d h:mi → 毫秒 */
const at = (day: string, h: number, mi = 0) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h, mi) - 8 * 3600_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function demoLife(today = '2026-10-11', start = '2025-08-01'): { records: DemoRecord[]; facts: Record<string, unknown> } {
  const r = rng(20261011);
  const out: DemoRecord[] = [];
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const between = (a: number, b: number) => a + r() * (b - a);
  const money = (v: number) => Math.round(v * 10) / 10;
  const spend = (day: string, h: number, v: number, merchant: string, category: string) =>
    out.push({ type: 'finance.expense', occurred_at: at(day, h, Math.floor(r() * 59)), day, tz: TZ, value: money(v), unit: 'CNY', title: `支出 ${category}`, data: { currency: 'CNY', category, merchant } });

  const todayNo = Date.parse(`${today}T00:00:00Z`);
  const daysAgo = (day: string) => Math.round((todayNo - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  let weight = 76.2;

  for (let day = start; day <= today; day = addDays(day, 1)) {
    const ago = daysAgo(day);
    const dom = +day.slice(8, 10);
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 周日
    const weekend = wd === 0 || wd === 6;
    const holiday = day >= '2026-10-01' && day <= '2026-10-07';
    const thisMonth = day.slice(0, 7) === today.slice(0, 7);

    // ── 固定收支 ──
    if (dom === 1) spend(day, 9, 3500, '房租', '居家');
    if (dom === 5) spend(day, 10, 58, '中国移动', '居家');
    if (dom === 13 && day !== today) spend(day, 8, 15, '网易云音乐', '其它');
    if (dom === 18) spend(day, 8, 25, '爱奇艺', '其它');
    if (dom === 10) out.push({ type: 'finance.income', occurred_at: at(day, 10), day, tz: TZ, value: 15000, unit: 'CNY', title: '收入 工资', data: { currency: 'CNY', category: '工资' } });

    // ── 睡眠 (醒来那天记) ──
    let bedH: number, sleepMin: number;
    if (ago < 7) { bedH = between(24.9, 25.6); sleepMin = between(320, 360); }
    else if (weekend) { bedH = between(23.8, 24.8); sleepMin = between(450, 520); }
    else { bedH = between(23.4, 24.4); sleepMin = between(380, 460); }
    if (r() < 0.85) {
      const prev = addDays(day, -1);
      const bed = at(prev, 0) + Math.round(bedH * 60) * 60_000;
      out.push({ type: 'health.sleep', occurred_at: bed, ended_at: bed + Math.round(sleepMin) * 60_000, day, tz: TZ, value: Math.round(sleepMin), unit: 'min', title: '睡眠', data: {} });
    }

    // ── 心情: 跟睡眠挂钩, 周一低, 最近两周低 ──
    let mood = 3.4 + (sleepMin >= 420 ? 0.7 : sleepMin < 390 ? -0.6 : 0) + (wd === 1 ? -1.0 : 0) + (weekend ? 0.3 : 0) + (ago < 14 ? -0.7 : 0) + between(-0.5, 0.5);
    mood = Math.max(1, Math.min(5, Math.round(mood)));
    if (r() < 0.75) out.push({ type: 'mood', occurred_at: at(day, 21, 30), day, tz: TZ, value: mood, unit: '/5', title: `心情 ${mood}/5`, data: { score: mood } });

    // ── 吃喝 ──
    const food = thisMonth ? 1.7 : 1;
    if (!weekend && !holiday) {
      if (r() < 0.6) spend(day, 9, between(13, 19), '瑞幸咖啡', '吃饭');
      spend(day, 12, between(24, 40) * (thisMonth ? 1.3 : 1), '美团外卖', '吃饭');
      if (r() < 0.75) spend(day, 19, between(25, 55) * food, pick(['美团外卖', '便利蜂', '盒马']), '吃饭');
      spend(day, 8, 4, '上海地铁', '交通');
      if (r() < 0.18) spend(day, 22, between(20, 45), '滴滴出行', '交通');
    } else {
      if (r() < (thisMonth ? 0.9 : 0.6)) spend(day, 18, between(80, 220) * food, pick(['海底捞', '西贝', '外婆家', '日料小馆']), '吃饭');
      if (r() < 0.3) spend(day, 15, between(60, 300), pick(['淘宝', '京东', '优衣库']), pick(['购物', '购物', '衣着']));
    }
    // 心情差的日子网购
    if (mood <= 2 && r() < 0.65) spend(day, 23, between(150, 420), pick(['淘宝', '京东', '拼多多']), '购物');
    if (day === '2026-10-07') spend(day, 15, 6999, 'Apple Store', '购物');
    if (holiday && day >= '2026-10-03' && day <= '2026-10-05') spend(day, 13, between(150, 400), pick(['景区门票', '民宿', '农家菜']), pick(['其它', '居家', '吃饭']));

    // ── 体重 (7 月中开始称, 每周掉 0.35) ──
    if (day >= '2026-07-15') {
      weight -= 0.35 / 7;
      if (r() < 0.7) out.push({ type: 'health.weight', occurred_at: at(day, 7, 30), day, tz: TZ, value: Math.round((weight + between(-0.3, 0.3)) * 10) / 10, unit: 'kg', title: '体重', data: {} });
    }

    // ── 人 ──
    if (day <= '2026-09-05' && wd === 0) out.push({ type: 'social.interaction', occurred_at: at(day, 20), day, tz: TZ, title: '和 妈妈', data: { with: ['妈妈'], channel: 'call' } });
    if (ago % 14 === 3) out.push({ type: 'social.interaction', occurred_at: at(day, 19), day, tz: TZ, title: '和 小王', data: { with: ['小王'], channel: 'meet' } });

    if (day >= '2026-09-28' && day < today) {
      out.push({ type: 'habit.check', occurred_at: at(day, 7), day, tz: TZ, value: 1, unit: 'times', title: '打卡 跑步', data: { habit: '跑步', done: true } });
      out.push({ type: 'fitness.workout', occurred_at: at(day, 7), day, tz: TZ, value: Math.round(between(28, 42)), unit: 'min', title: '运动 跑步', data: { kind: 'run', distanceKm: Math.round(between(4, 6.5) * 10) / 10 } });
    } else if (day >= '2026-07-01' && (wd === 2 || wd === 4) && r() < 0.8) {
      out.push({ type: 'fitness.workout', occurred_at: at(day, 19, 30), day, tz: TZ, value: Math.round(between(45, 70)), unit: 'min', title: '运动 健身房', data: { kind: 'gym' } });
    }

    // ── 家: 每月账单 (10 号出, 20 号前交); 电费夏天高, 这个月 (空调没关) 也高 ──
    if (dom === 10 && day.slice(0, 7) >= '2025-09') {
      const m = +day.slice(5, 7);
      const period = addDays(day, -15).slice(0, 7);
      const bill = (kind: string, v: number, payee: string) => out.push({
        type: 'bill', occurred_at: at(day, 9), day, tz: TZ, value: Math.round(v * 10) / 10, unit: 'CNY', title: `账单 ${kind}`,
        data: { kind, currency: 'CNY', period, due: `${day.slice(0, 8)}15`, paid: thisMonth ? false : true, payee },
      });
      const summer = m >= 7 && m <= 9;
      bill('electric', thisMonth ? between(430, 470) : summer ? between(260, 320) : between(120, 160), '国网上海');
      bill('water', between(38, 55), '上海城投水务');
      bill('gas', m <= 3 || m >= 12 ? between(90, 130) : between(35, 55), '上海燃气');
      bill('internet', 99, '中国电信宽带');
    }

    // ── 钱: 每月 15 号记一次各账户余额 (工资进储蓄, 基金涨跌, 房贷每月少一点) ──
    if (dom === 15 && day.slice(0, 7) >= '2026-03') {
      const k = (+day.slice(0, 4) - 2026) * 12 + +day.slice(5, 7) - 3; // 3 月 = 0
      const snap = (account: string, kind: string, v: number) => out.push({
        type: 'asset.snapshot', occurred_at: at(day, 21), day, tz: TZ, value: Math.round(v), unit: 'CNY', title: account, data: { account, kind, currency: 'CNY' },
      });
      snap('招行储蓄', 'deposit', 42000 + k * 6500 - (day >= '2026-10-08' ? 6999 : 0));
      snap('余额宝', 'fund', 18000 + k * 300);
      snap('指数基金', 'fund', 30000 * (1 + 0.012 * k) + (k % 3 === 2 ? -1800 : 0));
      snap('房贷', 'debt', -(680000 - k * 3200));
      snap('房子', 'property', 2600000);
    }
    if (day >= '2026-08-20' && day <= '2026-10-07') out.push({ type: 'habit.check', occurred_at: at(day, 22), day, tz: TZ, value: 1, unit: 'times', title: '打卡 背单词', data: { habit: '背单词', done: true } });

    // ── 地方 ──
    /* 带坐标: 足迹房间的地图按真坐标落点、按时间连线 */
    const visit = (name: string, h1: number, h2: number) => {
      const c = PLACES[name];
      out.push({ type: 'place.visit', occurred_at: at(day, h1), ended_at: at(day, h2), day, tz: TZ, title: `在 ${name}`, data: { name, ...(c ? { lat: c[0], lng: c[1] } : {}) } });
    };
    if (ago % 9 === 0 && ago > 30) visit('静安大悦城', 14, 17);
    if (ago % 7 === 3) visit('外婆家', 11, 15);
    if (ago % 11 === 5 && ago < 200) visit('前滩太古里', 15, 18);
    const trip: Record<string, string> = {
      '2026-10-03': '莫干山', '2026-10-04': '西湖', '2026-10-05': '乌镇',
      '2026-07-18': '宽窄巷子', '2026-07-19': '大熊猫基地', '2026-05-02': '平江路', '2026-03-14': '迪士尼',
    };
    if (trip[day]) visit(trip[day], 10, 17);
  }
  /* 触发器: 每年纪念日提前 10 天、每周日给爸妈打电话、到公司拿快递 (地点类不进洞察, 由 Pilot 在「到了」时查) */
  const trig = (when: string, data: Record<string, unknown>) =>
    out.push({ type: 'trigger', occurred_at: at('2026-09-01', 10), day: '2026-09-01', tz: TZ, title: String(data.text), data: { when, ...data } });
  trig('yearly', { date: '10-20', text: '恋爱纪念日，提前订餐厅', leadDays: 10 });
  trig('weekly', { weekday: 7, time: '20:00', text: '给爸妈打电话' });
  trig('place', { place: '公司', text: '前台拿快递' });

  /* 体检 (6 月): 尿酸、甘油三酯偏高 */
  out.push({
    type: 'health.report', occurred_at: at('2026-06-12', 10), day: '2026-06-12', tz: TZ, title: '2026 年度体检',
    data: {
      title: '2026 年度体检',
      items: [
        { name: '尿酸', value: 452, unit: 'μmol/L', flag: 'high' },
        { name: '甘油三酯', value: 2.1, unit: 'mmol/L', flag: 'high' },
        { name: '空腹血糖', value: 5.1, unit: 'mmol/L', flag: 'ok' },
      ],
      summary: '尿酸、甘油三酯偏高，建议少喝饮料、减少高嘌呤饮食，三个月后复查。',
    },
  });
  /* 知识库: 收藏和它做过的东西 */
  const know = (d: string, title: string, kind: string, extra: Record<string, unknown> = {}) =>
    out.push({ type: 'knowledge.item', occurred_at: at(d, 21), day: d, tz: TZ, title, data: { title, kind, ...extra } });
  know('2026-09-20', '产品需求文档模板', 'doc', { tags: ['工作'] });
  know('2026-10-02', '莫干山两日游路线', 'deliverable', { tags: ['旅行'] });
  know('2026-10-09', '《思考，快与慢》读书笔记', 'note', { tags: ['读书'] });
  return {
    records: out,
    facts: {
      'goal.weight': 70,
      'me.job': '产品经理',
      'me.likes.food': '火锅和日料',
      'person.妈妈.relation': '母亲',
      'person.妈妈.birthday': '10-14',
      'person.妈妈.likes': '桂花糕和越剧',
      'person.小王.relation': '同事',
      'person.张姐.relation': '客户',
      'person.张姐.likes': '不吃辣，喜欢靠窗的位置',
      'home.city': '上海',
      'home.geo': '31.2200,121.4450',
      'home.address': '静安区某小区',
      'vehicle.小白.model': '比亚迪海豚',
      'vehicle.小白.insurance_due': '2026-11-03',
      'vehicle.小白.inspection_due': '2027-04-20',
      'me.passport_expire': '2027-02-01',
    },
  };
}
