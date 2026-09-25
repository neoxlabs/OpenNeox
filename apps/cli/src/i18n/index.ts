/**
 * CLI 国际化模块
 *
 * 提供 CLI 界面的中英文翻译支持
 */

import { loadConfig, saveConfig } from '@neoxlabs/platform/utils/config.js';
import type { UserLanguage } from '@neoxlabs/kernel/types/configTypes.js';

// ============================================================================
// 类型定义
// ============================================================================

export type { UserLanguage };

/**
 * CLI 翻译内容
 */
export interface CLITranslations {
  // 通用
  common: {
    yes: string;
    no: string;
    cancel: string;
    confirm: string;
    back: string;
    exit: string;
    loading: string;
    error: string;
    success: string;
    warning: string;
    info: string;
    select: string;
    selectHint: string;
    escToCancel: string;
    escToBack: string;
    noItemsFound: string;
    /** 列表里标记「当前生效项」的短标签 (model.ts 的 ` · 当前` 后缀) */
    current: string;
  };

  // 斜杠命令菜单
  slashMenu: {
    title: string;
    hint: string;
    commandCount: string;  // e.g., "{count} 个命令" or "{count} commands"
    categories: {
      basic: string;
      account: string;
      mode: string;
      ai: string;
      session: string;
      process: string;
      tools: string;
      stats: string;
      config: string;
      skills: string;
    };
    commands: {
      help: string;
      clear: string;
      exit: string;
      setup: string;
      login: string;
      logout: string;
      whoami: string;
      usage: string;
      device: string;
      upgrade: string;
      speed: string;
      effort: string;
      style: string;
      theme: string;
      modelProfile: string;
      mode: string;
      run: string;
      runconfig: string;
      thinking: string;
      approval: string;
      sandbox: string;
      provider: string;
      model: string;
      sessions: string;
      session: string;
      sessionNew: string;
      sessionInfo: string;
      undo: string;
      checkpoint: string;
      checkpoints: string;
      rollback: string;
      sessionClear: string;
      sessionExport: string;
      compact: string;
      cleanup: string;
      ps: string;
      kill: string;
      workspace: string;
      websearch: string;
      mcp: string;
      context: string;
      memory: string;
      remote: string;
      index: string;
      tokenStats: string;
      costStats: string;
      sessionStatus: string;
      pricingConfig: string;
      configClear: string;
      configReset: string;
      notify: string;
      skills: string;
      language: string;
      tts: string;
      experimental: string;
      update: string;
      init: string;
      attach: string;
      attachments: string;
    };
  };

  // Skills 菜单
  skillsMenu: {
    title: string;
    hint: string;
    viewAll: string;
    viewAllDesc: string;
    import: string;
    importDesc: string;
    create: string;
    createDesc: string;
    refresh: string;
    refreshDesc: string;
    noSkills: string;
    selectToExecute: string;
    builtIn: string;
    user: string;
    workspace: string;
    importMethod: string;
    fromUrl: string;
    fromUrlDesc: string;
    fromPath: string;
    fromPathDesc: string;
    saveLocation: string;
    userGlobal: string;
    workspaceLocal: string;
    enterUrl: string;
    enterPath: string;
    importing: string;
    importSuccess: string;
    importFailed: string;
    createNew: string;
    enterId: string;
    enterName: string;
    enterDescription: string;
    creating: string;
    createSuccess: string;
    createFailed: string;
    refreshing: string;
    refreshSuccess: string;
    idFormatError: string;
    skillExists: string;
    categoryGit: string;
    categoryCode: string;
    categoryDocs: string;
    categoryTest: string;
    categoryCustom: string;
    selectCategory: string;
  };

  // 语言菜单
  languageMenu: {
    title: string;
    hint: string;
    current: string;
    chinese: string;
    chineseDesc: string;
    english: string;
    englishDesc: string;
    changed: string;
  };

  // 引导程序
  onboarding: {
    welcome: string;
    welcomeDesc: string;
    selectLanguage: string;
    selectLanguageDesc: string;
    setupComplete: string;
    setupCompleteDesc: string;
    continue: string;
    skip: string;
  };

  // 状态信息
  status: {
    thinking: string;
    running: string;
    idle: string;
    streaming: string;
    toolCall: string;
    waiting: string;
    ready: string;
    complete: string;
    failed: string;
  };

  // UI 组件
  ui: {
    // 通用
    tasks: string;
    plan: string;
    progress: string;
    executionPlan: string;
    percentComplete: string;
    // Network 模式
    criticalPath: string;
    normalNode: string;
    dependency: string;
    failed: string;
    // DAG
    dagLegend: string;
    dagTaskPlanning: string;
    nodes: string;
    levels: string;
    maxParallel: string;
    estimated: string;
    // Pipeline
    pipelineProgress: string;
    taskCount: string;
    taskAnalysis: string;
    intent: string;
    domain: string;
    complexity: string;
    scope: string;
    techDepth: string;
    dependencyLevel: string;
    ambiguity: string;
    routing: string;
    needsCCB: string;
    // Node 卡片
    reason: string;
    output: string;
    errorLabel: string;
    // CCB 评审
    riskSummary: string;
    suggestions: string;
    recommendedSolution: string;
    confirmReview: string;
    confirmToContinue: string;
    reReview: string;
    editRequirements: string;
    retriedTimes: string;
    risks: string;
    // Token 统计
    tokenIn: string;
    tokenOut: string;
    tokenCache: string;
    context: string;
    // 状态
    analyzing: string;
    planning: string;
    executing: string;
    reviewing: string;
    // 中断输入框
    interruptMessage: string;
    willSendNextRequest: string;
    enterYourMessage: string;
    typeMessage: string;
    enterToConfirm: string;
    // Provider 配置
    startingProviderSetup: string;
    completeSetupInPopup: string;
    noProviderDetected: string;
    needConfigProvider: string;
    detectedCredentials: string;
    supportedProviders: string;
    selectAction: string;
    // 输入行
    scrollHint: string;
    moreAbove: string;
    moreBelow: string;
    shiftEnterNewline: string;
    enterToSend: string;
    lineCount: string;
    // 状态栏提示
    backgroundAgentsRunning: string;  // e.g. "● {count} background agent(s)"
    running: string;
    tabToView: string;
    // 交互式 Provider 设置
    selectProtocol: string;
    selectDefaultModel: string;
    modelsAvailable: string;
    moreModels: string;
    configConfirm: string;
    name: string;
    protocol: string;
    model: string;
    pressEnterToConfirm: string;
    providerSetupWizard: string;
    // Header 欢迎页
    tipsForGettingStarted: string;
    welcomeEnjoy: string;
    typeMessageToStart: string;
    helpOrQuestionMark: string;
    pressQuestionForShortcuts: string;
    whatIsNeox: string;
    intelligentCodingAssistant: string;
    multiAgentAssistantoration: string;
    smartContextManagement: string;
    provider: string;
    path: string;
  };

  // 通知命令
  notify: {
    completionAlerts: string;
    soundOn: string;
    soundOff: string;
    soundLabel: string;
    soundDesc: string;
    soundFileLabel: string;
    soundFileDesc: string;
    notificationLabel: string;
    notificationDesc: string;
    enableSound: string;
    on: string;
    off: string;
    soundUpdated: string;
    enabled: string;
    disabled: string;
    enableNotification: string;
    notificationUpdated: string;
    noSoundFiles: string;
    placeSoundFiles: string;
    selectSound: string;
    selectHint: string;
    current: string;
    soundFileUpdated: string;
    invalidAction: string;
    useNotifyToView: string;
    // macOS 系统声音
    systemSounds: string;
    customSounds: string;
    systemSoundPrefix: string;
    taskComplete: string;
  };

  // 定价配置
  pricing: {
    title: string;
    hint: string;
    viewPricing: string;
    viewPricingDesc: string;
    addPricing: string;
    addPricingDesc: string;
    editPricing: string;
    editPricingDesc: string;
    deletePricing: string;
    deletePricingDesc: string;
    noPricing: string;
    noPricingHint: string;
    modelPattern: string;
    modelPatternHint: string;
    inputPrice: string;
    inputPriceHint: string;
    outputPrice: string;
    outputPriceHint: string;
    cachedPrice: string;
    cachedPriceHint: string;
    currency: string;
    pricingAdded: string;
    pricingUpdated: string;
    pricingDeleted: string;
    selectToEdit: string;
    selectToDelete: string;
    confirmDelete: string;
    perMillionTokens: string;
    invalidNumber: string;
    back: string;
  };

