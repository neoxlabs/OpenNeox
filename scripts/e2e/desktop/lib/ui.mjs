import { waitFor } from './assert.mjs';

export const SEL = {
  /* 壳层 */
  shellReady: '.neox-mode-seg__btn',
  modeBtn: '.neox-mode-seg__btn',
  modeOn: '.neox-mode-seg__btn.is-on',
  composer: '.atl-composer__input',
  sendBtn: '.atl-composer__send',
  stopBtn: '.atl-btn', // 运行中才有, 文案「停止」
  sidebar: '.neox-sidebar',
  sidebarToggle: '[aria-label="切换侧栏"]',
  railBtn: '.neox-rail__btn',

  /* 会话 (Code 工作台是 .neox-wb-row, Work 列表是 .neox-session-item, 两种都认) */
  newChat: '.neox-sidebar__newchat',
  sessionRow: '.neox-wb-row, .neox-session-item',
  sessionActive: '.neox-wb-row.is-active, .neox-session-item.is-active',
  sessionDelete: '[aria-label="删除会话"]',
  contextMenu: '.neox-context-menu',
  contextMenuItem: '.neox-context-menu-item',
  confirmDialog: '.neox-confirm-dialog',
  confirmPrimary: '.neox-file-dialog-btn.primary, .neox-file-dialog-btn.danger',

  /* 浮层 */
  tour: '.neox-tour',
  tourSkip: '.neox-tour__skip',
  modeNotice: '.msn-card',
  modeNoticeOk: '.msn-card__ok',
  projectPicker: '.nx-projpick',

  /* 搜索 / 通知 */
  searchBtn: '[aria-label="搜索"]',
  searchRoot: '.neox-sessionsearch',
  searchInput: '.neox-sessionsearch__input',
  searchEmpty: '.neox-sessionsearch__empty',
  notifBtn: '[aria-label^="通知"]',
  notifPopover: '.neox-notif-popover',

  /* 设置 */
  settingsCog: '.neox-sidebar__acct-cog',
  settingsRoot: '.settings-overlay, .neox-embedded-settings',
  settingsNavItem: '.nav-item',
  settingsNavActive: '.nav-item.active, .nav-item.is-active',
  settingsBack: '.settings-sidebar__back',
  settingsClose: '.settings-chrome__close',

  /* 模型 */
  modelBtn: '.atl-composer__model',
  modelMenu: '.atl-model__menu',

  /* Surface (aria 随模式变: Code=Surface 画布 / Work=右侧画布) */
  surfaceToggle: '[aria-label*="画布"]',
  surfaceChrome: '.sfc-chrome',
  surfaceSwitchBtn: '.sfc-chrome__switch-btn',
  surfaceSwitchMenu: '.sfc-chrome__switch-menu',
  surfaceTab: '.sfc-chrome__tab',
  surfaceTabClose: '.sfc-chrome__tab-close',

  /* 主题 (顶栏主题菜单入口) */
  themeToggle: '[aria-label="切换主题"]',
  themeMenu: '.neox-theme-menu',
  themeMenuRow: '.neox-theme-menu .neox-context-menu-item',

  /* 侧栏项目 / 工具 */
  projectLabel: '.neox-wb__label',
  /* 账户行左边那颗九宫格「工具」—— 点开进的是工具主页, 不是弹出托盘 (UI 3.0) */
  toolsToggle: '.neox-sidebar__tools-toggle',
  toolsHome: '.tools-home',
  toolsBack: '.tools-home .tp-back',
  toolCard: '.tools-home__card',
  toolName: '.tools-home__name',
  /* 老版本的弹出托盘 (clay 布局只在 hover 预览里出现, 主入口已换成工具主页) */
  toolDock: '.neox-sidebar__dock',
  toolItem: '.neox-sidebar__tool',

  /* 消息 */
  msgUser: '.atl-msg.is-user',
  msgAssistant: '.atl-msg.is-assistant',
};

/** 页面里可见元素个数 (offsetWidth/Height > 0) */
export async function visibleCount(page, selector) {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0).length,
    selector,
  );
}

