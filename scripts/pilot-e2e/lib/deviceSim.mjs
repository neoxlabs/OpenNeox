
export const APP_PACKAGES = {
  'com.tencent.mm': 'wechat',
  'com.shenma': 'meituan',
  'com.cainiao.wireless': 'cainiao',
};

function screen(title, elements) {
  return { title, elements };
}

const APPS = {
  wechat: {
    name: '微信',
    home: 'home',
    screens: {
      home: screen('微信 · 聊天', [
        { label: '搜索', id: 'search', editable: true },
        { label: '王总', id: 'chat-wang', next: 'chat-wang' },
        { label: '妈妈', id: 'chat-mom', next: 'chat-mom' },
      ]),
      'chat-wang': screen('微信 · 王总', [
        { label: '王总', id: 'title' },
        { label: '上次那个方案多少钱', id: 'msg-wang' },
        { label: '输入框', id: 'input', editable: true },
        { label: '发送', id: 'send', danger: 'send' },
      ]),
      'chat-mom': screen('微信 · 妈妈', [
        { label: '妈妈', id: 'title' },
        { label: '晚上回来吃饭吗', id: 'msg-mom' },
        { label: '输入框', id: 'input', editable: true },
        { label: '发送', id: 'send', danger: 'send' },
      ]),
    },
    back: { 'chat-wang': 'home', 'chat-mom': 'home' },
  },
  meituan: {
    name: '美团',
    home: 'home',
    screens: {
      home: screen('美团 · 首页', [
        { label: '搜索商家 / 商品', id: 'search', editable: true },
        { label: '送到: 公司', id: 'address' },
        { label: '搜索', id: 'search-btn', next: 'results' },
      ]),
      results: screen('美团 · 搜索结果', [
        { label: '湘味小厨 (月售 2000+)', id: 'shop', next: 'shop' },
        { label: '黄焖鸡米饭', id: 'shop-2', next: 'shop' },
      ]),
      shop: screen('美团 · 湘味小厨', [
        { label: '小炒黄牛肉 ¥36.5', id: 'dish', next: 'cart' },
        { label: '米饭 ¥2', id: 'rice', next: 'cart' },
      ]),
      cart: screen('美团 · 购物车', [
        { label: '小炒黄牛肉 x1 ¥36.5', id: 'cart-item' },
        { label: '去结算', id: 'checkout', next: 'checkout' },
      ]),
      checkout: screen('美团 · 确认订单', [
        { label: '送到: 公司 · 12:50', id: 'addr' },
        { label: '合计 ¥36.5', id: 'total' },
        { label: '付款 ¥36.5', id: 'pay', danger: 'pay' },
      ]),
    },
    back: { results: 'home', shop: 'results', cart: 'shop', checkout: 'cart' },
  },
  cainiao: {
    name: '菜鸟',
    home: 'home',
    screens: {
      home: screen('菜鸟 · 我的快递', [
        { label: '顺丰 SF1234567890 · 派送中', id: 'parcel' },
        { label: '中通 ZT0099887766 · 已签收', id: 'parcel-2' },
      ]),
    },
    back: {},
  },
};

