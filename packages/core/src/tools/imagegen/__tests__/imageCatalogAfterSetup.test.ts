import { describe, it, expect } from 'vitest';
import { generateImageTool } from '../imageGenTools.js';
import { setupImageGenResolvers } from '../../../server/services/imageGenSetup.js';

describe('出图模型目录 · 接线之后', () => {
  it('接线前读过描述, 接线后描述里能看到真实可用的模型', () => {
    const before = String(generateImageTool.description);
    expect(before).toMatch(/UNAVAILABLE right now/);

    setupImageGenResolvers(
      () => undefined,
      () => undefined,
      () => [{
        id: 'relay-img', name: 'relay', baseUrl: 'https://example.invalid/v1', apiKey: 'k',
        models: [{ id: 'gpt-image-2' }],
        capabilities: [{ modality: 'image', protocol: 'openai-images', enabled: true }],
      } as any],
      () => [],
    );

    const after = String(generateImageTool.description);
    expect(after).not.toMatch(/UNAVAILABLE right now/);
    expect(after).toMatch(/gpt-image-2/);
  });
});
