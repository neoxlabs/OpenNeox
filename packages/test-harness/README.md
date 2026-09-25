# @openneox/test-harness

产品回归场景包（≠ evals）。**CLI / Desktop 分目录**。

## 能力覆盖（重点）

| 域 | CLI | Desktop |
|---|---|---|
| Provider 配置和本地会话 | `cli.provider` / `cli.session` | `desktop.provider` / `desktop.session` |
| 会话切换/新建/删除 | `cli.session` | `desktop.session` 矩阵 |
| HTML / Vite / PPT / Word / Sheet | `cli.artifact` | `desktop.artifact` + surface 打开 |
| 用户配置的 OAuth 插件 | — | `desktop.cap.oauth-*` |
| 可选云能力边界 | — | `desktop.cloud` |
| Agent 对话组合 + 矩阵 | `cli.agent-flow` + `cli.mx.*` | `desktop.agent-flow` + `desktop.mx.*` |
| Timeline 布局 | — | `desktop.timeline-layout` |

## 命令

```bash
npm run neox-test -- modules
npm run neox-test:flows:cli
npm run neox-test:flows:desktop
npm run neox-test:cap:cli          # 登录/会话/产出能力
npm run neox-test:cap:desktop
npm run neox-test -- checklist --id desktop.cap.artifact-html__pin-tab
npm run neox-test:smoke
```

## 加用例

- CLI → `src/catalog/scenarios/cli/`
- Desktop → `src/catalog/scenarios/desktop/`
- 能力串联用 `kind:'flow'` + `mustNot` + `assertUi`
