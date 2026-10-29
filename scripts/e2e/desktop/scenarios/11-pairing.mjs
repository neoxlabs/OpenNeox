/* 手机配对页 (= 设置 → 远程访问) 能打开不报错。 */
import {
  openSettings,
  closeSettings,
  gotoSettingsSection,
  activeSettingsSection,
  settingsBodyText,
} from '../lib/ui.mjs';
import { assert } from '../lib/assert.mjs';

export default {
  id: 'pairing',
  title: '手机配对页',
  scenarios: [
    {
      id: 'pairing.open',
      title: '设置 → 远程访问 (手机配对页) 能打开且无报错',
      run: async ({ page }) => {
        await openSettings(page);
        /* 这个分区叫过「手机连接」, 现在是「远程访问」—— 两个名字都认, 以实际点中的为准 */
        const section = await gotoSettingsSection(page, ['手机连接', '远程访问']);
        assert((await activeSettingsSection(page)) === section, '没有切到手机配对分区');
        const text = await settingsBodyText(page);
        assert(text.trim().length > 0, '手机配对页内容为空');
        /* 配对页核心信息: 设备 / 配对手机 / 连接方式 */
        assert(
          text.includes('配对') || text.includes('设备') || text.includes('本机') || text.includes('连接'),
          `手机配对页看不到设备/配对信息 (前 120 字: ${text.slice(0, 120).replace(/\n/g, '|')})`,
        );
        for (const sign of ['Cannot read propert', 'is not a function', 'Uncaught']) {
          assert(!text.includes(sign), `手机配对页出现报错「${sign}」`);
        }
        await closeSettings(page);
      },
    },
  ],
};
