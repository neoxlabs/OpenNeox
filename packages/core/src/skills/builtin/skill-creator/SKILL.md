---
name: "Skill Creator"
description: "把一套做事方法写成技能 (SKILL.md): 用户说「把这个流程做成技能 / 以后都这么做 / 记住这套步骤」, 或者刚做完一件以后还会重复做的事时用"
description_en: "Turn a working procedure into a skill (SKILL.md) — when the user says 'make this a skill / always do it this way', or after finishing a task that will recur"
user-invocable: true
neox:
  category: custom
  aliases: [create-skill, new-skill, 写技能]
  dangerLevel: safe
---

## Overview

技能的作用是: 下次遇到同类任务, 自动加载这份说明, 照着做。平时常驻上下文的**只有 description 那一行**, 所以 description 决定这个技能能不能被正确触发, 是最重要的一行。

## Instructions

1. **先弄清楚要沉淀什么**
   - 什么场景下用 (用户会怎么说)。
   - 具体步骤、命令、文件路径。
   - 做这件事时踩过的坑、用户纠正过的做法。这部分最有价值, 一定要写进去。
   刚做完的任务, 直接从对话记录里提炼。信息不够时, 问用户一次, 把要问的集中成一个问题。

2. **决定放哪**
   - 只跟当前项目有关 → `<项目>/.neox/skills/<名字>/SKILL.md`。
   - 所有项目都用 → `~/.neox/skills/<名字>/SKILL.md`。
   - 名字用小写字母加连字符, 比如 `deploy-api`。

3. **写 SKILL.md**

```markdown
---
name: <名字>
description: <做什么 + 什么时候用。把用户可能说的关键词写进去, 不超过两句>
---

# <标题>

## 步骤
1. ... (写具体命令和路径, 不要写「按需处理」这种空话)

## 注意
- <坑: 现象 → 原因 → 正确做法>
```

   - 写给另一个 agent 看: 它没有这次对话的记忆, 所以每个步骤都要自己就能看懂。
   - 密码、token 不要写进去, 只写去哪里读 (比如某个 env 文件的路径)。
   - 正文控制在 150 行以内。参考资料太长的, 放到同目录下的其他文件里, 正文里写明什么时候去读哪个文件。

4. **检查能不能触发**: 用 2~3 句用户可能会说的话对照 description, 确认能对上; 再想 1 句不该触发的话, 确认对不上。
5. 告诉用户技能放在哪里、什么时候会自动用上。
