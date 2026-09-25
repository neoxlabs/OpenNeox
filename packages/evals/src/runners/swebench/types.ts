/**
 * SWE-bench task schema — 对齐 HuggingFace 上 princeton-nlp/SWE-bench{_Verified,_Lite} 的列定义.
 *
 *   官方字段语义见: https://github.com/princeton-nlp/SWE-bench/blob/main/docs/spec.md
 *   字段是 snake_case (跟数据源保持一致, 不再 camelCase 转换 — 减少 mismatch 概率).
 */

export interface SweBenchTask {
  /** 形如 "django__django-11999" — 唯一 ID, 用于 docker image / 报告引用 */
  instance_id: string;
  /** 形如 "django/django" — GitHub owner/repo */
  repo: string;
  /** 解决该 issue 前的基线 commit SHA — clone 时 checkout 到这 */
  base_commit: string;
  /** issue 正文 — 喂给 agent 当 prompt 输入 */
  problem_statement: string;
  /** maintainer 在 issue 下面给的提示 (常为空字符串) */
  hints_text: string;
  /** 官方 gold patch — agent 看不到, grader 用作参考 / 调试 (不强制 agent 跟它一致) */
  patch: string;
  /** test 文件的 patch — apply 这部分让 FAIL_TO_PASS 真在跑里被定义出来 */
  test_patch: string;
  /** 修复后期望从 FAIL → PASS 的测试 (JSON 序列化的列表字符串, 例: '["django/tests/...::test_foo"]') */
  FAIL_TO_PASS: string;
  /** 修复后必须仍然 PASS 的测试 (回归保护) */
  PASS_TO_PASS: string;
  /** issue 创建时间 (ISO 字符串) */
  created_at: string;
  /** 项目版本号 (e.g. "4.0", "1.11") — 决定 docker image tag */
  version: string;
  /** env 安装时 checkout 的 commit (通常 = base_commit, 偶尔不同) */
  environment_setup_commit?: string;
}

export type SweBenchSubset = 'verified' | 'verified-lite' | 'lite' | 'full';

export interface SweBenchDatasetOptions {
  /** 数据子集 — 默认 verified-lite (50 题, 跑 pilot 快) */
  subset?: SweBenchSubset;
  /** 本地缓存目录 — 默认 ~/.neox-evals/swebench-cache. 第二次跑直接读不重下 */
  cacheDir?: string;
  /** 只取前 N 题 (debug / pilot 用) */
  limit?: number;
  /** 只取指定 instance_id — 给单题复现用 */
  instanceIds?: string[];
}
