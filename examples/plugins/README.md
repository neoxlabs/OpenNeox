# Neox 示例插件

这些插件展示 plugin 系统的扩展点用法. 直接克隆 + `neox /plugins dev <path>` 即可试用.

## 插件清单

| 插件 | 模板 | 展示内容 |
|---|---|---|
| [hello-world](./hello-world) | basic | 最小插件 — skill + 命令 + tool |
| [ppt-outline](./ppt-outline) | ui-view | UI 面板 + tool + 命令, 演示 PPT 类领域插件 |
| [oauth-claude](./oauth-claude) | auth | Claude.ai / Console 订阅 OAuth (PKCE) |
| [oauth-codex](./oauth-codex) | auth | ChatGPT / Codex 订阅 OAuth (PKCE) |
| [oauth-grok](./oauth-grok) | auth | SuperGrok / Premium+ OAuth (PKCE) |

打包好的 tarball（可直接用桌面「+ 安装」选文件）在 [`dist/`](./dist/)：

- `dist/oauth-claude-0.1.0.tar.gz`
- `dist/oauth-codex-0.1.0.tar.gz`
- `dist/oauth-grok-0.1.0.tar.gz`

> Auth 插件：安装启用后，到 **设置 → API 服务商** 顶部「官方订阅登录」点登录。PKCE 在插件内；宿主不打包 `@neoxlabs/oauth-*`。详见 `内部设计文档`。

## 本地开发流程

```bash
# 1. 复制一个示例做起点
cp -r examples/plugins/hello-world ~/.neox/plugins/my-plugin
cd ~/.neox/plugins/my-plugin

# 2. 在 CLI 里以 dev 模式加载 (不复制, 直接链接)
neox /plugins dev $(pwd)

# 3. 修改 plugin.json / tools / skills 后, 重启 Neox 即刷新
```

## 用脚手架创建自己的插件

```bash
neox /plugins create my-new-plugin --template=basic
# 或
neox /plugins create my-new-plugin --template=ui-view
```

## 扩展点速查

- **skills/** — SKILL.md 提示模块, 用户可用 /skills 调用
- **commands/** — 斜杠命令模板 (.md, frontmatter + body)
- **tools/index.js** — 导出 `createTools(ctx): Tool[]`, 贡献 AI 工具
- **hooks.json / hooks 字段** — pre/post toolCall shell 钩子 (exit 1/2 可阻止工具)
- **agents/** — Agent 类型定义 (.md 带 frontmatter, 或 .json)
- **views** (manifest 字段) — iframe UI 面板, 用 neox-plugin:// 协议加载
- **mcpServers** — 以 MCP Server 形式贡献一批工具
- **authProvider** (manifest, `kind: auth`) — 官方订阅 OAuth factory 入口
