/** Provider configuration is handled by ensureProviderConfigured. This no-op
 * preserves the bootstrap interface, while explicit setup remains available
 * through `neox setup` and `neox provider add`. */
export async function runProviderSetupFlowIfNeeded(): Promise<void> {
  /* Compatibility no-op; provider setup is owned by ensureProviderConfigured. */
  return;
}
