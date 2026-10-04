/**
 * Model detection utilities
 */

/**
 * Check if a model name belongs to the GPT family.
 * Matches gpt-4, gpt-4o, gpt-5, gpt-5.3-codex, etc.
 */
export function isGPTModel(modelName: string): boolean {
  return /^gpt-/i.test(modelName);
}
