export type SessionProcessRoutingDepsFromMain = {
  getCommandContext: () => any;
  getProcessCommandContext: () => any;
  model: string;
  isRunning: boolean;
  setAutoCompactionInProgress: (value: boolean) => void;
};

export function buildSessionProcessRoutingDepsFromMain(
  params: SessionProcessRoutingDepsFromMain,
): SessionProcessRoutingDepsFromMain {
  return {
    getCommandContext: params.getCommandContext,
    getProcessCommandContext: params.getProcessCommandContext,
    model: params.model,
    isRunning: params.isRunning,
    setAutoCompactionInProgress: params.setAutoCompactionInProgress,
  };
}
