/**
 * Compatibility CLI args parser.
 *
 * Keep this module dependency-free so @openneox/core does not depend on
 * @openneox/cli while older deep imports keep working.
 */

export interface CLIArgs {
  continue: boolean;
  resume: string | boolean;
  model?: string;
  provider?: string;
  workDir?: string;
  help: boolean;
  version: boolean;
  noSession: boolean;
  debug?: boolean;
  debugConsole?: boolean;
  outputSchema?: string;
  unknownArgs?: string[];
  _: string[];
}

export function parseArgs(argv: string[] = process.argv): CLIArgs {
  const args: CLIArgs = {
    continue: false,
    resume: false,
    help: false,
    version: false,
    noSession: false,
    _: [],
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '-c':
      case '--continue':
        args.continue = true;
        break;

      case '-r':
      case '--resume': {
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          args.resume = nextArg;
          i += 1;
        } else {
          args.resume = true;
        }
        break;
      }

      case '-m':
      case '--model':
        if (argv[i + 1]) {
          args.model = argv[i + 1];
          i += 1;
        }
        break;

      case '-p':
      case '--provider':
        if (argv[i + 1]) {
          args.provider = argv[i + 1];
          i += 1;
        }
        break;

      case '-d':
      case '--dir':
      case '--workdir':
        if (argv[i + 1]) {
          args.workDir = argv[i + 1];
          i += 1;
        }
        break;

      case '-h':
      case '--help':
      case '-help':
        args.help = true;
        break;

      case '-v':
      case '-V':
      case '--version':
      case '-version':
        args.version = true;
        break;

      case '--no-session':
        args.noSession = true;
        break;

      case '--debug':
        args.debug = true;
        break;

      case '--debug-console':
        args.debug = true;
        args.debugConsole = true;
        break;

      case '--output-schema':
        if (argv[i + 1]) {
          args.outputSchema = argv[i + 1];
          i += 1;
        }
        break;

      default:
        if (arg.startsWith('-')) {
          args.unknownArgs ??= [];
          args.unknownArgs.push(arg);
        } else {
          args._.push(arg);
        }
        break;
    }
  }

  return args;
}
