# benchmarks

两套跑分台，2026-09-21 从 `~/AI/MK/neox-codebench` 和 `~/AI/MK/neox-webbench` 并进来。
并进来的只有台子本身；历次跑分产物（codebench 的 `work/` 86M、`results/` 27M）留在原处，
不进仓——它们是运行输出，不是源码。

| 目录 | 测什么 | 入口 |
|---|---|---|
| `code/` | 桌面端与 CLI 的编码任务 | `cli-run.mjs` · `desktop-run.mjs` |
| `web/` | 浏览器工具的往返次数 | `runner/agent.mjs` · `runner/replay.mjs` |

## 工作目录必须在判分树外

`WORK` 永远指到仓库外，默认 `/private/tmp/cb-work`：

```bash
WORK=/private/tmp/cb-work node benchmarks/code/desktop-run.mjs
```

这不是洁癖。2026-09-11 那一轮结果整批作废，原因是工作目录当时在跑分仓内，被测
agent 沿 `../` 翻上去读到了 `tasks-v2.mjs`——里面写着验收标准——照着它写答案。
同批次的竞品没翻，所以那次对比毫无意义。`desktop-run.mjs` 文件头也记着这件事。

并进 `Neox` 之后多了一条新约束：**不要把被测 agent 的工作区指向 Neox 仓自身**。
以前判分脚本住在 `~/AI/MK/neox-codebench`，跟仓库是兄弟关系；现在它就在仓里，
一旦 agent 的工作区是这个仓，任务定义和验收标准直接在它眼皮底下。

## code/

`tasks.mjs` 是第一版任务集，`tasks-v2.mjs` 是现行的。`templates/cece/` 是任务用的
初始工程（一个宠物管理系统），每轮跑分复制一份到 `WORK` 下再让 agent 动。

跑完用 `reverify-v2.mjs` 复核、`compare.mjs` / `final-compare.mjs` 出对比。
`analyze.mjs` 读 CLI 日志里的 usage 算花费。

## web/

`app/server.mjs` 起一个本地靶站，`tasks/tasks.mjs` 定义任务，`runner/` 下三个脚本分别是
实跑（`agent.mjs`）、录制回放（`replay.mjs`）和理论下限（`floor.mjs`）。
`recipes/` 里每个 `SKILL.md` 是一条给 agent 的操作配方。

判据是**往返次数**，不是耗时——耗时随网络和模型波动，往返数是工具设计的直接产物。
跑的时候固定用 flash 档模型，pro 档会把往返数压下去，掩盖掉工具本身的问题。
