# Agent 效果基线 (agent-bench)

改 agent 循环、提示词、工具之前/之后，用同一批任务跑一遍，比较通过率和各项成本。
判分只看**磁盘真相**（测试跑没跑过、文件里写了什么），不看模型自称做完了没有。

`packages/evals/src/release-suite` 是旧服务器时代的套件，已经不能用了；这套是另起的，两者没有依赖关系。

```
scripts/eval/
  agent-bench.mjs        跑分器 + 前后对比
  gen-report.mjs         指标报告: 一次出表, 自动对比上一次并标涨跌
  lib/metrics.mjs        从 SQLite 读真实用量
  lib/waste.mjs          白跑轮次四类分桶 (重读 / 穷举 / 空转 / 压缩后重读)
  lib/check-helpers.mjs  判分脚本公共零件
  lib/xlsx.mjs           极简 xlsx 读取器 (判分用, 无第三方依赖)
  lib/zip.mjs            极简 zip 读取器 (docx/pptx 判分用)
  lib/docx.mjs           读 docx 段落 + 标题 (pStyle / outlineLvl 都认)
  lib/pptx.mjs           读 pptx 页数 + 每页标题/文字
  lib/session-log.mjs    读会话库, 确认模型到底调了哪些工具
  tasks/<id>/            每个任务: task.json + prompt.md + fixture/ (或 gen.mjs) + check.mjs
  results/<时间>.json    每次跑分的结果
  results/<时间>.md      同一次跑分的指标报告
```

## 用法

```bash
node scripts/eval/agent-bench.mjs                       # 全部 30 题, 各跑 1 遍
node scripts/eval/agent-bench.mjs --suite quick         # 合并闸用的 10 题
node scripts/eval/agent-bench.mjs --repeat 3            # 每题 3 遍 (判断效果变化时的推荐姿势)
node scripts/eval/agent-bench.mjs --tasks code-fix-slug,chat-http-codes
node scripts/eval/agent-bench.mjs --cli apps/cli/dist/cli/main.js --model deepseek-v4.1-flash-1017
node scripts/eval/agent-bench.mjs --compare results/a.json results/b.json
```

| 参数 | 说明 |
|---|---|
| `--tasks a,b` | 只跑指定任务（默认全部） |
| `--suite quick\|full` | `quick` = 合并闸的 10 题（task.json 里 `"quick": true`），`full` = 全部 30 题（默认） |
| `--repeat N` | 每题跑 N 遍（默认 1） |
| `--cli <path>` | neox 可执行文件（默认 PATH 里的 `neox`；也可以指本地构建产物） |
| `--model <id>` | 默认 `deepseek-v4.1-flash-1017` |
| `--provider <id>` | 默认 `neox-cloud` (走订阅)。**不要换成本机配置里的 BYOK provider** (如 a6-ch234): 那是用户自己掏钱的 key。报「没有 neox-cloud」说明登录态没带进来, 先修登录, 别绕。 |
| `--timeout <sec>` | 单任务超时（默认 600 秒 = 10 分钟） |
| `--keep-temp` | 保留临时工作目录，方便看模型到底改了什么 |
| `--compare a b` | 不跑任务，直接对比两份报告 |

每个任务都在 `mkdtemp` 出来的临时目录里跑（`fixture/` 拷过去，或 `gen.mjs` 现场生成），
**不会碰当前仓库**。跑完（不带 `--keep-temp`）临时目录会被删掉。

## 任务集

共 30 题：Code 20 / Work 6 / Chat 4。`--suite quick` 只跑带 `"quick": true` 的 10 题
（原 8 题 + `code-refactor-signature` + `chat-tcp-handshake`），用作合并闸。

### Code

