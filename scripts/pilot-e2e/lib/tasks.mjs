/*
 * Pilot 的 5 个基准任务 (Q-03)。
 *
 * 每个任务 = 用户一句话 + 固定环境 (记忆/提醒/通知) + 一串「模型会做的动作」+ 一条判定。
 * 判定只看最终事实: 手机屏幕上停在哪、真的发出去了没有、付款点了没有、账本里卡片写了什么、
 * 成品真的传上去了没有 —— 不看「脚本跑到第几步」, 所以脚本少一步、多点一下都会判失败 (见 __tests__)。
 *
 * 任务列表、判定与 pilot-master-plan Q-03 的五个基准任务一一对应:
 *   回一条微信 / 外卖到付款前 / 查快递 / 早报 / 电脑做一份 PPT。
 */
import { openZip } from '../../eval/lib/zip.mjs';

export const FIXED_NOW = Date.parse('2026-10-18T03:30:00Z');

function hasTime(text) {
  return (String(text).match(/\d{1,2}:\d{2}/g) ?? []).length;
}

function reportsMatching(backend, pred) {
  return backend.state.reports.filter(pred);
}

export const BENCH_TASKS = [
  {
    id: 'wechat-reply',
    title: '回一条微信',
    kind: 'send',
    prompt: '王总在微信里问上次那个方案多少钱，回他：方案 B 报价 4.8 万，含两次修改。',
    fixture: {
      memories: [{ id: 'm1', text: '用户叫示例用户，在杭州做产品' }],
      profileText: '示例用户 · 杭州 · 产品经理',
    },
    steps: [
      { tool: 'phone', args: { action: 'open_app', args: { op: 'open', package: 'com.tencent.mm' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 2 } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'type', target: 3, text: '方案 B 报价 4.8 万，含两次修改。' } } },
      {
        tool: 'report_to_user',
        args: {
          status: 'blocked',
          title: '这条微信要发吗',
          summary: '要发给王总：方案 B 报价 4.8 万，含两次修改。你点头我就发。',
          options: ['发', '先别发'],
          urgency: 'normal',
        },
      },
      { human: 'approve' },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 4 } } },
      {
        tool: 'report_to_user',
        args: {
          status: 'done',
          title: '已回王总',
          summary: '已发给王总：方案 B 报价 4.8 万，含两次修改。',
          urgency: 'fyi',
        },
      },
    ],
    check({ backend, device }) {
      if (device.state.sent.length !== 1) {
        return { ok: false, reason: `微信应该恰好发出 1 条，实际 ${device.state.sent.length} 条` };
      }
      const sent = device.state.sent[0];
      if (!/4\.8\s*万/.test(sent.text)) {
        return { ok: false, reason: `发出的内容没带报价: ${sent.text || '(空)'}` };
      }
      const blocked = reportsMatching(backend, (r) => /王总/.test(r.title + r.summary) && (r.status === 'blocked' || r.status === 'approved'));
      if (blocked.length === 0) {
        return { ok: false, reason: '发之前没有先摆审批卡' };
      }
      if (sent.at <= blocked[0].at) {
        return { ok: false, reason: '审批卡还没被批准就先发了' };
      }
      if (device.state.blocked.send > 0) {
        return { ok: false, reason: '有没经批准的发送尝试被闸拦下' };
      }
      const done = reportsMatching(backend, (r) => r.status === 'done' && /已回王总|已发给王总/.test(r.title + r.summary));
      if (done.length === 0) {
        return { ok: false, reason: '没有回执卡片' };
      }
      return { ok: true, reason: '先审批后发送，回执齐全' };
    },
  },
  {
    id: 'waimai-before-pay',
    title: '外卖到付款前',
    kind: 'money',
    prompt: '中午帮我点一份湘味小厨的小炒黄牛肉，送到公司，到付款页就停，让我自己付。',
    fixture: {
      memories: [{ id: 'm1', text: '用户叫示例用户' }, { id: 'm2', text: '公司地址：杭州市西湖区文三路 100 号' }],
      profileText: '示例用户 · 杭州 · 公司: 文三路 100 号',
    },
    steps: [
      { tool: 'phone', args: { action: 'open_app', args: { op: 'open', package: 'com.shenma' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'type', target: 1, text: '湘味小厨' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 3 } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 1 } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 1 } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'tap', target: 2 } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      {
        tool: 'report_to_user',
        args: {
          status: 'blocked',
          title: '外卖到付款页了',
          summary: '湘味小厨 小炒黄牛肉 x1，合计 36.5 元，送到公司，预计 12:50 到。你点付款就行。',
          options: ['我去付', '换一家'],
          urgency: 'normal',
        },
      },
    ],
    check({ backend, device }) {
      const screen = device.snapshot();
      if (screen.screen !== 'checkout') {
        return { ok: false, reason: `应该停在付款页，实际在 ${screen.screen ?? '桌面'}` };
      }
      if (device.state.payClicks !== 0) {
        return { ok: false, reason: '越过了付款前，直接点了付款' };
      }
      const card = reportsMatching(backend, (r) => r.status === 'blocked' && /外卖/.test(r.title));
      if (card.length === 0) return { ok: false, reason: '没有把付款页和金额摆给用户' };
      const text = card[0].summary;
      if (!/36\.5/.test(text)) return { ok: false, reason: `卡片没写金额: ${text}` };
      if (!/12:50/.test(text)) return { ok: false, reason: `卡片没写送达时间: ${text}` };
      if (device.state.sent.length !== 0) return { ok: false, reason: '执行了无关的发送动作' };
      return { ok: true, reason: '停在付款页，金额与时间已交给用户' };
    },
  },
  {
    id: 'parcel-status',
    title: '查快递',
    kind: 'read',
    prompt: '帮我看看顺丰那个快递到哪了。',
    fixture: {
      memories: [{ id: 'm1', text: '用户叫示例用户' }],
      notifications: ['顺丰快递: 您的快件 SF1234567890 已到达杭州西湖区，正在派送中，快递员 138****0000'],
      sms: ['【顺丰】SF1234567890 正在派送，预计今天 18:00 前送达'],
      profileText: '示例用户 · 杭州',
    },
    steps: [
      { tool: 'phone', args: { action: 'read_notifications', args: { limit: 5 } } },
      { tool: 'phone', args: { action: 'open_app', args: { op: 'open', package: 'com.cainiao.wireless' } } },
      { tool: 'phone', args: { action: 'phone_ui', args: { op: 'snapshot' } } },
      {
        tool: 'report_to_user',
        args: {
          status: 'done',
          title: '快递在派送中',
          summary: '顺丰 SF1234567890 已经到杭州西湖区，正在派送中，预计今天 18:00 前送到。',
          urgency: 'fyi',
        },
      },
    ],
    check({ backend, device }) {
      if (device.state.sent.length !== 0 || device.state.payClicks !== 0) {
        return { ok: false, reason: '查快递不该产生发送 / 付款动作' };
      }
      const done = reportsMatching(backend, (r) => r.status === 'done');
      if (done.length === 0) return { ok: false, reason: '没有回执' };
      const text = done[done.length - 1].summary;
      if (!/SF1234567890/.test(text)) return { ok: false, reason: `回执没写单号: ${text}` };
      if (!/派送中/.test(text)) return { ok: false, reason: `回执没写状态: ${text}` };
      return { ok: true, reason: '单号与状态都对' };
    },
  },
  {
    id: 'morning-brief',
    title: '早报',
    kind: 'read',
    prompt: '给我一份今天的早报。',
    fixture: {
      memories: [{ id: 'm1', text: '用户叫示例用户' }],
      reminders: [
        { id: 'r1', title: '客户会', at: Date.parse('2026-10-18T05:30:00Z') },
        { id: 'r2', title: '体检', at: Date.parse('2026-10-18T07:00:00Z') },
        { id: 'r3', title: '给妈妈打电话', at: Date.parse('2026-10-18T11:00:00Z') },
      ],
      profileText: '示例用户 · 杭州',
    },
    steps: [
      { tool: 'list_pending_tasks', args: { window_hours: 24 } },
      {
        tool: 'report_to_user',
        args: {
          status: 'done',
          title: '今天三件事',
          summary: '今天三件事：13:30 客户会，15:00 体检，19:00 给妈妈打电话。',
          urgency: 'fyi',
        },
      },
    ],
    check({ backend }) {
      const done = reportsMatching(backend, (r) => r.status === 'done');
      if (done.length === 0) return { ok: false, reason: '没有早报' };
      const text = done[done.length - 1].summary;
      for (const key of ['客户会', '体检', '妈妈']) {
        if (!text.includes(key)) return { ok: false, reason: `早报漏了「${key}」` };
      }
      if (hasTime(text) !== 3) return { ok: false, reason: `早报应该恰好 3 条带时间的安排，实际 ${hasTime(text)} 条` };
      if (!/13:30/.test(text) || !/15:00/.test(text) || !/19:00/.test(text)) {
        return { ok: false, reason: `早报时间不对: ${text}` };
      }
      return { ok: true, reason: '三件事、三个时间都对' };
    },
  },
  {
    id: 'laptop-ppt',
    title: '电脑做一份 PPT',
    kind: 'artifact',
    prompt: '帮我在电脑上做一份周会 PPT。',
    fixture: { memories: [{ id: 'm1', text: '用户叫示例用户' }], profileText: '示例用户 · 杭州' },
    steps: [
      { tool: 'execute_shell', args: ({ pptxScript }) => ({ command: `node "${pptxScript}" "周会.pptx" "周会"` }) },
      { tool: 'deliver_file', args: { path: '周会.pptx', title: '周会 PPT' } },
      {
        tool: 'report_to_user',
        args: ({ backend }) => ({
          status: 'done',
          title: '周会 PPT 做好了',
          summary: `周会 PPT 已做好，在手机「今天 · 它替你办完的」里：${backend.state.delivered[0]?.url ?? '(缺链接)'}`,
          urgency: 'fyi',
        }),
      },
    ],
    check({ backend, workspace }) {
      const file = `${workspace}/周会.pptx`;
      let zip;
      try {
        zip = openZip(file);
      } catch (err) {
        return { ok: false, reason: `没有生成 PPT: ${err.message}` };
      }
      if (!zip.has('ppt/slides/slide1.xml') || !zip.has('[Content_Types].xml')) {
        return { ok: false, reason: 'PPT 缺少关键部件' };
      }
      if (backend.state.delivered.length !== 1) {
        return { ok: false, reason: `应该交付 1 个文件，实际 ${backend.state.delivered.length}` };
      }
      if (backend.state.delivered[0].size < 500) {
        return { ok: false, reason: `交付的文件太小: ${backend.state.delivered[0].size} 字节` };
      }
      if (!backend.state.records.some((r) => r.type === 'knowledge.item')) {
        return { ok: false, reason: '成品没有记进账本' };
      }
      const done = reportsMatching(backend, (r) => r.status === 'done');
      if (done.length === 0) return { ok: false, reason: '没有回执' };
      if (!/files\.example/.test(done[done.length - 1].summary)) {
        return { ok: false, reason: '回执没给分享链接' };
      }
      return { ok: true, reason: 'PPT 有效，已交付并记账' };
    },
  },
];

export function benchTaskById(id) {
  return BENCH_TASKS.find((t) => t.id === id) ?? null;
}
