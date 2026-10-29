
export type NeoxEditorEngineRuntime = typeof import('monaco-editor');

export async function loadNeoxEditorEngine(): Promise<NeoxEditorEngineRuntime> {
  await import('./setup');
  return import('monaco-editor');
}
