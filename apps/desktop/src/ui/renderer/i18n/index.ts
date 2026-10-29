/**
 * 国际化模块 - 支持中英文切换
 */

export type Language = 'zh' | 'en';

// 翻译文本类型
export interface Translations {
  // 通用
  common: {
    loading: string;
    save: string;
    cancel: string;
    add: string;
    edit: string;
    delete: string;
    confirm: string;
    refresh: string;
    close: string;
    on: string;
    off: string;
    auto: string;
    preview: string;
    clickToPreview: string;
    emptyDir: string;
    error: string;
    success: string;
    warning: string;
    info: string;
    openInFinder: string;
    copyPath: string;
    send: string;
    pause: string;
    resume: string;
    uploadImage: string;
    terminal: string;
    editor: string;
    debug: string;
    tools: string;
    quickTools: string;
  };
  // 设置页面
  settings: {
    title: string;
    // 菜单
    menu: {
      providers: string;
      routing: string;
      orchestrator: string;
      agent: string;
      general: string;
      storage: string;
      usage: string;
      about: string;
    };
    // 多模型协作
    orchestrator: {
      title: string;
      desc: string;
      enable: string;
      enabledDesc: string;
      disabledDesc: string;
      mode: string;
      modeSequential: string;
      modeParallel: string;
      modeHybrid: string;
      modeSequentialDesc: string;
      modeParallelDesc: string;
      modeHybridDesc: string;
      context: string;
      contextFull: string;
      contextSummary: string;
      contextSelective: string;
      contextFullDesc: string;
      contextSummaryDesc: string;
      contextSelectiveDesc: string;
      rules: string;
      rulesDesc: string;
      addRule: string;
      editRule: string;
      noRules: string;
      noRulesHint: string;
      taskType: string;
      selectTaskType: string;
      preferredModels: string;
      preferredModelsHint: string;
      fallbackModel: string;
      selectFallback: string;
      noModels: string;
    };
    // 模型路由
    routing: {
      title: string;
      desc: string;
      enable: string;
      enabledDesc: string;
      disabledDesc: string;
      configTitle: string;
      addRoute: string;
      noRoutes: string;
      noRoutesHint: string;
      providers: string;
      strategy: string;
      strategyPriority: string;
      strategyLatency: string;
      strategyRoundRobin: string;
      healthCheck: string;
      interval: string;
      timeout: string;
      failureThreshold: string;
      failureThresholdUnit: string;
      tips: {
        title: string;
        priority: string;
        latency: string;
        roundRobin: string;
        autoSwitch: string;
      };
    };
    // Agent 设置
    agent: {
      title: string;
      sandbox: string;
      sandboxDesc: string;
      sandboxOnDesc: string;
      sandboxOffDesc: string;
      approval: string;
      approvalDesc: string;
      approvalAutoDesc: string;
      approvalManualDesc: string;
      piiFilter: string;
      piiFilterDesc: string;
    };
    // Providers
    providers: {
      title: string;
      add: string;
      noProviders: string;
      noProvidersDesc: string;
      name: string;
      protocol: string;
      apiKey: string;
      apiKeyPlaceholder: string;
      apiKeyKeepEmpty: string;
      baseUrl: string;
      baseUrlPlaceholder: string;
      maxTokens: string;
      maxInputTokens: string;
      models: string;
      modelsSelected: string;
      modelsPlaceholder: string;
      addMoreModels: string;
      addCustomModel: string;
      allPresetsSelected: string;
      setAsDefault: string;
      deleteConfirm: string;
      addProvider: string;
      editProvider: string;
      // 健康状态
      health: {
        excellent: string;
        good: string;
        slow: string;
        testing: string;
        offline: string;
        error: string;
        unknown: string;
      };
    };
    // 通用设置
    general: {
      title: string;
      // 外观
      appearance: {
        title: string;
        darkMode: string;
        darkModeAuto: string;
        darkModeLight: string;
        darkModeDark: string;
        autoDesc: string;
        lightDesc: string;
        darkDesc: string;
        colorTheme: string;
        colorThemeDesc: string;
      };
      // 语言和调试
      languageDebug: {
        title: string;
        uiLanguage: string;
        uiLanguageDesc: string;
        cliDebug: string;
        cliDebugOnDesc: string;
        cliDebugOffDesc: string;
        piiFilter: string;
        piiFilterDesc: string;
      };
    };
    // 存储管理
    storage: {
      title: string;
      configDir: string;
      totalSize: string;
      loadError: string;
      files: {
        configJson: string;
        configJsonDesc: string;
        uiState: string;
        uiStateDesc: string;
        sessions: string;
        sessionsDesc: string;
        workspaces: string;
        workspacesDesc: string;
      };
    };
    // 使用统计
    usage: {
      title: string;
      summary: string;
      totalRequests: string;
      totalTokens: string;
      cachedTokens: string;
      providerCount: string;
      lastRequest: string;
      noData: string;
      noDataDesc: string;
      providerStats: string;
      requests: string;
      inputTokens: string;
      outputTokens: string;
      avgDuration: string;
      details: string;
      clearAll: string;
      clearAllConfirm: string;
      clearProvider: string;
      clearProviderConfirm: string;
      viewRecords: string;
      recentRecords: string;
      type: string;
      healthCheck: string;
      chat: string;
      model: string;
      duration: string;
      status: string;
      success: string;
      failed: string;
      noRecords: string;
    };
    // 关于
    about: {
      title: string;
      appName: string;
      tagline: string;
      description: string;
    };
  };

  // 主界面
  main: {
    welcome: string;
    selectProject: string;
    openProject: string;
    recentProjects: string;
    noRecentProjects: string;
    signIn: string;
    continueWithByok: string;
    newChat: string;
    sendMessage: string;
    typeMessage: string;
    inputPlaceholder: string;
    thinking: string;
    stop: string;
    retry: string;
    copy: string;
    copied: string;
  };

  // 会话
  session: {
    newSession: string;
    rename: string;
    delete: string;
    deleteConfirm: string;
    export: string;
    exportJson: string;
    exportMarkdown: string;
    clear: string;
    clearConfirm: string;
    undo: string;
    checkpoint: string;
    rollback: string;
    compact: string;
    compacting: string;
    compactingDesc: string;
    compactComplete: string;
    compactNotNeeded: string;
    compactNotNeededDesc: string;
    compactAnalyzing: string;
    compactSummarizing: string;
    compactSaving: string;
    compactBucketFiles: string;
    compactBucketCommands: string;
    compactBucketSearch: string;
    compactBucketConversation: string;
    compactBucketDone: string;
    compactBucketCompressing: string;
    compactBucketPending: string;
    searchPlaceholder: string;
    noSessions: string;
    noResults: string;
    startNewChat: string;
    clearSearch: string;
    messages: string;
    tokens: string;
  };

