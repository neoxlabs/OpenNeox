/**
 * Neox 用户目录的**唯一真相源**。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────
 * 极简版 (Neox Lite) 是独立发行的产品, 要跟标准版**同机共存且互不干扰**。
 * 但 `auth.enc` / `config.json` / `machine-id` / 日志 / sessions 原先全写死在
 * `os.homedir()/.neox` —— 桌面端的 `app.setPath('userData', …)` **管不着 homedir**,
 * 而极简版是纯 CLI, 连 userData 这一层都没有。
 *
 * 不隔离的后果, 最难受的一条: 在极简版点登出会删掉共用的 auth.enc, 标准版跟着掉线
 * (反向亦然)。其次是会话库共用 —— 极简版只有 24 个工具, 打开一个标准版建的会话,
 * 历史里全是它没有的工具调用。
 *
 * (这套机制和这段说明来自办公版 的隔离改动,  移植到极简版分支,
 *  只换了目录名。两个发行版是同一类问题, 同一个解法。)
 *
 * ── 为什么放在 kernel ────────────────────────────────────────────────────
 * `'.neox'` 这个字面量原先散在 **9 个包 / 158 行**里, 含最底层的 neox-kernel。
 * 常量必须落在**所有人都能引**的那一层, 否则又会分裂成"改了一半"的隔离 ——
 * 而半隔离比不隔离更危险: 你以为分开了, 实际还共用着 auth。
 * kernel 无任何内部依赖, 是唯一满足条件的层。
 *
 *  新增文件必须同时在 package.json 的 exports 白名单里加 `./platform/neoxHome.js`
 * —— 那张表是逐文件枚举的, 漏了**只炸打包版, dev 完全正常**。
 *
 *  改这个值等于换掉用户的全部本地数据位置。标准版永远是 `.neox`, 只有发行版分支
 *    才换 (办公版 `.neox-work` / 极简版 `.neox-lite`)。不要为了"测试方便"临时改它。
 *
 *  只管 **home 系**。`<workspace>/.neox/` 是项目本地元数据 (知识卡 / session-memory /
 *    cron / plans), 跟 .git 同级, 各发行版共用是对的 —— 那 44 处一律不动。
 */
import * as os from 'node:os';
import * as path from 'node:path';

/** 用户目录名 —— 标准版永远是 `.neox`。
 *
 *    `Merge branch 'lite'` 把极简版的 `.neox-lite` 带进了 main, 3.5.3 ~ 3.6.7 的
 *  标准版全在读写 `~/.neox-lite`: 老用户升级即掉登录、BYOK 配置和记忆"消失"。 改回,
 *  并由 database.ts 的 migrateLiteHomeToStandard() 在启动时把那一周的数据合并回 `.neox`。
 *  lite 分支自己改这个值; 从 main 往 lite 合并时这一行必须保留 lite 的。 */
export const NEOX_HOME_DIRNAME = '.neox';

/** 极简版 (lite 分支) 的目录名 —— 标准版只在"把误写进去的数据合并回来"时用它。 */
export const LITE_HOME_DIRNAME = '.neox-lite';

/** `~/.neox/<...parts>` 的绝对路径。 */
export function neoxHome(...parts: string[]): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, ...parts);
}
