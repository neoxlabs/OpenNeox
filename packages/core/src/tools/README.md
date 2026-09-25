# Markor Tools - Code Interpreter

强大的代码执行工具，让 AI Agent 能够执行代码进行计算、数据分析和自动化任务。

## 特性

✅ **多语言支持**
- Python 3
- JavaScript (Node.js)
- TypeScript (通过 tsx)
- Bash/Shell

✅ **安全可配置**
- 执行超时控制
- 输出大小限制
- 可选的网络访问控制
- 可选的文件系统访问控制

✅ **强大功能**
- 捕获标准输出和错误输出
- 自动捕获生成的图片（matplotlib 等）
- 错误处理和超时保护
- 详细的执行结果

## 快速开始

### 基础使用

```typescript
import { executeCode } from './src/tools/index.js';

// 执行 Python 代码
const result = await executeCode(
  `
import math
result = math.sqrt(144)
print(f"Square root: {result}")
`,
  'python'
);

console.log(result.stdout); // "Square root: 12.0"
```

### 在 StreamedRunner 中使用

```typescript
import { StreamedRunner } from './src/core/runner.js';
import { ShortTermMemory } from './src/memory/shortterm.js';
import { AnthropicProvider } from './src/models/anthropic.js';
import { executePython, executeJavaScript } from './src/tools/index.js';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: 'claude-3-5-sonnet-20241022',
});
const memory = new ShortTermMemory(200);
const runner = new StreamedRunner({
  llmProvider: provider,
  model: 'claude-3-5-sonnet-20241022',
  tools: [executePython, executeJavaScript],
  memory,
  config: { maxIterations: 5, temperature: 0.7 },
  instructions: 'You are a data analyst that can execute code',
});

let output = '';
for await (const event of runner.run('Compute the average of [1, 2, 3]')) {
  if (event.type === 'text_delta' && event.delta) {
    output += event.delta;
  }
}
console.log(output);
```

### 自定义配置

```typescript
import { CodeInterpreter } from './src/tools/index.js';

const interpreter = new CodeInterpreter({
  timeout: 60000,           // 60秒超时
  maxOutputSize: 20000,     // 最大输出 20000 字符
  allowNetwork: false,      // 禁止网络访问
  allowFileSystem: true,    // 允许文件系统访问
  captureImages: true,      // 捕获生成的图片
});

const result = await interpreter.execute(code, 'python');
```

## API 参考

### CodeInterpreter 类

```typescript
class CodeInterpreter {
  constructor(config?: CodeExecutionConfig)

  async execute(
    code: string,
    language: SupportedLanguage
  ): Promise<CodeExecutionResult>

  static formatResult(result: CodeExecutionResult): string
}
```

### 配置选项 (CodeExecutionConfig)

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `timeout` | number | 30000 | 执行超时（毫秒） |
| `maxMemoryMB` | number | 512 | 最大内存（仅 Docker） |
| `maxCPUPercent` | number | 50 | 最大 CPU 使用率（仅 Docker） |
| `allowNetwork` | boolean | true | 允许网络访问 |
| `allowFileSystem` | boolean | true | 允许文件系统访问 |
| `workingDirectory` | string | process.cwd() | 工作目录 |
| `env` | Record<string, string> | {} | 环境变量 |
| `captureImages` | boolean | false | 捕获生成的图片 |
| `maxOutputSize` | number | 10000 | 最大输出大小 |

### 执行结果 (CodeExecutionResult)

```typescript
interface CodeExecutionResult {
  success: boolean;           // 是否成功
  stdout: string;             // 标准输出
  stderr: string;             // 错误输出
  exitCode: number;           // 退出代码
  executionTime: number;      // 执行时间（毫秒）
  error?: string;             // 错误信息
  timedOut?: boolean;         // 是否超时
  command?: string;           // 实际执行的命令行（用于日志/调试）
  workingDirectory?: string;  // 执行时使用的工作目录
  images?: Array<{            // 生成的图片
    type: 'base64' | 'file';
    data: string;
    filename?: string;
  }>;
}
```

## 内置工具

### 1. execute_code - 通用代码执行器

```typescript
import { defaultCodeInterpreter } from './src/tools/index.js';

// 支持多种语言
const tool = defaultCodeInterpreter;
```

### 2. execute_python - Python 专用

