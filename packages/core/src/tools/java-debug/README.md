# Java Debug Tools for LLM

让 AI Agent 能够自动调试 Java 应用程序的工具集。

## 概述

Java Debug Tools 将 Microsoft Java Debug Server (基于 DAP 协议) 封装成 LLM 可调用的工具，让 AI 能够：

- 🚀 启动或附加到 Java 应用进行调试
- 🔴 设置断点（支持条件断点）
- ▶️ 控制执行流程（继续、单步、步入、步出）
- 🔍 查看变量值和调用栈
- 🧪 在调试上下文中执行表达式
- 🛑 管理调试会话

## 安装配置

### 1. 下载内置 JAR（仅首次需要）

Java Debug JAR 已内置到 Neox 中！首次使用只需运行：

```bash
npm run setup-java-debug
```

这会自动下载预构建的 Microsoft Java Debug JAR（约 3.1MB）到 `resources/java-debug/` 目录。

**注意：**
- 开发环境需要先运行此命令
- Electron 打包时会自动包含 JAR 文件
- 生产环境的 Neox 已经包含此 JAR

### 2. 配置 Neox

编辑配置文件：`~/Library/Application Support/Neox/config.json` (macOS)

```json
{
  "javaDebug": {
    "enabled": true
  }
}
```

**可选高级配置：**

```json
{
  "javaDebug": {
    "enabled": true,
    "javaHome": "/path/to/jdk",  // 可选：自定义 JDK 路径
    "jarPath": "/custom/path/com.microsoft.java.debug.plugin.jar"  // 可选：自定义 JAR 路径（默认使用内置 JAR）
  }
}
```

### 3. 重启 Neox

重启后，工具会自动加载。你应该看到：

```
✓ Java Debug 工具已启用 (11 个工具)
```

## 可用工具

### 1. `java_debug_launch`
启动 Java 应用进行调试

**参数：**
- `mainClass` (必需) - 主类名，如 `"com.example.Main"`
- `projectPath` (必需) - 项目根目录路径
- `classpath` (可选) - 类路径
- `args` (可选) - 程序参数
- `vmArgs` (可选) - JVM 参数
- `stopOnEntry` (可选) - 是否在入口点停止

**示例：**
```json
{
  "mainClass": "com.example.Main",
  "projectPath": "/Users/user/my-project",
  "args": ["--port", "8080"],
  "vmArgs": ["-Xmx512m"]
}
```

### 2. `java_debug_attach`
附加到运行中的 Java 进程

**参数：**
- `port` (必需) - JDWP 端口 (通常 5005)
- `hostName` (可选) - 主机名，默认 localhost
- `timeout` (可选) - 连接超时 (ms)

**启用 JDWP 的方式：**
```bash
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005 YourApp
```

### 3. `java_debug_set_breakpoint`
设置断点

**参数：**
- `sessionId` (必需) - 会话 ID
- `filePath` (必需) - Java 源文件路径
- `line` (必需) - 行号
- `condition` (可选) - 条件表达式，如 `"count > 10"`

### 4. `java_debug_continue`
继续执行直到下一个断点

### 5. `java_debug_step_over`
单步跳过（执行当前行）

### 6. `java_debug_step_into`
单步进入（进入方法内部）

### 7. `java_debug_step_out`
单步跳出（执行完当前方法）

### 8. `java_debug_get_variables`
获取当前作用域的变量

**参数：**
- `sessionId` (必需)
- `filter` (可选) - `"local"` | `"arguments"` | `"all"`

### 9. `java_debug_get_stack_trace`
获取调用栈

### 10. `java_debug_evaluate`
执行表达式

**参数：**
- `sessionId` (必需)
- `expression` (必需) - Java 表达式，如 `"user.getName()"`

### 11. `java_debug_stop`
停止调试会话

---

## AI Agent 使用示例

### 示例 1：调试 NullPointerException

```
User: "帮我调试 Main.java，程序在第 25 行抛出 NullPointerException"

AI Agent 操作流程：

1. java_debug_launch
   {
     "mainClass": "com.example.Main",
     "projectPath": "/Users/user/project"
   }
   → 返回：{ sessionId: "java-debug-123...", status: "running" }

2. java_debug_set_breakpoint
   {
     "sessionId": "java-debug-123...",
     "filePath": "/Users/user/project/src/Main.java",
     "line": 25
   }
   → 返回：{ verified: true, line: 25 }

3. java_debug_continue
   {
     "sessionId": "java-debug-123..."
   }
   → 返回：{ status: "stopped", stoppedReason: "breakpoint", location: { line: 25 } }

4. java_debug_get_variables
   {
     "sessionId": "java-debug-123...",
     "filter": "local"
   }
   → 返回：{
     "variables": [
       { "name": "user", "value": "null", "type": "User" },
       { "name": "count", "value": "5", "type": "int" }
     ]
   }

5. java_debug_get_stack_trace
   {
     "sessionId": "java-debug-123..."
   }
   → 返回：{
     "stackFrames": [
       { "name": "processUser", "source": { "path": "Main.java", "line": 25 } },
       { "name": "main", "source": { "path": "Main.java", "line": 10 } }
     ]
   }

6. java_debug_stop
   {
     "sessionId": "java-debug-123..."
   }

AI Agent 回复：
"我找到了问题！在第 25 行，变量 `user` 的值是 `null`。查看调用栈，
`user` 是在 `main` 方法第 10 行传入的。建议检查第 10 行的 `user`
初始化逻辑，确保在调用 `processUser` 之前 `user` 已经被正确创建。"
```