/** 点可见的那一个 (设置页会预热挂载一份隐藏 DOM, 不能盲点 first) */
export async function clickVisible(page, selector, { index = 0, timeout = 10_000, fx = 0.5, fy = 0.5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const box = await pointOnVisible(page, selector, index, fx, fy);
    if (box) {
      await page.mouse.click(box.x, box.y);
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`找不到可见元素 ${selector} (第 ${index} 个)`);
}

/** 元素内的相对坐标点 (fx/fy 0~1), 元素不可见时返回 null */
async function pointOnVisible(page, selector, index = 0, fx = 0.5, fy = 0.5) {
  return page
    .evaluate(
      ([sel, i, x, y]) => {
        const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
        const el = els[i];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width * x, y: r.top + r.height * y };
      },
      [selector, index, fx, fy],
    )
    .catch(() => null);
}

/**
 * 先移过去悬停再点 —— 有些控件平时 opacity:0, 鼠标进到那一块才显形 (顶栏侧栏开关)。
 * fx 用来避开压在按钮右边缘上的宽度调整条: 侧栏窄的时候按钮中心点正好落在 resizer 上。
 */
export async function hoverClick(page, selector, { index = 0, timeout = 10_000, fx = 0.5, fy = 0.5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const box = await pointOnVisible(page, selector, index, fx, fy);
    if (box) {
      await page.mouse.move(box.x, box.y);
      await page.waitForTimeout(200);
      await page.mouse.click(box.x, box.y);
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`找不到可见元素 ${selector} (第 ${index} 个)`);
}

/** 首次导览浮层会拦截点击 */
export async function dismissTour(page) {
  if (await visibleCount(page, SEL.tourSkip)) {
    await clickVisible(page, SEL.tourSkip).catch(() => {});
    await page.locator(SEL.tour).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

/** 第一次切换模式会弹「模式说明」卡 */
export async function dismissModeNotice(page) {
  if (await visibleCount(page, SEL.modeNoticeOk)) {
    await clickVisible(page, SEL.modeNoticeOk).catch(() => {});
    await page.locator(SEL.modeNotice).waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
}

/** 新建任务后会额外弹「在哪个项目里新建」下拉 —— 会话已经建好了, 这里只是关掉它 */
export async function dismissProjectPicker(page) {
  if (await visibleCount(page, SEL.projectPicker)) {
    await page.keyboard.press('Escape').catch(() => {});
    for (let i = 0; i < 20; i++) {
      if (!(await visibleCount(page, SEL.projectPicker))) return;
      await page.waitForTimeout(100);
    }
  }
}

/** 回到干净主界面: 刷新复位本地 UI 状态, 并归一到 Code 模式 (产品默认, 且模式会跨刷新保留) */
export async function resetToShell(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SEL.shellReady, { timeout: 30_000 });
  await dismissTour(page);
  await dismissModeNotice(page);
  await dismissProjectPicker(page);
  await ensureMode(page, 'Code');
}

/** 保证处于指定模式 (模式会跨刷新保留, 前面场景切走会污染后面) */
export async function ensureMode(page, label) {
  if ((await activeMode(page)) === label) return;
  await switchMode(page, label);
}

export async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

export async function activeMode(page) {
  return page.evaluate(
    () => document.querySelector('.neox-mode-seg__btn.is-on')?.textContent?.trim() ?? '',
  );
}

export async function modeLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.neox-mode-seg__btn')].map((el) => el.textContent.trim()),
  );
}

export async function switchMode(page, label) {
  /* 按文字找模式按钮, 取可见的那个 */
  const box = await page.evaluate((text) => {
    const el = [...document.querySelectorAll('.neox-mode-seg__btn')].find((e) =>
      e.textContent.trim().includes(text),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
  if (!box) throw new Error(`没有「${label}」模式按钮`);
  await page.mouse.click(box.x, box.y);
  await dismissModeNotice(page);
  await page.waitForTimeout(400);
}

/* ---------- 会话 ---------- */
export async function sessionRowCount(page) {
  return page.locator(SEL.sessionRow).count();
}

export async function sessionTitles(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.neox-wb-row, .neox-session-item')].map(
      (el) => (el.innerText || '').trim().split('\n')[0],
    ),
  );
}

export async function activeSessionTitle(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.neox-wb-row.is-active, .neox-session-item.is-active');
    return el ? (el.innerText || '').trim().split('\n')[0] : '';
  });
}

export async function activeSessionId(page) {
  return page.evaluate(
    () =>
      document
        .querySelector('.neox-wb-row.is-active, .neox-session-item.is-active')
        ?.getAttribute('data-session-id') ?? '',
  );
}

