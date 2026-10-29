/**
 * 工具执行辅助函数
 * Phase 1: 基础信息增强
 * Phase 2: 描述和命令生成
 */

import { parseMcpToolName } from '../mcp/utils.js';

// ==================== Phase 2: 描述提取器 ====================

/**
 * 从 LLM 的 assistant 消息中提取工具调用原因
 */
export class ToolDescriptionExtractor {
  /**
   * 从 assistant 消息提取描述
   * 支持常见的 LLM 表达模式
   */
  extractFromAssistantMessage(message: string, toolName: string): string | undefined {
    if (!message || message.length === 0) return undefined;

    // 模式 1: "I'll/I will ... to ..."
    const patterns = [
      /I(?:'ll| will) (\w+.*?) to (.*?)(?:\.|$)/i,
      /Let me (\w+.*?) to (.*?)(?:\.|$)/i,
      /(?:I'm|I am) going to (\w+.*?) to (.*?)(?:\.|$)/i,
      /(?:I'm|I am) (\w+ing.*?) to (.*?)(?:\.|$)/i,
      
      // 模式 2: "To ... I'll ..."
      /To (.*?)[,，] I(?:'ll| will) (\w+.*?)(?:\.|$)/i,
      
      // 模式 3: 直接动作描述
      /(?:First|Now|Next|Then)[,，] (?:I'll |I will |let me )?(\w+.*?)(?:\.|$)/i,
      
      // 模式 4: 中文模式
      /(?:我将|我会|让我)([^。，,]+)(?:来|以便|用于)([^。，,]+)/,
      /(?:首先|现在|接下来|然后)[,，](?:我将|我会|让我)?([^。，,]+)/,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        // 提取描述部分（通常是第二个捕获组）
        const description = match[2] || match[1];
        if (description && description.length > 0 && description.length < 200) {
          return description.trim();
        }
      }
    }

    // 模式 5: 查找包含工具名称附近的句子
    const toolNameLower = toolName.toLowerCase();
    const sentences = message.split(/[.。!！?？]/);
    for (const sentence of sentences) {
      if (sentence.toLowerCase().includes(toolNameLower) || 
          sentence.toLowerCase().includes('read') ||
          sentence.toLowerCase().includes('search') ||
          sentence.toLowerCase().includes('file')) {
        const cleaned = sentence.trim();
        if (cleaned.length > 10 && cleaned.length < 200) {
          return cleaned;
        }
      }
    }

    return undefined;
  }

  /**
   * 从工具名称和参数提取关键行为词
   */
  extractActionFromToolName(toolName: string): string {
    const actionMap: Record<string, string> = {
      'readfile': 'read',
      'write_file': 'write',
      'create_file': 'create',
      'edit': 'edit',
      'edit_file': 'edit',
      'Edit': 'edit',
      'search': 'search',
      'list_directory': 'list',
      'LS': 'list',
      'Glob': 'find',
      'find_files': 'find',
      'Execute': 'execute',
      'execute': 'execute',
    };

    return actionMap[toolName] || toolName.toLowerCase();
  }
}

// ==================== Phase 2: 命令生成器 ====================

/**
 * 为工具生成等效的 shell 命令
 */
export class CommandGenerator {
  /**
   * 生成等效的 shell 命令
   */
  generateEquivalentCommand(toolName: string, args: Record<string, any>): string | undefined {
    switch (toolName) {
      case 'search':
        return this.generateSearchCommand(args);
      
      case 'Glob':
      case 'find_files':
        return this.generateFindCommand(args);
      
      case 'Execute':
      case 'execute':
        return this.generateExecuteCommand(args);
      
      case 'readfile':
        return this.generateReadCommand(args);
      
      case 'list_directory':
      case 'LS':
        return this.generateLsCommand(args);
      
      case 'write_file':
      case 'create_file':
        return this.generateWriteCommand(args);
      
      default:
        return undefined;
    }
  }

  /**
   * 生成 search 命令
   */
  private generateSearchCommand(args: Record<string, any>): string {
    let cmd = 'rg';
    
    // 添加选项
    if (args.case_insensitive) cmd += ' -i';
    if (args.line_numbers) cmd += ' -n';
    
    // 上下文行
    if (args.context_lines) {
      cmd += ` -C ${args.context_lines}`;
    } else if (args.context) {
      cmd += ` -C ${args.context}`;
    } else {
      if (args.context_before) cmd += ` -B ${args.context_before}`;
      if (args.context_after) cmd += ` -A ${args.context_after}`;
    }
    
    // 搜索模式（转义引号）
    const pattern = args.pattern || '';
    cmd += ` "${this.escapeShellArg(pattern)}"`;
    
    // 搜索路径
    const path = args.path || args.directory || '.';
    cmd += ` ${this.escapeShellPath(path)}`;
    
    // 文件类型过滤
    if (args.type) {
      // ripgrep 风格的类型过滤
      cmd += ` --type=${args.type}`;
    }
    
    // glob 模式
    if (args.file_pattern) {
      cmd += ` -g "${this.escapeShellArg(args.file_pattern)}"`;
    } else if (args.glob_pattern) {
      cmd += ` -g "${this.escapeShellArg(args.glob_pattern)}"`;
    }
    
    return cmd;
  }

  /**
   * 生成 find 命令
   */
  private generateFindCommand(args: Record<string, any>): string {
    let cmd = 'find';
    
    // 搜索路径
    const folder = args.folder || args.path || '.';
    cmd += ` ${this.escapeShellPath(folder)}`;
    
    // 文件名模式
    if (args.patterns && Array.isArray(args.patterns) && args.patterns.length > 0) {
      if (args.patterns.length === 1) {
        cmd += ` -name "${this.escapeShellArg(args.patterns[0])}"`;
      } else {
        // 多个模式使用 -o (or)
        const patterns = args.patterns.map((p: string) => 
          `-name "${this.escapeShellArg(p)}"`
        ).join(' -o ');
        cmd += ` \\( ${patterns} \\)`;
      }
    }
    
    // 排除模式
    if (args.excludePatterns && Array.isArray(args.excludePatterns)) {
      args.excludePatterns.forEach((p: string) => {
        cmd += ` ! -path "${this.escapeShellArg(p)}"`;
      });
    }
    
    // 限制深度
    if (args.maxDepth) {
      cmd += ` -maxdepth ${args.maxDepth}`;
    }
    
    // 文件类型
    if (args.type === 'f') {
      cmd += ' -type f';
    } else if (args.type === 'd') {
      cmd += ' -type d';
    }
    
    return cmd;
  }

  /**
   * 生成 execute 命令
   */
  private generateExecuteCommand(args: Record<string, any>): string {
    // Execute 工具直接返回原始命令
    return args.command || '';
  }

  /**
   * 生成 cat/head 命令
   */
  private generateReadCommand(args: Record<string, any>): string {
    const path = args.path || args.file_path || args.filename || '';
    
    // 如果指定了行数范围，使用 sed
    if (args.start_line && args.num_lines) {
      const endLine = args.start_line + args.num_lines - 1;
      return `sed -n '${args.start_line},${endLine}p' ${this.escapeShellPath(path)}`;
    }
    
    // 如果只读取前 N 行，使用 head
    if (args.num_lines && !args.start_line) {
      return `head -n ${args.num_lines} ${this.escapeShellPath(path)}`;
    }
    
    // 默认使用 cat
    return `cat ${this.escapeShellPath(path)}`;
  }

  /**
   * 生成 ls 命令
   */
  private generateLsCommand(args: Record<string, any>): string {
    let cmd = 'ls';
    
    // 添加选项
    if (args.all || args.show_hidden) cmd += ' -a';
    if (args.long || args.detailed) cmd += ' -l';
    
    // 默认使用 -la 显示详细信息
    if (!cmd.includes('-')) {
      cmd += ' -la';
    }
    
    // 路径
    const path = args.path || args.directory || args.directory_path || '.';
    cmd += ` ${this.escapeShellPath(path)}`;
    
    return cmd;
  }

  /**
   * 生成 echo/cat 写入命令
   */
  private generateWriteCommand(args: Record<string, any>): string {
    const path = args.path || args.file_path || args.filename || '';
    const content = args.content || '';
    
    // 如果内容很短，使用 echo
    if (content.length < 100 && !content.includes('\n')) {
      return `echo "${this.escapeShellArg(content)}" > ${this.escapeShellPath(path)}`;
    }
    
    // 否则建议使用编辑器
    return `# Use editor to create ${path}`;
  }

  /**
   * 转义 shell 参数中的特殊字符
   */
  private escapeShellArg(arg: string): string {
    // 转义双引号和反斜杠
    return arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * 转义 shell 路径
   */
  private escapeShellPath(path: string): string {
    // 如果路径包含空格或特殊字符，添加引号
    if (/[\s()[\]{}$`!*?<>|&;]/.test(path)) {
      return `"${this.escapeShellArg(path)}"`;
    }
    return path;
  }
}

// ==================== Phase 1 Functions (继续保留) ====================

/**
 * 从工具参数中提取目标路径
 */
export function extractTargetPath(toolName: string, args: Record<string, any>): string | undefined {
  // 常见的路径字段名
  const pathFields = [
    'path',
    'file_path',
    'filePath',
    'filename',
    'directory',
    'folder',
    'dir',
    'file',
    'output_path',
    'input_path',
  ];

  // 按优先级查找路径字段
  for (const field of pathFields) {
    if (args[field] && typeof args[field] === 'string') {
      return args[field];
    }
  }

  // 针对特定工具的特殊处理
  switch (toolName) {
    case 'Execute':
    case 'execute':
      // Execute 工具：提取命令中的文件路径（简单启发式）
      if (args.command && typeof args.command === 'string') {
        const cmd = args.command;
        // 匹配常见的文件路径模式
        const pathMatch = cmd.match(/(?:^|\s)([./~][\w/.-]+\.\w+)(?:\s|$)/);
        if (pathMatch) {
          return pathMatch[1];
        }
        // 返回命令的前 50 个字符作为描述
        return cmd.substring(0, 50) + (cmd.length > 50 ? '...' : '');
      }
      break;

    case 'search':
      // 搜索工具：返回搜索目录
      return args.path || args.directory || '.';

    case 'Glob':
    case 'find_files':
      // 文件查找：返回搜索目录和模式
      const folder = args.folder || args.path || '.';
      if (args.patterns && Array.isArray(args.patterns)) {
        return `${folder} (${args.patterns.join(', ')})`;
      }
      return folder;

    case 'read_multiple_files':
      // 批量读取：返回文件列表
      if (args.files && Array.isArray(args.files)) {
        return args.files.length > 1 
          ? `${args.files.length} files`
          : args.files[0];
      }
      break;
  }

  // 如果没有找到路径，返回 undefined
  return undefined;
}

/**
 * 从工具参数推断描述
 */
export function inferToolDescription(toolName: string, args: Record<string, any>): string {
  const mcpInfo = parseMcpToolName(toolName);
  if (mcpInfo) {
    return `MCP ${mcpInfo.serverId}/${mcpInfo.toolName}`;
  }
  switch (toolName) {
    case 'readfile':
      const readPath = extractTargetPath(toolName, args);
      return readPath ? `Reading ${readPath}` : 'Reading file';

    case 'write_file':
    case 'create_file':
      const writePath = extractTargetPath(toolName, args);
      return writePath ? `Writing ${writePath}` : 'Writing file';

    case 'edit_file':
    case 'Edit':
      const editPath = extractTargetPath(toolName, args);
      return editPath ? `Editing ${editPath}` : 'Editing file';

    case 'search':
      const pattern = args.pattern || args.query;
      return pattern ? `Searching for "${pattern}"` : 'Searching code';

    case 'list_directory':
    case 'LS':
      const lsPath = extractTargetPath(toolName, args) || '.';
      return `Listing ${lsPath}`;

    case 'Glob':
    case 'find_files':
      if (args.patterns && Array.isArray(args.patterns)) {
        return `Finding files: ${args.patterns.join(', ')}`;
      }
      return 'Finding files';

    case 'Execute':
    case 'execute':
    case 'execute_shell':
    case 'execute_bash':
    case 'bash':
      const cmd = args.command || args.cmd || args.code || args.script || '';
      return cmd.length > 60 
        ? `Running: ${cmd.substring(0, 60)}...`
        : `Running: ${cmd}`;

    case 'read_multiple_files':
      if (args.files && Array.isArray(args.files)) {
        return `Reading ${args.files.length} files`;
      }
      return 'Reading multiple files';

    default:
      return `Executing ${toolName}`;
  }
}

/**
 * 生成工具结果摘要
 */
export function generateToolResultSummary(
  toolName: string,
  targetPath: string | undefined,
  resultLength: number,
  success: boolean
): string {
  if (!success) {
    return targetPath 
      ? `Failed: ${targetPath}`
      : `Failed`;
  }

  switch (toolName) {
    case 'readfile':
      return targetPath 
        ? `${targetPath} (${resultLength} chars)`
        : `${resultLength} chars`;

    case 'write_file':
    case 'create_file':
      return targetPath 
        ? `Created ${targetPath} (${resultLength} chars)`
        : `File created (${resultLength} chars)`;

    case 'edit_file':
    case 'Edit':
      return targetPath 
        ? `Edited ${targetPath}`
        : 'File edited';

    case 'search':
      return `Found ${resultLength} chars of matches`;

    case 'list_directory':
    case 'LS':
      return `Listed ${targetPath || 'directory'}`;

    case 'Glob':
    case 'find_files':
      // 尝试从结果长度推断文件数量（粗略估计）
      const estimatedFiles = Math.max(1, Math.floor(resultLength / 50));
      return `Found ~${estimatedFiles} files`;

    case 'Execute':
    case 'execute':
    case 'execute_shell':
    case 'execute_bash':
    case 'bash':
      return `Command completed (${resultLength} chars output)`;

    default:
      return `Completed (${resultLength} chars)`;
  }
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 格式化时长
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * 缩短路径（保留文件名和部分目录）
 */
export function shortenPath(fullPath: string, maxLength: number = 50): string {
  if (fullPath.length <= maxLength) return fullPath;

  const parts = fullPath.split(/[/\\]/);
  const fileName = parts[parts.length - 1];

  if (fileName.length >= maxLength - 3) {
    // 文件名太长，截断文件名
    return '...' + fileName.substring(fileName.length - maxLength + 3);
  }

  // 保留文件名，缩短目录部分
  const dirLength = maxLength - fileName.length - 4; // 4 = ".../" 的长度
  const dir = parts.slice(0, -1).join('/');

  if (dir.length <= dirLength) {
    return fullPath;
  }

  return '.../' + dir.substring(dir.length - dirLength) + '/' + fileName;
}