| id | 任务 | 判分方式 |
|---|---|---|
| `code-fix-slug` | 修 slugify 两个 bug（已有失败测试） | 测试哈希 + `node --test` + 向量抽查 |
| `code-fix-date-range` | 修日期枚举 off-by-one 和月份补零 | 测试哈希 + `node --test` + 向量抽查 |
| `code-add-uppercase` | 给格式化工具加 `uppercase` 选项 / `--upper` 开关 | 测试哈希 + 隐藏测试 |
| `code-explain-retry` | 读源码回答三个具体事实 | 答案必须出现事实 + 文件名:行号 |
| `code-big-repo-fix` | 605 个文件里定位并修失败测试 | 测试哈希 + `node --test` + 向量 |
| `code-refactor-signature` | 改 `calculateTotal` 签名并更新所有调用点 | 测试哈希 + 隐藏测试 + 无旧位置参数 |
| `code-refactor-extract` | 把函数拆到 `src/time/` 并更新全部 import | 新模块存在 + 旧文件不残留 + 三处 import + 测试 |
| `code-fix-bug-js` | 修分页/页数计算的两个 bug | 测试哈希 + `node --test` + 向量 |
| `code-fix-bug-python` | 修 Python 换行/拼接的两个 bug | 测试哈希 + unittest + 隐藏测试 |
| `code-fix-bug-go` | 修 Go 均值/中位数 | 测试哈希 + `go test` + 隐藏测试 |
| `code-add-cli-flag` | 给 notes CLI 加 `--tag` / `--json` | 测试哈希 + 隐藏测试跑真实 CLI |
| `code-fix-type-errors` | strict 下修 TS 类型错误 + 一处行为 | `tsc --noEmit` + 行为测试 + 禁用 any/@ts-ignore |
| `code-big-repo-config` | 600+ 文件里找真正生效的超时配置 | 测试哈希（现场重新生成 fixture）+ 只改生效项 |
| `code-explain-arch-queue` | 读队列项目回答存储/并发/重试 | 三个事实 + ≥2 处文件名:行号 |
| `code-explain-arch-http` | 读 HTTP 服务回答中间件顺序/鉴权/限流 | 顺序、401/429/500、100 次/60 秒 + 引用 |
| `code-write-test` | 给 `validatePassword` 写单测 | 测试通过 + 4 个变异体全部被测试抓出 |
| `code-dep-upgrade` | strutil 2.0 删除旧 API 后修调用方 | 测试哈希 + 无 `padLeft/padRight` + 码点向量 |

### Work

| id | 任务 | 判分方式 |
|---|---|---|
| `work-report-release` | 零散素材 → markdown 发布报告 | 小节齐全 + 素材里的数字/编号 |
| `work-xlsx-budget` | CSV 预算表 → 带公式的 xlsx | 自研 reader 读单元格与公式 |
| `work-docx-report` | 素材 → docx 季度报告 | 自研 reader 读标题 + 正文关键事实 |
| `work-pptx-deck` | 素材 → 5 页复盘 deck | 页数=5、五个标题各一页、无空页 |
| `work-xlsx-formatted` | CSV → 带公式/加粗表头/数字格式/列宽 | 公式、`SUM`、字体加粗、填充、numFmt、列宽 |
| `work-csv-summary` | CSV 订单 → markdown 汇总 | 总收入/区域合计/最高产品/取消数（只算 completed） |
| `work-md-summary` | 三份资料 → 400 字摘要 | 五个必含事实 + 字数上限 |
| `work-docx-edit` | 原地编辑已有 docx | 改对风险段 + 追加负责人 + 其它段落/标题保留 |

### Chat

| id | 任务 | 判分方式 |
|---|---|---|
| `chat-http-codes` | HTTP 301/302/307/308 的区别 | 四个状态码、永久/临时、方法是否保持 |
| `chat-tcp-handshake` | TCP 为什么三次握手 | 防历史连接 + 序列号/双向能力，≤200 字 |
| `chat-git-rebase` | merge 与 rebase 区别及风险 | 合并提交 / 重写历史 / 已推送分支风险 |
| `chat-sql-index` | 联合索引 (a,b,c) / 覆盖索引 / 回表 | 最左前缀、失效场景、覆盖索引、回表、列序 |
| `chat-news-search` | 搜索最近一周 AI 新闻并给来源 | 会话库里必须有 `web_search` + ≥3 链接 / ≥2 域名 |

`chat` 与 `code-explain-*` 判分需要模型最终回答文本，跑分器把 `neox --json` 的
`result` 写到临时文件，通过 `BENCH_OUTPUT_FILE` 交给 `check.mjs`。
`chat-news-search` 额外通过 `BENCH_DB_PATH` 读该次 run 的会话库，确认真的调了搜索工具
（只看行为，不判新闻内容）。

## 指标从哪里来

`neox -p --json` 只输出 `{ result, error }`，没有用量字段；CLI 也**没有** `--output-format`。
用量读的是 SQLite（`apps/cli` 的库，路径同样受 `NEOX_DB_PATH` 覆盖）：

- 跑分器给每个 run 设独立的 `NEOX_DB_PATH=<临时目录>/neox.db`，库里只有这一次运行的行，
  不需要按 session id 猜；
- `agent_turn_metrics`：模型请求轮数（`inferences`）、工具调用数（`tool_calls`）、
  首字时间（`ttfa_ms`）、时长、token；
- **注意**：`agent_turn_metrics` 的 token 是在「下一次请求边界」结算的，最后一个请求永远不在表里。
  真实的最后一段在 `sessions.latest_request_usage`，两个相加才是整次运行的用量
  （单请求的 chat 里表里全 0，只有后者有值）。这一点由 `lib/metrics.mjs` 处理，报告里
  `metricsSource` 会写明用了哪几路；
- `token_usage` 表在 print 模式下是空的，不要拿它当来源。

数据拿不到时字段写 `null`，不编造。`--json` 解析失败会退化成直接用原始 stdout 当回答。

## 报告

