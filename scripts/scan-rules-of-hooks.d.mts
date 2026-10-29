/* 类型声明 —— 扫描器本体是 .mjs (构建期工具, 不参与应用编译)。
 * 它从 renderer/hooks/ 挪到 scripts/ 之后就落在 tsconfig 的 include 之外了,
 * 单测 import 它会 TS7016 (隐式 any)。给一份手写声明, 不为它开 allowJs。 */
export interface HookViolation {
  file: string;
  line: number;
  col: number;
  hook: string;
  kind: 'after-return' | 'conditional' | 'loop' | 'plain-function' | string;
  owner: string;
}
export declare const UI_ROOT: string;
export declare function analyzeSource(file: string, src: string): HookViolation[];
export declare function scanDesktopUi(root?: string): { files: number; hits: HookViolation[] };
