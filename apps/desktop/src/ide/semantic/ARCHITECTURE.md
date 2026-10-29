# Neox Semantic Layer — Architecture

> 这是 Neox IDE 平台层的"第二块基石" —— 在 VFS / EditorService 之上，
> 提供 IDEA 级别的符号索引、补全、跳转、引用、Command Palette 能力。
> 作者：Claude + MK-CO，起始日期：2026-04-12。

## 1. 目标

一句话：**用 Node.js + Monaco 做出 IDEA 的编辑体验**，具体包括：

- Cmd+P 文件模糊搜索（< 10ms 响应）
- Cmd+T 符号模糊搜索（跨文件，跨语言）
- Cmd+Shift+P 统一搜索（files + symbols + commands）
- F12 跳转定义 / Shift+F12 查找引用
- 智能补全（Weigher 风格排序，超越 LSP 原生）
- 文件 Outline 面板
- 增量索引：启动后台扫盘，文件变更自动更新
- AI 融合：补全 / 搜索结果叠加 embedding 语义层

**性能目标**：对百万行代码工程，全量索引 < 60s、增量更新 < 200ms、热查询 < 10ms。

## 2. IDEA 核心概念的 Neox 对照表

| IDEA | Neox 实现 | 说明 |
|---|---|---|
| **PSI** (Program Structure Interface) | tree-sitter CST + SymbolInfo 包装 | tree-sitter 做 parse，SymbolInfo 是 PSI 的"裁剪版"语义视图 |
| **Stub** | SymbolStore 的 `symbols` 表 | 只存"声明级"信息（名 / 位置 / 签名），不存 body |
| **StubIndex** | `idx_symbols_name` 索引 + `findSymbolsByNamePrefix` | 按符号名 O(log n) 查 |
| **FileBasedIndex** | SymbolStore 的 `files` 表 + hash 比对 | mtime + hash 双保险判断 staleness |
| **IndexingStamp** | `files.mtime` + `files.hash` | mtime 变 → 重 parse；hash 变 → 重写 symbols |
| **CompletionContributor** | `CompletionProvider` 接口（Phase 2） | 多 backend：本地符号 / LSP / AI |
| **CompletionWeigher** | `CompletionRanker` 二次排序（Phase 2） | 类型匹配 / 临近度 / 使用频率 / embedding 相似度 |
| **LocalInspectionTool** | `Inspection` 接口（Phase 3） | 实时分析，Worker 跑，cooperative cancel |
| **IntentionAction** | Monaco `CodeActionProvider` | 直接用 Monaco 原生 API，没必要重造 |
| **SearchEverywhere** | `SemanticService.searchPalette()` + Palette UI | 同一个 query 并发搜 files / symbols / commands |
| **MinusculeMatcher** | `FuzzyMatcher` (自研 fzf 算法) | 本地实现，camelCase + word boundary + 连续匹配加分 |
| **VirtualFileSystem** | 已有的 `VfsService` | 不再重复造，语义层依赖它 + 自定义 FS Port 补 walk/stat |
| **DaemonCodeAnalyzer** | 隐式的"增量 reparser"（Phase 3） | debounce + AbortSignal，不要 pass scheduler |

**关键抉择**：
- ❌ **不复制 PSI 双树**：tree-sitter 已经给了 CST，再搞一层 PSI wrapper 是过度设计
- ❌ **不复制 Dumb Mode**：IDEA 的 DumbMode 是 JVM 遗毒，我们直接"索引未就绪时返回空"
- ❌ **不复制 ModificationTracker 全家桶**：用单一的 mtime + hash 就够了
- ✅ **复制 Stub 思想**：只存声明，body 不存，查询快 10~20x
- ✅ **复制 Weigher 链**：补全排序的精髓
- ✅ **复制 Contributor 模式**：Command Palette 的可插拔来源

## 3. 模块分层

