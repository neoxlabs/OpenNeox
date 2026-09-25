# @openneox/devtools

用于开发和诊断的 **agent 运行时监控**工具，不会进入默认桌面构建。

## 解耦保证

- 默认产品构建里 **0 行监控代码**。
- 本包是 devDependency,默认通过两条路径工作,都不污染产品:
  1. **进程外纯订阅(推荐,零产品改动)**:连接本机 WSGateway(`ws://127.0.0.1:<port>/ws`),被动订阅事件流。
  2. **in-process 深度 attach(可选)**:仅在 `__NEOX_DEVTOOLS__=true` 的测试构建里,由产品 bootstrap 动态 import `attach.js`。生产构建 `__NEOX_DEVTOOLS__=false` → 该分支被 DCE 删除 → 本包永不进 bundle。
- 桌面打包配置会排除 `@openneox/devtools`，避免监控代码进入默认发行包。

## 用法

```bash
# ① 终端仪表盘(进程外纯订阅,自动发现本机 server)
npx tsx packages/devtools/src/cli.ts monitor

# ② Web 仪表盘(node 桥接 SSE + 托管 React)—— 推荐
#    先构建一次前端: cd packages/devtools/web && npm i && npm run build
npx tsx packages/devtools/src/cli.ts serve --port 7399
#    浏览器打开 http://127.0.0.1:7399

# 手动指定 / 列出 server
... monitor --attach 127.0.0.1:4399 --token <t>
... list
```

### Web 仪表盘开发模式
```bash
# 终端 A: 桥接数据
npx tsx packages/devtools/src/cli.ts serve --port 7399
# 终端 B: vite 热更新(代理 /api → 7399)
cd packages/devtools/web && npm run dev   # http://127.0.0.1:7400
```

## 深度模式(控制平面:stall / loop / lock)

进程外订阅只能拿数据平面;要 stallGuard 卡死等控制平面信号,需让产品 server 进程内 attach。
**产品侧唯一接线点**在 `server/main.ts`,env 门控 + 变量字符串动态 import(编译期零依赖,默认构建不含):

```bash
# 用 tsx 跑 server(内部测试),开启深度模式 + 进程内仪表盘端口
NEOX_DEVTOOLS=1 NEOX_DEVTOOLS_PORT=7399 <启动 server 的命令>
# 浏览器打开 http://127.0.0.1:7399 —— 顶部 badge 显示 DEEP, Stalls 面板生效
```

- `NEOX_DEVTOOLS` 未设(客户默认)→ 那段 `if` 不进入,动态 import 不触发,**零成本**。
- devtools 是 devDependency,`electron-builder.files` 应加 `"!**/node_modules/@openneox/devtools/**/*"` 双保险。

## 两种数据深度

| 模式 | 数据平面(对话/工具/token) | 控制平面(stall/loop/lock) | 产品改动 |
|------|---------------------------|---------------------------|----------|
| 进程外订阅 | ✅(从 WS 事件流派生) | ❌(WS 流里没有) | 0 |
| in-process attach | ✅ | ✅(读 stallGuard 等被动 getter) | 1 处 DCE 分支 |

## 架构

```
事件源(产品, 不动)                 监控(本包, 寄生只读)
RuntimeEventHub.emit ──┬─→ 现有 sinks          ← 不碰
                       └─→ EventBus → WSGateway ─→ MonitorClient ─→ MonitorAggregator ─→ MonitorState ─→ 渲染
                                                   (进程外)                                               (终端/web)

深度模式: attachMonitor(hub) 直接挂只读 sink + 周期采样 stallGuard.getInflightStalls()
```

`MonitorState` 是前端无关的数据契约,终端仪表盘和后续 web 仪表盘消费同一份。
