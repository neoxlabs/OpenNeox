interface BasicCommandRoutingDeps {
  handleExit: () => void;
  handleHelp: () => Promise<void>;
  handleSchemaExample: (schemaName?: string) => Promise<void>;
}

export async function handleBasicCommandRouting(
  cmd: string,
  args: string[],
  deps: BasicCommandRoutingDeps,
): Promise<boolean> {
  switch (cmd) {
    case '/exit':
    case '/quit':
    case 'exit':
    case 'quit':
      deps.handleExit();
      return true;
    case '/help':
      await deps.handleHelp();
      return true;
    case '/schema-example':
      // structured-output schema 脚手架 — 高级/自动化用, 默认不对最终用户暴露
      if (!process.env.NEOX_DEBUG && !process.env.CLI_DEBUG) return false;
      await deps.handleSchemaExample(args[0]);
      return true;
    default:
      return false;
  }
}