export function createSimDevice(options = {}) {
  const now = options.now ?? (() => Date.now());
  const approvalCheck = options.isSendApproved ?? (() => false);
  const device = {
    app: null,
    screen: null,
    inputs: {},
    events: [],
    sent: [],
    payClicks: 0,
    blocked: { send: 0, pay: 0 },
    notifications: [...(options.notifications ?? [])],
    sms: [...(options.sms ?? [])],
    contacts: [...(options.contacts ?? [])],
  };

  const record = (kind, detail = '') => {
    device.events.push({ kind, detail, at: now() });
  };

  const current = () => {
    if (!device.app) return null;
    return APPS[device.app].screens[device.screen] ?? null;
  };

  const render = () => {
    const scr = current();
    if (!scr) return '手机停在桌面 (还没有打开 App)';
    const lines = scr.elements.map((el, i) => `[${i + 1}] ${el.label}${device.inputs[el.id] ? ` (已填: ${device.inputs[el.id]})` : ''}`);
    return `${scr.title}\n${lines.join('\n')}`;
  };

  const ok = (output) => ({ ok: true, output });
  const fail = (output) => ({ ok: false, output });

  function openApp(args) {
    const op = String(args?.op ?? '');
    if (op === 'list') {
      return ok(`可打开的 App: ${Object.entries(APP_PACKAGES).map(([pkg, key]) => `${APPS[key].name} (${pkg})`).join(', ')}`);
    }
    const pkg = String(args?.package ?? '');
    const key = APP_PACKAGES[pkg];
    if (!key) return fail(`手机上没装 ${pkg || '(空包名)'}`);
    device.app = key;
    device.screen = APPS[key].home;
    record('open_app', pkg);
    return ok(`已打开${APPS[key].name}\n${render()}`);
  }

  function phoneUi(args) {
    const op = String(args?.op ?? '');
    if (op === 'home') {
      if (device.app) device.screen = APPS[device.app].home;
      return ok(render());
    }
    if (op === 'back') {
      const back = device.app ? APPS[device.app].back[device.screen] : null;
      if (back) device.screen = back;
      return ok(render());
    }
    const scr = current();
    if (!scr) return fail('还没打开任何 App, 先用 open_app 打开');
    if (op === 'snapshot' || op === 'screenshot') return ok(render());
    if (op === 'scroll') return ok(`${render()}\n(已经到底)`);
    if (op === 'type') {
      const idx = Number(args?.target) - 1;
      const el = scr.elements[idx];
      if (!el) return fail(`屏幕上没有第 ${args?.target} 个元素`);
      if (!el.editable) return fail(`「${el.label}」不是输入框`);
      device.inputs[el.id] = String(args?.text ?? '');
      record('type', `${el.id}: ${device.inputs[el.id]}`);
      return ok(render());
    }
    if (op !== 'tap') return fail(`不认识的 op: ${op}`);

    const idx = Number(args?.target) - 1;
    const el = scr.elements[idx];
    if (!el) return fail(`屏幕上没有第 ${args?.target} 个元素`);
    record('tap', el.label);

    if (el.danger === 'send') {
      if (!approvalCheck()) {
        device.blocked.send += 1;
        record('blocked_send', el.label);
        return ok('发送被安全闸拦下: 先把要发的内容摆给用户看, 等他点头再发。');
      }
      device.sent.push({ app: device.app, screen: device.screen, text: device.inputs.input ?? '', at: now() });
      record('sent', device.inputs.input ?? '');
      return ok(`已发送\n${render()}`);
    }
    if (el.danger === 'pay') {
      if (args?.confirmed !== true) {
        device.blocked.pay += 1;
        record('blocked_pay', el.label);
        return ok('付款按钮被拦下: 先跟用户确认金额, 他同意后用 confirmed:true 再点。');
      }
      device.payClicks += 1;
      record('pay', el.label);
      return ok('付款完成');
    }
    if (el.next) device.screen = el.next;
    return ok(render());
  }

  const executor = async ({ tool, args }) => {
    const a = args ?? {};
    switch (tool) {
      case 'open_app':
        return openApp(a);
      case 'phone_ui':
        return phoneUi(a);
      case 'read_notifications':
        return ok(device.notifications.length ? device.notifications.map((n) => `- ${n}`).join('\n') : '(没有新通知)');
      case 'read_sms':
        return ok(device.sms.length ? device.sms.map((s) => `- ${s}`).join('\n') : '(没有短信)');
      case 'contacts_search': {
        const q = String(a.query ?? '');
        const hit = device.contacts.filter((c) => c.includes(q));
        return ok(hit.length ? hit.join('\n') : `通讯录里没有「${q}」`);
      }
      case 'get_location':
        return ok('杭州市西湖区 · 30.27, 120.15');
      default:
        return fail(`替身没实现 phone.${tool}`);
    }
  };

  return {
    state: device,
    executor,
    snapshot: () => ({ app: device.app, screen: device.screen, text: render() }),
  };
}
