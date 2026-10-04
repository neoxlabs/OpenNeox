/**
 * CLI Formatting Utilities
 * Helper functions for formatting text output
 */

import chalk from 'chalk';
import { getLanguage } from '../i18n/index.js';

/**
 * Format time ago string (e.g., "5m ago", "2h ago")
 */
export function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  let zh = false;
  try { zh = getLanguage() === 'zh'; } catch { /* */ }
  if (minutes < 1) return zh ? '刚刚' : 'just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  if (days === 1) return zh ? '昨天' : 'yesterday';
  return zh ? `${days} 天前` : `${days} days ago`;
}

/**
 * Format process duration (e.g., "500ms", "1.5s", "2m 30s")
 */
export function formatProcessDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * Format badges array into string (e.g., " [badge1, badge2]")
 */
export function formatBadges(badges: string[]): string {
  if (!badges || badges.length === 0) {
    return '';
  }
  return ` [${badges.join(', ')}]`;
}

/**
 * Format function arguments for display
 * Shows first 2 arguments with truncation
 */
export function formatArgs(args: any): string {
  if (!args || Object.keys(args).length === 0) {
    return '';
  }

  const entries = Object.entries(args);
  if (entries.length === 0) return '';

  // Take first 2 arguments
  const display = entries.slice(0, 2).map(([key, value]) => {
    let valueStr = String(value);
    // Truncate long values
    if (valueStr.length > 30) {
      valueStr = valueStr.substring(0, 27) + '...';
    }
    return `${key}=${valueStr}`;
  });

  const more = entries.length > 2 ? `, +${entries.length - 2}` : '';
  return chalk.dim(` (${display.join(', ')}${more})`);
}

/**
 * Truncate string with ellipsis
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Format file size in human readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format a number with thousands separator
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}
