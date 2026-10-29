
import { directGenerateImage, directEditImage, directCutoutImage, type DirectGenerateResult } from './imageDirectClient';
import { buildRequestParams, type ImageParamValues } from '../state/imageGenParams';
import type { ImageTemplate, ImageTemplateStep } from '../state/imageTemplates';
import { trackImage } from './imageTelemetry';

export interface RunTemplateOptions {
  template: ImageTemplate;
  /** 主图 (edit/cutout 步输入; generate 步作参考图): 绝对路径或 dataURL. */
  input?: string;
  /** 额外参考图 (换装的服装图等). */
  reference?: string;
  /** 槽位值 — 填进 prompt 的 {key}. */
  slotValues?: Record<string, string>;
  /** 用户当前选中模型 (模板/步指定的 model 优先于它). */
  model?: string;
  /** 显式尺寸覆盖 (如高清放大按原图算好的目标尺寸). */
  size?: string;
}

export type RunTemplateResult = DirectGenerateResult & { stepsRun: number };

/** 槽位实例化: {key} → 用户值 → placeholder → (optional 时) 空串. */
export function instantiatePrompt(prompt: string, template: ImageTemplate, values?: Record<string, string>): string {
  return prompt.replace(/\{([\w一-龥-]+)\}/g, (_m, key: string) => {
    const v = values?.[key];
    if (v != null && v.trim() !== '') return v;
    const slot = template.slots?.find(s => s.key === key);
    return slot?.placeholder ?? '';
  });
}

const fail = (error: string, stepsRun: number): RunTemplateResult =>
  ({ ok: false, paths: [], fileUrls: [], count: 0, error, stepsRun });

export async function runImageTemplate(opts: RunTemplateOptions): Promise<RunTemplateResult> {
  const { template } = opts;
  /* 无 steps = 单步模板 (mode + prompt) — 统一成一条 step 走同一循环. */
  const steps: ImageTemplateStep[] = template.steps?.length
    ? template.steps
    : [{ op: template.mode === 'generate' ? 'generate' : 'edit' }];

  let curInput = opts.input;
  let last: DirectGenerateResult | null = null;
  let ran = 0;

  for (const step of steps) {
    const model = step.model ?? template.model ?? opts.model;
    const mergedParams = { ...(template.params ?? {}), ...(step.params ?? {}) } as ImageParamValues;
    const p = buildRequestParams(mergedParams);
    const size = opts.size ?? p.size;
    const prompt = instantiatePrompt(step.prompt ?? template.prompt, template, opts.slotValues);

    let res: DirectGenerateResult;
    if (step.op === 'generate') {
      res = await directGenerateImage({
        prompt, model, size,
        n: p.n, quality: p.quality, background: p.background,
        outputCompression: p.outputCompression, providerOptions: p.providerOptions,
        image: curInput ? [curInput] : undefined,
      });
    } else if (step.op === 'cutout') {
      if (!curInput) return fail('cutout step needs an input image', ran);
      res = await directCutoutImage(curInput, model);
    } else {
      if (!curInput) return fail('edit step needs an input image', ran);
      res = await directEditImage({
        prompt, source: curInput,
        references: opts.reference ? [opts.reference] : undefined,
        model, size,
      });
    }
    ran++;
    if (!res.ok || !res.paths?.[0]) return { ...res, stepsRun: ran };
    curInput = res.paths[0];
    last = res;
  }

  if (last?.ok) trackImage('template_use', { templateId: template.id, steps: ran }, last.mode);
  return { ...(last as DirectGenerateResult), stepsRun: ran };
}