```
┌─────────────────────────────────────────────────────────┐
│ UI Layer (renderer)                                      │
│   CommandPalette / Outline / Completion / Hover         │
│            │  (IPC or direct import)                     │
│            ▼                                             │
├─────────────────────────────────────────────────────────┤
│ Semantic Layer (src/ide/semantic)          ← 本模块      │
│ ┌───────────────────────────────────────────────────┐   │
│ │  SemanticService ── 门面 ─────────────────────────│   │
│ │    │                                              │   │
│ │    ├─ FileIndex        (内存 Map，Cmd+P 数据源)   │   │
│ │    ├─ SymbolStore      (SQLite，符号持久化)       │   │
│ │    ├─ LanguageParser*  (tree-sitter / LSP / ...)  │   │
│ │    ├─ FuzzyMatcher     (fzf 算法)                 │   │
│ │    ├─ CompletionRanker (Phase 2)                  │   │
│ │    └─ DefinitionResolver (Phase 2)                │   │
│ │                                                    │   │
│ │  ── 对外发事件 ─────────────                       │   │
│ │    SEMANTIC_TOPIC (via MessageBus)                │   │
│ │      onBootstrapStarted / onProgress / onReady    │   │
│ │      onFileIndexed / onFileRemoved / onError      │   │
│ └───────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│ Platform Layer (已有)                                    │
│   VfsService / EditorService / MessageBus / Container   │
├─────────────────────────────────────────────────────────┤
│ Native deps                                              │
│   better-sqlite3 / chokidar / @vscode/ripgrep            │
│   (Phase 1 后追加：tree-sitter / tree-sitter-typescript) │
└─────────────────────────────────────────────────────────┘
```

## 4. 数据模型

### SQLite 表（用户级缓存目录的 `semantic/<workspaceHash>.db`，workspace 独立一份）

详细 schema 见 `symbolStore/schema.ts`，核心四张表：

- **`meta`** —— `schema_version` 等 kv 元数据，版本化迁移用
- **`files`** —— 已索引文件清单（path, language, mtime, hash, symbol_count）
- **`symbols`** —— 所有符号（name, kind, range, signature, parent_id, exported, ...）
- **`symbol_refs`** —— 符号引用点（Phase 3 填充，Find Usages 用）

### 索引覆盖

- `idx_files_path` —— O(1) 路径查询
- `idx_symbols_name` —— O(log n) 符号名前缀查询
- `idx_symbols_file` —— O(log n) 按文件拉全部符号（outline）
- `idx_symbols_kind` —— 按 kind 过滤（只搜类 / 只搜函数）
- `idx_refs_symbol` —— Find Usages 反向查询

## 5. 索引生命周期

### Bootstrap（启动时全量索引）

```
SemanticService.bootstrap()
  │
  ├─ 1. 所有 parser init()
  │
  ├─ 2. fs.walk(workspaceRoot) —— 列出候选文件
  │      过滤掉 node_modules / .git / dist / ...
  │
  ├─ 3. 遍历文件：
  │      - 灌入 FileIndex（Cmd+P 至少能搜到）
  │      - 对比 SymbolStore 中的 mtime：
  │          · 没变 → 跳过（增量恢复）
  │          · 变了 → 进 parse 队列
  │
  ├─ 4. 对队列里的文件：
  │      - parser.parse(content)
  │      - hash 对比（mtime 变但内容没变也跳过）
  │      - 写 SymbolStore（事务）
  │      - emit onFileIndexed
  │      - 节流 emit onProgress
  │
  └─ 5. state = ready, emit onReady
```

**重要**：bootstrap 过程中 SemanticService 对外依然提供 `searchFiles()` 查询 ——
FileIndex 早在第 3 步就被灌好了。只有 `searchSymbols()` 需要等 ready。

### Incremental update（增量更新）

```
chokidar / VfsService event
  │
  ├─ reindexFile(path)
  │   ├─ fs.stat() —— 拿 mtime
  │   ├─ upsert FileIndex
  │   ├─ parser.parse()
  │   ├─ hash 对比
  │   └─ SymbolStore.indexFile() —— 事务：先删旧 symbols，再插新的
  │
  └─ emit onFileIndexed
```

### 文件删除

```
removeFile(path)
  ├─ FileIndex.remove(path)
  ├─ SymbolStore.deleteFile(path)   // CASCADE 自动清 symbols + refs
  └─ emit onFileRemoved
```

## 6. 性能设计

### 查询性能目标

| 查询 | 目标 | 实现 |
|---|---|---|
| `searchFiles("comm")` | < 5ms on 10K files | 内存 FileIndex + JS FuzzyMatcher |
| `searchSymbols("comm")` | < 20ms on 100K symbols | SQL LIKE 前缀筛 + JS 二次排序 |
| `getFileOutline(path)` | < 2ms | 单次 JOIN + file_id 索引 |
| `getSymbolById(id)` | < 1ms | 主键查询 |
| `getReferences(symbolId)` | < 5ms | `idx_refs_symbol` 反向边 |

