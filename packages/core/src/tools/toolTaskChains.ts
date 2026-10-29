
export interface TaskChain {
  /** 稳定 id, 日志与测试用 */
  id: 'ppt' | 'sheet' | 'word';
  /** 回给模型看的短名 */
  label: string;
  /**
   * 命中关键词 (query 归一化后包含任意一个即命中)。
   * 中英都收: 模型可能传 "做个PPT" / "excel 透视" / "写文档"。
   */
  keywords: string[];
  /** 链上的工具 (按使用顺序)。toolMap 里没有的会被跳过。 */
  toolNames: string[];
  /** 这些工具归属于哪些 pack — 只用于漂移测试, 不参与解锁。 */
  packIds: string[];
  /** 解锁后回给模型的一句话: 这条链怎么走。 */
  hint: string;
}

export const TASK_CHAINS: readonly TaskChain[] = [
  {
    id: 'ppt',
    label: 'PPT 演示文稿',
    keywords: [
      'ppt', 'pptx', 'slide', 'slides', 'presentation', 'deck', 'keynote',
      '幻灯片', '演示文稿', '演示', '课件', '做ppt', '出个ppt',
    ],
    toolNames: [
      'deck_begin', 'deck_add_slide', 'deck_export',
      'list_slide_templates', 'pptx_read', 'pptx_replace_text',
      'generate_image', 'edit_image',
    ],
    packIds: ['pptx', 'image_gen'],
    hint: '做 deck: use_skill("pptx-deck-writer") → deck_begin(大纲/风格) → deck_add_slide(每次一页) → deck_export;'
      + ' 读/改用户已有的 .pptx 用 pptx_read / pptx_replace_text; 配图用 generate_image / edit_image。',
  },
  {
    id: 'sheet',
    label: 'Excel 表格',
    keywords: [
      'excel', 'xlsx', 'csv', 'spreadsheet', 'workbook', 'sheet',
      '表格', '工作表', '电子表格', '做表', '数据表', '透视',
    ],
    toolNames: [
      'sheet_describe', 'sheet_get_range',
      'sheet_new_workbook', 'sheet_write_range', 'sheet_set_cells',
      'sheet_export_file',
    ],
    packIds: ['sheet'],
    hint: '做表: sheet_describe(看结构) → sheet_get_range(读区域) → 新表用 sheet_new_workbook + sheet_write_range,'
      + ' 改已有 .xlsx 用 sheet_set_cells(保公式/样式) → sheet_export_file 导出。',
  },
  {
    id: 'word',
    label: 'Word 文档',
    keywords: [
      'word', 'docx', 'document', 'report', 'proposal', 'minutes',
      '文档', '写文档', '改文档', '公文', '合同', '纪要', '周报', '月报', '方案', '报告',
    ],
    toolNames: [
      'word_create', 'word_describe', 'word_get_paragraphs',
      'word_replace_text', 'word_edit_paragraph', 'word_insert_paragraph', 'word_delete_paragraph',
      'word_get_tables', 'word_get_table', 'word_set_cell',
      'word_export', 'word_to_pdf',
    ],
    packIds: ['word'],
    hint: '写/改文档: word_create 或 word_describe(看结构) → word_get_paragraphs(读) →'
      + ' word_replace_text / word_edit_paragraph / word_insert_paragraph 原地改(保格式) → word_export / word_to_pdf 交付。',
  },
];

/** 归一化: 小写 + 去掉空白, 让「做个 PPT」「做个ppt」都能命中。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * 单条关键词是否命中。
 *
 * 纯 ASCII 词按**词边界**匹配: 归一化之后的 query 里, `keyword` / `password`
 * 都包含 `word`, 子串匹配会整链解锁 12 个 Word 工具; `xlsx` 之于 `xls` 同理。
 * 中文没有词边界, 仍按子串 (「写文档」「改文档」都要命中 `文档`)。
 */
function matchesKeyword(normalizedQuery: string, keyword: string): boolean {
  const k = normalize(keyword);
  if (!k) return false;
  if (/^[a-z0-9]+$/.test(k)) {
    return new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`).test(normalizedQuery);
  }
  return normalizedQuery.includes(k);
}

/** query 命中的任务链; 可能多条 (例如「把 Excel 做成 PPT」)。 */
export function matchTaskChains(query: string | undefined | null): TaskChain[] {
  const q = normalize(query ?? '');
  if (!q) return [];
  return TASK_CHAINS.filter(chain => chain.keywords.some(k => matchesKeyword(q, k)));
}

/** 这批工具里只要有一个属于某条链, 就把那条链也算上 (模型按工具名搜时同样整链解锁)。 */
export function taskChainsForTools(toolNames: Iterable<string>): TaskChain[] {
  const names = new Set(toolNames);
  return TASK_CHAINS.filter(chain => chain.toolNames.some(n => names.has(n)));
}
