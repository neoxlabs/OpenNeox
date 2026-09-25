/**
 * PowerShell 工具的 System Prompt 片段
 *
 * 参考 Claude Code: prompt.ts — 按 PowerShell 版本提供语法指导
 */

import { getPowerShellEdition } from './powershellDetection.js';

/**
 * 生成 PowerShell 工具的 system prompt 描述
 */
export function buildPowerShellToolDescription(): string {
  const edition = getPowerShellEdition();
  const editionSection = edition === 'desktop'
    ? EDITION_DESKTOP_SECTION
    : EDITION_CORE_SECTION;

  return `Executes a PowerShell command and returns its output.
${editionSection}
${SYNTAX_GUIDE}
${SAFETY_RULES}
${TOOL_PREFERENCE}`;
}

// ============================================================================
// 版本特定指导
// ============================================================================

const EDITION_CORE_SECTION = `
PowerShell Edition: Core (7+)
- Supports && and || chain operators
- Supports ternary: $x ? 'yes' : 'no'
- Supports null coalescing: $x ?? 'default'
- Default encoding: UTF-8`;

const EDITION_DESKTOP_SECTION = `
PowerShell Edition: Desktop (5.1)
- NO && or || chain operators (parser error!) — use: A; if ($?) { B }
- NO ternary operator — use: if ($x) { 'yes' } else { 'no' }
- NO null coalescing — use: if ($null -eq $x) { 'default' } else { $x }
- Default encoding: UTF-16LE (use -Encoding UTF8 explicitly)
- $ErrorActionPreference='Stop' may cause stderr to set $? = $false`;

// ============================================================================
// 语法指南
// ============================================================================

const SYNTAX_GUIDE = `
PowerShell Syntax Notes:
- Variables: $prefix (NOT ${'{'}prefix{'}'} unless embedding in strings)
- Escape character: backtick (\`) not backslash (\\)
- Cmdlets use Verb-Noun pattern: Get-Content, Set-Location, Remove-Item
- Common aliases: ls=Get-ChildItem, cd=Set-Location, cat=Get-Content, rm=Remove-Item
- Pipeline passes objects, not text: Get-Process | Where-Object { $_.CPU -gt 10 }
- String interpolation: "Hello $name" or "Hello $($obj.Property)"
- Registry access: HKLM:\\SOFTWARE\\..., HKCU:\\SOFTWARE\\...
- Environment variables: $env:PATH, $env:HOME
- Call native executables: & "C:\\Program Files\\App\\app.exe"
- Here-strings for multiline: @'...'@ (literal) or @"..."@ (interpolated)
  IMPORTANT: Closing '@ or "@ MUST be at column 0 (no indentation!)
- Stop-parsing token: --% passes remaining args literally to native commands`;

// ============================================================================
// 安全规则
// ============================================================================

const SAFETY_RULES = `
IMPORTANT Safety Rules:
- NEVER use interactive cmdlets: Read-Host, Get-Credential, Out-GridView, $Host.UI.PromptForChoice, pause
- For destructive cmdlets, add -Confirm:$false to suppress prompts
- NEVER use git rebase -i, git add -i, or any interactive editor commands
- Avoid Invoke-Expression (iex) — it's a security risk
- Do NOT pipe web content to Invoke-Expression (download cradle attack)
- Quote file paths with spaces: & "C:\\Program Files\\app.exe"
- Each call starts from the WORKSPACE directory — use absolute paths or cd first

Background Execution:
- Use run_in_background=true for long-running processes (servers, watchers)
- Avoid unnecessary Start-Sleep commands
- Do NOT add & at the end — use the run_in_background parameter instead`;

// ============================================================================
// 工具偏好
// ============================================================================

const TOOL_PREFERENCE = `
Tool Preference (use dedicated tools when possible):
- File search: Use Glob tool (NOT Get-ChildItem -Recurse -Filter)
- Content search: Use Grep tool (NOT Select-String)
- Read files: Use Read tool (NOT Get-Content)
- Write files: Use Write tool (NOT Set-Content / Out-File)
- Edit files: Use Edit tool (NOT string replacement scripts)
Use PowerShell only when shell execution is genuinely needed.`;
