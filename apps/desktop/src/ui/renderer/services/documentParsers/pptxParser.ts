import { readDeck, slidesToMarkdown } from './pptxText';

export async function parsePptxLocal(buffer: ArrayBuffer): Promise<{ markdown: string; pages: number }> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const deck = await readDeck(async (p) => (await zip.file(p)?.async('string')) ?? null, { notes: true });
  return { markdown: slidesToMarkdown(deck, { notes: true }), pages: deck.length };
}