  // 运行时控制
  runtime: {
    sandbox: string;
    sandboxEnabled: string;
    sandboxDisabled: string;
    approval: string;
    approvalAuto: string;
    approvalManual: string;
  };

  // 错误消息
  errors: {
    networkError: string;
    authError: string;
    rateLimitError: string;
    serverError: string;
    unknownError: string;
    retrying: string;
    // Runner 错误
    loopDetected: string;
    loopDetectedSuggestion: string;
    placeholderDetected: string;
    placeholderDetectedSuggestion: string;
    runnerError: string;
    runnerErrorSuggestion: string;
  };

  // 文件编辑卡片
  editFile: {
    editFile: string;
    applied: string;
    reverted: string;
    pending: string;
    revert: string;
    revertAll: string;
    revertRemaining: string;
    reapply: string;
    reapplyAll: string;
    reapplyRemaining: string;
    apply: string;
    viewAll: string;
    collapse: string;
    originalFile: string;
    newFile: string;
    editingInProgress: string;
    replaceAll: string;
  };

  // 审批栏
  approval: {
    pendingConfirm: string;
    viewAllChanges: string;
    cannotRollback: string;
    reverting: string;
    rejectAll: string;
    acceptAll: string;
    fileChangeDetails: string;
    totalFiles: string;
    filteredInfo: string;
    filteredTooltip: string;
    modified: string;
    created: string;
    deleted: string;
    createdFile: string;
    createdFolder: string;
    deletedFolder: string;
    multipleEdits: string;
    changed: string;
    filesChanged: string;
  };

  // Agent工具
  tools: {
    title: string;
    description: string;
    readFile: { name: string; desc: string; };
    writeFile: { name: string; desc: string; };
    editFile: { name: string; desc: string; };
    searchFiles: { name: string; desc: string; };
    listDirectory: { name: string; desc: string; };
    createDirectory: { name: string; desc: string; };
    executeShell: { name: string; desc: string; };
    showTree: { name: string; desc: string; };
    smartTree: { name: string; desc: string; };
    analyzeCode: { name: string; desc: string; };
    search: { name: string; desc: string; };
    executePython: { name: string; desc: string; };
    executeJavaScript: { name: string; desc: string; };
    executeBash: { name: string; desc: string; };
    webFetch: { name: string; desc: string; };
    webSearch: { name: string; desc: string; };
    javaDebug: { name: string; desc: string; };
  };

  // 时间线标签
  timeline: {
    thinking: string;
    reasoning: string;
    toolCall: string;
    toolResult: string;
    toolError: string;
    code: string;
    editFile: string;
    log: string;
    you: string;
    assistant: string;
    smartCompaction: string;
    contextTrimming: string;
    messages: string;
    dropped: string;
    compressed: string;
    saved: string;
    items: string;
    contextUsage: string;
  };

  // Agent 状态栏 (status bar)
  agentStatus: {
    ready: string;
    thinking: string;
    generatingResponse: string;
    waitingForResponse: string;
    apiRespondingSlowly: string;
    longWait: string;
    toolRunning: string;
    toolChainInProgress: string;
    toolExecutionLong: string;
    exploreRunning: string;
    exploreStillRunning: string;
    callingTool: string;
    toolCompleted: string;
    toolError: string;
    generatingTool: string;
    messageQueued: string;
    messagesDelivered: string;
    providerSwitching: string;
    providerRecovered: string;
  };

  // Plan 模式
  plan: {
    generating: string;
    title: string;
    updated: string;
    execute: string;
    cancel: string;
    executing: string;
    completed: string;
    failed: string;
    defaultSummary: string;
    ready: string;
  };

  // Project View 文件树 (IDEA-style)
  explorer: {
    // 标题 / 占位
    projectTitle: string;
    // 右键菜单 / 动作名
    newFile: string;
    newFolder: string;
    rename: string;
    delete: string;
    duplicate: string;
    cut: string;
    copy: string;
    paste: string;
    copyPath: string;
    copyRelativePath: string;
    revealInFinder: string;
    openInTerminal: string;
    attachToComposer: string;
    revert: string;
    open: string;
    openWith: string;
    refresh: string;
    locateInProjectView: string;
    findInPath: string;
    findUsages: string;
    // 对话框
    newFileTitle: string;
    newFileLabel: string;
    newFilePlaceholder: string;
    newFolderTitle: string;
    newFolderLabel: string;
    newFolderPlaceholder: string;
    renameTitle: string;
    renameLabel: string;
    deleteConfirmTitle: string;
    deleteConfirmMessage: string;
    deleteConfirmMessagePlural: string;
    deletePermanently: string;
    moveToTrash: string;
    // 错误 / 反馈
    errorRename: string;
    errorDelete: string;
    errorCreate: string;
    errorCopyToClipboard: string;
    errorEmptyName: string;
    errorInvalidName: string;
    errorAlreadyExists: string;
    successCopiedPath: string;
    successCreated: string;
    successRenamed: string;
    successDeleted: string;
    successDuplicated: string;
    successPasted: string;
    viewOptions: string;
    showHiddenFiles: string;
    showExcludedFiles: string;
    sortBy: string;
    sortByName: string;
    sortByType: string;
    sortByTimeAsc: string;
    sortByTimeDesc: string;
    foldersFirst: string;
    compactMiddleDirs: string;
    // 视图作用域 (项目下拉) — 仅保留 IDEA 风格 9 项中真正能用的 3 项
    scopeProject: string;
    scopeOpenFiles: string;
    scopeChangedFiles: string;
  };
}

