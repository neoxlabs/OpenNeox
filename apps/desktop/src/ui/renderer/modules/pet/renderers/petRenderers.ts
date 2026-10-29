/**
 * petRenderers — 桌宠"渲染器"注册表 (插件机制的核心)
 *
 * 背景: 桌宠支持多种渲染方式, 但它们的"重量"差很多:
 *   · svg(灵动) / sprite(角色)  —— 零运行时依赖, 永远内置在核心包, 安装包不增重.
 *   · 3d(立体)                  —— 依赖 three + @react-three/* (~3MB), 不该让所有用户
 *                                  都背这个体积. 做成"渲染器插件": 默认不启用, 用户在设置
 *                                  里点启用后才按需加载 (React.lazy 独立 chunk).
 *
 * 这张表是单一事实源:
 *   · PetTab 用它渲染"风格"选择器 (只列 builtin + 已启用的 plugin) 和"渲染器扩展"开关区.
 *   · PetWindowRoot 用 kind 判断该不该走 lazy 加载.
 *
 * 后续(真正瘦安装包): plugin 渲染器的 chunk 可以从核心构建里剥离, 改成用户启用时
 * 从我们服务器/CDN 下载 (走现有 pluginInstaller 基建). 那一步只需把 load 的实现从
 * 本地 import() 换成"下载到 userData 再加载", 这张表的契约不变.
 */

export type PetRenderMode = 'svg' | 'sprite' | '3d';

export interface PetRendererDescriptor {
  id: PetRenderMode;
  label: { zh: string; en: string };
  desc: { zh: string; en: string };
  /** builtin = 永远内置在核心, 零额外体积; plugin = 重运行时, 默认不启用, 按需加载 */
  kind: 'builtin' | 'plugin';
  /** plugin 才有: 体积提示 (UI 显示, 让用户知道启用要下多大) */
  sizeHint?: string;
  /** 该渲染器是否需要不透明的毛玻璃窗口 (3d 因 macOS 透明+WebGL 死结需要; svg/sprite 用真透明) */
  needsVibrancy?: boolean;
  unavailable?: { zh: string; en: string };
}

export const PET_RENDERERS: PetRendererDescriptor[] = [
  {
    id: 'svg',
    kind: 'builtin',
    label: { zh: '灵动', en: 'Neo' },
    desc: { zh: '原创矢量小灵体, 会呼吸、跟随鼠标、打字点头. 零素材, 永远在线.', en: 'Original vector spirit — breathes, follows cursor, reacts to typing. Zero assets.' },
  },
  {
    id: 'sprite',
    kind: 'builtin',
    label: { zh: '角色', en: 'Character' },
    desc: { zh: '导入精美角色形象 (任意画风), 支持社区作品.', en: 'Import polished characters (any art style), community packs supported.' },
  },
  {
    id: '3d',
    kind: 'plugin',
    label: { zh: '立体', en: '3D' },
    desc: { zh: '真 3D 模型 (.glb), 可旋转. 较重, 启用后按需加载, 不占用核心安装包.', en: 'True 3D models (.glb), rotatable. Heavier — loaded on demand, not bundled in core.' },
    sizeHint: '~3MB',
    needsVibrancy: true,
    unavailable: {
      zh: '插件包还没上架，发布后自动开放。',
      en: 'Package not published yet — it unlocks once it is.',
    },
  },
];

/** 本机逃生门: 包已发布 / 自己搭了私有市场时先放开 (作者自测用) */
const PLUGIN_OVERRIDE_KEY = 'neox.petPlugins.enabled';

/** 插件渲染器现在能不能启用 —— PetTab 的开关和 handleTogglePlugin 共用这一个判定 */
export function isPetRendererPluginAvailable(id: string): boolean {
  const r = getRenderer(id);
  if (!r || !r.unavailable) return true;
  try {
    return window.localStorage.getItem(PLUGIN_OVERRIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export const PET_RENDERER_PLUGINS = PET_RENDERERS.filter((r) => r.kind === 'plugin');

export function getRenderer(id: string): PetRendererDescriptor | undefined {
  return PET_RENDERERS.find((r) => r.id === id);
}

export function isPluginRenderer(id: string): boolean {
  return getRenderer(id)?.kind === 'plugin';
}

/** 该 mode 当前是否可用 (builtin 永远可用; plugin 需在 enabledPlugins 里) */
export function isRendererAvailable(id: string, enabledPlugins: string[]): boolean {
  const r = getRenderer(id);
  if (!r) return false;
  return r.kind === 'builtin' || enabledPlugins.includes(id);
}