  // Provider 配置引导面板 (无 Provider 时启动显示)
  providerGuide: {
    welcome: string;
    noProviderDetected: string;
    needConfig: string;
    quickStart: string;
    quickStartUseServices: string;
    quickStartApiKey: string;
    quickStartProxy: string;
    supportedProviders: string;
  };

  // /setup 配置向导
  setup: {
    headerTitle: string;
    headerCurrent: string;          // "Current: {provider} · {model}"
    notConfigured: string;
    enabled: string;
    disabled: string;
    selectItem: string;
    accountLabel: string;           // 已登录
    accountLabelOut: string;        // 未登录
    accountDesc: string;
    providerLabel: string;          // "Provider ({count} configured)"
    providerLabelEmpty: string;
    providerDesc: string;
    modelLabel: string;             // "Model — {model}"
    modelDesc: string;
    webSearchLabel: string;         // "Web Search — {status}"
    webSearchDesc: string;
    mcpLabel: string;               // "MCP Servers ({count})"
    mcpLabelEmpty: string;
    mcpDesc: string;
    languageLabel: string;          // "Language — {lang}"
    languageDesc: string;
    advancedLabel: string;
    advancedDesc: string;
    advancedTitle: string;
    ttsLabel: string;               // "TTS — {status}"
    ttsDesc: string;
    remoteLabel: string;            // "Remote Access — {status}"
    remoteDesc: string;
    experimentalLabel: string;
    experimentalDesc: string;
    notifyLabel: string;
    notifyDesc: string;
    cancelled: string;
    errorTitle: string;
  };

  // /provider add 配置流程
  providerCmd: {
    addTitle: string;
    addSubtitle: string;
    step1: string;                  // "Step 1/4"
    step1Hint: string;
    step2: string;
    step3: string;
    step4: string;
    displayName: string;
    displayNameHint: string;
    protocolFormat: string;
    baseUrlHint: string;
    selectModelCategory: string;
    categoryRecommended: string;
    categoryAll: string;            // "- All — {count} models"
    categoryCustom: string;
    enterModelName: string;
    selectDefaultModel: string;
    noRegistryModels: string;
    customModelName: string;
    addMoreModels: string;
    enterMoreModels: string;
    enterMoreModelsHint: string;
    apiKey: string;
    apiKeyHint: string;
    confirmConfig: string;
    configPreview: string;
    summaryName: string;
    summaryProtocol: string;
    summaryBaseUrl: string;
    summaryApiKey: string;
    summaryModels: string;
    summaryDefault: string;
    setAsDefault: string;
    createdTitle: string;
    cancelledTitle: string;
    cancelledDetail: string;
    createFailed: string;
    // 协议选项
    protoOpenAIChat: string;
    protoOpenAIResponses: string;
    protoKimi: string;
    protoAnthropic: string;
    protoAnthropicOpenAI: string;
    protoDoubao: string;
    protoGemini: string;
    protoGlm: string;
    protoGlmClaude: string;
    protoKimiClaude: string;
    // edit-only 协议选项变体
    protoOpenAIChatEdit: string;
    protoOpenAIResponsesEdit: string;
    protoAnthropicOpenAIEdit: string;
    // edit 流程 hint
    editIdHint: string;
    editApiKeyHint: string;
  };

  modeCmd: {
    runSettingsTitle: string;
    reasoningEffortTitle: string;
    concurrencyTitle: string;
    // /mode 主菜单
    agentLabel: string;      agentDesc: string;
    askLabel: string;        askDesc: string;
    concurrencyEntry: string; concurrencyEntryDesc: string;
    runArchEntry: string;    runArchEntryDesc: string;
    archConfigEntry: string; archConfigEntryDesc: string;
    // 并发档位
    concurrencyAuto: string; concurrencyAutoDesc: string;
    concurrencyLow: string;  concurrencyLowDesc: string;
    // /effort
    effortMinimal: string; effortMinimalDesc: string;
    effortLow: string;     effortLowDesc: string;
    effortMedium: string;  effortMediumDesc: string;
    effortHigh: string;    effortHighDesc: string;
    effortXhigh: string;   effortXhighDesc: string;
    effortMax: string;     effortMaxDesc: string;
    effortUltra: string;   effortUltraDesc: string;
    // 提示
    noProviderBound: string;
    alreadySet: string;    // "当前已是 {v}"
  };

  // /model 配置菜单
  modelCmd: {
    subscriptionTitle: string;      // "Subscription · {plan}{count}{stale}"
    noModels: string;               // "0 models"
    modelsCount: string;            // "{count} models"
    cacheStale: string;
    noSubscription: string;
    selectBYOK: string;             // "Select BYOK model · {models} models / {providers} providers"
    noBYOKModels: string;
    noBYOKModelsHint: string;
    customBYOK: string;
    noSubModels: string;
    sessionExpired: string;
    sessionExpiredAction: string;
    membershipNetworkFail: string;
    /** 服务端拒了 (403/429/5xx) — 跟"网络不通"分开, 免得用户去折腾自己的网络.
     *  调用点会在后面接 ` (HTTP xxx)`, 所以这句不要以句号收尾. */
    membershipServerFail: string;
    refreshMembership: string;
    notSubscribed: string;
    notSubscribedHint: string;
    membershipRefreshed: string;
    membershipRefreshedHint: string;
    refreshFailed: string;
    cloudNotInjected: string;
    cloudNotInjectedHint: string;
    switchedToSub: string;
    onDemand: string;
    imageModelsHint: string;
    clearContextPrompt: string;     // "Conversation context detected. Clear history after switching to {model}?"
    contextCleared: string;
    contextClearedDetail: string;
    contextKept: string;
    contextKeptDetail: string;
    switchCancelled: string;
    switchCancelledDetail: string;
    ptcAutoDisabled: string;
  };

  // /session, /checkpoint, /compact 命令
  sessionCmd: {
    checkpointEnabled: string;
    checkpointEnabledDetail: string;
    checkpointDisabled: string;
    checkpointDisabledDetail: string;
    checkpointDisabledShort: string;
    checkpointEnableFirst: string;
    checkpointEnableFirstShort: string;
    checkpointMenuTitle: string;    // "Checkpoint · {size} ({detail})"
    checkpointMenuRepo: string;
    checkpointToggleOn: string;
    checkpointToggleOff: string;
    checkpointCreate: string;
    checkpointListRollback: string;
    checkpointCleanup: string;
    cleanupDone: string;
    cleanupDoneDetail: string;
    // /session-clear
    clearConfirmTitle: string;
    clearConfirmCancel: string;
    clearConfirmConfirm: string;
    clearCancelled: string;
    // /compact
    compactSessionDisabled: string;
    compactSessionDisabledDetail: string;
    compactNoProfile: string;
    compactNoProfileDetail: string;
    compactRunning: string;
    compactRunningDetail: string;
    compactInProgress: string;
    compactInProgressDetail: string;
    compactUnavailable: string;
    compactUnavailableDetail: string;
    compactNothing: string;
    compactNothingDetail: string;
    compactManual: string;
    compactComplete: string;
    compactFailedStatus: string;
    compactFailed: string;
    compactFailedCard: string;
  };
}

// ============================================================================
// 中文翻译
// ============================================================================

