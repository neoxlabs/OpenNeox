---
name: "Code Review"
description: "审查代码改动, 找出会让程序出错的真问题 (逻辑错、漏掉的分支、假成功、数据丢失、安全漏洞), 每条都先核实再报"
description_en: "Review code changes for real defects (logic errors, missed paths, fake success, data loss, security holes); verify each finding before reporting"
user-invocable: true
neox:
  category: code
  aliases: [cr, review]
  allowedTools: [readfile, search, search_files, git_diff, git_status, execute_shell]
  dangerLevel: safe
---

## Overview

目标只有一个: 找出**会让用户遇到错误行为**的问题。风格偏好、命名、「可以加注释」不算问题, 不要报。
宁可报 2 条确定的, 也不要报 10 条「可能」。

## Instructions

1. **确定审查范围**
   - 用户指定了文件 / 分支 / PR 就审它 (PR 用 `gh pr diff <号>`)。
   - 否则先 `git diff --staged`, 为空再 `git diff`, 再为空就 `git diff HEAD~1`。
   - 先通读 diff, 弄清这次改动想达成什么。

2. **读上下文, 不要只看 diff**
   对每处改动, 读它所在的整个函数, 以及调用它的地方 (用 search 找调用方)。很多 bug 不在改的那几行, 而在改动和调用方的约定对不上。

3. **按这些方向找问题**
   - **逻辑**: 条件写反、差一、空值 / 空数组、并发和重复点击、异步没 await、错误被吞掉。
   - **假成功**: 调用返回 `{success:false}` 或错误码, 调用方没检查, 界面照样显示成功。
   - **数据**: 覆盖写丢字段、路径拼错写到别处、迁移不幂等、删除删错对象。
   - **约定不一致**: 写入方和读取方对格式 / 目录 / 字段名的理解不同。
   - **安全**: 命令注入、路径穿越、SQL 注入、XSS、密钥写进日志或提交。
   - **遗漏**: 改了一处, 同类的另外几处没改 (用 search 找同名函数和同样的写法)。

4. **逐条核实**
   每个怀疑点都要找到证据: 构造具体输入走一遍代码路径, 能跑就写个小测试或命令跑一下。核实不了的要么删掉, 要么明确标「未核实」。

5. **输出**

```markdown
## 审查结论
一句话: 能不能合 / 有几个必须修的问题。

## 问题 (按严重度排序)
### 1. [P0/P1/P2] 一句话问题 · `文件:行`
- 现象: 用户做什么操作、会看到什么错误结果
- 原因: 代码层面为什么会这样
- 改法: 具体怎么改
- 核实: 怎么确认的 (跑了什么 / 走了哪条路径)
```

严重度: P0 = 数据丢失、功能完全坏、安全漏洞; P1 = 常见操作结果错误; P2 = 少见边界情况。
没找到问题就直接说「没发现问题」, 再列出看过的范围。不要为了显得认真而凑问题。