// 中文翻译
const zh: Translations = {
  common: {
    loading: '加载中...',
    save: '保存',
    cancel: '取消',
    add: '添加',
    edit: '编辑',
    delete: '删除',
    confirm: '确认',
    refresh: '刷新',
    close: '关闭',
    on: '开启',
    off: '关闭',
    auto: '自动',
    preview: '预览',
    clickToPreview: '点击预览',
    emptyDir: '目录为空',
    error: '错误',
    success: '成功',
    warning: '警告',
    info: '信息',
    openInFinder: '在文件管理器中显示',
    copyPath: '复制路径',
    send: '发送',
    pause: '暂停',
    resume: '继续',
    uploadImage: '上传图片',
    terminal: '终端',
    editor: '编辑器',
    debug: '调试',
    tools: '工具',
    quickTools: '快捷工具',
  },
  settings: {
    title: '设置',
    menu: {
      providers: 'API 服务商',
      routing: '模型路由',
      orchestrator: '多模型协作',
      agent: 'Agent 策略',
      general: '通用设置',
      storage: '存储管理',
      usage: '使用统计',
      about: '关于',
    },
    orchestrator: {
      title: '多模型协作',
      desc: '智能分解任务，为每个子任务选择最合适的模型',
      enable: '启用多模型协作',
      enabledDesc: '系统会自动分析任务并选择最合适的模型',
      disabledDesc: '使用单一模型处理所有任务',
      mode: '执行模式',
      modeSequential: '顺序',
      modeParallel: '并行',
      modeHybrid: '混合',
      modeSequentialDesc: '任务按顺序依次执行，稳定可靠',
      modeParallelDesc: '任务并行执行，速度更快',
      modeHybridDesc: '系统自动判断最优执行方式',
      context: '上下文共享',
      contextFull: '完整',
      contextSummary: '摘要',
      contextSelective: '精简',
      contextFullDesc: '完整传递上下文，消耗更多 tokens',
      contextSummaryDesc: '传递摘要，平衡效果与成本',
      contextSelectiveDesc: '仅传递关键信息，最省 tokens',
      rules: '任务路由规则',
      rulesDesc: '为不同类型的任务配置首选模型',
      addRule: '添加规则',
      editRule: '编辑路由规则',
      noRules: '暂无路由规则',
      noRulesHint: '点击添加规则，为特定任务类型指定首选模型',
      taskType: '任务类型',
      selectTaskType: '请选择任务类型',
      preferredModels: '首选模型',
      preferredModelsHint: '选择处理此类任务的首选模型（可多选）',
      fallbackModel: '备选模型',
      selectFallback: '选择备选模型',
      noModels: '请先在 Provider 中配置模型',
    },
    routing: {
      title: '模型路由',
      desc: '配置同一模型多个 Provider 自动切换，提高可用性',
      enable: '启用模型路由',
      enabledDesc: '已启用自动路由，选择 Auto 模型时将自动在多个 Provider 间切换',
      disabledDesc: '关闭后将使用单一 Provider',
      configTitle: '路由配置',
      addRoute: '添加路由',
      noRoutes: '暂无路由配置',
      noRoutesHint: '点击上方按钮添加模型路由，配置同一模型的多个 Provider',
      providers: 'Provider 列表',
      strategy: '路由策略',
      strategyPriority: '优先级',
      strategyLatency: '延迟优先',
      strategyRoundRobin: '轮询',
      healthCheck: '健康检查',
      interval: '间隔',
      timeout: '超时',
      failureThreshold: '失败阈值',
      failureThresholdUnit: '次后标记不可用',
      tips: {
        title: '使用说明',
        priority: '优先级策略：按优先级顺序尝试，第一个健康的 Provider 被选中',
        latency: '延迟策略：选择延迟最低的健康 Provider',
        roundRobin: '轮询策略：在健康的 Provider 之间轮流使用',
        autoSwitch: 'Provider 不可用时会自动切换到下一个',
      },
    },
    agent: {
      title: 'Agent 策略',
      sandbox: '沙箱模式',
      sandboxDesc: '在沙箱中执行命令，防止对系统造成影响',
      sandboxOnDesc: '命令在隔离环境中执行',
      sandboxOffDesc: '命令直接在系统中执行',
      approval: '审批模式',
      approvalDesc: '控制 Agent 执行操作前是否需要确认',
      approvalAutoDesc: '按策略自动执行：白名单只读工具自动，其他操作需确认',
      approvalManualDesc: '手动确认模式：除只读工具外，操作前需要确认',
      piiFilter: '内容保护',
      piiFilterDesc: '发送前把消息里的密码、API Key、Token 换成 <REDACTED>。抹掉了会告诉你抹了什么。',
    },
    providers: {
      title: 'API 服务商',
      add: '添加',
      noProviders: '未配置服务商',
      noProvidersDesc: '添加 API 服务商以开始聊天',
      name: '名称',
      protocol: '协议',
      apiKey: 'API Key',
      apiKeyPlaceholder: 'sk-...',
      apiKeyKeepEmpty: '留空保持不变',
      baseUrl: 'Base URL',
      baseUrlPlaceholder: 'https://api.openai.com/v1',
      maxTokens: '最大输出 Tokens',
      maxInputTokens: '最大输入 Tokens',
      models: '模型',
      modelsSelected: '已选择',
      modelsPlaceholder: '点击选择模型...',
      addMoreModels: '添加更多模型...',
      addCustomModel: '按回车添加自定义模型',
      allPresetsSelected: '所有预设模型已选择',
      setAsDefault: '设为默认',
      deleteConfirm: '确定要删除此服务商吗？',
      addProvider: '添加服务商',
      editProvider: '编辑服务商',
      health: {
        excellent: '优秀',
        good: '良好',
        slow: '较慢',
        testing: '检测中...',
        offline: '离线',
        error: '错误',
        unknown: '未知',
      },
    },
    general: {
      title: '通用设置',
      appearance: {
        title: '外观设置',
        darkMode: '明暗模式',
        darkModeAuto: '自动',
        darkModeLight: '浅色',
        darkModeDark: '深色',
        autoDesc: '根据时间自动切换（6:00-18:00 浅色）',
        lightDesc: '始终使用浅色模式',
        darkDesc: '始终使用深色模式',
        colorTheme: '颜色主题',
        colorThemeDesc: '选择你喜欢的主题色',
      },
      languageDebug: {
        title: '语言和调试',
        uiLanguage: '语言',
        uiLanguageDesc: '界面文字和 AI 回复语言一起切换',
        cliDebug: 'CLI 调试日志',
        cliDebugOnDesc: '当前已输出详细日志（CLI_DEBUG=1）',
        cliDebugOffDesc: '关闭后将减少终端调试信息',
        piiFilter: 'PII 内容保护',
        piiFilterDesc: '自动用 <REDACTED> 替换密码/API Key，避免 One-API PII 审核导致 400。',
      },
    },
    storage: {
      title: '存储管理',
      configDir: '配置目录',
      totalSize: '总占用空间',
      loadError: '无法加载存储信息',
      files: {
        configJson: 'config.json',
        configJsonDesc: '主配置文件（Provider、API Key 等）',
        uiState: 'ui-state.json',
        uiStateDesc: 'UI 状态配置（主题、工作区等）',
        sessions: 'sessions/',
        sessionsDesc: '会话历史记录',
        workspaces: 'workspaces/',
        workspacesDesc: '工作区状态',
      },
    },
    usage: {
      title: '使用统计',
      summary: '总览',
      totalRequests: '总请求数',
      totalTokens: '总 Token 数',
      cachedTokens: '缓存 Token',
      providerCount: '服务商数量',
      lastRequest: '最近请求',
      noData: '暂无统计数据',
      noDataDesc: '开始使用后将自动记录 API 调用统计',
      providerStats: '服务商统计',
      requests: '次请求',
      inputTokens: '输入',
      outputTokens: '输出',
      avgDuration: '平均耗时',
      details: '详情',
      clearAll: '清除所有',
      clearAllConfirm: '确定要清除所有使用统计数据吗？',
      clearProvider: '清除',
      clearProviderConfirm: '确定要清除此服务商的统计数据吗？',
      viewRecords: '查看记录',
      recentRecords: '最近请求',
      type: '类型',
      healthCheck: '测试',
      chat: '对话',
      model: '模型',
      duration: '耗时',
      status: '状态',
      success: '成功',
      failed: '失败',
      noRecords: '暂无请求记录',
    },
    about: {
      title: '关于',
      appName: 'Neox',
      tagline: 'AI 代码助手',
      description: '智能编程助手，帮助你更快地编写更好的代码。',
    },
  },

  main: {
    welcome: '欢迎使用 Neox',
    selectProject: '选择项目',
    openProject: '打开项目...',
    recentProjects: '最近项目',
    noRecentProjects: '没有最近项目',
    signIn: '登录',
    continueWithByok: '使用 BYOK 继续',
    newChat: '新对话',
    sendMessage: '发送消息',
    typeMessage: '输入消息...',
    inputPlaceholder: '输入任何内容... （支持粘贴图片或URL）',
    thinking: '思考中...',
    stop: '停止',
    retry: '重试',
    copy: '复制',
    copied: '已复制',
  },

  session: {
    newSession: '新建会话',
    rename: '重命名',
    delete: '删除',
    deleteConfirm: '确定要删除此会话吗？',
    export: '导出',
    exportJson: '导出为 JSON',
    exportMarkdown: '导出为 Markdown',
    clear: '清空',
    clearConfirm: '确定要清空此会话吗？',
    undo: '撤销',
    checkpoint: '创建检查点',
    rollback: '回滚',
    compact: '压缩',
    compacting: '正在压缩历史...',
    compactingDesc: '为避免上下文溢出，正在总结较旧的消息',
    compactComplete: '压缩完成',
    compactNotNeeded: '无需压缩',
    compactNotNeededDesc: '当前上下文在预算内，无需压缩',
    compactAnalyzing: '📊 分析对话历史...',
    compactSummarizing: '🤖 AI 正在生成摘要...',
    compactSaving: '💾 保存压缩结果...',
    compactBucketFiles: '文件内容',
    compactBucketCommands: '命令输出',
    compactBucketSearch: '搜索结果',
    compactBucketConversation: '对话流',
    compactBucketDone: '已完成',
    compactBucketCompressing: '压缩中...',
    compactBucketPending: '等待中',
    searchPlaceholder: '搜索历史记录...',
    noSessions: '暂无会话',
    noResults: '未找到结果',
    startNewChat: '开始新对话',
    clearSearch: '清除搜索',
    messages: '条消息',
    tokens: 'tokens',
  },

  runtime: {
    sandbox: '沙箱模式',
    sandboxEnabled: '沙箱已启用',
    sandboxDisabled: '沙箱已禁用',
    approval: '审批模式',
    approvalAuto: '自动',
    approvalManual: '手动',
  },

  errors: {
    networkError: '网络错误，请检查连接',
    authError: '认证失败，请检查 API Key',
    rateLimitError: '请求过于频繁，请稍后重试',
    serverError: '服务器错误，请稍后重试',
    unknownError: '未知错误',
    retrying: '正在重试...',
    // Runner 错误
    loopDetected: '检测到无限循环',
    loopDetectedSuggestion: '模型在重复调用同一个工具。请尝试重新表述您的请求，或开始新的对话。',
    placeholderDetected: '检测到占位符文本',
    placeholderDetectedSuggestion: '模型尝试写入占位符文本。这通常发生在对话历史包含截断数据时。请开始新的对话。',
    runnerError: '运行时错误',
    runnerErrorSuggestion: '请检查错误详情并重试。',
  },

  editFile: {
    editFile: '编辑文件',
    applied: '已应用',
    reverted: '已回退',
    pending: '待处理',
    revert: '回退',
    revertAll: '回退全部',
    revertRemaining: '回退剩余',
    reapply: '重新应用',
    reapplyAll: '重新应用全部',
    reapplyRemaining: '重新应用剩余',
    apply: '应用',
    viewAll: '查看全部',
    collapse: '收起',
    originalFile: '原文件',
    newFile: '新文件',
    editingInProgress: '编辑中...',
    replaceAll: '全部替换',
  },

  approval: {
    pendingConfirm: '待确认',
    viewAllChanges: '查看所有变更文件',
    cannotRollback: '无法回滚：没有可用的检查点',
    reverting: '回滚中...',
    rejectAll: '全部不接受',
    acceptAll: '全部接受',
    fileChangeDetails: '文件变更详情',
    totalFiles: '共',
    filteredInfo: '已过滤',
    filteredTooltip: '已自动过滤 node_modules、dist 等目录',
    modified: '个修改',
    created: '个新建文件',
    deleted: '个删除',
    createdFile: '新建',
    createdFolder: '新建文件夹',
    deletedFolder: '删除文件夹',
    multipleEdits: '多次修改',
    changed: '变更',
    filesChanged: '个文件变更',
  },

  tools: {
    title: 'Agent 可用工具',
    description: '点击开关启用/禁用工具',
    readFile: { name: '读取文件', desc: '读取文件内容' },
    writeFile: { name: '写入文件', desc: '创建或覆盖文件' },
    editFile: { name: '编辑文件', desc: '字符串替换编辑' },
    searchFiles: { name: '搜索文件', desc: 'Glob模式匹配查找' },
    listDirectory: { name: '列出目录', desc: '列出文件和子目录' },
    createDirectory: { name: '创建目录', desc: '创建新目录' },
    executeShell: { name: '执行命令', desc: '执行Shell命令' },
    showTree: { name: '目录树', desc: '显示目录树结构' },
    smartTree: { name: '智能扫描', desc: '智能识别项目结构' },
    analyzeCode: { name: '分析代码', desc: '分析代码结构' },
    search: { name: '搜索内容', desc: '正则表达式搜索' },
    executePython: { name: 'Python', desc: '执行Python代码' },
    executeJavaScript: { name: 'JavaScript', desc: '执行JavaScript代码' },
    executeBash: { name: 'Bash脚本', desc: '执行Bash脚本' },
    webFetch: { name: '获取网页', desc: '获取网页内容' },
    webSearch: { name: '网络搜索', desc: '搜索互联网信息' },
    javaDebug: { name: 'Java调试', desc: 'Java调试工具' },
  },

  timeline: {
    thinking: '思考过程',
    reasoning: '💭 推理中',
    toolCall: '工具调用',
    toolResult: '工具结果',
    toolError: '工具错误',
    code: '代码',
    editFile: '编辑文件',
    log: '日志',
    you: '你',
    assistant: '助手',
    smartCompaction: '智能上下文压缩',
    contextTrimming: '上下文窗口裁剪',
    messages: '消息',
    dropped: '丢弃',
    compressed: '压缩',
    saved: '节省',
    items: '条',
    contextUsage: '上下文',
  },

  agentStatus: {
    ready: '就绪',
    thinking: '思考中...',
    generatingResponse: '正在生成回复...',
    waitingForResponse: '等待响应中... {elapsed}s',
    apiRespondingSlowly: 'API 响应较慢... {elapsed}s',
    longWait: '长时间等待 ({elapsed}s)，超时将自动重试...',
    toolRunning: '工具执行中... {elapsed}s',
    toolChainInProgress: '工具链执行中... {elapsed}s',
    toolExecutionLong: '工具执行耗时较长 ({elapsed}s)...',
    exploreRunning: '探索 Agent 运行中... {elapsed}s',
    exploreStillRunning: '探索 Agent 仍在运行... {elapsed}s',
    callingTool: '调用: {toolName}',
    toolCompleted: '工具完成: {toolName}',
    toolError: '工具错误: {toolName}',
    generatingTool: '正在生成 {toolName}...',
    messageQueued: '消息已排队 #{position}',
    messagesDelivered: '已投递 {count} 条排队消息',
    providerSwitching: '正在切换到备用 Provider: {provider}',
    providerRecovered: 'Provider {provider} 已恢复',
  },

  plan: {
    generating: '生成计划中...',
    title: '执行计划',
    updated: '计划更新',
    execute: '执行',
    cancel: '取消',
    executing: '执行中',
    completed: '已完成',
    failed: '失败',
    defaultSummary: '以上是我制定的执行计划，确认后将开始执行。',
    ready: '计划已就绪',
  },

  explorer: {
    projectTitle: '项目',
    newFile: '新建文件',
    newFolder: '新建文件夹',
    rename: '重命名',
    delete: '删除',
    duplicate: '复制副本',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    copyPath: '复制绝对路径',
    copyRelativePath: '复制相对路径',
    revealInFinder: '在文件管理器中显示',
    openInTerminal: '在终端中打开',
    attachToComposer: '加到输入框 (@)',
    revert: '还原改动 (回到 HEAD)',
    open: '打开',
    openWith: '打开方式',
    refresh: '刷新',
    locateInProjectView: '在文件树中定位',
    findInPath: '在路径中查找',
    findUsages: '查找使用',
    newFileTitle: '新建文件',
    newFileLabel: '请输入文件名',
    newFilePlaceholder: '例如: index.ts',
    newFolderTitle: '新建文件夹',
    newFolderLabel: '请输入文件夹名',
    newFolderPlaceholder: '例如: components',
    renameTitle: '重命名',
    renameLabel: '新名称',
    deleteConfirmTitle: '确认删除',
    deleteConfirmMessage: '确定要把 "{name}" 移到回收站吗？',
    deleteConfirmMessagePlural: '确定要把这 {count} 项移到回收站吗？',
    deletePermanently: '永久删除',
    moveToTrash: '移到回收站',
    errorRename: '重命名失败',
    errorDelete: '删除失败',
    errorCreate: '创建失败',
    errorCopyToClipboard: '复制到剪贴板失败',
    errorEmptyName: '名称不能为空',
    errorInvalidName: '名称包含非法字符',
    errorAlreadyExists: '已存在同名文件 / 文件夹',
    successCopiedPath: '路径已复制',
    successCreated: '创建成功',
    successRenamed: '重命名成功',
    successDeleted: '已移到回收站',
    successDuplicated: '副本创建成功',
    successPasted: '粘贴成功',
    viewOptions: '视图选项',
    showHiddenFiles: '显示隐藏文件',
    showExcludedFiles: '显示已排除目录',
    sortBy: '排序方式',
    sortByName: '按名称排序',
    sortByType: '按类型排序',
    sortByTimeAsc: '按修改时间(旧→新)',
    sortByTimeDesc: '按修改时间(新→旧)',
    foldersFirst: '文件夹始终在前',
    compactMiddleDirs: '折叠空中间目录',
    scopeProject: '项目',
    scopeOpenFiles: '已打开文件',
    scopeChangedFiles: '已修改文件',
  },
};

