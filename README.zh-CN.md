<div align="center">

<img src="assets/brand/neox-app-icon.png" alt="" width="88">
<br><br>
<img src="assets/brand/wordmark-color.png" alt="OpenNeox" width="220">

<br>

**开源的终端 AI 编程 Agent。**<br>
自带模型 Key，无需账号，不走网关，不收集遥测。

<br>

[English](README.md) · **简体中文**

<br>

[![CI](https://github.com/neoxlabs/OpenNeox/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/neoxlabs/OpenNeox/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#快速开始)

</div>

---

`neox` 会读代码、跑命令、改文件，还会自己检查改得对不对 —— 在你指定的仓库里，
用你选的模型。一切都在你自己的机器上运行：会话、检查点、记忆和 API Key 都不会离开
本机，除了发给模型的那次请求。

- **什么模型都能用。** OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、通义千问、
  MiniMax、豆包、Grok、OpenRouter、Groq、Mistral、本地模型 —— 只要兼容 OpenAI 或
  Anthropic 协议就行。
- **真正干活的工具。** 改文件、搜索、Shell、Git 与 worktree、代码智能、解释器、
  浏览器自动化、联网调研、Office 文档、MCP、技能、子 Agent。
- **默认安全。** 每一次工具调用都要过权限检查；Shell 命令可以跑在系统沙箱里
  （macOS 用 Seatbelt，Linux 用 bubblewrap，Windows 用 AppContainer）。
- **整轮撤销。** 检查点会给这一轮改过的文件拍快照，`/rollback` 一步回到 Agent
  动手之前。
- **能写进脚本。** `neox -p` 执行一条指令并打印结果 —— 纯文本、JSON，或者符合你给的
  JSON Schema 的结构化输出 —— 适合 CI 和 Shell 管道。
- **能嵌进你的应用。** 同一套运行时以 SDK 形式提供，给你自己的 Node 应用用。

## 快速开始

需要 Node.js 20 及以上。包还没发布到 npm，先从源码构建：

```bash
git clone https://github.com/neoxlabs/OpenNeox.git
cd OpenNeox
npm ci
npm run build
npm link            # 把 `neox` 放进 PATH
```

添加模型 Key，交互式向导会把它存在本地：

```bash
neox provider add
```

或者直接导出环境变量，`neox` 会自动识别：

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # 也支持 OPENAI_API_KEY、GEMINI_API_KEY、
                                        # MOONSHOT_API_KEY、DOUBAO_API_KEY
                                        # （兼容端点再配 *_BASE_URL）
```

然后在任意项目里启动：

```bash
cd your-project
neox
```

## 用法

```bash
neox                              # 在当前目录开一个交互会话
neox "登录测试为什么挂了？"          # 执行一条指令，打印结果后退出
neox -c                           # 继续最近一次会话
neox -r                           # 挑一个历史会话恢复
neox -m <model> --provider <id>   # 这次用哪个模型
neox -d ../other-repo             # 在别的目录里干活
```

给脚本和 CI 用的非交互模式：

```bash
neox -p "总结一下这个分支改了什么"
neox -p --json "列出 src/ 里的 TODO"                   # stdout 输出一个 JSON 对象
neox -p --output-schema schema.json "提取所有 API 路由"
neox -p --yolo "把 lint 错误修掉"                       # 允许改文件、跑命令
```

不加 `--yolo` 时，`-p` 只读不写。

会话里的命令：

| 命令 | 作用 |
| --- | --- |
| `/session ls` · `/session new` · `/session export` | 管理会话 |
| `/checkpoint create [name]` | 给工作区拍快照 |
| `/rollback <id>` | 回滚到某个检查点 |
| `/provider` · `/model` | 切换服务商或模型 |

管理命令：

| 命令 | 作用 |
| --- | --- |
| `neox provider ls \| add \| test [id]` | 管理模型服务商 |
| `neox model ls` | 列出可用模型 |
| `neox mcp …` | 管理 MCP server |
| `neox skill …` | 管理技能 |
| `neox daemon …` | 后台守护进程 |

完整列表见 `neox --help`。

## 模型

一个服务商配置就是 API Key、模型和可选的 Base URL。
`packages/kernel/src/models/providerPresets.ts` 里的预设提供 Base URL、能力标记和
常用模型。适配层按协议统一工具 schema、思考开关、流式事件和消息配对：

| 协议族 | 适配器 |
| --- | --- |
| OpenAI | `openai`、`openai-responses` |
| Anthropic | `anthropic`、`anthropic-openai`、`glm-claude`、`kimi-claude` |
| Google | `gemini` |
| 其他原生协议 | `deepseek`、`kimi`、`glm`、`qwen`、`minimax`、`doubao`、`grok` |
| OpenAI 兼容预设 | OpenRouter、Mistral、Groq、Together AI、Dashscope、opencode Zen |

没有预设也没关系：任何兼容 OpenAI 或 Anthropic 协议的端点都能直接用，包括你本机跑的模型。

## 安全模型

三层互相独立，谁也替代不了谁：

- **权限** —— `PermissionManager` 对每一次工具调用做决定，读、写、破坏性操作、
  花钱的操作分开归类。
- **沙箱模式** —— 每次运行的粗粒度策略，整类整类地开关工具。
- **系统沙箱** —— `packages/sandbox` 把策略编译成 Seatbelt、bubblewrap/unshare 或
  AppContainer 的启动方式；没有可用后端时退回直接执行，并且会说明原因，不会悄悄失败。

## SDK

```ts
import { Agent, tool } from '@neoxlabs/sdk';
import { z } from 'zod';

const agent = new Agent({
  model: 'claude-sonnet-5',
  tools: [
    tool({
      name: 'read_invoice',
      description: '按 id 读取一张发票',
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => db.invoices.get(id),
      readOnly: true,
    }),
  ],
});

const result = await agent.run('总结发票 INV-204');
console.log(result.text);
```

`createSession` 跨调用保留对话和工具状态；`provider` / `providerFromEnv` 选择模型后端；
权限决定由你的应用提供 `PermissionHandler`。

## 架构

```
apps/cli/         `neox` 终端应用（Ink）
packages/
  kernel/         Agent 循环、服务商、消息与工具类型、权限
  platform/       配置、SQLite 存储、日志、模型注册表
  core/           运行时、工具、模型适配、会话、MCP、技能
  sdk/            可嵌入的 Agent / 会话 API
  sandbox/        系统沙箱策略编译与启动后端
  cloud/          可选能力契约，默认关闭
  …               evals、workflow、cluster、pptx、native、devtools、test-harness
plugins/          公开插件实现
```

一轮对话：编排器选定服务商和模型并打开检查点；`StreamedRunner` 流式接收回复，
校验每个工具调用，经过权限和沙箱后执行，把结果接回对话，如此循环，直到模型停下、
你取消，或者预算用完。详见 [docs/architecture.md](docs/architecture.md)（英文）。

## 开发

```bash
npm run type-check      # TypeScript 严格模式
npm test                # 单元测试（需 Node 22：会话测试用到 node:sqlite）
npm run check:arch      # 包边界、导出、模块路径
npm run audit:comments  # 注释质量闸
npm run check:licenses  # 许可证元数据
```

扫源码的测试需要 `ripgrep`，Shell 回归测试需要 `zsh`。`packages` 不允许 import
`apps`，违反时 `npm run check:boundaries` 直接让构建失败。

## 许可证

[Apache 2.0](LICENSE)。第三方材料保留各自的许可证，见 [NOTICE](NOTICE)。

## 参与贡献

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，
进行中的工作见 [docs/status.md](docs/status.md)。安全问题请按 [SECURITY.md](SECURITY.md)
私下报告，不要开公开 issue。
