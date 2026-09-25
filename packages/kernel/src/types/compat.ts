export interface CompatThresholds {
  /** Warning threshold ratio (0-1) */
  warn: number;
  /** Soft limit ratio (0-1) */
  soft: number;
  /** Hard limit ratio (0-1) */
  hard: number;
}

export interface ModelCompatOverrides {
  /** Explicit context window override (tokens) */
  contextWindow?: number;
  /** Override auto compact threshold (tokens) */
  autoCompactTokenLimit?: number;
  /** Override max output tokens */
  maxOutputTokens?: number;
  /** Override tail token budget used when rebuilding history */
  tailTokenBudget?: number;
  /** Override warning thresholds */
  warnThresholds?: Partial<CompatThresholds>;
}

export type CompatProfileSource = 'baseline' | 'override' | 'registry' | 'default' | 'unknown';

export interface CompatProfile {
  model: string;
  contextWindow?: number;
  autoCompactLimit?: number;
  maxOutputTokens?: number;
  tailTokenBudget?: number;
  warnThresholds: CompatThresholds;
  source: CompatProfileSource;
}
