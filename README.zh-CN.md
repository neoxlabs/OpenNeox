<div align="center">

<img src="assets/brand/neox-app-icon.png" alt="" width="128">

<h1>OpenNeox</h1>

**自研 Harness 的 AI 智能体：写代码、办公，终端、桌面、手机都能用。**<br>
自带模型 Key，无需账号，不收集遥测。

<br>

[English](README.md) · **简体中文**

<br>

[![CI](https://github.com/neoxlabs/OpenNeox/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/neoxlabs/OpenNeox/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](#快速开始)

</div>

---

OpenNeox 是 Neox 的开源版：一个 Harness 自研的 AI 智能体，用来写代码和办公，带终端、桌面、
手机三个客户端。自带模型 Key 即可使用，不需要账号，不收集遥测。

读代码、改文件、跑命令、Git、MCP、技能、子 Agent 这些基础能力都有。下面是它和同类工具
不太一样的地方：

- **自研 Harness。** agent loop、工具、上下文注入、压缩、子 Agent 是我们自己实现的，
  不基于现成的 Agent 框架。设计细节见 [Harness 设计](#harness-设计)。
- **多服务商。** OpenAI / Anthropic / Gemini / DeepSeek / Kimi / GLM / 通义千问 / 豆包 /
  Grok / MiniMax 等协议原生适配，Ollama、LM Studio 本地模型；服务商失败自动切备用链路，
  带健康检查。
- **远程连接。** 手机遥控电脑上的会话：同一 Wi-Fi 直连，外网走自己部署的中继，端到端加密。
  会话、回复、Agent 做出的截图和图表都能在手机上看。
- **持续运行。** 后台 Shell 任务、定时任务（cron）、后台子 Agent，完成后结果回到对话里。
- **权限与沙箱。** 三种 Agent 模式（只读 / 每步确认 / 自动）、三档沙箱（只读 / 可写工作区 /
  完全放开），Shell 跑在系统沙箱里（Seatbelt / bubblewrap / AppContainer）。
- **上下文看得见。** 当前占用、离自动压缩还有多少、按角色拆分，状态栏实时显示。
- **整轮撤销。** 影子 git 记录每轮改动，可以按 hunk、按文件或整轮回退。
- **不止写代码。** Work 模式出网页、表格、Word；Computer Use 操作本机 App；插件市场不用账号。
- **陶土风格界面**，还有一只桌宠。
- **方便二次开发。** 同一套运行时以 SDK 提供，可以部署到服务器上改成客服机器人之类的应用，
  省掉自己写 Agent 的大部分工作。

## 为什么做这个

Neox 是我今年 1 月开始用来学习 Agent 的工程，不知不觉做到了现在，最初是给公司内部和朋友用。
Claude Code、Codex 都很好，背后有大公司的投入；我们想要的是一个能配合 DeepSeek 等模型、
自己说了算的 Agent。目前来看，用它开发一个系统、支撑几个月的需求是够的；Computer Use 和一些
复杂场景的适配还不够完善。

Agent 的核心 —— agent loop 和每个工具 —— 都是从零写的。一开始手写，后来用 AI 辅助：从
Claude Opus 4.5、4.6、4.7、4.8 一路到现在的 5.5。早期是我们主导设计、让 AI 写重复代码，
到 Opus 5.5，它对 Agent 的理解已经很强。GPT 5.4、5.5、5.6 到 6.1 也都拿来写过，整体偏保守，
所以主力一直是 Claude。工具设计上参考过 Claude Code、Codex 等产品的做法，再按自己的场景取舍。

我们一直在同一个模型上拿它和 Claude Code、Codex 对比，持续改 harness；下面有一个[简单的对比测试](#简单的对比测试)。
我自己日常是订阅 + Neox 配 DeepSeek，远程处理公司的任务也很顺手。

手机端是因为我常用 Claude 的 App：尤其写前端时，Agent 做出来的截图在手机上就能看到，
人不在电脑前也能跟进，基本可以脱离电脑。

它不是 pi、opencode 或其它开源 Agent 的分支或改版，代码是我们自己写的；设计上有很多取舍，
未必人人喜欢，但也许能带来一点不同的体验。现在大模型厂商更多是针对 Claude Code 这类工具在训练，
自研 harness 的路不算宽；当作对 Agent 的理解和学习，也值得做下去。

## 和 neox-dev.com 的关系

[neox-dev.com](https://neox-dev.com) 是 Neox 的官网，那里是商业版：在开源版之外多了账号登录和订阅 ——
订阅是我们自己运营的模型网关，最初给朋友和公司内部用，登录就能直接用模型，不用自己配 Key。
两个版本是同一套代码，Agent、工具、桌面端、手机端、远程连接这些功能完全一样。开源版只去掉了
依赖我们服务器的部分：账号与订阅、云端会话、云端 Pilot。这部分代码有一些还留在仓库里，
只是在开源版里关掉了，没有刻意藏什么。

开源版不会主动连 neox-dev.com，只有打开插件页时会访问插件市场。

**怎么拿到开源版：**
- **桌面端（macOS / Windows）和安卓**：在 [Releases](https://github.com/neoxlabs/OpenNeox/releases) 下载。
- **命令行和 SDK**：从源码构建（见[快速开始](#快速开始)）。npm 上的 `@neoxlabs/cli` 是商业版，不是这个仓库。

## 现状

这不是一个完善的产品，也谈不上商业级 —— 我没有大公司的投入，功能面又很宽，一个人维护，
细节难免有不到位的地方；我自己主力用来开发，很多功能平时也用不到。主要配合 DeepSeek、GPT 系列使用。
我会不断完善、修复 bug，欢迎提 issue。

我自己的判断：和大厂的 Agent 比，neox 在工具扩展性上还差一些 —— 右侧工作面板的一些功能还不完整，
Computer Use 也不完善。

<p align="center">
  <img src="docs/images/desktop-session.png" alt="Code 模式：Agent 把 CSV 画成图，结果在对话旁边打开" width="100%">
</p>

## 功能一览


**两步上手。** 选你主要用来做什么，再填一个 Key —— 或者直接导入这台 Mac 上
Claude Code / Codex 已经配好的。

<p align="center">
  <img src="docs/images/desktop-onboarding.png" alt="引导：选 Work 或 Code" width="49%">
  <img src="docs/images/desktop-onboarding-model.png" alt="引导：自带 Key，或从 Claude Code / Codex 导入" width="49%">
</p>

**模型并排管理。** 任何兼容 OpenAI / Anthropic 协议的服务商，加上 Ollama、LM Studio
的本地模型。每个服务商都有健康检查，模型选择器把它们放在同一个列表里。

<p align="center">
  <img src="docs/images/desktop-providers.png" alt="模型服务商与健康检查：云端网关、通义千问、本地 Ollama" width="49%">
  <img src="docs/images/desktop-model-picker.png" alt="模型选择器：云端和本地模型在同一个列表" width="49%">
</p>
<p align="center">
  <img src="docs/images/desktop-add-provider.png" alt="添加服务商：粘贴 Key 自动识别，或从 Codex / Claude Code 导入" width="100%">
</p>

**本地部署模型。** 本地模型面板告诉你哪些模型装得下、实际加载的上下文有多长、
能不能调用工具。**让 Agent 操控 App。** 装上 Computer Use，它通过辅助功能读屏幕、
替你点按钮 —— 图里它在操作 macOS 计算器。

<p align="center">
  <img src="docs/images/desktop-local-models.png" alt="本地模型面板：内存、实际上下文、工具调用检测" width="49%">
  <img src="docs/images/desktop-computer-use.png" alt="Computer Use：Agent 点计算器并读出结果" width="49%">
</p>

**不止写代码。** Work 模式一句话做出网页、表格和 Word 文档。插件补上 GitHub、
Cloudflare、arXiv、数据库等能力 —— 不用账号。

<p align="center">
  <img src="docs/images/desktop-work.png" alt="Work 模式：一句话做出菜单网页、表格和 Word 文档" width="49%">
  <img src="docs/images/desktop-plugins.png" alt="Neox 插件市场，不用账号" width="49%">
</p>

**对话旁边的工作区。** 右侧面板可以打开文件、Git、表格、Word、PDF、浏览器、计划、待办、团队、
终端、运行中的服务，以及插件面板。「工具」页汇总技能、MCP、知识库、图片、插件、成品架和 Agent 团队。

<p align="center">
  <img src="docs/images/desktop-surfaces.png" alt="右侧工作区：文件、Git、表格、Word、PDF、浏览器、计划、待办、团队、终端、服务、插件面板" width="100%">
</p>
<p align="center">
  <img src="docs/images/desktop-tools.png" alt="工具：技能、MCP、知识库、图片、插件、成品架、团队" width="100%">
</p>

**按自己的习惯调。** 字号和显示密度、输入框形态，以及 Agent 动手前要不要问你 —— 包括把密钥抹掉再发给模型。

<p align="center">
  <img src="docs/images/desktop-conversation.png" alt="对话设置：字号、输入框形态、显示密度" width="49%">
  <img src="docs/images/desktop-permissions.png" alt="权限：动手前问不问、保护、沙箱" width="49%">
</p>

**手机遥控电脑。** 同一个 Wi-Fi：点一下电脑、核对一个码；在外面：走你自己部署的中继。
会话、回复和 Agent 做出来的文件（包括图表）都能在手机上看。

<p align="center">
  <img src="docs/images/desktop-remote.png" alt="远程访问：局域网直连与自托管中继都已连上" width="100%">
</p>
<p align="center">
  <img src="docs/images/phone-computers.png" alt="经中继在线的电脑" width="24%">
  <img src="docs/images/phone-computer.png" alt="手机上看电脑上的会话" width="24%">
  <img src="docs/images/phone-image.png" alt="手机上看电脑会话和它画的图" width="24%">
  <img src="docs/images/phone-confirm.png" alt="点一下连接：到电脑上核对同一个码" width="24%">
</p>

**终端。** 同一个 Agent，在仓库里用 `neox`：改动以 diff 显示，状态栏是审批模式、模型、上下文占用和花费，
`/context` 拆开看窗口里装了什么、上一轮命中了多少缓存。

<p align="center">
  <img src="docs/images/cli.png" alt="终端：修复计价 bug，带 diff、测试和状态栏" width="100%">
</p>
<p align="center">
  <img src="docs/images/cli-context.png" alt="终端：/context —— 窗口里装了什么、上一轮缓存命中" width="100%">
</p>

## Harness 设计

贯穿整个设计的有两条原则：**前缀稳定**（每一次请求都尽量命中提示词缓存，这是长会话成本和延迟的大头），
**不猜**（拿不准就报错让模型重来，不替模型做模糊决定）。下面按组件说。

### Agent 循环

主循环在 `packages/kernel/src/core/runner.ts`。轮数、工具调用次数、运行时长默认都不设上限 ——
靠「有没有进展」来停，而不是数数：

- **卡住检测**：每 15 秒检查一次进展，90 秒没动静先告警，240 秒尝试恢复（最多两次），600 秒放弃。
- **空转检测**：已经改过文件之后，连续 5 轮不调工具就收尾。
- **截断续写**：模型输出被 `length` 截断时，最多催 3 次让它接着写。
- **费用上限**：可以给会话设美元上限，到了就停。

一次回复里的多个工具调用按顺序分批：只读或声明为并发安全的工具一起跑，遇到第一个不安全的调用，
后面全部串行；写同一个文件靠文件锁串行；没有路径的工具（比如 Shell）当作屏障。
工具出错不抛异常，原样作为工具结果还给模型。每轮工具输出总量约占输入预算的 60%，超出部分头尾截断。

### 工具怎么暴露给模型

常驻的只有 25 个左右高频工具（搜索、读、改、写、Shell、子 Agent、联网、记忆、技能等），
其它工具按「工具包」组织，模型通过 `tool_search` 按需解锁。原因很直接：每次请求都要把所有工具的
schema 重发一遍，常驻越少越省；但一次 `tool_search` 本身要多一轮模型往返，所以哪些常驻是按实测
调用频率定的。解锁过的工具只往 `tools` 数组末尾追加、顺序不变，每次解锁只让缓存失效一次；
最多解锁 15 个，满了按最近最少使用淘汰。

### 请求模式：标准与节约

每次请求开局要带多少东西，有两档，随时切换（桌面端「请求模式」，CLI `--lean`），从下一句开始生效：

- **标准**（默认）：开局约 17–26K token —— 完整的做事规范 + 25 个常用工具随时可用。
- **节约**：开局约 3K token —— 精简规范 + 读、写、改、命令、搜索 6 个基础工具，其余用到时模型自己解锁。

标准模式开局大，是有意的取舍，不是浪费：

1. **这部分几乎都走缓存。** 开局内容整个会话里保持不变，第一次请求之后就是缓存命中；
   DeepSeek 等服务商的缓存命中价格只有正常输入的几十分之一。会话越长，这部分摊得越薄，
   真正花钱的是每轮新增的内容。前提是渠道本身保留缓存：一些第三方中转会把请求分到不同上游，
   缓存命中明显偏低（我们走中转实测过只有 58%），看缓存效果请以官方 API 为准。
2. **少一轮是一轮。** 工具不在手边，模型要先 `tool_search` 再调用，多一次完整的模型往返，
   而且每解锁一次，缓存失效一次。常用工具常驻，省掉的是这些来回。
3. **规范减少返工。** 改之前先读、改完要验证、不确定就停下来问 —— 这些写在规范里，
   模型少走弯路。一次改错再重来，花的 token 远多于开局那几千。较弱的模型尤其需要。
4. **模型知道自己能做什么。** 浏览器、Office 文档、MCP 都在列表里，模型会选对工具，
   而不是用 Shell 拼一个凑合的办法。

节约模式适合短任务、能力强的模型，或者想要首字更快的时候。哪一档更划算取决于任务长短和模型。

### 读文件与编辑

- **读**：默认一次 300 行，2000 行以内整文件读，单块最多 4000 行；整文件读有 25K token 预算，
  多文件一起读共享 40K。长文档第一次读只给大纲（8K 以内），带 `#L120-239` 这样的锚点，模型再按需读。
- **读取账本**：按路径和行范围记下给模型看过的内容、mtime 和大小。同一范围再读一次，只回一个
  简短占位，不重复塞全文。判断「读过之后文件有没有被改」靠 mtime + 大小，不算哈希。
- **编辑**：精确字符串替换，`old_string` 必须唯一（或显式 `replace_all`），一次可以改多处。
  匹配不上时只容忍空白和空行差异，没有「相似匹配」—— 宁可失败让模型重读，也不猜着改。
  账本只在匹配失败后用来诊断（没读过 / 读过但已过期），不强制先读后改。

### Shell

前台命令跑满 60 秒自动转到后台（不杀进程），用户发新消息时也会转；`sleep N` 开头或已知的长任务
直接后台跑。后台任务结束时，下一次模型调用前会插入一条完成通知，Agent 自己接着处理。
输出保留头 192KB + 尾 64KB，超过 16MB 强杀。开启沙箱时命令跑在 Seatbelt / bubblewrap /
AppContainer 里，并拒绝 `$()`、反引号和白名单外的命令。

### 上下文注入

时间、回复语言、设备状态这类每轮都变的信息追加在**最新一条用户消息**里，不进 system prompt；
system prompt 分段、顺序固定，并且会话开始时连同工具列表、模型一起拍一次快照，子 Agent 直接复用。
有一个只做测量的探针：每轮给 system prompt 算哈希、记录缓存命中，目标是 5 轮内 0 次变化、
命中率 80% 以上；缓存读取量比上一轮掉 5% 且超过 2000 token 时告警。
项目说明依次读 `.neox/INSTRUCTIONS.md`、`NEOX.md`、`AGENTS.md`、`.cursorrules`、`CLAUDE.md`。

### 压缩

分两级：

- **轻量级**（用到窗口 60%）：同一文件多次读取只留最新一次，只保留最近 4 个工具结果，清掉旧的
  Shell 输出；超过 30K 字符的工具输出落盘，对话里只留头尾预览。两次轻量压缩之间至少要再长 48K。
- **完整压缩**（`min(窗口 − 33K, 窗口 × 85%)`）：摘要请求复用当前对话前缀，命中缓存，只追加一句
  「请总结」；输出六段式摘要，最多 3 轮、收益低于 5% 就停。system 消息、最后一条用户消息和任务锚点
  原样保留，其余合成一条工作记录；压缩后重新注入计划和最近访问的文件。连续失败 3 次熔断。

### 子 Agent 之间传上下文

内置 explore / code / shell / plan 几种子 Agent。普通子 Agent 拿父对话的有损摘录（最多 12K 字符，
去掉工具结果）；fork 型子 Agent 拿完整父对话 —— 前缀和父对话一致，直接命中缓存。子 Agent 把结果
以摘要交回；彼此之间有带收件箱的消息总线。各自有独立的读取账本；读并发、写同一文件串行；
可以在独立的 git worktree 里干活，没有改动时自动清掉。

### 运行中插话与中断恢复

Agent 跑着的时候可以继续发消息：默认等这轮结束，也可以插到下一步之前；再按一次回车会打断正在输出的
模型（已输出的文字保留，正在跑的工具不杀）。暂停只在两次模型调用之间生效，不会卡在半截。
进程中途退出时，重启后给没有结果的工具调用补一个「被中断」的结果，修好历史，不自动续跑。

### 多服务商与重试

各协议原生适配。流式请求最多重试 6 次（1 秒起、指数退避、上限 4 秒、±20% 抖动），限流单独退避
（最长 60 秒）；连接 30 秒、首字节 20 秒、流空闲 120 秒超时。同一服务商连续失败就沿备用链路切换。
Anthropic 协议加 `cache_control`。

### 检查点

独立的影子 git 仓库记录每轮改动，可以按 hunk、按文件或整轮回退；回退前检查你之后有没有手动改过
同一个文件，改过就拒绝，不覆盖你的修改。

### 界面

桌面端时间线超过 400 行启用虚拟列表；流式增量按帧合并成一次渲染；行高和滚动位置有缓存。
手机经中继传的是端到端加密的信封，中继只转发密文；手机离线时中继在内存里暂存最多 24 小时。

## 简单的对比测试

**先说清楚：这只是简单测试。** 一道短任务、一道长任务，每家跑 2–3 次。不同场景、不同任务下，每个 Agent 的表现都会不一样；
在模型能力越来越强的今天，各家 Agent 整体上差得不多。下面的数字只说明这一道题上的情况。

### 短任务

**方法。** 在一个小的 Node「咖啡店」项目上加订单 HTTP 接口（参数校验、会员折扣、每 10 杯免 1 杯、
JSON 持久化、自己写测试和 README），事先写好并验证过 25 条隐藏测试用来判分。6 种配置 × 3 次，
每轮顺序随机。所有 Agent 用同一个 key 直连 DeepSeek 官方 API、同一个模型（DeepSeek V4.1 Flash，思考 high），
中间经过一个本地记录代理，逐个请求记录用量和时间。成本按 DeepSeek 官网峰时价计算（每百万 token：
缓存命中 $0.006、未命中 $0.30、输出 $1.20）。2026-10-29 测试；版本：OpenNeox CLI（标准 / 节约两种请求模式）、
opencode 1.18.32、pi 0.73.1、Codex CLI（按 DeepSeek 官方说明配置）、DeepSeek Harness（headless）。

**结果**（3 次的中位数；18 次全部通过 25 条隐藏测试）：

| | 首轮上下文（工具数） | 缓存命中 | 未命中输入 | 输出 | 单次成本 | 用时 | 请求数 |
|---|---|---|---|---|---|---|---|
| neox 标准 | 19,851 (19) | 98.0% | 7,860 | 12,769 | $0.0202 | 68.0 秒 | 13.3 |
| neox 节约 | 3,492 (8) | 96.9% | 6,222 | 15,081 | $0.0211 | 82.8 秒 | 14.7 |
| opencode | 10,264 (10) | 93.9% | 11,984 | 9,391 | $0.0155 | 50.4 秒 | 13.0 |
| pi | 4,490 (4) | 96.7% | 5,699 | 17,763 | $0.0239 | 94.0 秒 | 11.7 |
| Codex | 11,834 (10) | 97.4% | 16,894 | 19,155 | $0.0297 | 110.9 秒 | 19.7 |
| DeepSeek Harness | 9,254 (25) | 96.7% | 17,953 | 25,019 | $0.0391 | 156.3 秒 | 21.3 |

新会话**第一个请求**的缓存命中率：neox 94–95%、Codex 92–98%、neox 节约 62%、pi 60%、opencode 16%、
DeepSeek Harness 8%。neox 的 system prompt 和工具定义是固定的，工作目录这类每次不同的信息放在它们之后，
所以新会话也能命中缓存。

**能看出的：**
- 首轮上下文大不等于贵：各家输入缓存命中都在 94–98%，成本的 69–89% 来自输出。neox 标准首轮最大，
  但几十万命中 token 只花了约 $0.002；节约模式把首轮压到 3.5K，在这道题上反而没有更便宜。
- opencode 在这道题上最快也最便宜，主要因为它输出最少。
- 首字时间各家一样（约 0.7 秒），由 DeepSeek 服务端决定。

**局限：** 只有一道题；每家 3 次，1.5 倍以内的差异可能只是波动；最大上下文只到约 53K，长会话（压缩）没有测到；
题目是我们出的。

### 长任务

**方法。** 在空目录里从零写一个完整的咖啡店订单服务：HTTP 接口 + 命令行、菜单、带校验的订单、会员折扣、集章、
日报、原子写入的 JSON 持久化、自己的测试和 README，用事先写好并验证过的 44 条隐藏测试判分。条件同上
（DeepSeek 官方 API、同一个 key、V4.1 Flash、思考 high），每家 2 次，测试时段是高峰，下表价格即实付。
DeepSeek Harness 用 0.2.1-rc.2、Node 24、headless 配置。

**结果**（2 次的中位数）：

| | 通过 | 隐藏测试 | 用时 | 请求数 | 最大上下文 | 缓存命中 | 未命中输入 | 输出 | 单次成本 |
|---|---|---|---|---|---|---|---|---|---|
| neox 标准 | 2/2 | 44, 44 | 322 秒 | 20.5 | 90K | 99.3% | 8.0K | 66K | $0.090 |
| neox 节约 | 2/2 | 44, 44 | 297 秒 | 31 | 71K | 99.2% | 11.2K | 61K | $0.086 |
| opencode | 2/2 | 44, 44 | 374 秒 | 25.5 | 85K | 98.4% | 20.7K | 71K | $0.099 |
| pi | 1/2 | 43, 44 | 441 秒 | 37.5 | 98K | 98.7% | 23.7K | 78K | $0.112 |
| Codex | 1/2 | 43, 44 | 249 秒 | 26.5 | 64K | 98.6% | 15.3K | 44K | $0.065 |
| DeepSeek Harness | 2/2 | 44, 44 | 545 秒 | 35 | 116K | 98.9% | 25.2K | 92K | $0.132 |

**能看出的：**
- 成本主要由输出决定：Codex 输出最少，用时和成本最低；DeepSeek Harness 输出最多（其中约七成是思考），最慢也最贵。
- 长会话里 neox 的缓存命中最高（99.3%），未命中的输入最少。
- pi 和 Codex 各有一次漏了同一条规则（非会员订单不应记章）。

**局限：** 每家 2 次；最大上下文 61–122K，各家都没有触发上下文压缩；题目是我们出的。

## 下载

打好的安装包在 [Releases](https://github.com/neoxlabs/OpenNeox/releases)：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| macOS（Apple 芯片） | `OpenNeox-<版本>-arm64.dmg` | 还没做公证。拖进「应用程序」后执行一次 `xattr -dr com.apple.quarantine /Applications/OpenNeox.app`，或右键 → 打开。 |
| Android | `OpenNeox-<版本>.apk` | 安装时按提示允许浏览器 / 文件管理器安装应用。 |

Windows / Linux 桌面端、iOS 和 CLI 目前从源码构建，见下文。

## 快速开始

需要 Node.js 20 及以上。npm 上的 `@neoxlabs/cli` 是商业版；开源版请从源码构建：

```bash
git clone https://github.com/neoxlabs/OpenNeox.git
cd OpenNeox
npm ci
npm run build
npm link            # 把 `neox` 放进 PATH
```

添加模型 Key，交互式向导会把它存在本地：

```bash
neox provider add
```

或者直接导出环境变量，`neox` 会自动识别：

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # 也支持 OPENAI_API_KEY、GEMINI_API_KEY、
                                        # MOONSHOT_API_KEY、DOUBAO_API_KEY
                                        # （兼容端点再配 *_BASE_URL）
```

然后在任意项目里启动：

```bash
cd your-project
neox
```

## 用法

```bash
neox                              # 在当前目录开一个交互会话
neox "登录测试为什么挂了？"          # 执行一条指令，打印结果后退出
neox -c                           # 继续最近一次会话
neox -r                           # 挑一个历史会话恢复
neox -m <model> --provider <id>   # 这次用哪个模型
neox -d ../other-repo             # 在别的目录里干活
```

给脚本和 CI 用的非交互模式：

```bash
neox -p "总结一下这个分支改了什么"
neox -p --json "列出 src/ 里的 TODO"                   # stdout 输出一个 JSON 对象
neox -p --output-schema schema.json "提取所有 API 路由"
neox -p --yolo "把 lint 错误修掉"                       # 允许改文件、跑命令
```

不加 `--yolo` 时，`-p` 只读不写。

会话里的命令：

| 命令 | 作用 |
| --- | --- |
| `/session ls` · `/session new` · `/session export` | 管理会话 |
| `/checkpoint create [name]` | 给工作区拍快照 |
| `/rollback <id>` | 回滚到某个检查点 |
| `/provider` · `/model` | 切换服务商或模型 |

管理命令：

| 命令 | 作用 |
| --- | --- |
| `neox provider ls \| add \| test [id]` | 管理模型服务商 |
| `neox model ls` | 列出可用模型 |
| `neox mcp …` | 管理 MCP server |
| `neox skill …` | 管理技能 |
| `neox daemon …` | 后台守护进程 |

完整列表见 `neox --help`。

## 桌面端

```bash
npm ci
npm run ui:dev          # 构建各个包，然后带热更新启动 App
```

自己打包：`npm run dist:mac`（或 `dist:win` / `dist:linux`），产物在 `release/`。
macOS 上 `dist:mac` 会顺带编译 Computer Use 辅助程序，需要 Xcode 命令行工具（`xcode-select --install`）；Windows 上 `dist:win` 用 Rust 编译它（`rustup`）。
不配自己的签名证书时是未签名包。OpenNeox 的数据放在 `~/.neox-open`，
注册的是 `openneox://` 协议，跟其它 Neox 构建同机共存、互不共用设置和会话。不会自动更新。

## 手机端

```bash
cd apps/mobile
flutter run -t lib/main.dart
```

也可以直接装 Releases 里的 APK。

**配对。** 在桌面端打开 **设置 → 手机连接 → 配对手机**，然后在手机上任选一种：

- **点一下同一 Wi-Fi 下找到的电脑** —— 电脑上弹出「允许这台手机连接？」，两边显示同一个
  6 位核对码，点了 **允许** 才会配对；
- 扫二维码，或输入 8 位备份码。

配对时两台设备派生出一把端到端密钥（X25519 + HKDF），只有它们自己持有。同一个 Wi-Fi
下手机直连电脑。

### 出门也能连

在你自己的 VPS 上跑 [`cloud/relay`](cloud/relay)：

```bash
cd cloud/relay
echo "RELAY_DOMAIN=relay.example.com" >  .env   # 指向这台 VPS 的域名
echo "RELAY_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose up -d                             # Caddy 自动申请 HTTPS 证书
```

然后在桌面端 **设置 → 手机连接 → 自托管中继** 填上 `https://relay.example.com` 和令牌。
之后配对的手机随配对拿到中继；之前配好的手机下次在家里 Wi-Fi 连上时自动拿到。出门后手机
自己切到中继。中继只转发密文 —— 没有账号、没有数据库，也看不到你的会话内容。详见
[cloud/relay/README.md](cloud/relay/README.md)。

## 模型

一个服务商配置就是 API Key、模型和可选的 Base URL。
`packages/kernel/src/models/providerPresets.ts` 里的预设提供 Base URL、能力标记和
常用模型。适配层按协议统一工具 schema、思考开关、流式事件和消息配对：

| 协议族 | 适配器 |
| --- | --- |
| OpenAI | `openai`、`openai-responses` |
| Anthropic | `anthropic`、`anthropic-openai`、`glm-claude`、`kimi-claude` |
| Google | `gemini` |
| 其他原生协议 | `deepseek`、`kimi`、`glm`、`qwen`、`minimax`、`doubao`、`grok` |
| OpenAI 兼容预设 | OpenRouter、Mistral、Groq、Together AI、Dashscope、opencode Zen |

没有预设也没关系：任何兼容 OpenAI 或 Anthropic 协议的端点都能直接用，包括你本机跑的模型。

## 安全模型

三层互相独立，谁也替代不了谁：

- **权限** —— `PermissionManager` 对每一次工具调用做决定，读、写、破坏性操作、
  花钱的操作分开归类。
- **沙箱模式** —— 每次运行的粗粒度策略，整类整类地开关工具。
- **系统沙箱** —— `packages/sandbox` 把策略编译成 Seatbelt、bubblewrap/unshare 或
  AppContainer 的启动方式；没有可用后端时退回直接执行，并且会说明原因，不会悄悄失败。

## SDK

```ts
import { Agent, tool } from '@neoxlabs/sdk';
import { z } from 'zod';

const agent = new Agent({
  model: 'claude-sonnet-5',
  tools: [
    tool({
      name: 'read_invoice',
      description: '按 id 读取一张发票',
      schema: z.object({ id: z.string() }),
      handler: async ({ id }) => db.invoices.get(id),
      readOnly: true,
    }),
  ],
});

const result = await agent.run('总结发票 INV-204');
console.log(result.text);
```

`createSession` 跨调用保留对话和工具状态；`provider` / `providerFromEnv` 选择模型后端；
权限决定由你的应用提供 `PermissionHandler`。

## 架构

```
apps/cli/         `neox` 终端应用（Ink）
apps/desktop/     桌面端（Electron + React）
apps/mobile/      手机端（Flutter）
cloud/relay/      手机用的自托管中继（Go）
packages/
  kernel/         Agent 循环、服务商、消息与工具类型、权限
  platform/       配置、SQLite 存储、日志、模型注册表
  core/           运行时、工具、模型适配、会话、MCP、技能
  sdk/            可嵌入的 Agent / 会话 API
  sandbox/        系统沙箱策略编译与启动后端
  cloud/          可选能力契约，默认关闭
  pptx-compose/   PPT 生成引擎；pptx-renderer/ 在应用里渲染幻灯片
  …               native 等支撑包
plugins/          公开插件实现
```

一轮对话：编排器选定服务商和模型并打开检查点；`StreamedRunner` 流式接收回复，
校验每个工具调用，经过权限和沙箱后执行，把结果接回对话，如此循环，直到模型停下、
你取消，或者预算用完。详见 [docs/architecture.md](docs/architecture.md)（英文）。

## 开发

```bash
npm run type-check      # TypeScript 严格模式
npm test                # 单元测试（需 Node 22：会话测试用到 node:sqlite）
npm run check:arch      # 包边界、导出、模块路径
npm run audit:comments  # 注释质量闸
npm run check:licenses  # 许可证元数据
```

扫源码的测试需要 `ripgrep`，Shell 回归测试需要 `zsh`。`packages` 不允许 import
`apps`，违反时 `npm run check:boundaries` 直接让构建失败。

## 用到的开源项目

Agent 的 harness 是自研的，但应用本身站在很多开源项目上，主要有：

- **编辑器**：微软的 [Monaco Editor](https://github.com/microsoft/monaco-editor)（VS Code 的编辑器内核），
  在它基础上打了补丁；Java 调试用的是微软的 java-debug 插件
- **桌面端**：[Electron](https://www.electronjs.org/)、[React](https://react.dev/)、
  [TanStack Virtual](https://tanstack.com/virtual)（时间线虚拟列表）、[xterm.js](https://xtermjs.org/) +
  [node-pty](https://github.com/microsoft/node-pty)（终端）、[three.js](https://threejs.org/)（桌宠 3D）、
  [Mermaid](https://mermaid.js.org/)、[KaTeX](https://katex.org/)、[PDF.js](https://mozilla.github.io/pdf.js/)、
  [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)
- **终端**：[Ink](https://github.com/vadimdemedes/ink)（仓库里带了一份 6.6.0 快照）
- **工具层**：[ripgrep](https://github.com/BurntSushi/ripgrep)（经 @vscode/ripgrep）、
  [tree-sitter](https://tree-sitter.github.io/)、[Playwright](https://playwright.dev/)（浏览器自动化）、
  [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)、[sharp](https://sharp.pixelplumbing.com/)
- **手机端**：[Flutter](https://flutter.dev/)，以及 cryptography_flutter（带我们的补丁）等插件
- **中继**：Go + [gorilla/websocket](https://github.com/gorilla/websocket)，HTTPS 由 [Caddy](https://caddyserver.com/) 处理
- **图标**：[lobe-icons](https://github.com/lobehub/lobe-icons)（服务商图标）、devicon、simple-icons

完整清单和各自的许可证见 [NOTICE](NOTICE) 以及 npm / Flutter 的依赖清单。感谢这些项目的作者。

## 许可证

[GNU AGPL v3](LICENSE)。把修改过的版本作为网络服务提供给别人用时，需要向这些用户提供
源码。2026-10-27 之前发布的版本按 Apache 2.0 发布，仍可按 Apache 2.0 使用。第三方材料
保留各自的许可证，见 [NOTICE](NOTICE)。

## 参与贡献

提交修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，
进行中的工作见 [docs/status.md](docs/status.md)。安全问题请按 [SECURITY.md](SECURITY.md)
私下报告，不要开公开 issue。

## 社区

本项目参与并支持 [linux.do](https://linux.do) 社区，欢迎 Star、试用、提 issue 和 PR。
