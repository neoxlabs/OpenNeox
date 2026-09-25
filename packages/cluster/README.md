# @openneox/cluster — 集群底座

**agent loop 作为原子节点 + 确定性调度器。**

```
模板(数据) → workflow(编排) → cluster(底座) → core(agent loop)
                                   ↑ 本包
```

## 定位

| 层 | 知道什么 | 不知道什么 |
|---|---|---|
| **cluster** | **节点、依赖、领地、预算、进度** | **为什么是这些节点** |
| workflow | 目标怎么拆、谁依赖谁、失败了怎么改图 | 节点内部怎么跑 |
| 模板 | 一套具体干法（teamwork 是其中一份） | 一切逻辑 |

**节点内满血自主，节点间确定性调度。** 节点是对等的完整 neox（全套工具、能自己再派子 agent、
有自己的 worktree 和上下文），不是阉割版 worker——底层 agent loop 本来就强，做成受限 worker 是浪费。
而节点**之间**必须硬：依赖显式、拓扑序、不问 LLM。

## 目录

| 目录 | 内容 | 状态 |
|---|---|---|
| `src/scheduler/` | 就绪集 · 全局预算 · 埋点快照（纯函数，无 LLM） | ✅ 419 行 |
| `src/node/` | NodeRunner · worktree 编排 · 事件桥 · 中止链 | ❌ 待建 |
| `src/integrate/` | 持续集成引擎 · claim 注册表 | ❌ 待建 |

各目录的 README 写了具体放什么、以及搬运时必须就地改掉什么。

## 边界

- ❌ **不许出现「目标 / 需求 / 角色 / 审查」这类词** —— 那是 workflow 的语汇。
  这一层只认 `NodeSpec`：id、prompt、依赖、领地、预算。**为什么这条 prompt 长这样，与本层无关。**
- ❌ **不许 import `@openneox/workflow`** —— 依赖单向，由 npm 强制。
- ⚠️ **对 core 的入侵必须 mode 守卫。** 允许在 core 里加扩展点（枚举值 / 注册表 / 分支），
  但那些分支只能在集群模式下才可能进入——agentic 那条路径的行为一个字节都不能变。
  由 `src/__tests__/boundary.test.ts` 强制。

## 依据

- `experiments/ARCHITECTURE.md` —— 七轮实验的证据基线（哪些瓶颈是量化过的）
- `src/COORDINATOR.md` —— 协调层为什么要劈成「确定性调度器」和「协调 Agent」两半
- `src/CAPABILITY.md` —— 能力清单、缺口盘点、以及必须先验证的假设
