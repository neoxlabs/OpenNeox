
export type ImageTelemetryEvent =
  | 'generate'            // 文生图
  | 'edit'                // 描述编辑 (img2img)
  | 'cutout'              // 去背景
  | 'compare_keep_one'    // 抽卡对比里只保留一张
  | 'batch_capability'    // 图库批量套能力
  | 'export_sizes'        // 平台尺寸导出
  | 'template_save'       // 保存模板/能力
  | 'template_use';       // 用模板出图

export function trackImage(
  event: ImageTelemetryEvent,
  props: Record<string, unknown> | undefined,
  /** 出图结果的 mode — 只有 'neoxcloud' 会被记录. */
  mode: string | undefined,
): void {
  if (mode !== 'neoxcloud') return;   // BYOK/未知 → 不收集 (合规)
  try {
    const api = (window as unknown as { neox?: { imageTrack?: (p: unknown) => Promise<unknown> } }).neox;
    void api?.imageTrack?.({ event, props: props ?? {}, ts: Date.now() })?.catch?.(() => { /* 埋点失败不打扰 */ });
  } catch { /* noop */ }
}
