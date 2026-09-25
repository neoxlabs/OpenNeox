# @openneox/evals

> **Neox Agent · benchmark harness · 公开 + 可复现**

Run SWE-bench, HumanEval, and Neox's own Browser-verify bench against the Neox agent. Open-source so anyone can reproduce our published numbers.

跟 Cursor/Devin 闭源 harness 对比, Neox 的 bench harness 开源 — 数字怎么得到, 全在这.

---

## 为什么独立成包

| 维度 | 设计选择 | 理由 |
|---|---|---|
| **位置** | `packages/evals/` 内部 package | 同 monorepo, 版本对齐 SDK, 改 prompt 能 bisect 哪次 commit 拉了分数 |
| **开源** | Apache-2.0, 公开 | 运行结果和评测流程可复现 |
| **依赖** | `@openneox/core` 直接 import | 工具完整 (execute_shell/edit_file/browser_*), 不绕 SDK 公开 surface |
| **名字** | `evals` 不是 `swe` | 通用容器, 后续加 HumanEval / Browser-verify bench 不用改名 |

---

## 现状 (v0.1.0)

- [x] **E1** Package skeleton + workspace 注册
- [x] **E2** `runHeadlessAgent()` — 一次性 headless 跑, 输入 (workspace, prompt, model, BYOK key) → transcript + usage
- [x] CLI `neox-evals run-once` — 跑通 SDK 链路的 smoke test
- [x] **E3** SWE-bench dataset loader (HuggingFace datasets-server, 自动走 HTTPS_PROXY)
- [x] **E4** Git worktree harness (官方 swebench repo cache + per-task detached worktree)
- [x] **E5** Local quick grader (patch 形态评估) + 标准 `predictions.json` 输出
- [x] **E6** CLI `neox-evals swebench` 全套
- [ ] **E7** 接官方 Python harness (`swebench` PyPI), 出真 FAIL_TO_PASS / PASS_TO_PASS 分数

---

## 用法 (现版本)

```bash
# Build
npm run build -w @openneox/evals

# === smoke test: 单次 headless 跑, 验证 SDK 链路 ===
export ANTHROPIC_API_KEY=sk-...
node packages/evals/dist/cli/neox-evals.js run-once \
  --workspace /tmp/some-repo \
  --prompt "Fix the bug in src/index.ts that throws TypeError on empty input" \
  --model claude-sonnet-4-5-20250929 \
  --provider anthropic

# === SWE-bench: 单题复现 ===
export OPENAI_API_KEY=sk-...           # GLM 用 openai 协议
export HTTPS_PROXY=http://127.0.0.1:7890  # HF 国内需代理
node packages/evals/dist/cli/neox-evals.js swebench \
  --subset verified \
  --instance-ids pallets__flask-5014 \
  --model glm-4.6 --provider openai \
  --base-url https://open.bigmodel.cn/api/paas/v4 \
  --run-id pilot-1

# === SWE-bench: verified-lite 50 题完整 pilot ===
node packages/evals/dist/cli/neox-evals.js swebench \
  --subset verified-lite \
  --model glm-4.6 --provider openai \
  --base-url https://open.bigmodel.cn/api/paas/v4 \
  --per-task-timeout-ms 1800000 \
  --run-id verified-lite-pilot

# 输出: ./swebench-runs/<run-id>/
#   - predictions.json   官方 Python harness 格式, 喂给 swebench-py 出真分数
#   - outcomes.json      我们自己的浅评 (有/没/挂)
```

### 出真分数 (E7 还没接, 现版本手动跑官方 harness)

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path ./swebench-runs/<run-id>/predictions.json \
  --max_workers 4 \
  --run_id <run-id>
```

---

## 规划的 benchmarks

| Bench | 数据集来源 | 评测目标 |
|---|---|---|
| **SWE-bench Verified** | princeton-nlp 官方 (500 题, 人工审核) | 公开数字 vs Cursor/Devin/Claude Code |
| **SWE-bench Lite** | 300 题轻量子集 | 迭代时的 smoke test |
| **HumanEval** | OpenAI 164 题 | 单文件编程能力基线 |
| **LiveCodeBench** | 持续更新, 抗 contamination | 真实力, 不掺训练集 |
| **Neox Browser-verify bench** | 自建, ~30 题 | "改完真去 browser 验证 console 无 error" — Neox 独有差异化, 没人量化过 |

---

## License

Apache-2.0. See the repository root `LICENSE` and `NOTICE` files.