```typescript
import { executePython } from './src/tools/index.js';

const result = await executePython.function({
  code: 'print("Hello, Python!")',
  capture_images: true,  // 可选：捕获 matplotlib 图片
});
```

### 3. execute_javascript - JavaScript 专用

```typescript
import { executeJavaScript } from './src/tools/index.js';

const result = await executeJavaScript.function({
  code: 'console.log("Hello, Node.js!")',
});
```

### 4. execute_bash - Bash/Shell 专用

```typescript
import { executeBash } from './src/tools/index.js';

const result = await executeBash.function({
  code: 'echo "Hello, Bash!"',
});
```

## CLI 工具补充

以下工具由运行时层提供（`src/tools/runtimeTools.ts`），用于高效编程工作流：

- Git：`git_status`, `git_diff`, `git_blame`, `git_branch_list`, `git_branch`, `git_commit`
- 文件：`edit`, `delete_file`, `rename_file`
- 运行：`run_tests`, `run_lint`, `run_format`
- 导航：`readfile`, `build_index`, `index_stats`, `search_symbol`, `get_definitions`, `get_references`

示例：

```json
{"tool": "git_status", "args": {"path": "."}}
{"tool": "git_diff", "args": {"staged": false}}
{"tool": "run_tests", "args": {"preset": "npm", "extra_args": ["--", "--runInBand"]}}
```

说明：
- 写入/执行类工具默认需要审批（权限系统控制）。
- `edit` 使用内容寻址（`old_string` / `new_string`,照抄原文,不用行号/hash）。参数细则以 `edit` 工具自身的 description 为唯一出处。

## 使用场景

### 1. 数据分析

```python
import pandas as pd
import numpy as np

data = {
    'Name': ['Alice', 'Bob', 'Charlie'],
    'Age': [25, 30, 35],
    'Score': [85, 90, 95]
}

df = pd.DataFrame(data)
print(df.describe())
```

### 2. 数学计算

```python
import math

# 解二次方程
a, b, c = 2, 5, -3
discriminant = b**2 - 4*a*c
x1 = (-b + math.sqrt(discriminant)) / (2*a)
x2 = (-b - math.sqrt(discriminant)) / (2*a)

print(f"x1 = {x1}, x2 = {x2}")
```

### 3. 数据可视化

```python
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 2*np.pi, 100)
y = np.sin(x)

plt.plot(x, y)
plt.title('Sine Wave')
plt.savefig('plot.png')
print("Plot saved!")
```

### 4. JSON 处理

```javascript
const data = require('./data.json');

const processed = data
  .filter(item => item.score > 80)
  .map(item => ({
    name: item.name,
    grade: item.score >= 90 ? 'A' : 'B'
  }));

console.log(JSON.stringify(processed, null, 2));
```

### 5. 文件操作

```bash
# 查找大文件
find . -type f -size +1M -exec ls -lh {} \;

# 统计代码行数
find src -name "*.ts" | xargs wc -l
```

## 安全建议

1. **生产环境**：考虑使用 Docker 隔离
2. **超时设置**：根据任务复杂度调整 timeout
3. **输出限制**：防止内存溢出
4. **权限控制**：谨慎启用文件系统和网络访问
5. **代码审查**：在执行前验证用户输入的代码

## 示例

运行完整示例：

```bash
# 基础功能测试
npm run demo:code-interpreter

# StreamedRunner 集成示例
npm run demo:code-agent
```

## 依赖要求

运行时需要安装相应的语言环境：

- **Python**: `python3` (建议 3.8+)
- **JavaScript**: Node.js (建议 18+)
- **TypeScript**: `npx tsx` (自动安装)
- **Bash**: 系统自带

可选 Python 库（用于高级功能）：

```bash
pip install numpy pandas matplotlib requests
```

## 故障排除

### "Runtime not found" 错误

确保安装了对应的运行时：

```bash
# 检查 Python
python3 --version

# 检查 Node.js
node --version

# 检查 Bash
bash --version
```

### 超时问题

增加超时限制：

```typescript
const interpreter = new CodeInterpreter({ timeout: 60000 });
```

### 图片捕获不工作

确保安装了 matplotlib 并使用非交互式后端：

```python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
```

## 路线图

- [ ] Docker 沙箱支持
- [ ] 更多语言支持（Go, Rust, Java）
- [ ] 资源使用统计
- [ ] 代码执行历史
- [ ] 交互式输入支持

## 贡献

欢迎提交 Issue 和 Pull Request！
