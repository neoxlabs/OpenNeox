# @openneox/workflow — 编排层

**目标 → 节点图，以及运行中改图。**

```
模板(数据) → workflow(编排) → cluster(底座) → core(agent loop)
              ↑ 本包                 ↑ 单向依赖, npm 强制
```

## 三层的分工

| 层 | 知道什么 | 不知道什么 |
|---|---|---|
| cluster | 节点、依赖、领地、预算、进度 | 为什么是这些节点 |
| **workflow** | **目标怎么拆、谁依赖谁、失败了怎么改图** | **节点内部怎么跑** |
| 模板 | 一套具体干法（teamwork 是其中一份） | 一切逻辑 |

## 目录

| 目录 | 放什么 |
|---|---|
| `src/template.ts` | `WorkflowTemplate` 解释器 —— 把模板数据变成可执行的节点图 |
| `src/planner.ts` | 动态规划: 目标 → `NodeSpec[]` |
| `src/replan.ts` | 失败 / 掉队 / 越界后改图 |
| `src/templates/` | 自带模板**数据**。teamwork 住这里。用户可自定义编辑。 |

## 边界（`src/__tests__/boundary.test.ts` 强制）

- ❌ **不许直接 `runSession`。** 本包只产出/修改 `NodeSpec[]`，执行一律交给 cluster。
  规划本身要调 LLM 的话，也是**声明一个规划节点**交给 cluster 跑，而不是自己起 runtime。
- ❌ **不许 import `@openneox/core`。** 它不在依赖里，引了就是幽灵依赖。
- ❌ **`templates/` 里不许有逻辑。** 模板是数据——要能被用户编辑、被存进库、被序列化。
  一旦含分支，用户就编辑不了了，也就没法"支持自定义"。

## 现状

架子已摆，内容待设计。cluster 侧的 `scheduler/` 已有 419 行纯函数（就绪集 / 预算 / 埋点），
`node/` 和 `integrate/` 也还是空的。
