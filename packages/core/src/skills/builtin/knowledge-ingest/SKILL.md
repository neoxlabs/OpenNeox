---
name: "Knowledge Ingest"
description: "把文档/URL/文件消化成知识库卡片 (.neox/knowledge/), 或列出/检索/更新已有卡片"
description_en: "Ingest docs/URLs/files into knowledge cards (.neox/knowledge/), or list/search/refresh existing ones"
user-invocable: true
argument-hint: "add <url|文件路径|'文本'> | list | search <关键词> | refresh <卡片路径>"
when_to_use: "用户想把资料存进知识库、让 agent 记住一份文档、或管理已有知识卡时"
neox:
  category: knowledge
  aliases: [kb]
  dangerLevel: safe
---

## Overview

知识库 ingest — 把外部资料**消化**成结构化知识卡, 不做机械切片。
知识卡存放在 `{workspace}/.neox/knowledge/**/*.md`, 索引自动注入 system prompt, agent 跨会话可用。

设计: docs/NEOX_KNOWLEDGE_BASE_DESIGN.md。

## 子命令

按参数第一个词分派; 无参数时问用户想做什么。

### add <url | 文件路径 | "文本">

1. **读全原文** (不截断、不跳读):
   - URL → web 抓取工具读取; 分页/长文要读完
   - PDF / Word → 对应文档工具
   - 本地文件 → readfile
   - 直接给的文本 → 原样作为素材
2. **消化成知识卡** — 这是关键步骤, 遵守:
   - 面向"未来的 agent 读者"重写: 结论先行、去营销话术、去与使用无关的叙述
   - **保留精确性**: API 签名、参数表、版本号、限制条件逐字保留
   - 一个来源含多个独立主题时拆成多张卡, 每卡自包含 (50–300 行)
   - 关键事实旁标注出处小节/页码
3. **落盘**: 写 `{workspace}/.neox/knowledge/<主题目录>/<slug>.md`, frontmatter 必须齐:

   ```markdown
   ---
   title: <简短名词性标题>
   description: <一句话, 60 字内 — 写成"什么时候需要看这条"的触发条件, 不是内容概述>
   source: <URL 或文件路径> (抓取: YYYY-MM-DD)
   paths: ["相关代码 glob"]        # 仅当明确关联某些代码路径时才加
   keywords: [补充检索词]
   trust: draft
   updated: YYYY-MM-DD
   ---
   ```

   注: 另有 `always: true` 字段 — 全文常驻 system prompt, 用于合规/政策/规范这类
   "错过就出事"的知识。**只能由用户手标**, ingest 和 agent 都不要写它; 用户要求时
   提醒他自己改 frontmatter。

4. **回报**: 列出新卡的 title + 路径, 提示用户 review 后把 `trust: draft` 改为 `verified`。

### list

读 `.neox/knowledge/` 目录 (递归), 按目录分组列出: title、trust、updated、一句话描述。空库时说明用法。

### search <关键词>

用 knowledge_search 工具检索, 展示命中卡片和片段。

### refresh <卡片路径>

1. 读该卡 frontmatter 拿 source
2. 重新抓取 source (URL 才能 refresh; source 是本地文件则重读文件)
3. 对比新旧内容, 只更新有实质变化的部分, 更新 `updated` 日期
4. 回报变化摘要; 内容有实质变更时把 trust 降回 draft 提醒 review

## 约束

- 绝不把任务状态/会话记录写进知识库 — 那是 memory 的领域
- 卡片是给 agent 读的资料, 不是给人看的报告 — 不要客套、不要总结感想
- 写卡前检查同主题卡片是否已存在 (看 system prompt 里的 Knowledge Base 索引): 已存在 → 更新该卡而不是新建重复卡
