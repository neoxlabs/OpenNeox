---
name: "Simplify"
description: "精简刚改过的代码: 删掉重复、多余的抽象、死代码和没必要的兜底, 行为保持不变"
description_en: "Simplify recently changed code: remove duplication, needless abstraction, dead code and unnecessary fallbacks without changing behavior"
user-invocable: true
neox:
  category: code
  aliases: [simplify, cleanup, 精简]
  dangerLevel: safe
---

## Overview

前提是**行为不变**。精简完, 原来的测试要照样通过; 没有测试的, 先补一个能锁住当前行为的测试再动。

## Instructions

1. **定范围**: 默认只看本次改动 (`git diff` / `git diff HEAD~1`)。用户指定了文件就看那些文件。不要顺手去改范围外的老代码。

2. **找这几类可以精简的地方**
   - 同一段逻辑写了两遍以上 → 抽成一个函数, 或者复用仓库里已有的工具函数 (先 search 有没有现成的)。
   - 只被用一次的抽象层、包装函数、配置项 → 内联回去。
   - 不可能走到的分支、没人调用的函数、注释掉的代码 → 删掉 (先 search 确认真的没人用)。
   - 吞掉错误的 try/catch、「万一呢」的兜底默认值 → 删掉, 让错误暴露出来。确实需要处理的, 改成明确处理。
   - 过长的函数 → 只在拆开能明显看懂时才拆。
   - 注释只是把代码复述一遍 → 删掉。说明「为什么这样写」的注释要保留。

3. **一次改一类, 改完就验证**: 跑相关测试和 typecheck, 通过了再改下一类。

4. **汇报**
   - 删了多少行、合并了什么;
   - 跑了哪些验证、结果如何;
   - 看到但没动的地方 (比如超出范围、风险大), 列出来让用户决定。
