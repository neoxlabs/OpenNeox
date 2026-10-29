# 桌面端场景回归 (desktop e2e)

一条命令跑完一批「用户真实操作路径」的桌面端回归。每次合并前跑一遍（不调模型那档，约 5～6 分钟）。

```bash
# 全量 (不调模型; 需要先有构建产物 ui:build-electron)
npm run test:e2e:desktop

# 改了 packages/* 或主进程代码, 连构建一起
npm run test:e2e:desktop:build

# 连需要真模型回复的场景 (走订阅, 一句话任务, 数量 ≤15)
npm run test:e2e:desktop:model

# 只跑某几个模块 / 只列场景 / 套件自检 (不启 Electron)
node scripts/e2e/desktop/run.mjs --only boot,modes
node scripts/e2e/desktop/run.mjs --list
node scripts/e2e/desktop/run.mjs --self-check
```

## 它做什么

- 起一个**隔离**的真实实例: `NEOX_HOME_DIRNAME=.neox-e2e`, vite 5191 / server 4511 / CDP 41811。
  登录态从 `~/Library/Application Support/Neox/{auth,gateway-key}.enc` 和 `machine-id` 复制到隔离 home。
- 用 CDP（`playwright-core` 连 Electron 的 `--remote-debugging-port`）驱动**真实点击**。
- 每个场景: 操作 → 断言界面（文本 / 元素存在 / 无报错浮层 / 无未捕获异常）→ 必要时断言磁盘。
- 失败自动截图到 `scripts/e2e/desktop/artifacts/`。
- 结束打印结果表（通过/失败/耗时）并写 `artifacts/report-<runId>.json`。
- 跑完自动收尾: 杀 Electron / vite / server, 清理隔离 home（`--keep-home` 可保留排查）。

## 目录

```
run.mjs              入口: 起实例 / 调度场景 / 出结果表 + JSON
lib/instance.mjs     隔离实例启动 (vite + server + Electron + CDP) 与收尾
lib/ui.mjs           跨场景复用的界面动作 (真实 DOM 选择器 + 常用操作)
lib/assert.mjs       断言 / 轮询等待
scenarios/*.mjs      按模块分文件的场景, 每个模块导出 { id, title, scenarios: [...] }
artifacts/           失败截图 + JSON 报告 (不入库)
```

## 加场景

在 `scenarios/` 对应模块文件的 `scenarios` 数组里加一项:

```js
{
  id: 'module.name',        // 全局唯一
  title: '一句话说明',
  model: false,             // true 表示会真调模型, 默认档会跳过
  timeoutMs: 60_000,        // 可选, 默认 60s (model 默认 240s)
  run: async ({ page, reset, shot }) => {
    // 用 lib/ui.mjs 里的动作, 用 lib/assert.mjs 的 assert / waitFor
  },
}
```

`run` 抛错即判失败并截图。新增/改 UI 导致选择器过期时，先 `--only <模块>` 快速定位。

## 注意

- 场景之间默认 `reset`（刷新复位 + 归一到 Code 模式）。模式会跨刷新保留，所以每个场景开始都强制回 Code，避免互相污染。
- 草稿空会话全局只有一个（新建会替换当前空会话），所以「两个会话来回切」这类场景必须有真实内容，标了 `model: true`。
- 需要真调模型一律走订阅（`neox-cloud`），**不要**用本机 BYOK provider。
