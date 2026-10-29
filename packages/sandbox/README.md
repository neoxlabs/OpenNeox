# @openneox/sandbox

Neox 解耦沙盒核心。纯函数、零 neox 依赖 —— 给定「能力策略 + 命令」产出可直接 `child_process.spawn` 的规格。

## 能力模型 (四轴)

```ts
interface SandboxPolicy {
  fs: {
    read: 'all' | { roots: string[] };   // 默认 all (读无害, 程序需读系统库/证书)
    writeRoots: string[];                 // 可写子树 (工作区 + tmp + 包缓存)
    readOnlyWithin: string[];             // 写档内挖只读洞 —— 密钥护栏
  };
  net: 'none' | 'localhost' | 'all';
  proc: { exec: boolean };
}
```

## Tier 预设

| tier | read | write | net |
|---|---|---|---|
| `read-only` | all | ∅ | none |
| `workspace-write` | all | ws + tmp + 缓存 | none |
| `workspace-net` | all | ws + tmp + 缓存 | all |
| `trusted` | — | — | — (不沙盒) |

**密钥护栏** (所有档恒挂): `<ws>/.git`、`~/.ssh`、`~/.aws`、`~/.neox` 等即便落在可写 root 下也只读 —— 防偷改密钥 / git 历史 / `.git/hooks` 沙盒逃逸。

## 后端

- **macOS** — Seatbelt (`sandbox-exec`)。**参数化** profile (`(param "KEY")` + `-D KEY=path`),零注入。完整 sysctl/mach 基座白名单,正常命令不误伤。
- **Linux** — bubblewrap (`--ro-bind / /` 整盘只读 + 可写 root 重 bind + 只读洞覆盖);无 bwrap 回落 `unshare`。
- **Windows** — 阶段二 `appcontainer`（`CreateAppContainerProfile` + ACE on writeRoots，需 `koffi`）；回落阶段一 `restricted-token`（Job Object）；再不行则直跑 `ComSpec/cmd`（与 core shellInvocation 同源拼参）。

## 用法

```ts
import { tierToPolicy, buildSandboxInvocation, probeBackend } from '@openneox/sandbox';

const policy = tierToPolicy('workspace-write', {
  workspaceRoot: '/path/to/ws',
  home: os.homedir(),
  tmpDir: os.tmpdir(),
});

const inv = buildSandboxInvocation(policy, { command: 'npm test', cwd: '/path/to/ws' });
const child = spawn(inv.program, inv.args, { cwd: '/path/to/ws' });
// ... 执行完
inv.cleanup();
```

设计全文见 `docs/SANDBOX_DESIGN.md`。
