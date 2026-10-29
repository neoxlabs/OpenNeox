/**
 * Desktop 侧 runtime worker entry —— agent runtime 跑在这条独立线程上。
 *
 * ── 为什么要有这个文件 (而不是直接指向 neox-core 的那个) ────────────────────
 * 打包器只把**被编译入口所在包**里的 worker entry 当成独立 chunk 处理。CLI 侧为同样的
 * 原因在自己主包放了一份 (apps/cli/src/workers/runtimeWorkerEntry.ts) —— 当时是
 * bun --compile 不嵌入依赖包的 worker, 症状是打出来的 binary 里 "ModuleNotFound
 * /$bunfs/root/runtimeWorkerEntry.js", worker 起不来静默回落 same-loop。
 * 桌面这边同理: tsup 的 entry 表里必须有它, 才会在 dist/ui-electron/workers/ 落一个
 * 可被 `new URL('../workers/runtimeWorkerEntry.js', import.meta.url)` 解析到的真实文件
 * (跟 indexingCpuWorker 完全同款, 那条路径在打包版里已经验证过)。
 *
 * 真实 runtime 逻辑单一来源仍在 neox-core 的 runtimeWorkerEntry。
 * 这里多做一件宿主才知道的事: 先把已启用插件的 connector/tools 装进**本线程**的
 * toolPackRegistry。主进程 bootstrap 到不了 worker 那份单例, 不装的话设置页显示
 * 「已连接」, 模型 tool_search 却说没有 gcal_*。
 */
import { setRuntimePluginBootstrap } from '@neoxlabs/core/tools/packs/toolPack.js';

async function boot(): Promise<void> {
  const { bootstrapPlugins } = await import('../../../plugins/pluginIntegration.js');
  const run = () => bootstrapPlugins({ runtimeOnly: true });
  setRuntimePluginBootstrap(run);
  try {
    await run();
  } catch (err: any) {
    console.warn('[PLUGIN] runtime worker bootstrap failed:', err?.message ?? err);
  }
  await import('@neoxlabs/core/sdk/runtimeWorkerEntry.js');
}

void boot();
