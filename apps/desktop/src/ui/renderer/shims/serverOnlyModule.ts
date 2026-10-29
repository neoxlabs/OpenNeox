function describe(name: string): never {
  throw new Error(
    `[renderer-shim] 渲染层不该使用服务端模块 "${name}"。`
    + ' 这通常意味着某个后端包 (node 侧) 的模块被 import 进了渲染层 —— '
    + '请把那个 import 改成 type-only, 或把它挪到主进程/worker 侧。'
    + ' 需要具体是哪个文件拉进来的, 看 Vite 的报错栈或搜 `import ... from \''
    + name.replace(/^node:/, '') + '\'`。',
  );
}

const handler: ProxyHandler<Record<string, unknown>> = {
  get(_target, prop) {
    /* import x from 'fs' 走 default; __esModule 是打包器 interop 探针, 不能抛 */
    if (prop === 'default') return proxy;
    if (prop === '__esModule') return true;
    if (prop === 'then') return undefined;      /* 别被当成 thenable */
    return describe(String(prop));
  },
};

const proxy: Record<string, unknown> = new Proxy({}, handler);

export default proxy;

/* 具名 import 也要能解析 (否则 dev 里直接 SyntaxError, 报错更远)。
 * 全部指向同一个会抛错的代理 —— 只有**真去用**才会炸。 */
export const promises = proxy;
export const constants = proxy;
export const readFileSync = proxy;
export const writeFileSync = proxy;
export const existsSync = proxy;
export const mkdirSync = proxy;
export const readdirSync = proxy;
export const statSync = proxy;
export const unlinkSync = proxy;
export const rmSync = proxy;
export const createWriteStream = proxy;
export const createReadStream = proxy;
export const spawn = proxy;
export const exec = proxy;
export const execFile = proxy;
export const execSync = proxy;
export const spawnSync = proxy;
export const join = proxy;
export const resolve = proxy;
export const dirname = proxy;
export const basename = proxy;
export const extname = proxy;
export const homedir = proxy;
export const tmpdir = proxy;
export const platform = proxy;
export const createHash = proxy;
export const randomBytes = proxy;
