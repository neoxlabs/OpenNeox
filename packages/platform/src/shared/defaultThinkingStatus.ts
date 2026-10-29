const DEFAULT_THINKING_STATUSES = [
  'Thinking...',
  'Processing...',
  'Analyzing...',
  'Pondering...',
  'Contemplating...',
];

let statusIndex = 0;

export function getDefaultThinkingStatus(): string {
  const status = DEFAULT_THINKING_STATUSES[statusIndex];
  statusIndex = (statusIndex + 1) % DEFAULT_THINKING_STATUSES.length;
  return status;
}

export function resetDefaultThinkingStatusRotation(): void {
  statusIndex = 0;
}
