# CLI 场景回归测试 (`apps/cli/src/__tests__/e2e/`)

真实进程级 CLI 回归: 非交互 `-p` / `--json` + 交互 PTY 场景。
不调真实模型的用例全部走本地假网关 (`infra/fakeGateway.ts`) 和隔离 HOME。

## 跑哪里、跑多久

```bash
# 全部 CLI e2e (串行, 约 5-8 分钟, 取决于机器负载). 根 vitest 默认排除本目录, 避免拖慢单测
npm run test:e2e:cli

# 只跑非交互 (直接指定文件, 走 e2e 配置)
npx vitest run --config vitest.e2e.config.ts apps/cli/src/__tests__/e2e/print-args.test.ts apps/cli/src/__tests__/e2e/print-output.test.ts

# 只跑交互
npx vitest run --config vitest.e2e.config.ts apps/cli/src/__tests__/e2e/interactive-slash.test.ts apps/cli/src/__tests__/e2e/interactive-runtime.test.ts

# 真调模型冒烟 (默认跳过, 4 个, 需要已登录的 neox-cloud)
NEOX_E2E_LIVE=1 npm run test:e2e:cli -- apps/cli/src/__tests__/e2e/live-smoke.test.ts
```

前置: `npm ci` 后 `npm run build:packages` (CLI 用 tsx 跑源码, `@neoxlabs/*` 需要 dist)。

> `vitest.e2e.config.ts` 串行执行 (`fileParallelism: false`)。并行跑时 CLI 冷启动会被拖到
> 10s 以上，触发默认超时；根 `vitest.config.ts` 因此把本目录排除，入口统一走上面的 npm script。

## 文件

| 文件 | 覆盖 |
|---|---|
| `print-args.test.ts` | 参数解析、`--provider` / `-m` 报错文案、`-c/-r` 拒绝、退出码、未知 flag |
| `print-output.test.ts` | `--json` 结构、流式纯文本、provider/model 解析、SSE 分块、上游 400、`--timeout`、`--yolo` 写文件、`--workdir`、`--no-session` |
| `interactive-slash.test.ts` | 40 条斜杠命令全部能打开/执行、不崩、回到输入态 |
| `interactive-runtime.test.ts` | 斜杠菜单/过滤、模型回合、ESC 中断、运行中再输入、60 列渲染、resize、Ctrl+L、历史、`/exit`、Ctrl+C |
| `live-smoke.test.ts` | 4 个真模型冒烟 (`neox-cloud` + `deepseek-v4.1-flash-1017`) |

## 隔离与稳定性约定

- **绝不碰真实 `~/.neox`**: `infra/workspace.ts` 每个用例建临时 HOME + `NEOX_HOME_DIRNAME=.neox`。
  必须显式设置 `NEOX_HOME_DIRNAME` —— 本仓开发 shell 里带着 `.neox-w-clie2e`，不覆盖会读写开发者真实配置。
- 网格关掉继承的 `NEOX_*` / 代理变量；`NEOX_USE_DAEMON=0` 保证 in-process。
- 假网关会区分标题生成等侧路请求 (`aux`)，不消费脚本队列，`chatRequests()` 只算主对话轮。
- `node-pty` 的 `spawn-helper` 在 `npm ci` 后可能丢可执行位；`infra/ptyCli.ts` 遇到
  `posix_spawnp failed` 会自动补 `chmod +x` 重试。
- 交互模式启动后的**第一个 Enter 会被吞**（早期输入捕获/首帧），`spawnPtyCli` 会先空敲一次 Enter 预热。
- “运行中”用状态栏 `Responding` 判定；流式文本只在回合结束时落到 PTY 输出，不能拿它当运行信号。
- 每个 PTY 用例结束都 `SIGKILL` + 删除临时目录；斜杠命令表在每条命令前 ESC + Ctrl+U 归位。

## 已知的 CLI 行为（测试按现状断言）

- 运行中按 Enter 是 **中断当前回合 + 用新消息开下一轮**（`utils/runningTaskInput.ts`），不是静默排队。
- `-p` 默认只读：写文件/执行命令必须显式 `--yolo`，否则 stderr 出现
  `Tool approval denied ... Pass --yolo`。
- 上游 5xx 会自动重试一次；4xx 直接失败（测试用 400 验证错误文案）。
- `/rc` 未登录时的提示是中文，不受 `config.language` 影响。

## 已知问题（本套件发现，未修）

- **`echo prompt | neox --json` 在配置了 provider 时会进交互 TUI 并挂住**，与
  `bootstrap/printMode.ts` 顶部注释承诺的管道模式不符；不带 provider 时反而会正确打印
  “No AI provider set up” 并退出。带 `-p` 的管道输入正常（有对应用例）。
- `-p --resume` 会把它后面的一个参数当作 resume id 吃掉（`-p --resume hello` 变成
  “无 prompt”），必须写成 `-p --resume <id> <prompt>`；测试已按当前行为断言。
- `/whoami` 在 `HIDDEN_COMMANDS` 里且注释写着隐藏命令仍可直接敲，但实际返回
  `Unknown command /whoami`（该命令已合并进 `/stats`）。本套件未为它写通过用例。
- 交互模式启动后约 1 秒内发送的第一个 Enter 会被吞（早期输入捕获/首帧动画期间）。
  `spawnPtyCli` 因此先空敲一次 Enter 预热；真实用户若启动后立刻回车可能遇到同样现象。