// 英文翻译
const en: Translations = {
  common: {
    loading: 'Loading...',
    save: 'Save',
    cancel: 'Cancel',
    add: 'Add',
    edit: 'Edit',
    delete: 'Delete',
    confirm: 'Confirm',
    refresh: 'Refresh',
    close: 'Close',
    on: 'On',
    off: 'Off',
    auto: 'Auto',
    preview: 'Preview',
    clickToPreview: 'Click to preview',
    emptyDir: 'Empty directory',
    error: 'Error',
    success: 'Success',
    warning: 'Warning',
    info: 'Info',
    openInFinder: 'Show in File Manager',
    copyPath: 'Copy path',
    send: 'Send',
    pause: 'Pause',
    resume: 'Resume',
    uploadImage: 'Upload image',
    terminal: 'Terminal',
    editor: 'Editor',
    debug: 'Debug',
    tools: 'Tools',
    quickTools: 'Quick Tools',
  },
  settings: {
    title: 'Settings',
    menu: {
      providers: 'API Providers',
      routing: 'Model Routing',
      orchestrator: 'Orchestration',
      agent: 'Agent Settings',
      general: 'General',
      storage: 'Storage',
      usage: 'Usage',
      about: 'About',
    },
    orchestrator: {
      title: 'Multi-Model Orchestration',
      desc: 'Intelligently decompose tasks and select the best model for each subtask',
      enable: 'Enable Orchestration',
      enabledDesc: 'System will analyze tasks and select best models',
      disabledDesc: 'Use agentic model for all tasks',
      mode: 'Execution Mode',
      modeSequential: 'Sequential',
      modeParallel: 'Parallel',
      modeHybrid: 'Hybrid',
      modeSequentialDesc: 'Tasks execute one by one, stable and reliable',
      modeParallelDesc: 'Tasks execute in parallel, faster',
      modeHybridDesc: 'System auto-decides optimal execution',
      context: 'Context Sharing',
      contextFull: 'Full',
      contextSummary: 'Summary',
      contextSelective: 'Selective',
      contextFullDesc: 'Full context, uses more tokens',
      contextSummaryDesc: 'Summary only, balanced approach',
      contextSelectiveDesc: 'Key info only, minimal tokens',
      rules: 'Task Routing Rules',
      rulesDesc: 'Configure preferred models for different task types',
      addRule: 'Add Rule',
      editRule: 'Edit Routing Rule',
      noRules: 'No routing rules',
      noRulesHint: 'Click to add rules for specific task types',
      taskType: 'Task Type',
      selectTaskType: 'Select task type',
      preferredModels: 'Preferred Models',
      preferredModelsHint: 'Select preferred models for this task (multi-select)',
      fallbackModel: 'Fallback Model',
      selectFallback: 'Select fallback model',
      noModels: 'Please configure models in Provider first',
    },
    routing: {
      title: 'Model Routing',
      desc: 'Configure multiple Providers for the same model with auto-switching',
      enable: 'Enable Model Routing',
      enabledDesc: 'Auto routing enabled, will switch between Providers when using Auto model',
      disabledDesc: 'Disabled, will use single Provider',
      configTitle: 'Route Configuration',
      addRoute: 'Add Route',
      noRoutes: 'No routes configured',
      noRoutesHint: 'Click the button above to add model routes',
      providers: 'Provider List',
      strategy: 'Routing Strategy',
      strategyPriority: 'Priority',
      strategyLatency: 'Latency',
      strategyRoundRobin: 'Round Robin',
      healthCheck: 'Health Check',
      interval: 'Interval',
      timeout: 'Timeout',
      failureThreshold: 'Failure Threshold',
      failureThresholdUnit: 'failures to mark unavailable',
      tips: {
        title: 'Usage Tips',
        priority: 'Priority: Try in order, first healthy Provider wins',
        latency: 'Latency: Choose the healthy Provider with lowest latency',
        roundRobin: 'Round Robin: Rotate between healthy Providers',
        autoSwitch: 'Auto switch to next Provider when current is unavailable',
      },
    },
    agent: {
      title: 'Agent Settings',
      sandbox: 'Sandbox Mode',
      sandboxDesc: 'Execute commands in a sandbox to prevent system impact',
      sandboxOnDesc: 'Commands run in isolated environment',
      sandboxOffDesc: 'Commands run directly on system',
      approval: 'Approval Mode',
      approvalDesc: 'Control whether Agent needs confirmation before executing',
      approvalAutoDesc: 'Policy-driven: whitelisted read tools auto-run, others require approval',
      approvalManualDesc: 'Manual mode: approval required for non-read actions',
      piiFilter: 'Content Protection',
      piiFilterDesc: 'Replaces passwords, API keys and tokens with <REDACTED> before sending. You are told what was removed.',
    },
    providers: {
      title: 'API Providers',
      add: 'Add',
      noProviders: 'No providers configured',
      noProvidersDesc: 'Add an API provider to start chatting',
      name: 'Name',
      protocol: 'Protocol',
      apiKey: 'API Key',
      apiKeyPlaceholder: 'sk-...',
      apiKeyKeepEmpty: 'Leave empty to keep current',
      baseUrl: 'Base URL',
      baseUrlPlaceholder: 'https://api.openai.com/v1',
      maxTokens: 'Max Output Tokens',
      maxInputTokens: 'Max Input Tokens',
      models: 'Models',
      modelsSelected: 'selected',
      modelsPlaceholder: 'Click to select models...',
      addMoreModels: 'Add more models...',
      addCustomModel: 'Press Enter to add custom model',
      allPresetsSelected: 'All preset models selected',
      setAsDefault: 'Set as default',
      deleteConfirm: 'Are you sure you want to delete this provider?',
      addProvider: 'Add Provider',
      editProvider: 'Edit Provider',
      health: {
        excellent: 'Excellent',
        good: 'Good',
        slow: 'Slow',
        testing: 'Testing...',
        offline: 'Offline',
        error: 'Error',
        unknown: 'Unknown',
      },
    },
    general: {
      title: 'General',
      appearance: {
        title: 'Appearance',
        darkMode: 'Dark Mode',
        darkModeAuto: 'Auto',
        darkModeLight: 'Light',
        darkModeDark: 'Dark',
        autoDesc: 'Auto switch based on time (Light: 6:00-18:00)',
        lightDesc: 'Always use light mode',
        darkDesc: 'Always use dark mode',
        colorTheme: 'Color Theme',
        colorThemeDesc: 'Choose your preferred theme color',
      },
      languageDebug: {
        title: 'Language & Debug',
        uiLanguage: 'Language',
        uiLanguageDesc: 'Switches both the interface text and the language the AI replies in',
        cliDebug: 'CLI Debug Logs',
        cliDebugOnDesc: 'Verbose logging enabled (CLI_DEBUG=1)',
        cliDebugOffDesc: 'Reduced terminal debug info',
        piiFilter: 'PII Protection',
        piiFilterDesc: 'Auto-replace passwords/API Keys with <REDACTED> to avoid One-API PII filtering 400 errors.',
      },
    },
    storage: {
      title: 'Storage',
      configDir: 'Config Directory',
      totalSize: 'Total Size',
      loadError: 'Failed to load storage info',
      files: {
        configJson: 'config.json',
        configJsonDesc: 'Main config file (Providers, API Keys, etc.)',
        uiState: 'ui-state.json',
        uiStateDesc: 'UI state config (theme, workspaces, etc.)',
        sessions: 'sessions/',
        sessionsDesc: 'Session history',
        workspaces: 'workspaces/',
        workspacesDesc: 'Workspace state',
      },
    },
    usage: {
      title: 'Usage Statistics',
      summary: 'Summary',
      totalRequests: 'Total Requests',
      totalTokens: 'Total Tokens',
      cachedTokens: 'Cached Tokens',
      providerCount: 'Providers',
      lastRequest: 'Last Request',
      noData: 'No usage data yet',
      noDataDesc: 'API usage will be tracked automatically',
      providerStats: 'Provider Statistics',
      requests: 'requests',
      inputTokens: 'Input',
      outputTokens: 'Output',
      avgDuration: 'Avg Duration',
      details: 'Details',
      clearAll: 'Clear All',
      clearAllConfirm: 'Are you sure you want to clear all usage data?',
      clearProvider: 'Clear',
      clearProviderConfirm: 'Are you sure you want to clear this provider\'s data?',
      viewRecords: 'View Records',
      recentRecords: 'Recent Requests',
      type: 'Type',
      healthCheck: 'Health Check',
      chat: 'Chat',
      model: 'Model',
      duration: 'Duration',
      status: 'Status',
      success: 'Success',
      failed: 'Failed',
      noRecords: 'No request records',
    },
    about: {
      title: 'About',
      appName: 'Neox',
      tagline: 'AI-Powered Code Assistant',
      description: 'An intelligent coding assistant that helps you write better code faster.',
    },
  },

  main: {
    welcome: 'Welcome to Neox',
    selectProject: 'Select Project',
    openProject: 'Open Project...',
    recentProjects: 'Recent Projects',
    noRecentProjects: 'No recent projects',
    signIn: 'Sign in',
    continueWithByok: 'Continue with BYOK',
    newChat: 'New Chat',
    sendMessage: 'Send Message',
    typeMessage: 'Type a message...',
    inputPlaceholder: 'Ask anything... (paste image or URL)',
    thinking: 'Thinking...',
    stop: 'Stop',
    retry: 'Retry',
    copy: 'Copy',
    copied: 'Copied',
  },

  session: {
    newSession: 'New Session',
    rename: 'Rename',
    delete: 'Delete',
    deleteConfirm: 'Are you sure you want to delete this session?',
    export: 'Export',
    exportJson: 'Export as JSON',
    exportMarkdown: 'Export as Markdown',
    clear: 'Clear',
    clearConfirm: 'Are you sure you want to clear this session?',
    undo: 'Undo',
    checkpoint: 'Create Checkpoint',
    rollback: 'Rollback',
    compact: 'Compact',
    compacting: 'Compacting history...',
    compactingDesc: 'Summarizing older messages to avoid context overflow',
    compactComplete: 'Compaction complete',
    compactNotNeeded: 'No compaction needed',
    compactNotNeededDesc: 'Context is within budget, no compaction required',
    compactAnalyzing: '📊 Analyzing conversation...',
    compactSummarizing: '🤖 AI generating summary...',
    compactSaving: '💾 Saving results...',
    compactBucketFiles: 'Files',
    compactBucketCommands: 'Commands',
    compactBucketSearch: 'Search',
    compactBucketConversation: 'Conversation',
    compactBucketDone: 'Done',
    compactBucketCompressing: 'Compressing...',
    compactBucketPending: 'Pending',
    searchPlaceholder: 'Search history...',
    noSessions: 'No sessions yet',
    noResults: 'No results found',
    startNewChat: 'Start a new chat',
    clearSearch: 'Clear search',
    messages: 'messages',
    tokens: 'tokens',
  },

  runtime: {
    sandbox: 'Sandbox Mode',
    sandboxEnabled: 'Sandbox Enabled',
    sandboxDisabled: 'Sandbox Disabled',
    approval: 'Approval Mode',
    approvalAuto: 'Auto',
    approvalManual: 'Manual',
  },

  errors: {
    networkError: 'Network error, please check your connection',
    authError: 'Authentication failed, please check your API Key',
    rateLimitError: 'Rate limited, please try again later',
    serverError: 'Server error, please try again later',
    unknownError: 'Unknown error',
    retrying: 'Retrying...',
    // Runner errors
    loopDetected: 'Infinite loop detected',
    loopDetectedSuggestion: 'The model is repeatedly calling the same tool. Please try rephrasing your request or start a new conversation.',
    placeholderDetected: 'Placeholder text detected',
    placeholderDetectedSuggestion: 'The model attempted to write placeholder text. This usually happens when conversation history contains truncated data. Please start a new conversation.',
    runnerError: 'Runtime error',
    runnerErrorSuggestion: 'Please check the error details and try again.',
  },

  editFile: {
    editFile: 'Edit File',
    applied: 'Applied',
    reverted: 'Reverted',
    pending: 'Pending',
    revert: 'Revert',
    revertAll: 'Revert All',
    revertRemaining: 'Revert Remaining',
    reapply: 'Reapply',
    reapplyAll: 'Reapply All',
    reapplyRemaining: 'Reapply Remaining',
    apply: 'Apply',
    viewAll: 'View All',
    collapse: 'Collapse',
    originalFile: 'Original',
    newFile: 'New',
    editingInProgress: 'Editing in progress...',
    replaceAll: 'Replace All',
  },

  approval: {
    pendingConfirm: 'Pending',
    viewAllChanges: 'View all changed files',
    cannotRollback: 'Cannot rollback: No checkpoint available',
    reverting: 'Reverting...',
    rejectAll: 'Reject All',
    acceptAll: 'Accept All',
    fileChangeDetails: 'File Change Details',
    totalFiles: 'Total',
    filteredInfo: 'Filtered',
    filteredTooltip: 'Auto-filtered node_modules, dist, etc.',
    modified: 'modified',
    created: 'created',
    deleted: 'deleted',
    createdFile: 'Create',
    createdFolder: 'Create Folder',
    deletedFolder: 'Delete Folder',
    multipleEdits: 'Multiple Edits',
    changed: 'Changed',
    filesChanged: 'files changed',
  },

  tools: {
    title: 'Available Agent Tools',
    description: 'Toggle to enable/disable tools',
    readFile: { name: 'Read File', desc: 'Read file contents' },
    writeFile: { name: 'Write File', desc: 'Create or overwrite file' },
    editFile: { name: 'Edit File', desc: 'String replacement edit' },
    searchFiles: { name: 'Search Files', desc: 'Glob pattern matching' },
    listDirectory: { name: 'List Directory', desc: 'List files and dirs' },
    createDirectory: { name: 'Create Directory', desc: 'Create new directory' },
    executeShell: { name: 'Execute Shell', desc: 'Execute shell commands' },
    showTree: { name: 'Show Tree', desc: 'Display directory tree' },
    smartTree: { name: 'Smart Tree', desc: 'Smart project scan' },
    analyzeCode: { name: 'Analyze Code', desc: 'Analyze code structure' },
    search: { name: 'Search', desc: 'Content search' },
    executePython: { name: 'Python', desc: 'Execute Python code' },
    executeJavaScript: { name: 'JavaScript', desc: 'Execute JavaScript code' },
    executeBash: { name: 'Bash Script', desc: 'Execute Bash scripts' },
    webFetch: { name: 'Web Fetch', desc: 'Fetch web content' },
    webSearch: { name: 'Web Search', desc: 'Search the web' },
    javaDebug: { name: 'Java Debug', desc: 'Java debugging tools' },
  },

  timeline: {
    thinking: 'Thought Process',
    reasoning: '💭 Reasoning',
    toolCall: 'Tool Call',
    toolResult: 'Tool Result',
    toolError: 'Tool Error',
    code: 'Code',
    editFile: 'Edit File',
    log: 'Log',
    you: 'You',
    assistant: 'Assistant',
    smartCompaction: 'Smart Context Compaction',
    contextTrimming: 'Context Window Trimming',
    messages: 'Messages',
    dropped: 'Dropped',
    compressed: 'Compressed',
    saved: 'Saved',
    items: '',
    contextUsage: 'Context',
  },

  agentStatus: {
    ready: 'Ready',
    thinking: 'Thinking...',
    generatingResponse: 'Generating response...',
    waitingForResponse: 'Waiting for response... {elapsed}s',
    apiRespondingSlowly: 'API responding slowly... {elapsed}s',
    longWait: 'Long wait ({elapsed}s) — will retry if timeout...',
    toolRunning: 'Tool is running... {elapsed}s',
    toolChainInProgress: 'Tool chain in progress... {elapsed}s',
    toolExecutionLong: 'Tool execution taking long ({elapsed}s)...',
    exploreRunning: 'Explore agents running... {elapsed}s',
    exploreStillRunning: 'Explore agents still running... {elapsed}s',
    callingTool: 'Calling: {toolName}',
    toolCompleted: 'Tool completed: {toolName}',
    toolError: 'Tool error: {toolName}',
    generatingTool: 'Generating {toolName}...',
    messageQueued: 'Message queued #{position}',
    messagesDelivered: '{count} queued messages delivered',
    providerSwitching: 'Switching to backup provider: {provider}',
    providerRecovered: 'Provider {provider} recovered',
  },

  plan: {
    generating: 'Generating plan...',
    title: 'Execution Plan',
    updated: 'Updated Plan',
    execute: 'Execute',
    cancel: 'Cancel',
    executing: 'Executing',
    completed: 'Completed',
    failed: 'Failed',
    defaultSummary: 'Above is my execution plan. Please confirm to start execution.',
    ready: 'Plan Ready',
  },

  explorer: {
    projectTitle: 'Project',
    newFile: 'New File',
    newFolder: 'New Folder',
    rename: 'Rename',
    delete: 'Delete',
    duplicate: 'Duplicate',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    copyPath: 'Copy Path',
    copyRelativePath: 'Copy Relative Path',
    revealInFinder: 'Reveal in File Manager',
    openInTerminal: 'Open in Terminal',
    attachToComposer: 'Add to composer (@)',
    revert: 'Revert Changes (to HEAD)',
    open: 'Open',
    openWith: 'Open With',
    refresh: 'Refresh',
    locateInProjectView: 'Locate in Project View',
    findInPath: 'Find in Path',
    findUsages: 'Find Usages',
    newFileTitle: 'New File',
    newFileLabel: 'Enter file name',
    newFilePlaceholder: 'e.g. index.ts',
    newFolderTitle: 'New Folder',
    newFolderLabel: 'Enter folder name',
    newFolderPlaceholder: 'e.g. components',
    renameTitle: 'Rename',
    renameLabel: 'New name',
    deleteConfirmTitle: 'Confirm Delete',
    deleteConfirmMessage: 'Move "{name}" to Trash?',
    deleteConfirmMessagePlural: 'Move {count} items to Trash?',
    deletePermanently: 'Delete Permanently',
    moveToTrash: 'Move to Trash',
    errorRename: 'Rename failed',
    errorDelete: 'Delete failed',
    errorCreate: 'Create failed',
    errorCopyToClipboard: 'Copy to clipboard failed',
    errorEmptyName: 'Name cannot be empty',
    errorInvalidName: 'Name contains invalid characters',
    errorAlreadyExists: 'A file or folder with that name already exists',
    successCopiedPath: 'Path copied',
    successCreated: 'Created',
    successRenamed: 'Renamed',
    successDeleted: 'Moved to Trash',
    successDuplicated: 'Duplicated',
    successPasted: 'Pasted',
    viewOptions: 'View Options',
    showHiddenFiles: 'Show Hidden Files',
    showExcludedFiles: 'Show Excluded Files',
    sortBy: 'Sort By',
    sortByName: 'Sort by Name',
    sortByType: 'Sort by Type',
    sortByTimeAsc: 'Sort by Time (Asc)',
    sortByTimeDesc: 'Sort by Time (Desc)',
    foldersFirst: 'Folders Always on Top',
    compactMiddleDirs: 'Compact Empty Middle Packages',
    scopeProject: 'Project',
    scopeOpenFiles: 'Open Files',
    scopeChangedFiles: 'Changed Files',
  },
};

/* 出海 P1: 深合并 fallback —— 任何 en 缺失的 key 自动回落到 zh, 防止英文 UI 因漏译
 * 某个 key 取到 undefined 而崩/白屏 (TS 接口理论上保证全量, 但运行期防御 + 未来漂移兜底).
 * 只回填缺失的叶子/分支, 已有的 en 值不被覆盖. */
function deepFallback<T>(base: T, override: Partial<T> | undefined): T {
  if (override == null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (override as T) ?? base;
  }
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  const ov: any = override;
  for (const key of Object.keys(base as any)) {
    const b = (base as any)[key];
    const o = ov[key];
    if (o === undefined) continue;                       // en 缺这个 key → 保留 zh
    out[key] = (b && typeof b === 'object' && !Array.isArray(b))
      ? deepFallback(b, o)
      : (o ?? b);
  }
  return out as T;
}

// 翻译表 — en 以 zh 为底回填, 杜绝缺 key 取到 undefined
const enWithFallback: Translations = deepFallback(zh, en);
const translations: Record<Language, Translations> = { zh, en: enWithFallback };

// 获取翻译
export function getTranslations(lang: Language): Translations {
  return translations[lang] || translations.zh;
}

// 导出默认翻译
export { zh, en };