`results/<YYYYMMDD-HHMMSS>.json`：

```jsonc
{
  "meta":    { "cli": "...", "model": "...", "provider": "...", "repeat": 1, "startedAt": "..." },
  "summary": { "taskCount": 8, "runCount": 8, "passedRuns": 7, "passRate": 0.875,
               "avgDurationMs": ..., "avgModelRequests": ..., "avgToolCalls": ...,
               "avgInputTokens": ..., "avgCacheHitTokens": ..., "avgOutputTokens": ...,
               "avgFirstTokenMs": ... },
  "tasks": [
    {
      "id": "code-fix-slug", "kind": "code",
      "passCount": 1, "runCount": 1, "passRate": 1,
      "avg": { /* 同 summary 的那几项 */ },
      "runs": [
        {
          "run": 1, "pass": true, "timedOut": false, "exitCode": 0,
          "durationMs": 62300,          // 进程墙钟时间
          "firstOutputMs": 3100,        // stdout 首字节 (兜底)
          "firstTokenMs": 2800,         // agent_turn_metrics.ttfa_ms
          "modelRequests": 7,
          "toolCalls": 12,
          "inputTokens": 88123,
          "cacheHitTokens": 62000,
          "outputTokens": 1240,
          "agentDurationMs": 59000,
          "metricsSource": "agent_turn_metrics + sessions.latest_request_usage",
          "checkExit": 0,
          "checkOutput": "PASS",
          "answerTail": "…",
          "modelError": null
        }
      ]
    }
  ]
}
```

终端同时打两张表（每题一行 + 汇总）。`--compare` 打印每题通过率和各项指标均值的 A/B/Δ。

## 自动指标报告 (EVAL-02)

每次 `agent-bench.mjs` 跑完都会自动出一份指标报告：终端打「指标均值 / 白跑四类 / 每题」三张表，
并把同样的内容写成 `results/<时间>.md`。每一项都自动和 `results/` 里**上一次**的报告比，
标 `▲/▼ + 好/差`（通过率越高越好；时长、轮数、工具调用、token、白跑越低越好），
只标涨跌，**不设「不许退步」的闸**。

也可以单独出报告：

```bash
node scripts/eval/gen-report.mjs                          # 最新一次 vs 上一次
node scripts/eval/gen-report.mjs results/a.json --prev results/b.json
node scripts/eval/gen-report.mjs --out /tmp/report.md
```

## 白跑轮次四类 (EVAL-04)

口径在 `lib/waste.mjs` 头部，跑分时从该次 run 的会话库离线算，报告里每题、每次都有：

| 分桶 | 判定 | 单位 |
|---|---|---|
| 重读 | 同一文件在没有写入的情况下又被读一次 | 命中轮数 / 调用数 |
| 穷举 | 同一工具在同一路径第 3 次及以后，或参数完全相同的重复调用（搜索、shell） | 命中轮数 / 调用数 |
| 空转 | 模型输出没有工具调用、之后又被续跑的轮次（有 `agent_turn_metrics.waste_json` 时优先用它） | 轮数 |
| 压缩后重读 | 文件在最近一次压缩（`compaction_snapshot`）前读过、压缩后又读 | 命中轮数 / 调用数 |

`wasteTurns` 是这些轮次的并集，`wasteRate = wasteTurns / turns`；拿不到会话库时四类都写 0、`source: null`。

## 噪声：别把单次结果当结论

模型的输出有随机性。同样的任务集，单次跑出来 8/8 和 7/8 都可能是运气 —— 判断某个改动
是好是坏，至少 `--repeat 3`，看的是通过率和各指标均值的**趋势**，不是单场输赢。

这也正是 `内部设计文档` 里「度量先拿来看，不做不许退步的 CI 门」的原因：
LLM 结果有噪声，硬门会误拦。

## 加一个任务

1. 建 `tasks/<id>/`，写 `task.json`：

   ```json
   { "title": "一句话说明", "kind": "code|work|chat", "timeoutSec": 600 }
   ```

2. 写 `prompt.md`（发过去的完整提示词）。
3. 准备 fixture：静态的放 `fixture/`（整个目录会拷到临时工作目录）；要几百个文件的写
   `gen.mjs`，约定 `node gen.mjs <target-dir>` 现场生成，内容必须确定（不能有时间戳/随机数），
   否则测试文件的哈希会漂。
4. 写 `check.mjs`：由 `node check.mjs <workdir>` 调起，退出码 0 = 通过。
   用 `lib/check-helpers.mjs` 里的 `runCheck` / `assert*` / `runNodeTest` / `findFile`；
   `code-*` 任务请用 `assertUntampered` 钉死测试文件哈希，**改测试不算通过**。
5. 本地先自测一遍：拿未修的 fixture 跑 check（应失败），再手写一份理想答案/理想产物跑
   （应通过）。别把没验过的判分脚本交给模型去撞。
