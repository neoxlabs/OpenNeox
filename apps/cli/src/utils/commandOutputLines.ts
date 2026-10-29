interface CommandOutputControllerLike {
  setCommandOutputLines?: (lines: string[]) => void;
  clearCommandOutputLines?: () => void;
}

export function createCommandOutputLinesCallbacks(
  uiController: unknown,
): {
  outputLines?: (lines: string[]) => void;
  clearOutputLines?: () => void;
} {
  const controller = uiController as CommandOutputControllerLike | null;
  return {
    outputLines: controller && typeof controller.setCommandOutputLines === 'function'
      ? (lines: string[]) => {
        controller.setCommandOutputLines!(lines);
      }
      : undefined,
    clearOutputLines: controller && typeof controller.clearCommandOutputLines === 'function'
      ? () => {
        controller.clearCommandOutputLines!();
      }
      : undefined,
  };
}
