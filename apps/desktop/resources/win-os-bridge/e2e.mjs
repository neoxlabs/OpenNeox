/**
 * 端到端验证 —— 走**真实 TS 链路**, 不是裸协议。
 *
 *   为什么另写一个 (smoke.mjs 已经在跑协议了): 协议通 ≠ 产品通。真正上模型的那条路是
 *   `computer_snapshot` → 编号 → `computer_run({steps})` → `expectChange` 判定,
 *   中间还有守卫、重定位、快照渲染、断言口径。这一层如果没跑过, "桥能说话"跟
 *   "模型能用它干活"之间就还差着一次真实验证。
 *
 * 用法: node apps/desktop/resources/win-os-bridge/e2e.mjs
 */
import { computerSnapshot, runComputerScript } from '../../../core/dist/runtime/computer/computerRun.js';
import { resolveBridgeBinary, getOsBridge } from '../../../core/dist/runtime/computer/osBridgeClient.js';

const MARK = `neox e2e ${new Date().toISOString().slice(11, 19)}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log('── 环境 ──');
const bin = resolveBridgeBinary();
check('本平台解析到的是 Windows 桥 (不是 mac 那份)', !!bin && bin.toLowerCase().endsWith('.exe'), bin ?? '(null)');

console.log('\n── 感知 (computer_snapshot) ──');
const snap = await computerSnapshot('notepad');
/* snapshot 成功时返回的是**给模型看的那份**(actionable / digest), 失败才是 {ok:false, code} */
check('snapshot 成功', snap.ok !== false, snap.ok === false ? `${snap.code}: ${snap.error}` : `${snap.ms}ms / ${snap.elementCount} 个元素`);
if (snap.ok === false) {
  console.log('  snapshot 回执:', JSON.stringify(snap).slice(0, 700));
  console.log('\n✗ 感知就没通, 后面不用跑了');
  process.exit(1);
}
console.log(`  模型看到的编号清单:`);
for (const line of snap.actionable ?? []) console.log(`    ${line}`);
if (snap.digest) console.log(`  文本摘要: ${snap.digest}`);

/* 编号只能从这份清单里读出来 —— 模型也是这么干的, 所以这里也这么干 (别走内部捷径) */
const editLine = (snap.actionable ?? []).find((l) => l.includes('[Edit]'));
const editId = editLine ? Number(/^(\d+)\./.exec(editLine)?.[1]) : undefined;
check('编号清单里能读出输入框', Number.isInteger(editId), `编号 ${editId} ← "${editLine ?? ''}"`);

console.log('\n── 执行 (computer_run 一段脚本) ──');
const run = await runComputerScript({
  app: 'notepad',
  steps: [
    { action: 'set_value', target: editId, text: MARK, label: '写入标记文本', expectChange: { watch: 'screen' } },
    { action: 'key', key: 'end', label: '光标移到末尾' },
  ],
});
for (const s of run.steps ?? []) {
  console.log(`    ${s.ok ? '✓' : '✗'} [${s.index}] ${s.action}${s.label ? ` (${s.label})` : ''} ${s.ms}ms ${s.error ?? ''}`);
}
check('脚本整体成功', run.ok === true, `${run.ranSteps}/${run.totalSteps} 步, ${run.totalMs}ms`);

console.log('\n── 读回 (界面真的变了吗) ──');
/* 用桥的 read 直读那个元素的值 —— 还是产品自己的客户端, 只是绕过了给模型看的渲染 */
const readBack = await getOsBridge().request({ op: 'read', app: 'notepad', target: editId });
check('记事本里出现了刚写的文本', String(readBack.value ?? '').includes(MARK),
  `值 = ${JSON.stringify(String(readBack.value ?? '').slice(0, 90))}`);

console.log('\n── 守卫 (模型走这条路也必须被拒) ──');
const denied = await runComputerScript({ app: 'cmd', steps: [{ action: 'type', text: 'whoami' }] });
const deniedText = JSON.stringify(denied.steps ?? []);
check('对终端的脚本被拒 (早拦或桥那层拦都算)',
  denied.ok === false && /终端|terminal|app_forbidden_terminal/.test(deniedText),
  deniedText.slice(0, 120));

console.log(failures === 0 ? '\n✓ 端到端通过\n' : `\n✗ ${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
