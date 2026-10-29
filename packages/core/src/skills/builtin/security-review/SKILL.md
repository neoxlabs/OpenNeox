---
name: "Security Review"
description: "对代码或改动做安全审查: 注入、越权、路径穿越、密钥泄露、不安全的依赖和配置, 每条给出可复现的利用路径和修法"
description_en: "Security review of code or changes: injection, broken authz, path traversal, secret leaks, unsafe deps and config — each with a reproducible path and fix"
user-invocable: true
neox:
  category: code
  aliases: [security, sec-review, 安全审查]
  allowedTools: [readfile, search, search_files, git_diff, git_status, execute_shell]
  dangerLevel: safe
---

## Overview

只报**能说出攻击路径**的问题: 谁、从哪个入口、传什么、能拿到或破坏什么。说不出路径的「理论风险」不报, 或者单独列为「建议加固」。
这是防御性审查, 只描述问题类别和修法, 不写可以直接用来攻击的完整利用代码。

## Instructions

1. **先画出信任边界**: 外部输入从哪里进来 (HTTP 参数、请求头、文件上传、IPC 消息、命令行参数、读进来的文件内容、模型输出), 最后流到哪些危险的地方 (shell、SQL、文件路径、HTML、eval、反序列化、跳转 URL)。

2. **沿着数据流查**
   - **注入**: 拼字符串的 shell 命令、SQL、HTML。看参数有没有转义, 有没有用参数化接口。
   - **路径**: 用户给的路径有没有做规范化 (`path.resolve` 之后再判断前缀), 软链能不能逃出允许的目录, `..` 有没有被拦住。
   - **认证和越权**: 每个接口有没有校验身份, 能不能通过改 id 读到或改到别人的数据, 管理接口有没有单独鉴权。
   - **密钥**: 有没有硬编码密钥, 日志、错误信息、提交记录里会不会带出 token, 前端包里有没有不该有的 key。
   - **依赖和配置**: CORS 是不是 `*`, cookie 有没有 HttpOnly/Secure, 调试开关会不会在生产打开。用 `npm audit` 或 lock 文件查有没有已知漏洞的版本。
   - **Electron / 桌面**: `nodeIntegration`、`contextIsolation`、preload 暴露的 IPC 有没有校验参数, `shell.openExternal` 传的是不是用户可控的 URL。
   - **Agent / 模型**: 模型输出或网页内容会不会被当成指令执行 (提示词注入), 工具调用有没有权限闸。

3. **输出**
   每条写: 严重度 (高 / 中 / 低) · `文件:行` · 攻击路径 (入口 → 传入什么 → 后果) · 修法。
   最后单列「建议加固」, 放那些说不出具体攻击路径、但值得做的事。
