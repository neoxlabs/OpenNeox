let sandboxEnabled = process.env.NEOX_SANDBOX === 'on';

export function setSandboxEnabled(enabled: boolean): void {
  sandboxEnabled = enabled;
}

export function isSandboxEnabled(): boolean {
  return sandboxEnabled;
}
