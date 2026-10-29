import * as fs from 'fs';
import * as path from 'path';
import { L } from '../i18n/index.js';

type ValidationFailure = {
  ok: false;
  message: string;
  details?: string;
};

type ValidationSuccess = {
  ok: true;
  resolvedPath: string;
};

export type WorkspaceSwitchValidationResult = ValidationSuccess | ValidationFailure;

interface ValidateWorkspaceSwitchTargetOptions {
  targetPath: string;
  currentWorkDir: string;
  normalizeWorkspacePath: (input: string) => string;
  formatWorkspaceLabel: (workspacePath: string) => string;
}

export function validateWorkspaceSwitchTarget(
  options: ValidateWorkspaceSwitchTargetOptions,
): WorkspaceSwitchValidationResult {
  const { targetPath, currentWorkDir, normalizeWorkspacePath, formatWorkspaceLabel } = options;

  let resolvedPath: string;
  try {
    resolvedPath = normalizeWorkspacePath(targetPath);
  } catch (error: any) {
    return { ok: false, message: L('工作区路径无效', 'Invalid workspace path'), details: error?.message || String(error) };
  }

  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, message: L('工作区不存在', 'Workspace does not exist'), details: resolvedPath };
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    return { ok: false, message: L('目标不是目录', 'Target is not a directory'), details: resolvedPath };
  }
  if (path.resolve(resolvedPath) === currentWorkDir) {
    return { ok: false, message: L('已在当前工作区', 'Already in this workspace'), details: formatWorkspaceLabel(resolvedPath) };
  }

  return { ok: true, resolvedPath };
}