/**
 * 新建任务: 等「激活会话 id」变成新的。
 * 不能用行数判断 —— 草稿空会话全局只有一个, 在空会话上再新建会替换它, 行数不变但 id 变了。
 */
export async function newSession(page, { timeout = 20_000 } = {}) {
  const before = await activeSessionId(page);
  await clickVisible(page, SEL.newChat);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const id = await activeSessionId(page);
    if (id && id !== before) {
      await page.waitForTimeout(300);
      await dismissProjectPicker(page);
      return id;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`新建任务后激活会话没有变化 (仍是 ${before || '空'})`);
}

/** 按标题点开某个会话 */
export async function openSessionByTitle(page, title) {
  const box = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.neox-wb-row, .neox-session-item')].find((e) =>
      (e.innerText || '').trim().includes(t),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, title);
  if (!box) throw new Error(`侧栏没有「${title}」会话`);
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(500);
}

/**
 * 删除会话: 右键会话行 → 上下文菜单「删除」→ 确认弹窗。
 * Code 工作台的行 (.neox-wb-row) 没有行内删除按钮, 右键菜单是两种模式都有的统一入口。
 */
export async function deleteActiveSession(page) {
  const id = await activeSessionId(page);
  if (!id) throw new Error('没有激活会话, 无法删除');
  const rowSel = `.neox-wb-row[data-session-id="${id}"], .neox-session-item[data-session-id="${id}"]`;
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2 };
  }, rowSel);
  if (!box) throw new Error('找不到要删除的会话行');
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.waitForSelector(SEL.contextMenu, { state: 'visible', timeout: 10_000 });
  const clicked = await page.evaluate(() => {
    const menu = document.querySelector('.neox-context-menu');
    if (!menu) return false;
    const item = [...menu.querySelectorAll('.neox-context-menu-item')].find((e) =>
      (e.innerText || '').trim().includes('删除'),
    );
    if (!item) return false;
    item.click();
    return true;
  });
  if (!clicked) throw new Error('上下文菜单里没有「删除」');
  await page.waitForSelector(SEL.confirmDialog, { timeout: 10_000 });
  await clickVisible(page, SEL.confirmPrimary);
  await page.waitForTimeout(600);
}

/* ---------- 设置 ---------- */
export async function openSettings(page) {
  await clickVisible(page, SEL.settingsCog);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await visibleCount(page, SEL.settingsNavItem)) return;
    await page.waitForTimeout(150);
  }
  throw new Error('设置面板没有出现 (看不到分区导航)');
}

export async function settingsVisible(page) {
  return (await visibleCount(page, SEL.settingsRoot)) > 0;
}

export async function settingsNavLabels(page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    if (!vis) return [];
    return [...vis.querySelectorAll('.nav-item')].map((el) => el.innerText.trim());
  });
}

/**
 * 进设置分区。label 可以是字符串, 也可以是候选数组 —— 同一个分区在不同版本叫过不同名字
 * (手机配对页叫过「手机连接」, 现在叫「远程访问」)。先精确匹配, 再按包含匹配。
 * 返回真正点中的那个分区名, 调用方据此断言高亮。
 */
export async function gotoSettingsSection(page, label) {
  const names = Array.isArray(label) ? label : [label];
  const hit = await page.evaluate((cands) => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    if (!vis) return '';
    const items = [...vis.querySelectorAll('.nav-item')];
    const text = (el) => el.innerText.trim();
    let item = null;
    let matched = '';
    for (const name of cands) {
      item = items.find((el) => text(el) === name);
      if (item) { matched = name; break; }
    }
    if (!item) {
      for (const name of cands) {
        item = items.find((el) => text(el).includes(name));
        if (item) { matched = text(item); break; }
      }
    }
    if (!item) return '';
    item.click();
    return matched;
  }, names);
  if (!hit) throw new Error(`设置里没有「${names.join(' / ')}」分区`);
  await page.waitForTimeout(400);
  return hit;
}

export async function activeSettingsSection(page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    if (!vis) return '';
    const el = vis.querySelector('.nav-item.active, .nav-item.is-active');
    return el ? el.innerText.trim() : '';
  });
}

export async function settingsBodyText(page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    return vis ? vis.innerText : '';
  });
}

