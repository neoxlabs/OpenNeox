---
name: "Code Review"
description: "对代码变更进行全面审查，检查潜在问题"
description_en: "Review code changes thoroughly and flag potential issues"
user-invocable: true
neox:
  category: code
  aliases: [cr, review]
  allowedTools: [readfile, glob, grep, execute_shell]
  dangerLevel: safe
---

## Overview

对代码变更进行专业审查，关注代码质量、安全性、性能等方面。

## Instructions

请按以下步骤执行代码审查：

1. **获取要审查的代码变更**
   - 默认审查 staged changes：`git diff --staged`
   - 如果没有 staged changes，审查工作区变更：`git diff`
   - 可指定文件、分支或 PR

2. **分析代码变更**
   关注以下方面：

   ### 正确性
   - 代码逻辑是否正确
   - 边界条件是否处理
   - 异常情况是否考虑

   ### 安全性（OWASP Top 10）
   - 注入攻击（SQL、命令、XSS）
   - 认证和授权问题
   - 敏感数据暴露
   - 不安全的配置

   ### 性能
   - 是否有 N+1 查询
   - 是否有不必要的循环
   - 内存泄漏风险
   - 是否缺少缓存

   ### 可维护性
   - 代码是否清晰易读
   - 命名是否合理
   - 是否有重复代码
   - 注释是否充分

3. **生成审查报告**

## Output Format

使用以下格式输出审查报告：

```markdown
## Code Review Report

### Summary
- 审查文件数: X
- 变更行数: +X / -X
- 总体评价: [优秀/良好/需改进/有问题]

### Critical Issues 🔴
严重问题，必须修复

- [文件:行号] 问题描述
  建议: 修复建议

### Warnings ⚠️
警告，建议修复

- [文件:行号] 问题描述
  建议: 修复建议

### Suggestions 💡
改进建议

- [文件:行号] 改进建议

### Highlights ✨
代码中的亮点

- [文件:行号] 亮点描述
```

## 参数说明

- `<file>`: 指定要审查的文件
- `--branch <name>`: 审查指定分支与当前分支的差异
- `--pr <number>`: 审查指定 PR（需要 GitHub CLI）
- `--focus <area>`: 聚焦审查区域（security/performance/style）

## Examples

### 审查 staged changes
```
用户: /review
AI: 获取 staged changes，进行全面审查，输出报告
```

### 审查指定文件
```
用户: /review src/auth/login.ts
AI: 读取文件，进行审查，输出报告
```

### 聚焦安全审查
```
用户: /review --focus security
AI: 重点检查安全相关问题
```

### 审查 PR
```
用户: /review --pr 123
AI: 使用 gh 命令获取 PR 变更，进行审查
```

## 审查清单

### 必查项
- [ ] 是否有硬编码的密钥或密码
- [ ] 是否有 SQL 注入风险
- [ ] 是否有 XSS 风险
- [ ] 是否正确处理了错误
- [ ] 是否有资源泄漏（文件、连接等）

### 推荐查项
- [ ] 变量命名是否清晰
- [ ] 函数是否过长（> 50 行）
- [ ] 是否有魔法数字
- [ ] 是否缺少必要的日志
- [ ] 是否有适当的类型定义
