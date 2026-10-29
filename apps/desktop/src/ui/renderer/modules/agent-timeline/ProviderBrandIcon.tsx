import React from 'react';
import neoxMarkUrl from '../../assets/brand/mark-ring-96.webp?inline';
import neoxMaskUrl from '../../assets/brand/mark-ring-mask.png?inline';


export type ProviderBrand =
  | 'auto'        /* Neox Cloud 自动路由的虚拟"模型" — 不是真 provider 但需要图标 */
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'kimi'
  | 'mimo'         /* 小米 MiMo */
  | 'deepseek'
  | 'glm'
  | 'doubao'
  | 'qwen'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'hunyuan'      /* 腾讯混元 — 网关上常缩写成 hy3 / hy4-preview */
  | 'meta'         /* Muse Spark / Muse Wonder / Llama */
  | 'openrouter'   /* 多厂牌网关 (服务商行用): 模型名认得出厂牌时一律让位给厂牌 */
  | 'opencode'
  | 'generic';

export function isAutoRoutedModelName(name?: string): boolean {
  const n = (name ?? '').trim().toLowerCase();
  if (!n) return false;
  return n === 'auto' || /(^|[-_/:])auto$/.test(n);
}

export function inferProviderBrand(input: {
  id?: string;
  name?: string;
  protocol?: string;
  providerId?: string;
}): ProviderBrand {
  const id = (input.id ?? '').toLowerCase();
  const name = (input.name ?? '').toLowerCase();
  /* input.protocol 仍在签名里 (调用方都在传), 但**不再参与判定** —— 见下面兜底那段说明。 */
  const pid = (input.providerId ?? '').toLowerCase();
  const hay = `${id} ${name} ${pid}`;

  /* Neox Cloud 自动路由 — model.name === 'auto' 的虚拟模型, 没有真实 provider.
   * 没图标的话 ModelPicker 按钮就只有 "auto" 字纯文字, 显得很秃, 给个 sparkles 兜底. */
  if (isAutoRoutedModelName(name) || isAutoRoutedModelName(id.split(':').pop())
    || /(^|[^a-z])auto-routed?($|[^a-z])/.test(hay)) return 'auto';

  if (/^grok|xai/.test(id) || hay.includes('grok') || hay.includes('xai')) return 'xai';
  if (/^claude/.test(id) || hay.includes('claude') || hay.includes('anthropic')) return 'anthropic';
  if (/^(muse|llama)|^meta[-/]/.test(id) || /\bmuse-|llama|meta\//.test(hay)) return 'meta';
  if (/^gemini/.test(id) || hay.includes('gemini')
    || /^nano-?banana|^imagen/.test(id) || hay.includes('nano-banana') || hay.includes('nanobanana')
    || hay.includes('imagen')) return 'gemini';

  /* 按 model id / 关键字 — 前缀匹配比 substring 稳 */
  if (/^gpt[- ]|^o\d|^codex|gpt-/.test(id) || /(^|[^a-z])gpt[- ]/.test(hay)
    || /(^|[^a-z])(dall-?e|sora)($|[^a-z])/.test(hay) || hay.includes('openai')) return 'openai';
  if (/^kimi|moonshot/.test(id) || hay.includes('kimi') || hay.includes('moonshot')) return 'kimi';
  if (/^mimo/.test(id) || hay.includes('mimo') || hay.includes('xiaomi')) return 'mimo';
  if (/^deepseek/.test(id) || hay.includes('deepseek')) return 'deepseek';
  if (/^glm|chatglm|zhipu/.test(id) || hay.includes('glm') || hay.includes('zhipu')) return 'glm';
  if (/^doubao|^seed|^bytedance/.test(id) || hay.includes('doubao') || hay.includes('seedream') || hay.includes('seedance') || hay.includes('bytedance')) return 'doubao';
  if (/^qwen|tongyi/.test(id) || hay.includes('qwen')) return 'qwen';
  if (/^mistral|^codestral|^mixtral/.test(id) || hay.includes('mistral')) return 'mistral';
  if (/^minimax|^abab/.test(id) || hay.includes('minimax') || hay.includes('abab')) return 'minimax';
  /* 腾讯混元 —— 网关上几乎都缩写成 hy: opencode 的 hy3 / hy3-preview / hy4-preview。
   * `^hy\d` 要求 hy 后面紧跟数字, 不会误吃 hybrid / hyper 这类词。 */
  if (/^hy\d|^hunyuan/.test(id) || hay.includes('hunyuan') || /(^|[^a-z])hy\d/.test(hay)) return 'hunyuan';


  /* openrouter / opencode 这两个网关牌子**不在这里**判: 这个函数回答「模型是谁家的」, 网关不造模型。
   * 只有设置页的服务商行 (ProvidersTab providerRowBrand) 会用到它们。 */
  return 'generic';
}

/* Vite eager glob — 构建期把所有 svg 收集成 { './openai.svg': '/assets/openai-xxxx.svg' } */
const ICONS = import.meta.glob('../../assets/icons/providers/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function resolveIconUrl(brand: ProviderBrand): string | null {
  if (brand === 'generic') return neoxMarkUrl;
  if (brand === 'auto') return neoxMarkUrl;
  const key = Object.keys(ICONS).find(p => p.endsWith(`/${brand}.svg`));
  return key ? ICONS[key] : null;
}

interface IconProps {
  brand: ProviderBrand;
  size?: number;
  className?: string;
}

export const ProviderBrandIcon: React.FC<IconProps> = ({ brand, size = 14, className }) => {
  /* Neox 自己的标 (neox-free / 自动路由 / 认不出的兜底) 跟主题走: 深色底白标, 浅色底黑标 (10-21 用户)。
   * 用标的轮廓当遮罩、填主题文字色, 换主题不用换图。 */
  if (brand === 'generic' || brand === 'auto') {
    const mask = `url(${neoxMaskUrl}) center / contain no-repeat`;
    return (
      <span
        className={className}
        aria-hidden="true"
        style={{ width: size, height: size, display: 'block', flex: 'none', background: 'currentColor', WebkitMask: mask, mask }}
      />
    );
  }
  const url = resolveIconUrl(brand);
  if (!url) return null; /* 只有资源真缺失才不渲染 — generic 现在也有 Neox mark 兜底 */
  return (
    <img
      src={url}
      alt={brand}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', display: 'block' }}
      aria-hidden="true"
      draggable={false}
    />
  );
};