const zh: CLITranslations = {
  common: {
    yes: '是',
    no: '否',
    cancel: '取消',
    confirm: '确认',
    back: '返回',
    exit: '退出',
    loading: '加载中...',
    error: '错误',
    success: '成功',
    warning: '警告',
    info: '信息',
    select: '选择',
    selectHint: '↑↓ 选择 · Enter 确认 · Esc 取消',
    escToCancel: 'ESC 取消',
    escToBack: 'ESC 返回',
    noItemsFound: '未找到匹配项',
    current: '当前',
  },

  slashMenu: {
    title: '命令菜单',
    hint: '输入筛选 · ESC 关闭',
    commandCount: '{count} 个命令',
    categories: {
      basic: '基础',
      account: '账号',
      mode: '模式',
      ai: 'AI',
      session: '会话',
      process: '进程',
      tools: '工具',
      stats: '统计',
      config: '配置',
      skills: '技能',
    },
    commands: {
      help: '显示帮助',
      /* 不是"清屏" —— 它清的是对话上下文, 终端上已有的字擦不掉 (见 InkRuntime.clearMessages) */
      clear: '清空对话上下文',
      exit: '退出',
      setup: '配置向导: 服务、模型、联网搜索',
      login: '登录 Neox Cloud',
      logout: '退出登录',
      whoami: '当前账号',
      usage: '用量和额度',
      device: '已登录的设备',
      upgrade: '升级订阅 (打开网页)',
      speed: '速度模式 (turbo/normal/deep)',
      effort: '推理深度 (minimal~ultra)',
      style: '输出风格 (concise/standard/detailed/code_only)',
      theme: '配色主题',
      modelProfile: 'Model Profile 查看 / Toolset 配置',
      mode: '交互模式: Agent 干活 / Ask 只聊',
      run: '切换运行架构 (agentic 多Agent / assistant 助理调度)',
      runconfig: '运行架构配置 (Main/Worker/并发)',
      thinking: '深度思考开关',
      approval: '工具执行前要不要问你',
      sandbox: '沙箱: 限制命令能改哪些文件',
      provider: '服务和 API Key',
      model: '切换模型',
      sessions: '列出所有会话',
      session: '会话: 新建、导出、清空',
      sessionNew: '创建新会话',
      sessionInfo: '显示会话信息',
      undo: '撤销最近对话',
      checkpoint: '检查点设置',
      checkpoints: '列出检查点',
      rollback: '把文件改动退回某个检查点',
      sessionClear: '清空当前会话',
      sessionExport: '导出会话',
      compact: '压缩对话, 腾出上下文',
      cleanup: '磁盘占用管理',
      ps: '后台命令',
      kill: '结束后台命令',
      workspace: '切换工作目录',
      websearch: '联网搜索',
      mcp: 'MCP 服务器',
      context: '上下文用了多少',
      memory: '记忆',
      remote: '手机 / 远程访问',
      index: '管理代码索引',
      tokenStats: 'Token 用量统计 (请求/缓存/费用估算)',
      costStats: '显示费用统计',
      sessionStatus: '当前会话: 目录、模型、账号、模式',
      pricingConfig: '模型定价配置 (供费用估算)',
      configClear: '清除缓存配置',
      configReset: '重置所有配置',
      notify: '完成提醒 (声音 / 通知)',
      skills: '技能',
      language: '界面语言',
      tts: '语音合成设置',
      experimental: '实验特性开关',
      update: '检查更新',
      init: '读一遍项目, 生成项目记忆 (.neox/project.md)',
      attach: '给下一条消息附文件、图片或网址',
      attachments: '管理待发送附件 (list/clear/remove)',
    },
  },

  skillsMenu: {
    title: '技能列表',
    hint: '选择技能执行 · ESC 返回',
    viewAll: '○ 查看所有技能',
    viewAllDesc: '已加载 {count} 个技能',
    import: '○ 导入技能',
    importDesc: '从 URL 或本地路径导入',
    create: '○ 创建新技能',
    createDesc: '创建自定义技能',
    refresh: '○ 刷新技能列表',
    refreshDesc: '重新加载所有技能',
    noSkills: '暂无可用技能\n创建技能: ~/.neox/skills/<name>/SKILL.md\n或: .neox/skills/<name>/SKILL.md',
    selectToExecute: '选择技能执行',
    builtIn: '── 内置 ──',
    user: '── 用户 (~/.neox/skills) ──',
    workspace: '── 工作区 (.neox/skills) ──',
    importMethod: '导入方式',
    fromUrl: '○ 从 URL 导入',
    fromUrlDesc: 'GitHub raw URL 或其他 SKILL.md 链接',
    fromPath: '○ 从本地路径导入',
    fromPathDesc: '本地 SKILL.md 文件或目录',
    saveLocation: '保存位置',
    userGlobal: '○ 用户目录 (全局)',
    workspaceLocal: '○ 工作区 (当前项目)',
    enterUrl: '请输入 SKILL.md 的 URL:',
    enterPath: '请输入 SKILL.md 的本地路径:',
    importing: '正在导入技能...',
    importSuccess: '✓ 技能导入成功: {id}',
    importFailed: '✗ 导入失败: {error}',
    createNew: '创建新技能',
    enterId: '请输入技能 ID (小写字母、数字、连字符):',
    enterName: '请输入技能名称:',
    enterDescription: '请输入技能描述:',
    creating: '正在创建技能...',
    createSuccess: '✓ 技能创建成功!\n  路径: {path}\n  编辑 SKILL.md 文件自定义技能行为',
    createFailed: '✗ 创建失败: {error}',
    refreshing: '正在刷新技能列表...',
    refreshSuccess: '✓ 已刷新，共 {count} 个技能',
    idFormatError: '✗ ID 格式错误: 必须以小写字母开头，只能包含小写字母、数字和连字符',
    skillExists: '✗ 技能 \'{id}\' 已存在',
    categoryGit: 'Git 相关操作',
    categoryCode: '代码相关操作',
    categoryDocs: '文档相关操作',
    categoryTest: '测试相关操作',
    categoryCustom: '自定义分类',
    selectCategory: '选择技能分类',
  },

  languageMenu: {
    title: '语言设置',
    hint: '选择界面语言',
    current: '当前语言',
    chinese: '中文',
    chineseDesc: '使用中文界面',
    english: 'English',
    englishDesc: 'Use English interface',
    changed: '语言已切换为: {lang}',
  },

  onboarding: {
    welcome: '欢迎使用 Neox CLI!',
    welcomeDesc: '让我们进行一些基本设置',
    selectLanguage: '请选择您的首选语言',
    selectLanguageDesc: '您可以稍后在设置中更改',
    setupComplete: '设置完成!',
    setupCompleteDesc: '现在您可以开始使用 Neox 了',
    continue: '继续',
    skip: '跳过',
  },

  status: {
    thinking: '思考中',
    running: '运行中',
    idle: '空闲',
    streaming: '输出中',
    toolCall: '工具调用',
    waiting: '等待中',
    ready: '就绪',
    complete: '完成',
    failed: '失败',
  },

  ui: {
    // 通用
    tasks: '任务',
    plan: '计划',
    progress: '进度',
    executionPlan: '执行计划',
    percentComplete: '完成',
    // Network 模式
    criticalPath: '关键路径',
    normalNode: '普通节点',
    dependency: '依赖关系',
    failed: '失败',
    // DAG
    dagLegend: '★ 关键路径  ○ 普通节点  ← 依赖关系',
    dagTaskPlanning: 'DAG 任务规划',
    nodes: '节点',
    levels: '层级',
    maxParallel: '最大并行',
    estimated: '预估',
    // Pipeline
    pipelineProgress: '执行进度',
    taskCount: '{count} 任务',
    taskAnalysis: '任务分析',
    intent: '意图',
    domain: '领域',
    complexity: '复杂度',
    scope: '范围',
    techDepth: '技术深度',
    dependencyLevel: '依赖度',
    ambiguity: '模糊度',
    routing: '路由',
    needsCCB: '需要 CCB 评审',
    // Node 卡片
    reason: '原因',
    output: '输出',
    errorLabel: '错误',
    // CCB 评审
    riskSummary: '风险汇总',
    suggestions: '建议',
    recommendedSolution: '推荐方案',
    confirmReview: '请确认是否接受此评审结果',
    confirmToContinue: '确认继续',
    reReview: '重新评审',
    editRequirements: '编辑需求',
    retriedTimes: '已重试 {count} 次，该模型暂时下线',
    risks: '风险',
    // Token 统计
    tokenIn: 'in',
    tokenOut: 'out',
    tokenCache: 'cache',
    context: '上下文',
    // 状态
    analyzing: '分析中',
    planning: '规划中',
    executing: '执行中',
    reviewing: '审核中',
    // 中断输入框
    interruptMessage: '插队消息',
    willSendNextRequest: '将在下次请求时发送',
    enterYourMessage: '输入你的消息',
    typeMessage: '输入消息...',
    enterToConfirm: '确认',
    // Provider 配置
    startingProviderSetup: '正在启动 Provider 配置流程...',
    completeSetupInPopup: '请在弹出的交互式界面中完成配置',
    noProviderDetected: '检测到您还没有配置 AI Provider',
    needConfigProvider: '为了使用 Neox CLI，您需要先配置一个 Provider',
    detectedCredentials: '检测到环境变量中的凭证',
    supportedProviders: '支持: OpenAI, Anthropic, Gemini, Doubao, Codex',
    selectAction: '请选择操作',
    // 输入行
    scrollHint: '滚动',
    moreAbove: '更多...',
    moreBelow: '更多...',
    shiftEnterNewline: 'Shift+Enter 换行',
    enterToSend: '发送',
    lineCount: '{count} 行',
    backgroundAgentsRunning: '● {count} 个后台 agent',
    running: '运行中',
    tabToView: '(tab 查看)',
    // 交互式 Provider 设置
    selectProtocol: '选择协议类型',
    selectDefaultModel: '选择默认模型',
    modelsAvailable: '共 {count} 个可用模型',
    moreModels: '还有 {count} 个模型',
    configConfirm: '配置确认',
    name: '名称',
    protocol: '协议',
    model: '模型',
    pressEnterToConfirm: '按 Enter 确认创建，ESC 取消',
    providerSetupWizard: 'Provider 配置向导',
    // Header 欢迎页
    tipsForGettingStarted: '快速入门提示',
    welcomeEnjoy: '欢迎使用！',
    typeMessageToStart: '输入消息开始对话',
    helpOrQuestionMark: '/help 或 ? 查看命令',
    pressQuestionForShortcuts: '按 ? 查看所有快捷键',
    whatIsNeox: '什么是 Neox？',
    intelligentCodingAssistant: '您的智能编程助手',
    multiAgentAssistantoration: '多 Agent 协作支持',
    smartContextManagement: '智能上下文管理',
    provider: '服务商',
    path: '路径',
  },

  notify: {
    completionAlerts: '完成提醒',
    soundOn: '开启',
    soundOff: '关闭',
    soundLabel: '声音: {status}',
    soundDesc: '任务完成时播放提示音',
    soundFileLabel: '声音文件: {file}',
    soundFileDesc: '声音文件夹: {dir}',
    notificationLabel: '系统通知: {status}',
    notificationDesc: '任务完成时发送系统通知',
    enableSound: '启用完成提示音',
    on: '开启',
    off: '关闭',
    soundUpdated: '完成提示音已更新',
    enabled: '已启用',
    disabled: '已禁用',
    enableNotification: '启用系统通知',
    notificationUpdated: '系统通知已更新',
    noSoundFiles: '未找到声音文件',
    placeSoundFiles: '请将音频文件放入: {dir}',
    selectSound: '选择提示音',
    selectHint: '↑↓ 选择, Enter 确认, ESC 取消',
    current: '当前',
    soundFileUpdated: '声音文件已更新',
    invalidAction: '无效操作',
    useNotifyToView: '使用 /notify 查看可用选项',
    // macOS 系统声音
    systemSounds: '── 系统声音 ──',
    customSounds: '── 自定义声音 ──',
    systemSoundPrefix: '[系统]',
    taskComplete: '任务完成',
  },

  pricing: {
    title: '模型定价配置',
    hint: '配置模型价格用于费用计算',
    viewPricing: '○ 查看定价配置',
    viewPricingDesc: '查看已配置的模型定价',
    addPricing: '○ 添加定价',
    addPricingDesc: '为模型添加定价配置',
    editPricing: '○ 编辑定价',
    editPricingDesc: '修改已有的定价配置',
    deletePricing: '○ 删除定价',
    deletePricingDesc: '删除定价配置',
    noPricing: '暂无定价配置',
    noPricingHint: '使用 /cost 添加模型定价',
    modelPattern: '模型名称或模式',
    modelPatternHint: '支持通配符，如 gpt-4*, claude-3*',
    inputPrice: '输入价格 ($/1M tokens)',
    inputPriceHint: '每百万输入 tokens 的价格',
    outputPrice: '输出价格 ($/1M tokens)',
    outputPriceHint: '每百万输出 tokens 的价格',
    cachedPrice: '缓存价格 ($/1M tokens)',
    cachedPriceHint: '缓存命中的价格 (可选，留空跳过)',
    currency: '货币',
    pricingAdded: '定价配置已添加',
    pricingUpdated: '定价配置已更新',
    pricingDeleted: '定价配置已删除',
    selectToEdit: '选择要编辑的定价',
    selectToDelete: '选择要删除的定价',
    confirmDelete: '确认删除此定价配置?',
    perMillionTokens: '$/M',
    invalidNumber: '请输入有效的数字',
    back: '← 返回',
  },

  providerGuide: {
    welcome: '欢迎使用 Neox CLI',
    noProviderDetected: '检测到您还没有配置 AI Provider',
    needConfig: '为了使用 Neox CLI，您需要先配置一个 AI Provider（如 OpenAI、Claude 等）',
    quickStart: '快速开始：',
    quickStartUseServices: '您可以使用 OpenAI、Anthropic Claude、Gemini 等服务',
    quickStartApiKey: '需要准备 API Key（从对应服务商获取）',
    quickStartProxy: '可以使用代理地址（如果您使用第三方代理）',
    supportedProviders: '支持的 Provider：',
  },

  setup: {
    headerTitle: '设置',
    headerCurrent: '当前: {provider} · {model}',
    notConfigured: '未设置',
    enabled: '已开',
    disabled: '已关',
    selectItem: '选择要配置的项目',
    accountLabel: '账号 — 已登录',
    accountLabelOut: '账号 — 未登录',
    accountDesc: 'Neox Cloud 套餐和用量',
    providerLabel: '自带 Key — {count} 个',
    providerLabelEmpty: '自带 Key — 没有',
    providerDesc: '用自己的 API Key, 不走订阅',
    modelLabel: '模型 — {model}',
    modelDesc: '切换模型',
    webSearchLabel: '联网搜索 — {status}',
    webSearchDesc: '让模型能搜网页',
    mcpLabel: 'MCP 服务器 — {count} 个',
    mcpLabelEmpty: 'MCP 服务器 — 没有',
    mcpDesc: '接外部服务提供的工具',
    languageLabel: '语言 — {lang}',
    languageDesc: '界面语言',
    advancedLabel: '更多',
    advancedDesc: '语音、远程访问、完成提醒、实验功能',
    advancedTitle: '更多设置',
    ttsLabel: '语音朗读 — {status}',
    ttsDesc: '把回答读出来',
    remoteLabel: '远程访问 — {status}',
    remoteDesc: '用手机或另一台电脑连过来',
    experimentalLabel: '实验功能',
    experimentalDesc: '还没做完的功能',
    notifyLabel: '完成提醒',
    notifyDesc: '声音和系统通知',
    cancelled: '已取消',
    errorTitle: '配置出错',
  },

  providerCmd: {
    addTitle: '添加新的 Provider',
    addSubtitle: '请按步骤完成配置',
    step1: 'Step 1/4',
    step1Hint: 'Provider 名称和地址',
    step2: 'Step 2/4',
    step3: 'Step 3/4',
    step4: 'Step 4/4',
    displayName: 'Provider 显示名称',
    displayNameHint: '例如: OpenAI, Claude API, 私有代理',
    protocolFormat: '协议格式',
    baseUrlHint: '直接回车使用默认值，或输入自定义代理地址',
    selectModelCategory: '选择模型分类',
    categoryRecommended: '> 推荐 — 当前协议推荐',
    categoryAll: '- 全部 — {count} 个模型',
    categoryCustom: '+ 自定义输入',
    enterModelName: '输入模型名称',
    selectDefaultModel: '选择默认模型',
    noRegistryModels: '该分类暂无注册模型，请手动输入模型名称',
    customModelName: '> 自定义模型名称',
    addMoreModels: '是否添加更多模型?',
    enterMoreModels: '输入更多模型名称',
    enterMoreModelsHint: '多个模型用逗号分隔，例如: glm-5,MiniMax-M2.5',
    apiKey: 'API Key',
    apiKeyHint: '输入你的 API 密钥或 Token',
    confirmConfig: '确认配置',
    configPreview: '配置预览',
    summaryName: '名称',
    summaryProtocol: '协议',
    summaryBaseUrl: '地址',
    summaryApiKey: 'API Key',
    summaryModels: '模型',
    summaryDefault: '默认',
    setAsDefault: '设为默认 Provider?',
    createdTitle: '✓ Provider 创建成功',
    cancelledTitle: '已取消',
    cancelledDetail: 'Provider 设置已取消',
    createFailed: '创建失败',
    protoOpenAIChat: 'OpenAI (Chat Completions) — 最通用, 多数厂商兼容',
    protoOpenAIResponses: 'OpenAI (Responses API) — OpenAI 新接口',
    protoKimi: 'Kimi (Moonshot) — OpenAI 兼容',
    protoAnthropic: 'Anthropic (Claude) — 原生格式',
    protoAnthropicOpenAI: 'Anthropic (OpenAI 格式) — 代理常用',
    protoDoubao: '豆包 (Doubao) — 火山方舟',
    protoGemini: 'Google Gemini — 原生格式',
    protoGlm: 'GLM (智谱 AI) — OpenAI 兼容',
    protoGlmClaude: 'GLM (Claude 协议) — Anthropic 原生',
    protoKimiClaude: 'Kimi (Claude 协议) — kimi-k2.5, kimi-k2',
    protoOpenAIChatEdit: 'OpenAI (Chat Completions) — 最通用, 多数厂商兼容',
    protoOpenAIResponsesEdit: 'OpenAI (Responses API) — OpenAI 新接口',
    protoAnthropicOpenAIEdit: 'Anthropic (OpenAI 格式) — OpenAI 兼容',
    editIdHint: '仅限小写字母、数字和连字符（-），最长 48 个字符',
    editApiKeyHint: '输入新的 API 密钥（留空保留当前）',
  },

  modeCmd: {
    runSettingsTitle: '运行设置',
    reasoningEffortTitle: '推理强度',
    concurrencyTitle: '并发档位',
    agentLabel: 'Agent — 干活',
    agentDesc: '自己读写文件、跑命令, 适合写代码',
    askLabel: 'Ask — 只聊',
    askDesc: '只回答问题, 尽量不动工具',
    concurrencyEntry: '并发',
    concurrencyEntryDesc: 'auto 多模型并行更快; 额度紧就选 low',
    runArchEntry: '运行架构',
    runArchEntryDesc: '多 Agent 协作, 或助理 + 调度 (进阶)',
    archConfigEntry: '架构配置',
    archConfigEntryDesc: '助理架构的 Agent 池 (进阶)',
    concurrencyAuto: 'auto — 并行 (默认)',
    concurrencyAutoDesc: '主模型 + 同家快模型的子 agent 一起跑',
    concurrencyLow: 'low — 单模型',
    concurrencyLowDesc: '一个模型干完, 并发降到 1; 适合限流、想稳',
    effortMinimal: 'minimal — 几乎不想',
    effortMinimalDesc: '最快',
    effortLow: 'low — 浅想',
    effortLowDesc: '快, 简单问题',
    effortMedium: 'medium — 中等',
    effortMediumDesc: '平衡',
    effortHigh: 'high — 深想',
    effortHighDesc: '复杂任务推荐',
    effortXhigh: 'xhigh — 很深',
    effortXhighDesc: '难题 (慢)',
    effortMax: 'max — 最深',
    effortMaxDesc: '最难的任务 (部分模型支持)',
    effortUltra: 'ultra — 自动委派',
    effortUltraDesc: '拆任务交给子 agent (部分模型支持)',
    noProviderBound: '当前会话没绑定 provider/model, 先选一个 (/model)',
    alreadySet: '当前已是 {v}',
  },

  modelCmd: {
    subscriptionTitle: '模型 · {plan}{count}{stale}',
    noModels: '',
    modelsCount: '',
    cacheStale: '',
    noSubscription: '没有订阅',
    selectBYOK: '选择 BYOK 模型 · {models} 个模型 / {providers} 个 provider',
    noBYOKModels: '未配置 BYOK 模型',
    noBYOKModelsHint: '用 /provider add 添加 provider，再用 /model add 添加 model。',
    customBYOK: '用自己的 Key…',
    noSubModels: '当前套餐没有可用模型 · /upgrade 升级',
    sessionExpired: '登录已过期',
    sessionExpiredAction: '重新登录',
    membershipNetworkFail: '网络不通, 模型列表没能加载',
    membershipServerFail: '服务暂时不可用, 不是你的网络问题, 稍后再试',
    refreshMembership: '重试',
    notSubscribed: '没有订阅',
    notSubscribedHint: '/upgrade 升级, 或选"用自己的 Key"',
    membershipRefreshed: '已刷新',
    membershipRefreshedHint: '再打开 /model 看最新列表',
    refreshFailed: '刷新失败',
    cloudNotInjected: '订阅模型还没准备好',
    cloudNotInjectedHint: '重新 /login 一次',
    switchedToSub: '已切到订阅模型',
    onDemand: '按量',
    imageModelsHint: '── 下面是出图模型, 不能当对话模型 ──',
    clearContextPrompt: '检测到当前会话已有上下文。切换到 {model} 后是否清空历史上下文？',
    contextCleared: '会话上下文已清空',
    contextClearedDetail: '已清空当前会话历史。',
    contextKept: '会话上下文已保留',
    contextKeptDetail: '已保留当前会话历史。',
    switchCancelled: '已取消模型切换',
    switchCancelledDetail: '已取消模型切换。',
    ptcAutoDisabled: 'GPT 模型不支持 PTC，已自动关闭（重启生效）',
  },

  sessionCmd: {
    checkpointEnabled: 'Checkpoint 已启用',
    checkpointEnabledDetail: '已启用文件快照（重启生效）',
    checkpointDisabled: 'Checkpoint 已禁用',
    checkpointDisabledDetail: '已禁用文件快照（重启生效）',
    checkpointDisabledShort: 'Checkpoint 已禁用',
    checkpointEnableFirst: '请先执行 /checkpoint enable 开启',
    checkpointEnableFirstShort: '请先开启 Checkpoint',
    checkpointMenuTitle: 'Checkpoint · 占用 {size}（{detail}）',
    checkpointMenuRepo: 'repo {repo}, legacy {legacy}, {count} 个 checkpoint',
    checkpointToggleOn: '✓ ON  Checkpoint — 已启用',
    checkpointToggleOff: '○ OFF  Checkpoint — 已关闭',
    checkpointCreate: '+ 创建 checkpoint',
    checkpointListRollback: '列出 / 回滚',
    checkpointCleanup: 'x 清理',
    cleanupDone: '清理完成',
    cleanupDoneDetail: 'Checkpoint 私有仓库与 legacy .cdundo 已清理',
    clearConfirmTitle: '清空当前会话内容? 此操作不可恢复',
    clearConfirmCancel: '取消',
    clearConfirmConfirm: '确认清空',
    clearCancelled: '已取消',
    compactSessionDisabled: '会话已禁用',
    compactSessionDisabledDetail: '压缩仅适用于启用了持久化的会话。',
    compactNoProfile: '缺少模型上下文画像',
    compactNoProfileDetail: '请检查 Provider/Model 配置。',
    compactRunning: '正在执行任务',
    compactRunningDetail: '请等待当前任务完成或按 ESC 两次中断后再压缩。',
    compactInProgress: '压缩进行中',
    compactInProgressDetail: '请稍候片刻。',
    compactUnavailable: '压缩不可用',
    compactUnavailableDetail: '未连接到服务端或无活跃会话。',
    compactNothing: '无内容需要压缩',
    compactNothingDetail: '当前对话为空，没有可压缩的内容。',
    compactManual: '[~] 手动压缩中...',
    compactComplete: '压缩完成！',
    compactFailedStatus: '压缩失败',
    compactFailed: '手动压缩失败',
    compactFailedCard: '✗ 压缩失败',
  },
};

