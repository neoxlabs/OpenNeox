# OpenNeox

OpenNeox 是 Neox 的开源命令行 AI Agent（`neox`）及其底层 TypeScript 运行时，
同一套运行时也以 SDK 形式提供，可以嵌进你自己的 Node 应用。

## 功能

- 与供应商无关的 Agent 内核：流式输出、工具调用、权限控制和有界执行。
- BYOK（自带 API Key）模型配置，支持 OpenAI 兼容、Anthropic 兼容等协议。
- 会话、检查点、记忆和凭据都留在运行 Agent 的那台机器上。
- 工具沙箱、MCP、插件、技能和 SDK 扩展点。
- `packages/cloud` 只提供可选能力契约，默认没有云端实现和服务地址。

## 从源码运行

依赖 Node.js 20+ 和 npm。

```bash
npm ci
npm run type-check
npm test
npm run build
node apps/cli/dist/cli/main.js --version
```

用 `neox provider` 配置你自己的模型 API Key。CLI 可执行文件名为 `neox`。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `apps/cli` | 终端宿主和命令行界面 |
| `packages/kernel` | 供应商无关的 Agent 循环和契约 |
| `packages/platform` | 配置、存储、日志和宿主服务 |
| `packages/core` | 运行时、工具、模型、会话和服务适配器 |
| `packages/sdk` | 面向使用者的 Agent API |
| `packages/cloud` | 默认关闭的可选能力契约 |
| `packages/sandbox` | 操作系统沙箱策略和调用工具 |
| `plugins` | 公开插件实现 |
| `docs` | 架构和贡献者文档 |

架构和数据流见 [docs/architecture.md](docs/architecture.md)。

## 扩展方式

**插件**通过 manifest 提供工具、hooks、MCP server、connector 映射和外部
Agent。凭据与权限决定由宿主控制。

**SDK** 使用者可以通过 `@openneox/sdk` 创建 Agent、增加工具、选择供应商并
消费流式事件。

**MCP** server 是由用户管理的集成。OAuth client ID、token 和 endpoint 由
用户或部署方提供，仓库不内置供应商凭据。

## 开源版与官方产品的区别

开源版是完整的本地 CLI 运行时，不包含账号、订阅、云市场、官方模型网关，
也不包含 Neox 桌面端和手机端。托管服务只在 `packages/cloud` 中保留了默认
关闭的扩展契约。

本仓库默认不会发布数据或连接托管服务。

## 许可证

项目代码使用 [Apache License 2.0](LICENSE)。第三方材料继续使用各自的原
许可证，详见 [NOTICE](NOTICE) 以及资源旁的 license notice。

## 参与贡献

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)
和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
