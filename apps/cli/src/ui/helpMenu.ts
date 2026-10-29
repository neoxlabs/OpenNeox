import { getHelpCategoryChoices, printFullHelp } from '../commands/index.js';
import { getLanguage } from '../i18n/index.js';

interface HelpMenuUIControllerLike {
  promptSelect: (args: {
    message: string;
    choices: Array<{ title: string; value: string; description?: string }>;
    initialValue?: string;
  }) => Promise<string | null>;
}

interface RunHelpMenuFlowOptions {
  uiController: HelpMenuUIControllerLike | null;
  getLastSelection: () => string | undefined;
  setLastSelection: (value: string) => void;
  executeCommand: (command: string) => Promise<void>;
  logInfo: (message: string, details?: string) => void;
}

const helpTitle = () => (getLanguage() === 'zh' ? '命令和快捷键' : 'Commands & shortcuts');

export async function runHelpMenuFlow(options: RunHelpMenuFlowOptions): Promise<void> {
  if (!options.uiController) {
    printFullHelp();
    return;
  }

  helpLoop: while (true) {
    try {
      const categoryId = await options.uiController.promptSelect({
        message: getLanguage() === 'zh' ? '帮助 · 回车执行命令' : 'Help · enter runs the command',
        choices: getHelpCategoryChoices(),
        initialValue: options.getLastSelection(),
      });

      if (categoryId === null || categoryId === 'exit') {
        break helpLoop;
      }
      if (categoryId) {
        options.setLastSelection(categoryId);
      }

      await new Promise(resolve => setTimeout(resolve, 50));

      /* 条目 id 就是命令本身 (见 getHelpCategories), 选中即执行 */
      if (categoryId?.startsWith('/')) {
        await options.executeCommand(categoryId);
      } else if (categoryId === 'help-text') {
        const helpText: string[] = [];
        printFullHelp((line) => helpText.push(line));
        options.logInfo(helpTitle(), helpText.join('\n'));
      }

      break helpLoop;
    } catch (error: any) {
      if (error.message !== 'cancelled' && error.message !== 'User cancelled') {
        const helpText: string[] = [];
        printFullHelp((line) => helpText.push(line));
        options.logInfo(helpTitle(), helpText.join('\n'));
      }
      break helpLoop;
    }
  }
}
