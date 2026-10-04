type AsyncCommandHandler = () => Promise<boolean>;

interface RunCommandPipelineOptions {
  handlers: AsyncCommandHandler[];
}

export async function runCommandPipeline(options: RunCommandPipelineOptions): Promise<boolean> {
  for (const handler of options.handlers) {
    if (await handler()) {
      return true;
    }
  }
  return false;
}
