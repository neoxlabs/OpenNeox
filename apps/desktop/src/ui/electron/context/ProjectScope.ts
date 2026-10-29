
import type { BrowserWindow } from 'electron';
import { Scope } from '../../../ide/scope/Scope.js';
import type { AppScope } from './AppScope.js';

export class ProjectScope extends Scope {
  readonly workspacePath: string;
  readonly window: BrowserWindow;
  readonly windowId: number;

  constructor(parent: AppScope, workspacePath: string, window: BrowserWindow) {
    super({ parent, level: 'project' });
    this.workspacePath = workspacePath;
    this.window = window;
    this.windowId = window.id;
  }
}
