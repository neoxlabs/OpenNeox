# schemas/ — Provider / Model / Protocol 真相源

> 这个目录是模型 / 接入服务 / 协议的**真相源**, 客户端从这里读 (构建时经 `scripts/bake-schemas.mjs` 内嵌进 kernel).

## 目录

```
schemas/
├── README.md          ← 本文件
├── protocols/         ← 协议规范 (openai-chat / anthropic-messages / ...)
├── providers/         ← 接入服务 (OpenRouter / Anthropic-direct / OpenAI-direct / ...)
└── models/            ← 模型清单 (claude-opus-4-8 / gpt-5.5 / ...)
```

## 加新 model 流程

1. 复制最接近的 yaml 改一份, 文件名 = `id` + `.yaml`
2. 必填:
   - `id`, `display_name`, `family`, `context_window`, `max_output_tokens`
   - `upstream_slugs.<provider_id>` 至少 1 个
   - `capabilities.*` 老实声明 (别瞎填 `supported: true`)
   - `pricing.input/output_per_mtok` (USD per million)
   - `availability` (`ga` / `preview` / `hidden`)
3. 跑 `npm run schema:lint` 校验
4. PR review 合并

## 加新 provider 流程

1. 复制最接近的 provider yaml
2. 必填: `id`, `slug`, `base_url`, `protocol`, `auth`, `features`
3. 至少在一个 model 的 `upstream_slugs` 引用它 (否则没意义)
4. PR review

## 加新 protocol 流程

> 极少发生 — 通常 anthropic-messages / openai-chat / gemini 三种就够.

新 protocol 需要客户端实现适配器, 不是改 yaml 就能完事.

## 不在这里放什么

- 秘密 (API key 等) → 用户本地配置 / 环境变量

---

## 工具

- `npm run schema:lint` — 校验 yaml 字段 + 交叉引用