// ============================================================================
// 英文翻译
// ============================================================================

const en: CLITranslations = {
  common: {
    yes: 'Yes',
    no: 'No',
    cancel: 'Cancel',
    confirm: 'Confirm',
    back: 'Back',
    exit: 'Exit',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    warning: 'Warning',
    info: 'Info',
    select: 'Select',
    selectHint: '↑↓ select · Enter confirm · Esc cancel',
    escToCancel: 'ESC to cancel',
    escToBack: 'ESC to go back',
    noItemsFound: 'No items found',
    current: 'Current',
  },

  slashMenu: {
    title: 'Command Menu',
    hint: 'Type to filter · ESC to close',
    commandCount: '{count} commands',
    categories: {
      basic: 'Basic',
      account: 'Account',
      mode: 'Mode',
      ai: 'AI',
      session: 'Session',
      process: 'Process',
      tools: 'Tools',
      stats: 'Stats',
      config: 'Config',
      skills: 'Skills',
    },
    commands: {
      help: 'Show help',
      clear: 'Clear conversation context',
      exit: 'Exit',
      setup: 'Setup: provider, model, web search',
      login: 'Sign in to Neox Cloud',
      logout: 'Sign out',
      whoami: 'Current account',
      usage: 'Usage and limits',
      device: 'Signed-in devices',
      upgrade: 'Upgrade plan (opens browser)',
      speed: 'Speed mode (turbo/normal/deep)',
      effort: 'Reasoning effort (minimal~ultra)',
      style: 'Output style (concise/standard/detailed/code_only)',
      theme: 'Color theme',
      modelProfile: 'View model profile / configure toolset',
      mode: 'Mode: Agent does the work / Ask just chats',
      run: 'Run architecture (agentic: multi-agent / assistant: orchestrated)',
      runconfig: 'Run architecture config (Main/Worker/concurrency)',
      thinking: 'Extended thinking on / off',
      approval: 'Whether tools ask before running',
      sandbox: 'Sandbox: limit what commands can modify',
      provider: 'Providers and API keys',
      model: 'Switch model',
      sessions: 'List all sessions',
      session: 'Session: new, export, clear',
      sessionNew: 'Create new session',
      sessionInfo: 'Show session info',
      undo: 'Undo recent turns',
      checkpoint: 'Checkpoint settings',
      checkpoints: 'List checkpoints',
      rollback: 'Roll file changes back to a checkpoint',
      sessionClear: 'Clear current session',
      sessionExport: 'Export session',
      compact: 'Compact the conversation to free context',
      cleanup: 'Disk usage manager',
      ps: 'Background commands',
      kill: 'Stop a background command',
      workspace: 'Switch workspace',
      websearch: 'Web search',
      mcp: 'MCP servers',
      context: 'How much context is used',
      memory: 'Memory',
      remote: 'Phone / remote access',
      index: 'Manage code index',
      tokenStats: 'Token usage stats (requests/cache/cost estimate)',
      costStats: 'Show cost stats',
      sessionStatus: 'This session: directory, model, account, mode',
      pricingConfig: 'Model pricing config (for cost estimate)',
      configClear: 'Clear cached config',
      configReset: 'Reset all config',
      notify: 'Completion alerts (sound / notification)',
      skills: 'Skills',
      language: 'Interface language',
      tts: 'TTS voice output settings',
      experimental: 'Experimental features toggle',
      update: 'Check for updates',
      init: 'Read the project and write its memory (.neox/project.md)',
      attach: 'Attach a file, image or URL to the next message',
      attachments: 'Manage pending attachments (list/clear/remove)',
    },
  },

  skillsMenu: {
    title: 'Skills List',
    hint: 'Select skill to execute · ESC to go back',
    viewAll: '○ View All Skills',
    viewAllDesc: '{count} skills loaded',
    import: '○ Import Skill',
    importDesc: 'Import from URL or local path',
    create: '○ Create New Skill',
    createDesc: 'Create a custom skill',
    refresh: '○ Refresh Skills',
    refreshDesc: 'Reload all skills',
    noSkills: 'No skills available\nCreate skill: ~/.neox/skills/<name>/SKILL.md\nOr: .neox/skills/<name>/SKILL.md',
    selectToExecute: 'Select skill to execute',
    builtIn: '── Built-in ──',
    user: '── User (~/.neox/skills) ──',
    workspace: '── Workspace (.neox/skills) ──',
    importMethod: 'Import Method',
    fromUrl: '○ Import from URL',
    fromUrlDesc: 'GitHub raw URL or SKILL.md link',
    fromPath: '○ Import from Local Path',
    fromPathDesc: 'Local SKILL.md file or directory',
    saveLocation: 'Save Location',
    userGlobal: '○ User Directory (Global)',
    workspaceLocal: '○ Workspace (Current Project)',
    enterUrl: 'Enter SKILL.md URL:',
    enterPath: 'Enter local path to SKILL.md:',
    importing: 'Importing skill...',
    importSuccess: '✓ Skill imported: {id}',
    importFailed: '✗ Import failed: {error}',
    createNew: 'Create New Skill',
    enterId: 'Enter skill ID (lowercase letters, numbers, hyphens):',
    enterName: 'Enter skill name:',
    enterDescription: 'Enter skill description:',
    creating: 'Creating skill...',
    createSuccess: '✓ Skill created!\n  Path: {path}\n  Edit SKILL.md to customize behavior',
    createFailed: '✗ Creation failed: {error}',
    refreshing: 'Refreshing skills...',
    refreshSuccess: '✓ Refreshed, {count} skills loaded',
    idFormatError: '✗ ID format error: Must start with lowercase letter, only contain lowercase letters, numbers, and hyphens',
    skillExists: '✗ Skill \'{id}\' already exists',
    categoryGit: 'Git operations',
    categoryCode: 'Code operations',
    categoryDocs: 'Documentation operations',
    categoryTest: 'Test operations',
    categoryCustom: 'Custom category',
    selectCategory: 'Select skill category',
  },

  languageMenu: {
    title: 'Language Settings',
    hint: 'Select interface language',
    current: 'Current language',
    chinese: '中文',
    chineseDesc: '使用中文界面',
    english: 'English',
    englishDesc: 'Use English interface',
    changed: 'Language changed to: {lang}',
  },

  onboarding: {
    welcome: 'Welcome to Neox CLI!',
    welcomeDesc: "Let's do some basic setup",
    selectLanguage: 'Please select your preferred language',
    selectLanguageDesc: 'You can change this later in settings',
    setupComplete: 'Setup Complete!',
    setupCompleteDesc: 'You can now start using Neox',
    continue: 'Continue',
    skip: 'Skip',
  },

  status: {
    thinking: 'Thinking',
    running: 'Running',
    idle: 'Idle',
    streaming: 'Streaming',
    toolCall: 'Tool Call',
    waiting: 'Waiting',
    ready: 'Ready',
    complete: 'Complete',
    failed: 'Failed',
  },

  ui: {
    // 通用
    tasks: 'tasks',
    plan: 'Plan',
    progress: 'Progress',
    executionPlan: 'Execution Plan',
    percentComplete: 'complete',
    // Network 模式
    criticalPath: 'Critical Path',
    normalNode: 'Normal Node',
    dependency: 'Dependency',
    failed: 'failed',
    // DAG
    dagLegend: '★ Critical  ○ Normal  ← Dependency',
    dagTaskPlanning: 'DAG Task Planning',
    nodes: 'Nodes',
    levels: 'Levels',
    maxParallel: 'Max Parallel',
    estimated: 'Estimated',
    // Pipeline
    pipelineProgress: 'Execution Progress',
    taskCount: '{count} tasks',
    taskAnalysis: 'Task Analysis',
    intent: 'Intent',
    domain: 'Domain',
    complexity: 'Complexity',
    scope: 'Scope',
    techDepth: 'Tech Depth',
    dependencyLevel: 'Dependency',
    ambiguity: 'Ambiguity',
    routing: 'Routing',
    needsCCB: 'Needs CCB Review',
    // Node 卡片
    reason: 'Reason',
    output: 'Output',
    errorLabel: 'Error',
    // CCB 评审
    riskSummary: 'Risk Summary',
    suggestions: 'Suggestions',
    recommendedSolution: 'Recommended Solution',
    confirmReview: 'Please confirm to accept this review result',
    confirmToContinue: 'confirm to continue',
    reReview: 're-review',
    editRequirements: 'edit requirements',
    retriedTimes: 'Retried {count} times, model temporarily offline',
    risks: 'Risks',
    // Token 统计
    tokenIn: 'in',
    tokenOut: 'out',
    tokenCache: 'cache',
    context: 'context',
    // 状态
    analyzing: 'Analyzing',
    planning: 'Planning',
    executing: 'Executing',
    reviewing: 'Reviewing',
    // 中断输入框
    interruptMessage: 'Interrupt Message',
    willSendNextRequest: 'Will be sent on next request',
    enterYourMessage: 'Enter your message',
    typeMessage: 'Type a message...',
    enterToConfirm: 'Confirm',
    // Provider 配置
    startingProviderSetup: 'Starting Provider setup...',
    completeSetupInPopup: 'Please complete setup in the popup interface',
    noProviderDetected: 'No AI Provider configured',
    needConfigProvider: 'To use Neox CLI, you need to configure a Provider first',
    detectedCredentials: 'Detected credentials in environment variables',
    supportedProviders: 'Supports: OpenAI, Anthropic, Gemini, Doubao, Codex',
    selectAction: 'Select an action',
    // 输入行
    scrollHint: 'scroll',
    moreAbove: 'more...',
    moreBelow: 'more...',
    shiftEnterNewline: 'Shift+Enter for newline',
    enterToSend: 'Send',
    lineCount: '{count} lines',
    backgroundAgentsRunning: '● {count} background agent{plural}',
    running: 'running',
    tabToView: '(tab to view)',
    // 交互式 Provider 设置
    selectProtocol: 'Select Protocol Type',
    selectDefaultModel: 'Select Default Model',
    modelsAvailable: '{count} models available',
    moreModels: '{count} more models',
    configConfirm: 'Configuration Confirm',
    name: 'Name',
    protocol: 'Protocol',
    model: 'Model',
    pressEnterToConfirm: 'Press Enter to confirm, ESC to cancel',
    providerSetupWizard: 'Provider Setup Wizard',
    // Header 欢迎页
    tipsForGettingStarted: 'Tips for getting started',
    welcomeEnjoy: 'Welcome! Enjoy!',
    typeMessageToStart: 'Type your message to start',
    helpOrQuestionMark: '/help or ? for commands',
    pressQuestionForShortcuts: 'Press ? to see all shortcuts',
    whatIsNeox: 'What is Neox?',
    intelligentCodingAssistant: 'Your intelligent coding assistant',
    multiAgentAssistantoration: 'Multi-agent assistantoration support',
    smartContextManagement: 'Smart context management',
    provider: 'Provider',
    path: 'Path',
  },

  notify: {
    completionAlerts: 'Completion Alerts',
    soundOn: 'On',
    soundOff: 'Off',
    soundLabel: 'Sound: {status}',
    soundDesc: 'Play a sound when a task completes',
    soundFileLabel: 'Sound file: {file}',
    soundFileDesc: 'Sound folder: {dir}',
    notificationLabel: 'Notification: {status}',
    notificationDesc: 'Send a system notification on completion',
    enableSound: 'Enable completion sound',
    on: 'On',
    off: 'Off',
    soundUpdated: 'Completion sound updated',
    enabled: 'Enabled',
    disabled: 'Disabled',
    enableNotification: 'Enable completion notifications',
    notificationUpdated: 'Completion notifications updated',
    noSoundFiles: 'No sound files found',
    placeSoundFiles: 'Place audio files in: {dir}',
    selectSound: 'Select completion sound',
    selectHint: 'Up/Down to select, Enter to confirm, ESC to cancel',
    current: 'Current',
    soundFileUpdated: 'Sound file updated',
    invalidAction: 'Invalid action',
    useNotifyToView: 'Use /notify to view available options',
    // macOS system sounds
    systemSounds: '── System Sounds ──',
    customSounds: '── Custom Sounds ──',
    systemSoundPrefix: '[System]',
    taskComplete: 'Task complete',
  },

  pricing: {
    title: 'Model Pricing Configuration',
    hint: 'Configure model prices for cost calculation',
    viewPricing: '○ View Pricing',
    viewPricingDesc: 'View configured model pricing',
    addPricing: '○ Add Pricing',
    addPricingDesc: 'Add pricing for a model',
    editPricing: '○ Edit Pricing',
    editPricingDesc: 'Edit existing pricing',
    deletePricing: '○ Delete Pricing',
    deletePricingDesc: 'Delete pricing configuration',
    noPricing: 'No pricing configured',
    noPricingHint: 'Use /cost to add model pricing',
    modelPattern: 'Model name or pattern',
    modelPatternHint: 'Supports wildcards, e.g. gpt-4*, claude-3*',
    inputPrice: 'Input price ($/1M tokens)',
    inputPriceHint: 'Price per million input tokens',
    outputPrice: 'Output price ($/1M tokens)',
    outputPriceHint: 'Price per million output tokens',
    cachedPrice: 'Cached price ($/1M tokens)',
    cachedPriceHint: 'Price for cached tokens (optional, leave empty to skip)',
    currency: 'Currency',
    pricingAdded: 'Pricing configuration added',
    pricingUpdated: 'Pricing configuration updated',
    pricingDeleted: 'Pricing configuration deleted',
    selectToEdit: 'Select pricing to edit',
    selectToDelete: 'Select pricing to delete',
    confirmDelete: 'Confirm delete this pricing?',
    perMillionTokens: '$/M',
    invalidNumber: 'Please enter a valid number',
    back: '← Back',
  },

  providerGuide: {
    welcome: 'Welcome to Neox CLI',
    noProviderDetected: 'No AI provider configured yet',
    needConfig: 'To use Neox CLI, configure an AI provider first (e.g. OpenAI, Claude)',
    quickStart: 'Quick start:',
    quickStartUseServices: 'Use OpenAI, Anthropic Claude, Gemini, and more',
    quickStartApiKey: 'Have an API key ready (from your provider)',
    quickStartProxy: 'A proxy URL is supported (if you use a third-party proxy)',
    supportedProviders: 'Supported providers:',
  },

  setup: {
    headerTitle: 'Setup',
    headerCurrent: 'Current: {provider} · {model}',
    notConfigured: 'not set',
    enabled: 'on',
    disabled: 'off',
    selectItem: 'Select what to configure',
    accountLabel: 'Account — signed in',
    accountLabelOut: 'Account — signed out',
    accountDesc: 'Plan and usage for Neox Cloud',
    providerLabel: 'Your own keys — {count}',
    providerLabelEmpty: 'Your own keys — none',
    providerDesc: 'Bring your own API key; bypasses the subscription',
    modelLabel: 'Model — {model}',
    modelDesc: 'Switch model',
    webSearchLabel: 'Web search — {status}',
    webSearchDesc: 'Let the model search the web',
    mcpLabel: 'MCP servers — {count}',
    mcpLabelEmpty: 'MCP servers — none',
    mcpDesc: 'Extra tools from external servers',
    languageLabel: 'Language — {lang}',
    languageDesc: 'Interface language',
    advancedLabel: 'More',
    advancedDesc: 'Voice, remote access, alerts, experiments',
    advancedTitle: 'More settings',
    ttsLabel: 'Voice — {status}',
    ttsDesc: 'Read replies aloud',
    remoteLabel: 'Remote access — {status}',
    remoteDesc: 'Use from your phone or another machine',
    experimentalLabel: 'Experiments',
    experimentalDesc: 'Unfinished features',
    notifyLabel: 'Completion alerts',
    notifyDesc: 'Sound and system notification',
    cancelled: 'Cancelled',
    errorTitle: 'Setup Error',
  },

  providerCmd: {
    addTitle: 'Add New Provider',
    addSubtitle: 'Follow the steps to complete setup',
    step1: 'Step 1/4',
    step1Hint: 'Provider name and URL',
    step2: 'Step 2/4',
    step3: 'Step 3/4',
    step4: 'Step 4/4',
    displayName: 'Provider display name',
    displayNameHint: 'e.g. OpenAI, Claude API, Private Proxy',
    protocolFormat: 'Protocol format',
    baseUrlHint: 'Press Enter for the default, or enter a custom proxy URL',
    selectModelCategory: 'Select model category',
    categoryRecommended: '> Recommended — for current protocol',
    categoryAll: '- All — {count} models',
    categoryCustom: '+ Custom input',
    enterModelName: 'Enter model name',
    selectDefaultModel: 'Select default model',
    noRegistryModels: 'No registered models in this category, please enter a model name manually',
    customModelName: '> Custom model name',
    addMoreModels: 'Add more models?',
    enterMoreModels: 'Enter more model names',
    enterMoreModelsHint: 'Separate with commas, e.g. glm-5,MiniMax-M2.5',
    apiKey: 'API Key',
    apiKeyHint: 'Enter your API key or token',
    confirmConfig: 'Confirm configuration',
    configPreview: 'Configuration preview',
    summaryName: 'Name',
    summaryProtocol: 'Protocol',
    summaryBaseUrl: 'URL',
    summaryApiKey: 'API Key',
    summaryModels: 'Models',
    summaryDefault: 'Default',
    setAsDefault: 'Set as default provider?',
    createdTitle: '✓ Provider created',
    cancelledTitle: 'Cancelled',
    cancelledDetail: 'Provider setup cancelled',
    createFailed: 'Creation failed',
    /* 型号枚举必然过期 —— 见中文块同名条目的说明, 改成描述协议本身。 */
    protoOpenAIChat: 'OpenAI (Chat Completions) — most widely compatible',
    protoOpenAIResponses: "OpenAI (Responses API) — OpenAI's newer endpoint",
    protoKimi: 'Kimi (Moonshot) — OpenAI-compatible',
    protoAnthropic: 'Anthropic (Claude) — native format',
    protoAnthropicOpenAI: 'Anthropic (OpenAI format) — common for proxies',
    protoDoubao: 'Doubao — Volcano Ark',
    protoGemini: 'Google Gemini — native format',
    protoGlm: 'GLM (Zhipu AI) — OpenAI-compatible',
    protoGlmClaude: 'GLM (Claude protocol) — Anthropic native',
    protoKimiClaude: 'Kimi (Claude protocol) — kimi-k2.5, kimi-k2',
    protoOpenAIChatEdit: 'OpenAI (Chat Completions) — most widely compatible',
    protoOpenAIResponsesEdit: "OpenAI (Responses API) — OpenAI's newer endpoint",
    protoAnthropicOpenAIEdit: 'Anthropic (OpenAI format) — OpenAI-compatible',
    editIdHint: 'Lowercase letters, numbers and hyphens (-) only, max 48 characters',
    editApiKeyHint: 'Enter a new API key (leave empty to keep current)',
  },

  modeCmd: {
    runSettingsTitle: 'Run settings',
    reasoningEffortTitle: 'Reasoning effort',
    concurrencyTitle: 'Concurrency',
    agentLabel: 'Agent — calls tools automatically',
    agentDesc: 'Agent uses tools on its own; best for coding tasks',
    askLabel: 'Ask — conversation only, few tools',
    askDesc: 'Answers questions and avoids tool calls where it can',
    concurrencyEntry: 'Concurrency',
    concurrencyEntryDesc: 'auto = parallel speedup / low = single model; pick low if your quota is tight',
    runArchEntry: 'Run architecture (agentic / assistant)',
    runArchEntryDesc: 'Multi-agent collaboration vs. assistant + Agent OS scheduling',
    archConfigEntry: 'Architecture config (Main / Worker / concurrency)',
    archConfigEntryDesc: 'Agent pool settings for the assistant architecture (advanced)',
    concurrencyAuto: 'auto — combined + medium concurrency (default)',
    concurrencyAutoDesc: 'Main model plus same-family fast sub-agents running in parallel',
    concurrencyLow: 'low — single model + low concurrency',
    concurrencyLowDesc: 'One model does it all, concurrency drops to 1; good under rate limits',
    effortMinimal: 'minimal — fastest, no reasoning',
    effortMinimalDesc: 'Fastest; skips chain-of-thought',
    effortLow: 'low — shallow reasoning',
    effortLowDesc: 'Fast; simple reasoning',
    effortMedium: 'medium — balanced',
    effortMediumDesc: 'Balanced (gpt-5 default)',
    effortHigh: 'high — deep reasoning',
    effortHighDesc: 'Recommended for complex tasks',
    effortXhigh: 'xhigh — very deep',
    effortXhighDesc: 'For hard problems (slow)',
    effortMax: 'max — maximum reasoning',
    effortMaxDesc: 'GPT-5.6 maximum reasoning depth (hardest tasks)',
    effortUltra: 'ultra — automatic task delegation',
    effortUltraDesc: 'GPT-5.6 Sol/Terra delegation mode',
    noProviderBound: 'This session has no provider/model bound — pick one first (/model)',
    alreadySet: 'Already set to {v}',
  },

  modelCmd: {
    subscriptionTitle: 'Model · {plan}{count}{stale}',
    noModels: '',
    modelsCount: '',
    cacheStale: '',
    noSubscription: 'No subscription',
    selectBYOK: 'Select BYOK model · {models} models / {providers} providers',
    noBYOKModels: 'No BYOK models configured',
    noBYOKModelsHint: 'Use /provider add to add a provider, then /model add to add a model.',
    customBYOK: 'Use your own key…',
    noSubModels: 'Your plan has no models · /upgrade',
    sessionExpired: 'Signed out — session expired',
    sessionExpiredAction: 'Sign in again',
    membershipNetworkFail: 'Network unreachable; could not load models',
    membershipServerFail: 'Service unavailable — not a problem on your end; try again shortly',
    refreshMembership: 'Retry',
    notSubscribed: 'Not subscribed',
    notSubscribedHint: '/upgrade, or pick "Use your own key"',
    membershipRefreshed: 'Refreshed',
    membershipRefreshedHint: 'Open /model again to see the latest list',
    refreshFailed: 'Refresh failed',
    cloudNotInjected: 'Subscription models are not ready',
    cloudNotInjectedHint: 'Run /login again',
    switchedToSub: 'Switched to subscription model',
    onDemand: 'pay-as-you-go',
    imageModelsHint: '── Image models below — not usable for chat ──',
    clearContextPrompt: 'Conversation context detected. Clear history after switching to {model}?',
    contextCleared: 'Conversation context cleared',
    contextClearedDetail: 'Current session history cleared.',
    contextKept: 'Conversation context kept',
    contextKeptDetail: 'Current session history kept.',
    switchCancelled: 'Model switch cancelled',
    switchCancelledDetail: 'Model switch cancelled.',
    ptcAutoDisabled: 'GPT models do not support PTC; it has been auto-disabled (takes effect on restart)',
  },

  sessionCmd: {
    checkpointEnabled: 'Checkpoint enabled',
    checkpointEnabledDetail: 'File snapshots enabled (takes effect on restart)',
    checkpointDisabled: 'Checkpoint disabled',
    checkpointDisabledDetail: 'File snapshots disabled (takes effect on restart)',
    checkpointDisabledShort: 'Checkpoint disabled',
    checkpointEnableFirst: 'Run /checkpoint enable first',
    checkpointEnableFirstShort: 'Enable Checkpoint first',
    checkpointMenuTitle: 'Checkpoint · {size} used ({detail})',
    checkpointMenuRepo: 'repo {repo}, legacy {legacy}, {count} checkpoints',
    checkpointToggleOn: '✓ ON  Checkpoint — enabled',
    checkpointToggleOff: '○ OFF  Checkpoint — disabled',
    checkpointCreate: '+ Create checkpoint',
    checkpointListRollback: 'List / Rollback',
    checkpointCleanup: 'x Cleanup',
    cleanupDone: 'Cleanup done',
    cleanupDoneDetail: 'Checkpoint private repository and legacy .cdundo cleaned up',
    clearConfirmTitle: 'Clear current session content? This cannot be undone',
    clearConfirmCancel: 'Cancel',
    clearConfirmConfirm: 'Confirm clear',
    clearCancelled: 'Cancelled',
    compactSessionDisabled: 'Session disabled',
    compactSessionDisabledDetail: 'Compaction only applies to sessions with persistence enabled.',
    compactNoProfile: 'Missing model context profile',
    compactNoProfileDetail: 'Please check your Provider/Model configuration.',
    compactRunning: 'Task in progress',
    compactRunningDetail: 'Wait for the current task to finish, or press ESC twice to interrupt before compacting.',
    compactInProgress: 'Compaction in progress',
    compactInProgressDetail: 'Please wait a moment.',
    compactUnavailable: 'Compaction unavailable',
    compactUnavailableDetail: 'Not connected to the server, or no active session.',
    compactNothing: 'Nothing to compact',
    compactNothingDetail: 'The current conversation is empty; nothing to compact.',
    compactManual: '[~] Manual compaction...',
    compactComplete: 'Compaction complete!',
    compactFailedStatus: 'Compaction failed',
    compactFailed: 'Manual compaction failed',
    compactFailedCard: '✗ Compaction failed',
  },
};

