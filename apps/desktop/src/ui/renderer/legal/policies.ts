/**
 * 法律文档 + 版本号 — 单一信息源.
 *
 *   markdown 源在 docs/legal/*.zh.md, 通过 Vite ?raw 直接 import 字符串内容.
 *   ConsentModal 渲染 markdown 给用户看; localStorage 存"已同意的版本号", 跟
 *   LEGAL_VERSION 比对, 不一致就强制再次弹窗.
 *
 *   版本递进规则:
 *     · '0.1.0-draft' — 律师审定前的开发草稿期, 一直保持. 内测用户首次启动会弹一次.
 *     · '1.0.0'       — 律师审定后的首个正式版.
 *     · '1.1.0' / '2.0.0' — 重大变更 (收集范围 / 用途 / 第三方共享 / 跨境):
 *                            提前 7 日告知 + 强制再确认.
 *     · 仅 typo / 排版修订: 不动 LEGAL_VERSION, 用户无感, 不重复打扰.
 */
import termsRaw from '../../../../../../docs/legal/terms_of_service.zh.md?raw';
import privacyRaw from '../../../../../../docs/legal/privacy_policy.zh.md?raw';
import inventoryRaw from '../../../../../../docs/legal/data_inventory.zh.md?raw';

export const LEGAL_VERSION = '0.1.0-draft';

export type LegalDocId = 'terms' | 'privacy' | 'data_inventory';

export interface LegalDoc {
  id: LegalDocId;
  title: string;
  /** tab 列表显示的简短副标题 */
  subtitle: string;
  content: string;
}

export const LEGAL_DOCS: readonly LegalDoc[] = [
  { id: 'terms',          title: '用户协议',  subtitle: '服务条款 / 双方权利义务', content: termsRaw     },
  { id: 'privacy',        title: '隐私政策',  subtitle: '收集 / 使用 / 共享',       content: privacyRaw   },
  { id: 'data_inventory', title: '数据清单',  subtitle: '个保法 §17/§30 详细附录',  content: inventoryRaw },
];