### 写入性能目标

| 操作 | 目标 | 实现 |
|---|---|---|
| 全量 bootstrap 10K 文件 | < 10s | 并发 parse（Worker pool，Phase 2）+ 事务批量写 |
| 增量单文件 | < 200ms | 串行 parse + 单事务 |
| hash 未变跳过 | < 1ms | hash 比对跳过所有 parse + 写入 |

## 7. Phase 路线图

### Phase 1 —— 地基（当前）

**目标**：跑通从 bootstrap 到 Cmd+P 的完整链路。

- [x] types.ts / MessageBus topic / Service token
- [x] SymbolStore (SQLite + 事务化写入)
- [x] FileIndex (内存 Map + basename 反向索引)
- [x] FuzzyMatcher (fzf 风格打分)
- [x] LanguageParser 接口 + TypeScriptParser (regex placeholder)
- [x] SemanticService 门面
- [ ] 单测冒烟用例
- [ ] 接入 `src/ide/index.ts`
- [ ] 提交 commit

### Phase 1.5 —— 真实 parser

- [ ] `npm install tree-sitter tree-sitter-typescript`
- [ ] electron-rebuild 处理 native module
- [ ] 把 TypeScriptParser 的 regex 实现换成 tree-sitter 查询
- [ ] 支持嵌套符号（class 里的 method、namespace 里的 class）
- [ ] 支持签名抽取（函数参数、返回类型）

### Phase 2 —— 补全 / 跳转 / Command Palette UI

- [ ] CompletionProvider 接口 + LocalSymbolsProvider（第一个后端）
- [ ] CompletionRanker（Weigher 链）
- [ ] DefinitionResolver（本地 Symbol Graph → LSP fallback）
- [ ] Monaco provider 绑定层（`registerCompletionItemProvider` 等）
- [ ] CommandPalette React UI（renderer/modules/palette）
- [ ] 接通 EditorService 的 tab 切换 → currentFile 感知

### Phase 3 —— 引用 / 重构 / 分析

- [ ] 引用抽取（tree-sitter 查询 + `symbol_refs` 表）
- [ ] Find Usages UI
- [ ] Inspection 接口 + 基础检查（unused variable, unused import）
- [ ] QuickFix（Monaco CodeAction）
- [ ] Rename（先本地，再跨文件）

### Phase 4 —— AI 融合

- [ ] EmbeddingIndex（全项目 embedding，每个符号 + 注释）
- [ ] 补全 AI 增强（Cursor 风格 ghost text，与 LSP 结果融合）
- [ ] 语义搜索（Cmd+Shift+F 支持自然语言 query）
- [ ] AI rename / AI refactor 建议

## 8. 测试策略

- **单测**：每个子模块独立测试（FuzzyMatcher / SymbolStore / FileIndex）
- **集成测**：用内存 SQLite + 内存 FileSystemPort 跑完整 bootstrap 流程
- **性能基准**：放在 `__tests__/benchmarks/`，测 10K / 100K 符号的查询 p99
- **真实项目对比测**：拿 Neox 自己当 fixture 跑索引，断言符号数 + 查询命中率

## 9. 安全 / 隐私

- 索引数据只存在用户级缓存目录的 `semantic/<workspaceHash>.db`，永不上传
- 不在项目目录下生成索引文件 → 避免污染、避免误 commit、避免多 workspace 重复
- embedding 计算默认本地模型（Phase 4），需要远端模型时用户显式授权

## 10. 非目标（明确不做）

- ❌ Refactor 大全家桶（Extract Method / Change Signature 等）—— 让 LSP 做
- ❌ Debugger 集成 —— Neox 已经有 java-debug 子系统
- ❌ 版本控制集成 —— simple-git 已经在用
- ❌ 终端 / REPL —— 已经有 xterm + node-pty
- ❌ 设置 UI —— 设置系统已经独立
- ❌ 完整的类型推断 —— 交给 LSP

**本层只做：索引 + 搜索 + 符号查询 + 补全 + 跳转 + 引用。做深做精，不做广。**
