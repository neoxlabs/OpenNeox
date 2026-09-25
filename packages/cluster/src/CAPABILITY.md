# 集群能力设计 · 调研

> 承接 `experiments/ARCHITECTURE.md`（实验证据）与 `COORDINATOR.md`（协调层怎么劈）。
> 这一篇回答的是没人回答过的那个问题：**集群到底能干什么、由哪些零件构成、哪些已经有了、哪些是空的。**

---

## 结论先行

1. **已建的全是"算"的部分**（就绪集 / 预算 / 埋点，三个纯函数模块 417 行），一行也跑不起来 —— **执行层是零**。
2. **最大缺口不是调度，是"常开机制"**：持续集成、claim 注册表、覆盖度闸。这三件对应的实测代价分别是 460 个错误 / 24-28 个重复文件 / 23% 需求漏做，而三件的实现成本都极低且**不含 LLM**。
3. **整个调度器压在一条未验证的假设上**：节点能不能把跨节点依赖**显式声明出来**。hrbench 的 460 个错误恰恰证明了它们**运行期没识别出来**。如果规划期也识别不出，`dependsOn` 就是摆设，`readySet.ts` 是空壳。**这条必须先测，再谈其余。**
4. 包本身有两处不自洽（见 §8），顺手记着。

---

## 一、能力清单 —— 集群比单 agent 多出来的到底是什么

先把"能力"定义清楚，否则会滑向"多开几个 agent"这种伪能力。**单 agent 已经很强，集群只有在提供它拿不到的东西时才成立。**

