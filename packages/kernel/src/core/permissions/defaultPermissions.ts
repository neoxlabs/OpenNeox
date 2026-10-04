/**
 * Default tool permission presets shared by CLI and UI.
 */

import { ToolPermission, type ToolPermissionConfig } from '../../types/permissions.js';
import { PermissionManager } from './PermissionManager.js';

const DEFAULT_TOOL_PERMISSIONS: ToolPermissionConfig[] = [
  // Read-only tools - always allow
  {
    toolName: 'readfile',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'search_symbol',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'get_definitions',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'get_references',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'search',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'search_files',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'list_directory',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'show_tree',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'git_status',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'git_diff',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'git_blame',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'git_branch_list',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'smart_tree',
    permission: ToolPermission.ALLOW,
  },
  {
    toolName: 'analyze_code',
    permission: ToolPermission.ALLOW,
  },

  // Write tools - require approval (allow remember)
  {
    toolName: 'write_file',
    permission: ToolPermission.ASK,
    reason: 'This will create or overwrite a file',
    allowRemember: true,
  },
  {
    toolName: 'edit',
    permission: ToolPermission.ASK,
    reason: 'This will modify files (targeted edit or patch)',
    allowRemember: true,
  },
  {
    toolName: 'create_directory',
    permission: ToolPermission.ASK,
    reason: 'This will create a directory',
    allowRemember: true,
  },
  {
    toolName: 'delete_file',
    permission: ToolPermission.ASK,
    reason: 'This will permanently delete files or directories',
    allowRemember: false,
  },
  {
    toolName: 'rename_file',
    permission: ToolPermission.ASK,
    reason: 'This will rename or move files or directories',
    allowRemember: true,
  },
  {
    toolName: 'git_branch',
    permission: ToolPermission.ASK,
    reason: 'This will create or switch git branches',
    allowRemember: true,
  },
  {
    toolName: 'git_commit',
    permission: ToolPermission.ASK,
    reason: 'This will create a git commit',
    allowRemember: true,
  },
  {
    toolName: 'build_index',
    permission: ToolPermission.ASK,
    reason: 'This will build a local code index',
    allowRemember: true,
  },
  {
    toolName: 'write_neox_config',
    permission: ToolPermission.ASK,
    reason: 'This will modify local Neox configuration',
    allowRemember: false,
  },
  {
    toolName: 'add_neox_provider',
    permission: ToolPermission.ASK,
    reason: 'This will add a local AI provider and store its API key',
    allowRemember: false,
  },
  {
    toolName: 'set_default_neox_provider',
    permission: ToolPermission.ASK,
    reason: 'This will change the default local AI provider',
    allowRemember: true,
  },
  {
    toolName: 'remove_neox_provider',
    permission: ToolPermission.ASK,
    reason: 'This will remove a local AI provider',
    allowRemember: false,
  },
  {
    toolName: 'neox_switch_model',
    permission: ToolPermission.ASK,
    reason: 'This will change the default model for a provider',
    allowRemember: true,
  },
  {
    toolName: 'neox_mcp_manage',
    permission: ToolPermission.ASK,
    reason: 'This can add, remove, enable, or disable MCP servers',
    allowRemember: false,
  },
  {
    toolName: 'neox_export_config',
    permission: ToolPermission.ASK,
    reason: 'This can expose local Neox configuration metadata',
    allowRemember: false,
  },
  {
    toolName: 'neox_health_check',
    permission: ToolPermission.ASK,
    reason: 'This will make a network request to a provider endpoint',
    allowRemember: false,
  },

  /* Low-risk shell commands may be remembered after approval. High-risk
   * decisions remain non-cacheable through the PermissionManager risk check. */
  {
    toolName: 'execute_shell',
    permission: ToolPermission.ASK,
    reason: 'WARNING: running shell commands can modify your system',
    allowRemember: true,
  },
  {
    toolName: 'execute_bash',
    permission: ToolPermission.ASK,
    reason: 'WARNING: running shell commands can modify your system',
    allowRemember: true,
  },
  {
    toolName: 'execute_python',
    permission: ToolPermission.ASK,
    reason: 'WARNING: executing code can modify files or run external commands',
    allowRemember: true,
  },
  {
    toolName: 'execute_javascript',
    permission: ToolPermission.ASK,
    reason: 'WARNING: executing code can modify files or run external commands',
    allowRemember: true,
  },
  {
    toolName: 'run_tests',
    permission: ToolPermission.ASK,
    reason: 'WARNING: running tests executes project code',
    allowRemember: false,
  },
  {
    toolName: 'run_lint',
    permission: ToolPermission.ASK,
    reason: 'WARNING: running lint executes project tools',
    allowRemember: false,
  },
  {
    toolName: 'run_format',
    permission: ToolPermission.ASK,
    reason: 'WARNING: running format executes project tools',
    allowRemember: false,
  },

  // Network tools - require approval (allow remember)
  {
    toolName: 'web_fetch',
    permission: ToolPermission.ASK,
    reason: 'This will make a network request',
    allowRemember: true,
  },
  {
    toolName: 'web_search',
    permission: ToolPermission.ASK,
    reason: 'This will make a network request',
    allowRemember: true,
  },
];

export function applyDefaultToolPermissions(permissionManager: PermissionManager): void {
  permissionManager.setToolPermissions(DEFAULT_TOOL_PERMISSIONS);
}
