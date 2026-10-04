/**
 * Dynamic status display with animations for agent operations
 */

import chalk from 'chalk';
import * as readline from 'readline';

export interface StatusDisplayConfig {
  isDarkBackground: boolean;
}

export interface ToolDetails {
  name: string;
  args: any;
  result?: string;
  error?: string;
  duration?: number;
  timestamp: Date;
}

export interface FileOperation {
  type: 'read' | 'write' | 'search';
  path: string;
  lines?: number;
  size?: number;
}

export class StatusDisplay {
  private currentStatus: string = '';
  private statusBrightness: number = 50; // 0-100
  private brightnessDirection: number = 1; // 1 for increasing, -1 for decreasing
  private animationInterval: NodeJS.Timeout | null = null;
  private toolHistory: ToolDetails[] = [];
  private fileOperations: FileOperation[] = [];
  private statusLine: number = 0; // Track which line the status is on
  private isDark: boolean;
  private isActive: boolean = false;
  private spinnerFrame: number = 0;
  // 多种 Spinner 样式，根据状态类型选择
  private spinnerStyles = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    arrows: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
    pulse: ['█', '▓', '▒', '░', '▒', '▓'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    circle: ['◐', '◓', '◑', '◒'],
    star: ['✶', '✸', '✹', '✺', '✹', '✸'],
  };
  private spinnerChars: string[] = this.spinnerStyles.dots;
  private currentType:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'complete'
    | 'error'
    | 'compacting'
    | 'info'
    | 'compaction_complete'
    | 'explore_complete' = 'thinking';

  constructor(config: StatusDisplayConfig) {
    this.isDark = config.isDarkBackground;
  }

  /**
   * Start the status display
   */
  start(): void {
    this.isActive = true;
    this.clear();
    this.renderStatusBar();
    this.startAnimation();
  }

  /**
   * Stop the status display
   */
  stop(): void {
    this.isActive = false;
    this.stopAnimation();
  }

  /**
   * Update the current status
   */
  updateStatus(
    status: string,
    type:
      | 'thinking'
      | 'tool_call'
      | 'tool_result'
      | 'complete'
      | 'error'
      | 'compacting'
      | 'info'
      | 'compaction_complete'
      | 'explore_complete' = 'thinking'
  ): void {
    if (!this.isActive) return;

    this.currentStatus = status;
    this.currentType = type;

    // Restart animation when status changes
    if (type === 'thinking' || type === 'tool_call' || type === 'compacting' || type === 'info') {
      this.startAnimation();
    } else {
      this.stopAnimation();
    }

    this.renderStatusBar();
  }

  /**
   * Add a tool call to history
   */
  addToolCall(tool: ToolDetails): void {
    this.toolHistory.push(tool);
  }

  /**
   * Add a file operation
   */
  addFileOperation(operation: FileOperation): void {
    this.fileOperations.push(operation);
  }

  /**
   * Update tool call result
   */
  updateToolResult(toolName: string, result: string, duration: number): void {
    const tool = this.toolHistory[this.toolHistory.length - 1];
    if (tool && tool.name === toolName) {
      tool.result = result;
      tool.duration = duration;
    }
  }

  /**
   * Update tool call error
   */
  updateToolError(toolName: string, error: string): void {
    const tool = this.toolHistory[this.toolHistory.length - 1];
    if (tool && tool.name === toolName) {
      tool.error = error;
    }
  }

  /**
   * Clear the display
   */
  clear(): void {
    console.clear();
    this.toolHistory = [];
    this.fileOperations = [];
    this.statusLine = 0;
  }

  /**
   * Start brightness animation
   */
  private startAnimation(): void {
    if (this.animationInterval) return;

    this.animationInterval = setInterval(() => {
      if (!this.isActive) return;

      // Update spinner
      this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerChars.length;

      // Update brightness (pulse effect) - 更快的亮度变化
      this.statusBrightness += this.brightnessDirection * 10;

      if (this.statusBrightness >= 100) {
        this.statusBrightness = 100;
        this.brightnessDirection = -1;
      } else if (this.statusBrightness <= 30) {
        // 从 40 降到 30，对比度更强
        this.statusBrightness = 30;
        this.brightnessDirection = 1;
      }

      this.renderStatusBar();
    }, 50); // 50ms = 20fps for faster, more responsive animation
  }

