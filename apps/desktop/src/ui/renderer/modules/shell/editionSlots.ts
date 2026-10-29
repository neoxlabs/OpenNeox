/**
 * 发行版注册入口 —— 整棵渲染树里**唯一**一处接发行版实现的地方。
 *
 * 带账号体系的发行版把自己的实现 (账户行、登录弹窗、额度浮层、会员数据……) 放在
 * `./edition/` 目录里, 由 `./edition/index.tsx` 导出两个函数:
 *
 *   bootEdition()           注册能力钩子 (editionHooks) + 装常驻服务, 越早越好
 *   registerEditionSlots()  注册组件插槽 (uiSlots)
 *
 * 这里用 import.meta.glob 去找那个文件, 而不是写一句静态 import: 公开构建里 `edition/`
 * 整个目录不存在, glob 匹配不到就是空对象 —— 两个函数退化成空操作, 共享代码不用改一行、
 * 导出时也不用改写本文件。静态 import 做不到这一点 (目录不在, 编译直接失败)。
 *
 * 收益是共享组件里一条 if 都不用加: 挂载点、props 契约、兜底实现三者是同一份代码,
 * 发行版差异全部收在 `edition/` 这一个目录里。
 *
 * 调用时机 (main.tsx):
 *   bootEdition            模块求值阶段, 早于 React 挂载 —— 能力钩子在第一次渲染前就位,
 *                          hook 类条目整个生命周期是同一个函数, 调用顺序稳定。
 *   registerEditionSlots   React 挂载之前 —— 第一帧就是最终形态, 不闪一下本地兜底。
 *                          插槽订阅了 registry 变化, 所以之后再补注册同样生效。
 */

interface EditionEntry {
  bootEdition?: () => void;
  registerEditionSlots?: () => void;
}

const entries = Object.values(
  import.meta.glob<EditionEntry>('./edition/index.tsx', { eager: true }),
);

export function bootEdition(): void {
  for (const e of entries) e.bootEdition?.();
}

export function registerEditionSlots(): void {
  for (const e of entries) e.registerEditionSlots?.();
}