// ============================================================================
// 翻译管理
// ============================================================================

const translations: Record<UserLanguage, CLITranslations> = { zh, en };

/** 全局语言状态 */
let globalLanguage: UserLanguage = 'zh';

/** 语言变更监听器 */
const languageListeners = new Set<(lang: UserLanguage) => void>();

/**
 * 获取当前语言
 */
export function getLanguage(): UserLanguage {
  return globalLanguage;
}

/**
 * 设置当前语言
 */
export function setLanguage(lang: UserLanguage): void {
  if (globalLanguage !== lang) {
    globalLanguage = lang;
    // 通知所有监听器
    for (const listener of languageListeners) {
      listener(lang);
    }
  }
}

/**
 * 从配置文件加载语言设置
 */
export function loadLanguageFromConfig(): UserLanguage {
  const config = loadConfig();
  const lang = config.language || 'zh';
  globalLanguage = lang;
  return lang;
}

/**
 * 保存语言设置到配置文件
 */
export function saveLanguageToConfig(lang: UserLanguage): void {
  const config = loadConfig();
  config.language = lang;
  saveConfig(config);
  setLanguage(lang);
}

/**
 * 添加语言变更监听器
 */
export function addLanguageListener(listener: (lang: UserLanguage) => void): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

/**
 * 获取翻译对象
 */
export function getTranslations(lang?: UserLanguage): CLITranslations {
  return translations[lang || globalLanguage];
}

/**
 * 快捷方式：获取当前语言的翻译
 */
export function t(): CLITranslations {
  return translations[globalLanguage];
}

/**
 * 格式化翻译字符串（替换占位符）
 * @example formatMessage('已加载 {count} 个技能', { count: 5 }) => '已加载 5 个技能'
 */
export function formatMessage(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
}

/**
 * 判断是否为中文
 */
export function isZh(): boolean {
  return globalLanguage === 'zh';
}

/**
 * 判断是否为英文
 */
export function isEn(): boolean {
  return globalLanguage === 'en';
}

/**
 * 计算字符串在终端中的显示宽度
 * 中文字符占2个宽度，英文字符占1个宽度
 */
export function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.charCodeAt(0);
    // CJK 字符范围（中日韩统一表意文字）
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
      (code >= 0xff00 && code <= 0xffef)    // Fullwidth Forms
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}