| # | 能力 | 单 agent 有没有 | 证据 |
|---|---|---|---|
| C1 | **并行墙钟压缩** | ❌ | k=2 单位时间交付 1.19×（⚠️ n=1，40% 历史方差，**这条最弱**） |
| C2 | **跨节点依赖显式化** | ❌ 依赖隐含在上下文里 | 460 错误，抽样 13/20 是"跨模块的东西没人定" |
| C3 | **确定性仲裁**（编译器当裁判，不是 agent 互相商量） | ❌ 单 agent 无缝可对 | 集成错误 100% 是接口对齐，零业务逻辑 |
| C4 | **领地/命名的先到先得** | ❌ | k=2 → `org/`+`peopleorg/`；k=4 → 再多 `hr/`+`shared/` |
| C5 | **做完没有的判据** | ❌ 77% 就自称完成 | k=1 缺 7 项功能 |
| C6 | **掉队者可观测 + 可处置** | ❌ 单会话没有"队" | k=4 节点 14.3/17.3/19.0/**19.4** min，最慢的决定墙钟 |
| C7 | **全局并发收口** | ❌ core 里是三层各管各的常数 | 3 节点 × 3 子 agent = 12，不是 3 |

**注意 C3/C4/C5 严格来说不是"并行才有"的能力** —— 它们是工程机制，单 agent 装上同样受益（ARCHITECTURE.md §2⑤ 已经指出：覆盖度闸修好之后单 agent 本身就能接近 97%）。

这引出一个必须写下来的判断：

> **集群的收益里，"并行"那部分（C1）是最弱、方差最大、唯一可能是噪声的一条；
> "工程机制"那部分（C3/C4/C5）是最硬、最便宜、且不依赖并行成立的。**
>
> 所以落地顺序应该反过来：**先把常开机制做出来（单节点就能验），再谈多节点。**
> 先冲并行是拿最不确定的收益去付最高的协调成本 —— 那正是 k=4 变成 0.64× 的原因。

---

## 二、缺口盘点

| 层 | 零件 | 状态 | 备注 |
|---|---|---|---|
| 类型 | `types.ts` | ✅ 152 行 | NodeSpec / WorkflowTemplate / Budget / Event 都定了 |
| 调度 | `readySet.ts` 就绪集 + 环检测 + 领地重叠检测 | ✅ 136 行纯函数 | 有测试 |
| 调度 | `budget.ts` 全局并发/token 记账 | ✅ 92 行 | **只有记账，没有接线到 core** |
| 调度 | `telemetry.ts` 快照/掉队/静默/越界 | ✅ 189 行纯函数 | **消费的事件流还没人喂** |
| **执行** | **NodeRunner（节点 = 一次 runSession）** | ❌ **空** | §3 |
| **执行** | **worktree 生命周期编排** | ❌ 空（core 有原语） | §3.2 |
| **执行** | **runtime 事件 → NodeTelemetry 的桥** | ❌ 空 | §3.3 |
| **常开** | **持续集成引擎** | ❌ 空 | §4.1 · 代价最大解法最便宜 |
| **常开** | **claim 注册表** | ❌ 空 | §4.2 |
| **常开** | **覆盖度闸** | ❌ 空 | §4.3 |
| 协调 | 协调 Agent 接线（快照 → 决策 → 指令） | ❌ 空 | COORDINATOR.md 设计完了，没实现 |
| 收口 | 并发跨层统一 | ❌ 需要 core 一个 mode 守卫的扩展点 | §5 |
| 模板 | WorkflowTemplate 的解释器 | ❌ 空 | `exports` 里已经占了 `./workflow/*` 的坑 |
| 集成 | 模式接入（core `AgentRunMode` 目前只有 `'agentic'`） | ❌ 空 | §6 |

**419 行"算"的代码，0 行"跑"的代码。** 这是当前最准确的一句话总结。

---

## 三、执行层 —— 最大的空

### 3.1 节点 = 一次 `RuntimeOrchestrator.runSession`

实验里已经验证过这条路可行（七轮实验全部走的 `runSession`，与产品同一个 agent loop）。现成签名（`runtimeOrchestrator.ts:80`）里，集群需要的全都有：

```
sessionId          → 节点 id（同时是子会话 id —— 见下面那颗雷）
prompt             → 节点意图（不是步骤清单）
abortSignal        → 掉队处置 / 预算熔断的执行手段
onRuntimeEvent     → 【关键】telemetry 的唯一数据源，零 token 观测就靠它
buildHostConfig    → 每节点独立 workDir（worktree）、独立模型
```

**不需要给 core 加任何东西就能跑起来第一个节点。** 执行层是纯外部编排。

⚠️ **一颗现成的雷**：工作区里刚修的 `isAgentIdTaken`（`agenticRuntime.ts:336`）说明 **agentId 同时被当成子会话 id，是全局命名空间**。集群节点 id 直接当 sessionId 用会撞上同一个坑 —— 节点 id 必须带 run 前缀（`clu-<runId>-<node>`），不能是 `node-1` 这种。这条在 `types.ts` 的注释里没写，得补。

### 3.2 worktree

core 已有全套原语（`worktreeIsolation.ts`：`createWorktree` / `cleanupWorktree` / `removeWorktree` / `pruneStaleWorktrees` / `listWorktrees`），集群只需要编排：

```
节点开跑  createWorktree(workDir, nodeId) → 分支 + 独立目录
节点跑完  不立刻 cleanup —— 持续集成引擎要反复读它
run 结束  cleanupWorktree（合并）/ removeWorktree（丢弃）
崩溃恢复  pruneStaleWorktrees
```

**决策：合并由集成引擎做，不由节点做。** 节点不该碰 git 合并 —— 那是确定性动作，交给 agent 只会引入幻觉和 merge 冲突的自由发挥。

### 3.3 事件桥（`onRuntimeEvent` → `NodeTelemetry`）

`telemetry.ts` 定义了要什么（lastTool / turns / tokens / changedFiles / lastActivityAt），但**谁来填没写**。桥的职责：

```
tool_call 事件      → lastTool, lastToolAt, toolCalls++, lastActivityAt
write/edit 类工具   → changedFiles.set(path, +1)     ← 越界检测的唯一输入
token usage 事件    → inputTokens/outputTokens       ← 预算熔断的唯一输入
turn 边界           → turns++
```

**设计约束（COORDINATOR.md §1 已定）**：这条桥是**只读旁路**，不回灌任何东西进节点上下文。节点完全不知道自己被观测着。

⚠️ 风险：`changedFiles` 从工具事件推，等于"agent 声称它改了什么"。**更可靠的是 `git diff --name-only` 直接问 worktree** —— 确定性、零幻觉、还能抓到 shell 里绕过工具的写入。建议 telemetry 的 `changedFiles` **改成从 git 采**，事件流只用来算活跃度。这是对现有设计的一处修正。

---

## 四、常开机制 —— 该先做的三件

共同点：**全部不含 LLM，全部单节点就能验证收益，全部实现成本极低。**

### 4.1 持续集成引擎（代价 460，解法几乎免费）

```
每 3-5 分钟:
  各 worktree 分支 → 合到集成分支 → 跑 verifyCommand（tsc --noEmit）
  错误按文件路径归属到节点 → 作为下一轮消息喂回该节点
  归属不到任何领地的错误 → 升给协调 Agent（这就是"切错面"的信号）
```

`WorkflowTemplate.features.continuousIntegrationMs` / `verifyCommand` 的坑已经在 `types.ts` 留好了，引擎是空的。

三个必须现在就想清楚的问题：
- **合并冲突怎么办？** 领地不重叠 → 理论上不冲突。真冲突了 = 领地划错了 → 这本身是最有价值的告警（`scope_conflict`），升给协调 Agent，**不要让 agent 自己解冲突**。
- **错误回灌怎么不打断节点？** 节点正在跑一轮的时候不能插话。走 `pendingMessages` 那类轮次边界注入（core 的 sub-agent 已经有这个机制）。
- **回灌多少？** 只给**属于你的**错误，别给全量 460 条。归属靠文件路径 ∈ ownedPaths —— 确定性。

### 4.2 claim 注册表（24-28 个重复文件）

先到先得的文件锁，写文件，不过 LLM。零 token、零延迟、结果确定。
`readySet.ts` 里已经有**静态**的领地重叠检测（规划期），claim 注册表管的是**运行期**：节点想建 `org/` 时先 claim，第二个节点 claim 失败 → 拿到"已被 node-a 占了，用它的"，而不是自己另起一个 `peopleorg/`。

### 4.3 覆盖度闸（77% → 97%）

需求清单逐条核对才准收工。**这是唯一一件需要 LLM 的常开机制**（判断"这条做了没有"是语义判断），但它是**收敛的**：清单固定、逐条判、有终点，不是开放式协商。

**这件事单 agent 就能验，而且 ARCHITECTURE.md 说它可能把 77% 直接推到 97%** —— 投入产出比全场最高，且不依赖集群任何其它部分。**建议作为第一个落地的零件。**

---

## 五、并发收口 —— 唯一需要动 core 的地方

`budget.ts` 会记账，但 core 现在有两个**独立的、模块内私有的**常数：

```
backgroundAgent.ts:89   MAX_CONCURRENT_BACKGROUND_AGENTS  （写入型子 agent，默认 3）
agenticModeTools.ts:296 MAX_PARALLEL_EXPLORES             （explore，默认 2）
```

两者都是模块级 `const`，只有 env 能改。集群化后变成三层各管各的，**没有任何地方知道总并发是多少**。

**方案（必须是 mode 守卫的，`boundary.test.ts` §3 会验）**：core 加一个可选的**准入回调**，不传 = 现在的行为一个字节不变；集群模式下传入 `ClusterBudgetTracker.tryAcquire`。形态跟刚加的 `isAgentIdTaken` 完全一致 —— 那是个现成的、已经被接受的先例，照抄它的形状即可。

⚠️ 别用 env 传：`boundary.test.ts` §2 明令禁止改 `NEOX_*`（同进程跑的 agentic 会被波及）。

---

## 六、模式接入

`modeFactory.ts:9` 现在是 `export type AgentRunMode = 'agentic'` —— 单值联合。加 `'teamwork'` 会波及 `main.ts` / `chatRequestPreparation` / `sessionAborter` / `hostBridgeHandlers` / `sdk` 至少 6 处。

边界测试已经**明确允许**这么做（用户 2026-07-29 拍板："也不用完全不入侵……就是别影响原来 agentic 的能力"），条件是所有分支 mode 守卫。

**但这一步应该最后做。** 在能力本身没验证之前接 UI/模式切换，是给未定型的东西铺管线。

---

## 七、必须先验证的假设

### 假设 A（致命）：节点能显式声明跨节点依赖

**整个 `readySet.ts` 建立在 `dependsOn` 是真实可得的信息上。** 而 460 个错误证明节点**运行期没识别出来**。规划期能不能识别出来 —— 没测过。

**最便宜的实验**：拿 hrbench 那份 154 行 PRD（已有），只做规划、不做实现：

```
给规划 agent: PRD + "输出切分方案，每个节点声明 ownedPaths 和 dependsOn"
判据: 拿 k=4 那 460 个真实错误当标准答案，看规划出的依赖图**覆盖了多少条**真实跨模块引用
成本: 一次规划调用，几分钟，几万 token。对比全跑一轮 891k token
```

**这个实验有现成的标准答案**（460 个错误就是ground truth），这是它最值钱的地方。测出来：
- 覆盖率高 → 调度器成立，继续
- 覆盖率低 → `dependsOn` 是摆设，集群的价值只剩 §4 那三件常开机制（那也仍然值钱，但**不需要集群框架**）

### 假设 B：持续集成能把 460 压下去

理论支持强（CI 五十年实践），**未实测**。但可以在假设 A 之后用同一个 hrbench 场景直接对比，标准答案也是现成的。

### 假设 C：k=2 的 1.19×

n=1，历史方差 40%。**这条我建议暂时当"未知"处理，不要拿它当设计依据。** 好在 §1 已经论证过：集群的价值不该压在这条上。

---

## 八、包本身的两处不自洽

1. **名字**：`README.md` 通篇写 `@openneox/neox-teamwork`，`package.json` 是 `@openneox/cluster`。`boundary.test.ts` 的注释也还在说 teamwork。定一个 —— 建议 **cluster 是包名（框架），teamwork 是模板名**（`package.json` 的 description 就是这么写的，README 没跟上）。
2. **exports 占了三个空坑**：`./node/*`、`./workflow/*` 目录不存在，`./scheduler/*` 有。不影响 typecheck，但对照本仓库"exports 收窄只炸打包版"那次教训，**空坑先别留**，用到再加。

---

## 九、建议的推进顺序

```
① 假设 A 实验（规划期依赖识别率）        ← 几分钟，有 ground truth，决定后面全部
② 覆盖度闸                                ← 单 agent 就受益，77%→97%，不依赖集群
③ NodeRunner + 事件桥（changedFiles 走 git 采）  ← 让 419 行纯函数第一次真的跑起来
④ 持续集成引擎 + claim 注册表             ← 假设 B
⑤ 并发收口（core 加准入回调，照抄 isAgentIdTaken 的形状）
⑥ 协调 Agent 接线
⑦ 模式接入 / UI
```

**①和②可以并行，且②不管①结果如何都值得做。**
