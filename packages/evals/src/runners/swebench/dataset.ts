/**
 * SWE-bench dataset 加载.
 *
 *   数据源: HuggingFace datasets-server REST API (无需 hub token 也能拿公开数据集 rows).
 *     例: https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test&offset=0&length=100
 *
 *   策略:
 *     1. 先检查本地 cacheDir 有没有完整 JSONL — 有就直接 stream 读, 不走网络
 *     2. 没有 → 分页拉所有 rows, 写一个 JSONL 缓存 (~/.neox-evals/swebench-cache/<subset>.jsonl)
 *     3. 应用 limit / instanceIds 过滤后返回
 *
 *   verified-lite 是 verified 的前 50 题 (按 instance_id alphabetic sort), 我们手工切, 不依赖另一个 dataset 名.
 *   "lite" subset 是 princeton-nlp/SWE-bench_Lite (300 题), 也走同样 API.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { SweBenchDatasetOptions, SweBenchSubset, SweBenchTask } from './types.js';

/* 在国内环境多数靠 clash/v2ray 转 HuggingFace. Node fetch 不自动读 HTTPS_PROXY
 * 环境变量, 我们手动把 undici 的全局 dispatcher 替换成 ProxyAgent —
 * 之后 fetch 都走代理. 没设代理 env 时 noop, 国外用户不受影响.
 * undici 是 Node 18+ 内置, 不需要单独装. */
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
let proxyApplied = false;
async function ensureProxy(): Promise<void> {
  if (proxyApplied || !PROXY) return;
  try {
    const undici = await import('undici');
    undici.setGlobalDispatcher(new undici.ProxyAgent(PROXY));
    proxyApplied = true;
    process.stderr.write(`[swebench-loader] using proxy ${PROXY}\n`);
  } catch {
    /* 老 node 没 undici 全局 dispatcher → 让 fetch 直连, 不爆错 */
  }
}

const HF_DATASETS_SERVER = 'https://datasets-server.huggingface.co';
const HF_PAGE_SIZE = 100; /* server max = 100 per request */

const DATASET_NAME: Record<SweBenchSubset, string> = {
  verified:      'princeton-nlp/SWE-bench_Verified',
  /* verified-lite 不是独立 dataset, 是 verified 取前 50; 加载时跟 verified 走同一文件再裁切 */
  'verified-lite': 'princeton-nlp/SWE-bench_Verified',
  lite:          'princeton-nlp/SWE-bench_Lite',
  full:          'princeton-nlp/SWE-bench',
};

function defaultCacheDir(): string {
  return path.join(os.homedir(), '.neox-evals', 'swebench-cache');
}

function cacheFilePath(subset: SweBenchSubset, dir: string): string {
  /* verified-lite 跟 verified 共用同一份原始文件 — 它只是 view, 不重下 */
  const key = subset === 'verified-lite' ? 'verified' : subset;
  return path.join(dir, `${key}.jsonl`);
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

interface HfRowsResponse {
  rows: Array<{ row: Record<string, unknown> }>;
  num_rows_total?: number;
}

async function downloadDataset(subset: SweBenchSubset, cacheFile: string): Promise<void> {
  await ensureProxy();
  const dataset = DATASET_NAME[subset];
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  /* HF datasets-server 的 split 名 SWE-bench 都用 'test' (跟语义无关, 只是数据集 split). */
  const split = 'test';
  const config = 'default';

  let offset = 0;
  let total = Infinity;
  const fh = await fs.open(cacheFile, 'w');
  try {
    while (offset < total) {
      const url = `${HF_DATASETS_SERVER}/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${HF_PAGE_SIZE}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`HuggingFace datasets-server ${resp.status} ${resp.statusText}: ${url}`);
      }
      const body = (await resp.json()) as HfRowsResponse;
      if (typeof body.num_rows_total === 'number') total = body.num_rows_total;
      if (!body.rows.length) break;
      for (const r of body.rows) {
        await fh.write(JSON.stringify(r.row) + '\n');
      }
      offset += body.rows.length;
      /* 进度提示 — stderr, 不污染 JSON output */
      process.stderr.write(`[swebench-loader] ${dataset}: ${offset}/${total === Infinity ? '?' : total}\n`);
    }
  } finally {
    await fh.close();
  }
}

async function readJsonl(file: string): Promise<SweBenchTask[]> {
  const content = await fs.readFile(file, 'utf-8');
  const out: SweBenchTask[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as SweBenchTask);
  }
  return out;
}

export async function loadSweBenchTasks(options: SweBenchDatasetOptions = {}): Promise<SweBenchTask[]> {
  const subset = options.subset ?? 'verified-lite';
  const dir = options.cacheDir ?? defaultCacheDir();
  const cacheFile = cacheFilePath(subset, dir);

  if (!(await fileExists(cacheFile))) {
    process.stderr.write(`[swebench-loader] cache miss, downloading ${DATASET_NAME[subset]} → ${cacheFile}\n`);
    await downloadDataset(subset, cacheFile);
  } else {
    process.stderr.write(`[swebench-loader] cache hit ${cacheFile}\n`);
  }

  let tasks = await readJsonl(cacheFile);

  /* verified-lite: verified 的前 50 个 (按 instance_id 字典序稳定切) */
  if (subset === 'verified-lite') {
    tasks = tasks.slice().sort((a, b) => a.instance_id.localeCompare(b.instance_id)).slice(0, 50);
  }

  if (options.instanceIds?.length) {
    const set = new Set(options.instanceIds);
    tasks = tasks.filter(t => set.has(t.instance_id));
  }

  if (options.limit && options.limit > 0) {
    tasks = tasks.slice(0, options.limit);
  }

  return tasks;
}
