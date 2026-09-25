# cluster/node — 执行层

**一个节点 = 一次完整的 neox agent 会话。** 不是阉割版 worker。

## 这里放什么

| 零件 | 职责 | 从哪来 |
|---|---|---|
| NodeRunner | 跑一个节点: `RuntimeOrchestrator.runSession` + 生命周期 | 新写, 骨架照抄老 team 的派发路径 |
| worktree 编排 | 建 / 保留 / 合并后清理 / 崩溃后 prune | core 有全套原语 (`worktreeIsolation.ts`), 这里只编排 |
| 事件桥 | `onRuntimeEvent` → `NodeTelemetry` | 新写 |
| 中止链 | 父 signal / 预算熔断 / 掉队处置 → 节点 abort | 搬老 team 的 `abortAllRunningLanes` 形状 |

## 搬运时必须就地改掉的两处

1. **`changedFiles` 改成问 git，不问 agent。**
   `telemetry.ts` 现在打算从工具事件推"它改了哪些文件"——那等于"agent 声称它改了什么"。
   改成 `git diff --name-only` 直接问 worktree：确定性、零幻觉，还能抓到绕过工具的 shell 写入。
   越界检测的输入必须可靠，事件流只用来算活跃度。

2. **节点 id 必须带 run 前缀。**
   `agentId` 同时是**子会话 id**，是全局命名空间（见 `agenticRuntime.ts` 的 `isAgentIdTaken`）。
   `node-1` 这种裸名跨会话必撞，撞了就是把新节点的输出追加进别人的旧子会话。
   形如 `clu-<runId>-<node>`。

## 边界

- ❌ 不许出现「目标 / 需求 / 角色 / 审查」这类词——那是 workflow 的语汇。
  这里只认 `NodeSpec`：id、prompt、依赖、领地、预算。**为什么这条 prompt 长这样，与本层无关。**
- ❌ 不许 import `@openneox/workflow`。依赖是单向的，由 npm 强制。
