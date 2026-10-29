---
name: "Init Project Instructions"
description: "读懂当前项目, 生成或更新项目说明文件 (NEOX.md / AGENTS.md): 怎么构建、测试、运行, 目录结构, 项目约定和要避开的坑"
description_en: "Study the current project and create or update its instructions file (NEOX.md / AGENTS.md): build, test, run, layout, conventions and pitfalls"
user-invocable: true
neox:
  category: code
  aliases: [init, 初始化项目说明]
  dangerLevel: safe
---

## Overview

项目说明是之后每个会话开头都会读到的东西。只写**读代码不容易看出来、但干活必须知道**的内容。写成短句清单, 不写介绍性的文字。

## Instructions

1. **先看已有的**: 项目根目录有没有 `NEOX.md`、`AGENTS.md`、`CLAUDE.md`、`.cursorrules`、`.github/copilot-instructions.md`。有就在它的基础上更新, 保留用户自己写的内容, 不要整份重写。

2. **收集事实** (每一条都要从文件里确认, 不要猜)
   - 包管理器和命令: 从 `package.json` scripts / `Makefile` / `pyproject.toml` / `Cargo.toml` 里, 找出安装、构建、跑全部测试、跑单个测试、lint、typecheck、本地启动的命令。
   - 目录结构: 只写顶层几个目录各放什么, 以及入口文件在哪。
   - 约定: 从现有代码看出来的写法 (错误怎么处理、测试放哪、命名风格), 以及 README / CONTRIBUTING 里写明的规矩。
   - 坑: 需要的环境变量、必须先跑的生成步骤、改了 A 必须同时改 B 的地方。

3. **写文件**: 默认写 `NEOX.md`; 项目里已经有 `AGENTS.md` 就更新那一份。结构:

```markdown
# <项目名>
一句话说明这是什么。

## 命令
- 安装: ...
- 构建: ...
- 测试: ... (单个测试: ...)
- 启动: ...

## 结构
- `src/...`: ...

## 约定
- ...

## 注意
- ...
```

4. **核实**: 至少挑一条测试命令或构建命令真跑一次, 确认写对了。写进去的命令没跑过的, 在汇报里说明。
5. 写完给用户看改了哪些地方。通用的编程建议 (「写清晰的代码」之类) 不要写进去。
