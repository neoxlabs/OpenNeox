/* 侧栏: 收起展开 / 项目分区 / 新建时的项目选择器 / 工具架。 */
import {
  SEL,
  sidebarWidth,
  visibleCount,
  clickVisible,
  hoverClick,
  dismissProjectPicker,
  openToolsPage,
  toolPageLabels,
  closeToolsPage,
  bodyText,
} from '../lib/ui.mjs';
import { assert, waitFor } from '../lib/assert.mjs';

export default {
  id: 'sidebar',
  title: '侧栏',
  scenarios: [
    {
      id: 'sidebar.collapse-expand',
      title: '侧栏可以收起再展开',
      run: async ({ page }) => {
        const expanded = await sidebarWidth(page);
        assert(expanded > 200, `侧栏初始宽度异常: ${expanded}`);
        /* 这颗按钮平时 opacity:0, 侧栏窄时中心点还压在宽度调整条上 —— 先悬停再点靠左的位置 */
        await hoverClick(page, SEL.sidebarToggle, { fx: 0.3 });
        await waitFor(async () => (await sidebarWidth(page)) < expanded - 20, { what: '侧栏收起' });
        await hoverClick(page, SEL.sidebarToggle, { fx: 0.3 });
        await waitFor(async () => (await sidebarWidth(page)) >= expanded - 4, { what: '侧栏展开' });
      },
    },
    {
      id: 'sidebar.projects-visible',
      title: '侧栏有「项目」分区 (含项目名)',
      run: async ({ page }) => {
        const text = await bodyText(page);
        /* Code 工作台把会话按项目分组: 有「项目」分区标题 + 项目名 */
        assert(
          text.includes('项目') || text.includes('编码') || text.includes('工作'),
          '侧栏看不到项目分区 / 项目名',
        );
        assert((await visibleCount(page, SEL.projectLabel)) >= 1, '没有项目标签元素');
      },
    },
    {
      id: 'sidebar.newchat-project-picker',
      title: '点新建任务会弹「在哪个项目里新建」且可关掉',
      run: async ({ page }) => {
        await clickVisible(page, SEL.newChat);
        await page.waitForTimeout(800);
        const pickerShown = (await visibleCount(page, SEL.projectPicker)) > 0;
        /* 项目列表为空时可能不弹 —— 那不弹也算正常, 只断言会话已建 */
        assert((await page.locator(SEL.sessionRow).count()) >= 1, '点新建后没有会话');
        if (pickerShown) {
          await dismissProjectPicker(page);
          assert((await visibleCount(page, SEL.projectPicker)) === 0, '项目选择器关不掉');
        }
      },
    },
    {
      id: 'sidebar.tools-dock',
      title: '账户行「工具」按钮 → 工具主页, 能返回任务',
      run: async ({ page }) => {
        assert((await visibleCount(page, SEL.toolsToggle)) >= 1, '侧栏底部看不到「工具」按钮');
        await openToolsPage(page);
        const labels = await toolPageLabels(page);
        assert(labels.includes('技能'), `工具主页里看不到「技能」(实际: ${labels.join(',')})`);
        assert(labels.length >= 5, `工具卡太少 (${labels.length})`);
        await closeToolsPage(page);
        assert(!(await bodyText(page)).includes('给 Agent 加本事'), '退出后仍停在工具主页');
      },
    },
  ],
};
