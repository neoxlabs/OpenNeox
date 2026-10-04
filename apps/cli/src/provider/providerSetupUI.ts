import React from 'react';
import { render } from '../../vendor/ink/src/index.js';
import { ProviderSetupWizard } from '../ink/components/ProviderSetupWizard.js';
import { InteractiveProviderSetup, type ProviderConfigResult } from '../ink/components/InteractiveProviderSetup.js';
import { WelcomeMenu, type WelcomeMenuChoice } from '../ink/components/WelcomeMenu.js';
import { detectProvidersFromEnv } from './providerDetection.js';

/**
 * 全新用户首次启动: 显 NEOX logo + 3 选项 (login/BYOK/exit) Ink menu.
 * Resolve 用户选择. unmount 干净, 留给下一步 (login flow / wizard / exit) 用 stdin.
 */
export async function runInkWelcomeMenu(opts: { showLogin?: boolean } = {}): Promise<WelcomeMenuChoice> {
  return new Promise((resolve) => {
    let resolved = false;
    const app = render(
      React.createElement(WelcomeMenu, {
        showLogin: opts.showLogin,
        onSelect: (choice: WelcomeMenuChoice) => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve(choice);
        },
      }),
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: true,
        patchConsole: false,
      },
    );
  });
}

export type ProviderSetupWizardResult =
  | { choice: 'auto'; selectedIndices: number[]; detectedProviders: ReturnType<typeof detectProvidersFromEnv> }
  | { choice: 'setup' | 'manual' | 'exit' };

export async function runInkProviderSetupWizard(): Promise<ProviderSetupWizardResult> {
  const detectedProviders = detectProvidersFromEnv();

  return new Promise((resolve) => {
    let resolved = false;
    const app = render(
      React.createElement(ProviderSetupWizard, {
        detectedProviders,
        onComplete: () => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve({ choice: 'exit' });
        },
        onStartSetup: () => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve({ choice: 'setup' });
        },
        onManualEdit: () => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve({ choice: 'manual' });
        },
        onAutoCreate: (indices?: number[]) => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          /* indices 未传 (向后兼容老调用) → 全选 */
          const selectedIndices = indices ?? detectedProviders.map((_, i) => i);
          resolve({ choice: 'auto', selectedIndices, detectedProviders });
        },
      }),
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: true,
        patchConsole: false,
      },
    );
  });
}

export async function runInkInteractiveSetup(): Promise<ProviderConfigResult | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const app = render(
      React.createElement(InteractiveProviderSetup, {
        onComplete: (config: ProviderConfigResult) => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve(config);
        },
        onCancel: () => {
          if (resolved) return;
          resolved = true;
          app.unmount();
          resolve(null);
        },
      }),
      {
        stdout: process.stdout,
        stdin: process.stdin,
        exitOnCtrlC: true,
        patchConsole: false,
      },
    );
  });
}