  /**
   * Stop brightness animation
   */
  private stopAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = null;
    }
  }

  /**
   * Render the status bar with brightness effect
   */
  private renderStatusBar(): void {
    if (!this.isActive) return;

    // Move cursor to home and clear screen
    process.stdout.write('\x1b[H\x1b[2J');

    // Add visual indicators based on type
    let icon = '';
    let colorFn = chalk.blue;

    switch (this.currentType) {
      case 'thinking':
        icon = this.spinnerChars[this.spinnerFrame];
        colorFn = chalk.cyan;
        break;
      case 'tool_call':
        icon = this.spinnerChars[this.spinnerFrame];
        colorFn = chalk.yellow;
        break;
      case 'tool_result':
        icon = '✓';
        colorFn = chalk.green;
        break;
      case 'complete':
        icon = '★';
        colorFn = chalk.green;
        break;
      case 'error':
        icon = '[x]';
        colorFn = chalk.red;
        break;
    }

    // Calculate color based on brightness
    const brightness = Math.floor(this.statusBrightness);
    const animatedStatus = `${icon}  ${this.currentStatus}`;
    const statusText = this.applyBrightness(animatedStatus, brightness, this.currentType);

    // Draw status bar
    const bar = '═'.repeat(process.stdout.columns || 80);
    console.log(chalk.dim(bar));
    console.log(statusText);
    console.log(chalk.dim(bar));

    // Render tool history and file operations
    this.renderToolHistory();
    this.renderFileOperations();
  }

  /**
   * Apply brightness to text (simulate pulse effect)
   */
  private applyBrightness(text: string, brightness: number, type: string): string {
    // Use RGB color codes to simulate brightness
    // Map brightness (40-100) to RGB intensity
    const intensity = Math.floor((brightness / 100) * 255);

    let r = 0, g = 0, b = 0;

    switch (type) {
      case 'thinking':
        // Cyan pulse: 暗变亮再变暗
        r = Math.floor(intensity * 0.2);
        g = Math.floor(intensity * 0.9);
        b = intensity;
        break;
      case 'tool_call':
        // Yellow pulse
        r = intensity;
        g = Math.floor(intensity * 0.9);
        b = Math.floor(intensity * 0.2);
        break;
      case 'tool_result':
        // Green (static)
        r = 0;
        g = intensity;
        b = 0;
        break;
      case 'complete':
        // Green (static)
        r = 0;
        g = intensity;
        b = Math.floor(intensity * 0.5);
        break;
      case 'error':
        // Red (static)
        r = intensity;
        g = 0;
        b = 0;
        break;
      default:
        // Default blue
        r = 0;
        g = Math.floor(intensity * 0.5);
        b = intensity;
    }

    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }

  /**
   * Render tool call history
   */
  private renderToolHistory(): void {
    if (!this.isActive || this.toolHistory.length === 0) return;

    console.log('\n' + chalk.bold('Tool Calls:'));

    // Show last 5 tool calls
    const recentTools = this.toolHistory.slice(-5);

    for (const tool of recentTools) {
      const timeStr = this.formatTime(tool.timestamp);
      const durationStr = tool.duration ? chalk.dim(` (${tool.duration}ms)`) : '';

      if (tool.error) {
        console.log(chalk.red(`  ✗ ${timeStr} ${tool.name}${durationStr}`));
        console.log(chalk.red(`    Error: ${tool.error}`));
      } else if (tool.result) {
        const resultPreview = this.truncate(tool.result, 60);
        console.log(chalk.green(`  ✓ ${timeStr} ${tool.name}${durationStr}`));
        console.log(chalk.dim(`    → ${resultPreview}`));
      } else {
        console.log(chalk.yellow(`  ⋯ ${timeStr} ${tool.name}...`));
      }
    }
  }

  /**
   * Render file operations
   */
  private renderFileOperations(): void {
    if (!this.isActive || this.fileOperations.length === 0) return;

    console.log('\n' + chalk.bold('File Operations:'));

    // Show last 5 file operations
    const recentOps = this.fileOperations.slice(-5);

    for (const op of recentOps) {
      const sizeStr = op.size ? chalk.dim(` (${this.formatSize(op.size)})`) : '';
      const linesStr = op.lines ? chalk.dim(` (${op.lines} lines)`) : '';

      switch (op.type) {
        case 'read':
          console.log(chalk.blue(`  [r] Read: ${op.path}${linesStr}${sizeStr}`));
          break;
        case 'write':
          console.log(chalk.green(`  [w]  Write: ${op.path}${linesStr}${sizeStr}`));
          break;
        case 'search':
          console.log(chalk.cyan(`  [?] Search: ${op.path}`));
          break;
      }
    }
  }

  /**
   * Format timestamp
   */
  private formatTime(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return chalk.dim(`${hours}:${minutes}:${seconds}`);
  }

  /**
   * Format file size
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Truncate text
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Display final summary
   */
  displaySummary(iterations: number, toolCalls: number, tokens: number, duration: number): void {
    this.stop();

    console.log('\n' + chalk.dim('─'.repeat(process.stdout.columns || 80)));
    console.log(chalk.bold('Summary:'));
    console.log(chalk.dim(`  • Iterations: ${iterations}`));
    console.log(chalk.dim(`  • Tool Calls: ${toolCalls}`));
    console.log(chalk.dim(`  • Tokens Used: ${tokens}`));
    console.log(chalk.dim(`  • Duration: ${(duration / 1000).toFixed(2)}s`));

    if (this.fileOperations.length > 0) {
      const reads = this.fileOperations.filter(op => op.type === 'read').length;
      const writes = this.fileOperations.filter(op => op.type === 'write').length;
      const searches = this.fileOperations.filter(op => op.type === 'search').length;

      console.log(chalk.dim(`  • Files Read: ${reads}`));
      console.log(chalk.dim(`  • Files Written: ${writes}`));
      console.log(chalk.dim(`  • Searches: ${searches}`));
    }

    console.log(chalk.dim('─'.repeat(process.stdout.columns || 80)));
  }
}
