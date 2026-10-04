import chalk from 'chalk';
import { getNeoxLogo } from '../asciiArt.js';
import { colors } from '../constants.js';
import { t, isZh } from '../i18n/index.js';

interface RenderMainHeaderOptions {
  workDir: string;
  providerDisplayName: string;
  model: string;
  toolsCount: number;
}

export function renderMainHeader(options: RenderMainHeaderOptions): void {
  console.clear();
  console.log();

  const logo = getNeoxLogo(process.stdout.columns);
  const logoLines = logo.split('\n');

  logoLines.forEach((line, index) => {
    if (!line.trim()) {
      console.log();
      return;
    }
    const progress = index / Math.max(logoLines.length - 1, 1);
    const coloredLine = progress < 0.33
      ? chalk.cyan(line)
      : progress < 0.66
        ? chalk.magenta(line)
        : chalk.hex('#FF69B4')(line);
    console.log(coloredLine);
  });

  console.log();
  console.log(colors.dim(`  ${'─'.repeat(50)}`));
  console.log();

  const workDirShort = options.workDir.replace(process.env.HOME || '', '~');
  console.log(colors.dim('  Provider: ') + colors.info(options.providerDisplayName));
  console.log(colors.dim('  Model:    ') + colors.info(options.model));
  console.log(colors.dim('  Dir:      ') + colors.info(workDirShort));
  console.log(colors.dim('  Tools:    ') + colors.info(options.toolsCount.toString()));
  console.log();
  console.log(
    colors.dim('  Type ') + colors.highlight('/help') + colors.dim(' for commands  │  ') +
    colors.highlight('ESC') + colors.dim(' to interrupt  │  ') +
    colors.error('Ctrl+C') + colors.dim(' to exit'),
  );
  console.log();
  console.log(colors.dim('─'.repeat(50)));
}

export function showProviderConfigurationGuidePanel(): void {
  const g = t().providerGuide;
  const zh = isZh();
  console.clear();
  console.log();
  console.log(chalk.yellow('━'.repeat(60)));
  console.log();
  console.log(chalk.bold.yellow(`  ⚠  ${g.welcome}`));
  console.log();
  console.log(chalk.cyan(`  ${g.noProviderDetected}`));
  console.log(chalk.dim(`  ${g.needConfig}`));
  console.log();
  console.log(chalk.bold.green(`  ${g.quickStart}`));
  console.log(chalk.dim(`    • ${g.quickStartUseServices}`));
  console.log(chalk.dim(`    • ${g.quickStartApiKey}`));
  console.log(chalk.dim(`    • ${g.quickStartProxy}`));
  console.log();
  console.log(chalk.bold.magenta(`  ${g.supportedProviders}`));
  console.log(chalk.green('    OpenAI') + chalk.dim(zh ? ' - GPT-4o, GPT-4, o3-mini 等' : ' - GPT-4o, GPT-4, o3-mini, etc.'));
  console.log(chalk.cyan('    Anthropic') + chalk.dim(zh ? ' - Claude Sonnet 4.5, Claude Opus 等' : ' - Claude Sonnet 4.5, Claude Opus, etc.'));
  console.log(chalk.yellow('    Gemini') + chalk.dim(zh ? ' - Gemini 2.5 系列' : ' - Gemini 2.5 series'));
  console.log(chalk.blue(zh ? '    豆包 (Doubao)' : '    Doubao') + chalk.dim(zh ? ' - 火山方舟深度思考模型' : ' - Volcengine Ark deep-reasoning models'));
  console.log();
  console.log(chalk.yellow('━'.repeat(60)));
  console.log();
}