### 示例 2：使用条件断点调试循环

```
User: "为什么循环只执行了一次？代码在 Main.java 第 30-35 行"

AI Agent 操作：

1. java_debug_launch(...)

2. java_debug_set_breakpoint({
     "sessionId": "...",
     "filePath": "/path/to/Main.java",
     "line": 30,
     "condition": "i >= 1"  // 条件断点：只在 i >= 1 时暂停
   })

3. java_debug_continue(...)
   → 停在第 30 行，i = 1

4. java_debug_get_variables(...)
   → { "i": "1", "max": "10" }

5. java_debug_step_over(...)  // 单步执行，查看是否进入循环体

6. java_debug_get_variables(...)
   → 发现执行流程跳出了循环

7. java_debug_evaluate({
     "sessionId": "...",
     "expression": "i < max"
   })
   → { "result": "true" }

AI 分析：条件是 true，但循环还是退出了... 查看代码发现第 33 行有 `break`！

AI 回复：
"我发现问题了！在第 33 行，你使用了 `break` 语句，导致循环提前退出。
虽然 `i < max` 条件是 true（i=1, max=10），但 break 语句强制退出了循环。
如果你想跳过当前迭代而不是退出循环，应该使用 `continue` 而不是 `break`。"
```

---

## 架构设计

```
┌─────────────────────────────────────┐
│       LLM Agent (Claude)            │
│                                     │
│  "帮我调试这个 Java 程序..."          │
└─────────────────────────────────────┘
              ↓
    调用 Java Debug Tools
              ↓
┌─────────────────────────────────────┐
│      Java Debug Tools               │
│  - java_debug_launch                │
│  - java_debug_set_breakpoint        │
│  - java_debug_get_variables         │
│  - ...                              │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│    Session Manager                  │
│  - 管理多个调试会话                  │
│  - 维护会话状态                      │
│  - 处理 DAP 消息                    │
└─────────────────────────────────────┘
              ↓
┌─────────────────────────────────────┐
│       DAP Client                    │
│  - TCP 通信                         │
│  - DAP 协议实现                     │
└─────────────────────────────────────┘
              ↓
        TCP/stdio (DAP)
              ↓
┌─────────────────────────────────────┐
│  Microsoft Java Debug Server        │
│    (java-debug JAR)                 │
└─────────────────────────────────────┘
              ↓
            JDI/JDWP
              ↓
┌─────────────────────────────────────┐
│      Java Application               │
└─────────────────────────────────────┘
```

---

## 技术细节

### DAP (Debug Adapter Protocol)

- **协议格式：** JSON-RPC over TCP
- **消息格式：**
  ```
  Content-Length: {length}\r\n\r\n
  {JSON payload}
  ```

### 生命周期

```
initialize → launch/attach → configurationDone → running
                                                    ↓
                                          stopped (breakpoint)
                                                    ↓
                                          continue/step/evaluate
                                                    ↓
                                          disconnect/terminate
```

### 事件处理

- `stopped` - 程序暂停（断点、异常、步进）
- `continued` - 程序继续
- `terminated` - 程序终止
- `output` - 输出信息

---

## 故障排除

### 问题：工具未加载

**检查：**
1. 配置文件中 `javaDebug.enabled` 是否为 `true`
2. `javaDebug.jarPath` 路径是否正确
3. JAR 文件是否存在且可读

### 问题：连接超时

**可能原因：**
1. Java Debug Server 启动失败
2. JAVA_HOME 未设置或不正确
3. JAR 文件损坏

**解决：**
```bash
# 手动测试 JAR
java -jar /path/to/java-debug.jar

# 检查 JAVA_HOME
echo $JAVA_HOME
```

### 问题：断点未验证 (verified: false)

**可能原因：**
1. 源文件路径不正确
2. 代码未用 `-g` 选项编译（缺少调试信息）
3. 行号不匹配（源码和编译后的字节码不一致）

**解决：**
```bash
# 确保编译时包含调试信息
javac -g YourClass.java
```

---

## 限制和已知问题

1. **仅支持本地调试：** 目前仅支持 localhost 连接
2. **单线程优先：** 多线程调试支持有限
3. **热代码替换：** 不支持运行时修改代码
4. **性能：** 大型应用可能需要更长的启动时间

---

## 参考资源

- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [Microsoft Java Debug](https://github.com/microsoft/java-debug)
- [Java Platform Debugger Architecture](https://docs.oracle.com/javase/8/docs/technotes/guides/jpda/)
- [JDI Documentation](https://docs.oracle.com/javase/7/docs/jdk/api/jpda/jdi/)

---

## 贡献

欢迎提交 Issue 和 Pull Request！

如果你发现 bug 或有功能建议，请在 GitHub 上创建 Issue。

---

## License

MIT License
