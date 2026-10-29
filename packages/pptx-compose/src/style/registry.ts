
import { STYLE_SPECS, type StyleSpec } from './styleSpec.js';

const imported = new Map<string, StyleSpec>();

/** 注册一套运行时风格 (同一个 id 再注册 = 覆盖)。返回原 spec 便于链式使用。 */
export function registerStyleSpec(spec: StyleSpec): StyleSpec {
  if (!spec || typeof spec.id !== 'string' || !spec.id.trim()) {
    throw new Error('registerStyleSpec: spec.id 必填');
  }
  imported.set(spec.id, spec);
  return spec;
}

/** 内置优先, 其次运行时导入。风格查找的唯一入口。 */
export function getStyleSpec(id: string): StyleSpec | undefined {
  if (!id) return undefined;
  return STYLE_SPECS[id] ?? imported.get(id);
}

/** 这个 id 是不是内置风格 (导入风格不算) */
export function isBuiltinStyle(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(STYLE_SPECS, id);
}

/** 已注册的运行时风格 id (调试/工具回执用; 不含内置) */
export function importedStyleIds(): string[] {
  return [...imported.keys()];
}
