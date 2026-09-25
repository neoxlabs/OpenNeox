interface ServiceCommandRoutingDeps {
  handleApproval: (args: string[]) => Promise<void>;
  handleWebSearch: (args: string[]) => Promise<void>;
  handleNotify: (actionArg?: string) => Promise<void>;
  handleMcp: (actionArg?: string) => Promise<void>;
  handleRemote: (actionArg?: string) => Promise<void>;
  handleSupervisor: (actionArg?: string) => Promise<void>;
}

export async function handleServiceCommandRouting(
  cmd: string,
  args: string[],
  deps: ServiceCommandRoutingDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/approval':
      await deps.handleApproval(args);
      return true;
    case '/websearch':
      await deps.handleWebSearch(args);
      return true;
    case '/notify':
      await deps.handleNotify(args[0]);
      return true;
    case '/mcp':
      await deps.handleMcp(args[0]);
      return true;
    case '/remote':
      await deps.handleRemote(args[0]);
      return true;
    case '/supervisor':
      await deps.handleSupervisor(args[0]);
      return true;
    default:
      return false;
  }
}