/** 关设置: 嵌入态点「返回」, 浮层态点 X; 都没有就 Esc */
export async function closeSettings(page) {
  if (!(await settingsVisible(page))) return;
  if (await visibleCount(page, SEL.settingsBack)) {
    await clickVisible(page, SEL.settingsBack);
  } else if (await visibleCount(page, SEL.settingsClose)) {
    await clickVisible(page, SEL.settingsClose);
  } else {
    await page.keyboard.press('Escape');
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await settingsVisible(page))) return;
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  if (await settingsVisible(page)) throw new Error('设置面板关不掉');
}

/* ---------- 搜索 / 通知 ---------- */
export async function openSearch(page) {
  await clickVisible(page, SEL.searchBtn);
  await page.waitForSelector(SEL.searchInput, { state: 'visible', timeout: 10_000 });
}

export async function closeSearch(page) {
  await page.keyboard.press('Escape');
  await page.locator(SEL.searchInput).waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

export async function openNotifications(page) {
  await clickVisible(page, SEL.notifBtn);
  await page.waitForSelector(SEL.notifPopover, { state: 'visible', timeout: 10_000 });
}

export async function closeNotifications(page) {
  await page.keyboard.press('Escape');
  await page.locator(SEL.notifPopover).waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/* ---------- 模型 ---------- */
export async function openModelMenu(page) {
  await clickVisible(page, SEL.modelBtn);
  await page.waitForSelector(SEL.modelMenu, { state: 'visible', timeout: 10_000 });
}

export async function closeModelMenu(page) {
  await page.keyboard.press('Escape');
  await page.locator(SEL.modelMenu).waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

export async function currentModelLabel(page) {
  return page.evaluate(() => document.querySelector('.atl-composer__model')?.getAttribute('aria-label') ?? '');
}

/* ---------- Surface ---------- */
/** 面板是否真的画出来了 (不能只看元素在不在 —— 收起的 chrome 仍挂着, 只是 0 尺寸 / hidden) */
export async function surfaceOpen(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.sfc-chrome')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  });
}

export async function toggleSurface(page) {
  await clickVisible(page, SEL.surfaceToggle);
  await page.waitForTimeout(600);
}

/** Surface 的开合会跨场景保留 (面板是任务级状态), 所以场景要先「确保」状态而不是盲切 */
export async function ensureSurfaceOpen(page) {
  if (await surfaceOpen(page)) return;
  await toggleSurface(page);
  await waitFor(async () => surfaceOpen(page), { what: 'Surface 面板打开', timeout: 15_000 });
}

export async function ensureSurfaceClosed(page) {
  if (!(await surfaceOpen(page))) return;
  await toggleSurface(page);
  await waitFor(async () => !(await surfaceOpen(page)), { what: 'Surface 面板关闭', timeout: 15_000 });
}

/** 从 Surface 的新建菜单里选一项 (默认「文件」) */
export async function newSurfaceTab(page, label = '文件') {
  await ensureSurfaceOpen(page);
  await clickVisible(page, SEL.surfaceSwitchBtn);
  await page.waitForSelector(SEL.surfaceSwitchMenu, { state: 'visible', timeout: 10_000 });
  const picked = await page.evaluate((name) => {
    const menu = document.querySelector('.sfc-chrome__switch-menu');
    if (!menu) return false;
    const item = [...menu.querySelectorAll('.sfc-chrome__switch-menu-item')].find((e) =>
      (e.innerText || '').includes(name),
    );
    if (!item) return false;
    item.click();
    return true;
  }, label);
  if (!picked) throw new Error(`Surface 新建菜单里没有「${label}」`);
  await page.waitForTimeout(600);
}

/* ---------- 主题 ---------- */
/** 设置→外观里当前选中的主题卡名字 */
export async function activeThemeCard(page) {
  return page.evaluate(() => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    const card = vis?.querySelector('.theme-pack-card.is-active');
    return card?.querySelector('.theme-pack-card__name')?.innerText.trim() ?? '';
  });
}

/** 设置→外观里点一张主题卡 (按名字); 返回是否点到 */
export async function clickThemeCard(page, name) {
  return page.evaluate((label) => {
    const roots = [...document.querySelectorAll('.settings-overlay, .neox-embedded-settings')];
    const vis = roots.find((el) => el.offsetWidth > 0 && el.offsetHeight > 0);
    if (!vis) return false;
    const card = [...vis.querySelectorAll('.theme-pack-card')].find(
      (e) => (e.querySelector('.theme-pack-card__name')?.innerText || '').trim() === label,
    );
    if (!card) return false;
    card.click();
    return true;
  }, name);
}

/* ---------- 主题 ---------- */
export async function themeAttr(page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? '');
}

/* ---------- 发消息 (会真调模型) ---------- */
export async function sendMessage(page, text) {
  const input = page.locator(SEL.composer).first();
  await input.waitFor({ state: 'visible', timeout: 15_000 });
  await input.fill(text);
  await page.waitForTimeout(150);
  await clickVisible(page, SEL.sendBtn);
}

/** 用户消息条数 (判断消息真的进了会话流) */
export async function userMessageCount(page) {
  return page.locator(SEL.msgUser).count();
}

/** 等到某条用户消息出现在时间线里 (文本包含 text) */
export async function waitForUserText(page, text, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((t) => {
      return [...document.querySelectorAll('.atl-msg.is-user')].some((e) =>
        (e.innerText || '').includes(t),
      );
    }, text);
    if (found) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`时间线里没有包含「${text}」的用户消息`);
}

/** 最后一条助手消息的正文长度 (流式过程中会变) */
export async function lastAssistantText(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.atl-msg.is-assistant')];
    const last = els[els.length - 1];
    if (!last) return '';
    const body = last.querySelector('.atl-msg__text') || last;
    return (body.innerText || '').trim();
  });
}

/* 停止按钮的两种形态 ——
 * 输入框工具栏的那个是 `.atl-composer__stop` (圆钮只有 aria-label, **没有可见文字**),
 * 旧的 `.atl-btn`「停止」只存在于某些内联提示。两处都要认, 否则 isRunning 永远 false。 */
const STOP_BTN = '.atl-composer__stop, .atl-btn';

/** 是否正在生成 (停止按钮可见) */
export async function isRunning(page) {
  return page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetWidth > 0);
    return els.some((e) =>
      e.classList.contains('atl-composer__stop')
      || (e.getAttribute('aria-label') || '').includes('停止')
      || (e.innerText || '').includes('停止'),
    );
  }, STOP_BTN);
}

/** 点停止 */
export async function clickStop(page) {
  const box = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find(
      (e) => e.offsetWidth > 0 && (
        e.classList.contains('atl-composer__stop')
        || (e.getAttribute('aria-label') || '').includes('停止')
        || (e.innerText || '').includes('停止')
      ),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, STOP_BTN);
  if (!box) throw new Error('找不到「停止」按钮');
  await page.mouse.click(box.x, box.y);
}

/* ---------- 视口 (Electron 下用 CDP Emulation, page.setViewportSize 不可靠) ---------- */
export async function setViewport(page, width, height) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(400);
}

export async function clearViewport(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await page.waitForTimeout(300);
}

/** 横向溢出检查: 文档滚动宽 > 视口宽 即为溢出 */
export async function overflowMetrics(page) {
  return page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

/* ---------- 侧栏 ---------- */
export async function sidebarWidth(page) {
  return page.evaluate(
    () => document.querySelector('.neox-sidebar')?.getBoundingClientRect().width ?? 0,
  );
}

export async function ensureSidebarExpanded(page) {
  if ((await sidebarWidth(page)) >= 200) return;
  await clickVisible(page, SEL.sidebarToggle).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if ((await sidebarWidth(page)) >= 200) return;
    await page.waitForTimeout(150);
  }
}

/* ---------- 工具主页 (UI 3.0: 账户行左边那颗九宫格) ---------- */
export async function toolsPageOpen(page) {
  return (await visibleCount(page, SEL.toolsHome)) > 0;
}

/** 点侧栏「工具」进工具主页 */
export async function openToolsPage(page) {
  if (await toolsPageOpen(page)) return;
  await clickVisible(page, SEL.toolsToggle);
  await page.waitForSelector(SEL.toolsHome, { state: 'visible', timeout: 15_000 });
}

/** 工具主页上每张卡的名字 (技能 / MCP / 知识库 / 图片 / 插件 / 团队 …) */
export async function toolPageLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.tools-home__name')].map((el) => (el.innerText || '').trim()).filter(Boolean),
  );
}

/** 左上角「返回任务」 */
export async function closeToolsPage(page) {
  if (!(await toolsPageOpen(page))) return;
  await clickVisible(page, SEL.toolsBack);
  await waitFor(async () => !(await toolsPageOpen(page)), { what: '工具主页关闭', timeout: 10_000 });
}
