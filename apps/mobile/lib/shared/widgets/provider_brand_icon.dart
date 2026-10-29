/// provider_brand_icon.dart — 模型来源厂商的官方 mark。
///
/// 桌面端一直有这个 (ProviderBrandIcon.tsx), 手机端的模型选择器却只有裸文字 id ——
/// 用户对比后原话: "也没有做素材图标 官方的 客户端都有"。
///
/// 素材跟桌面端**同一批** (assets/icons/providers/*.svg, simple-icons CC0 /
/// lobe-icons MIT), 推断规则也逐条照搬 —— 两端认不出同一个模型会更奇怪。
library;

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

enum ProviderBrand {
  auto,
  openai,
  anthropic,
  gemini,
  kimi,
  mimo,
  deepseek,
  glm,
  doubao,
  qwen,
  xai,
  mistral,
  minimax,
  hunyuan, /* 腾讯混元 —— 网关上常缩写成 hy3 / hy4-preview (同桌面) */
  generic,
}

/* ── 厂商判定的正则, 全部提到顶层 ──
 *
 * 2026-09-22: 原来这些 `RegExp(...)` 是**写在函数体里的字面量**, 每次执行到就重新
 * 编译一遍。而 [inferProviderBrand] 在模型选择器里**每行**都要调一次 (每行左侧一个
 * 厂商 mark), 300 个模型的列表滚起来就是持续重编正则 —— 在 120Hz 屏上尤其明显。
 * Dart 不会给函数体内的字面量做缓存, 提成顶层 final 后只在首次使用时编译一次。
 *
 * 顺序不变: 规则顺序本身就是语义 (见 inferProviderBrand 的各条注释)。 */
final _reAutoSuffix = RegExp(r'(^|[-_/:])auto$');
final _reAutoRouted = RegExp(r'(^|[^a-z])auto-routed?($|[^a-z])');
final _reXai = RegExp(r'^grok|xai');
final _reAnthropic = RegExp(r'^claude');
final _reGemini = RegExp(r'^gemini');
final _reNanoBanana = RegExp(r'^nano-?banana|^imagen');
final _reOpenaiHead = RegExp(r'^gpt[- ]|^o\d|^codex|gpt-');
final _reOpenaiHay = RegExp(r'(^|[^a-z])gpt[- ]');
final _reOpenaiImage = RegExp(r'(^|[^a-z])(dall-?e|sora)($|[^a-z])');
final _reKimi = RegExp(r'^kimi|moonshot');
final _reMimo = RegExp(r'^mimo');
final _reDeepseek = RegExp(r'^deepseek');
final _reGlm = RegExp(r'^glm|chatglm|zhipu');
final _reDoubao = RegExp(r'^doubao|^seed|^bytedance');
final _reQwen = RegExp(r'^qwen|tongyi');
final _reMistral = RegExp(r'^mistral|^codestral|^mixtral');
final _reMinimax = RegExp(r'^minimax|^abab');
final _reHunyuan = RegExp(r'^hy\d|^hunyuan|(^|[^a-z])hy\d');

/// 自动路由虚拟模型 —— id 不是裸 'auto' (free 档是 or-free-auto, 付费档 or-pro-auto)。
bool isAutoRoutedModelName(String? name) {
  final n = (name ?? '').trim().toLowerCase();
  if (n.isEmpty) return false;
  return n == 'auto' || _reAutoSuffix.hasMatch(n);
}

/// 规则顺序跟桌面端 inferProviderBrand 完全一致 —— 顺序本身就是语义
/// (grok 要在 anthropic 之前判, minimax 要在 mistral 之后判, 见各条注释)。
ProviderBrand inferProviderBrand({String? id, String? name, String? providerId}) {
  final i = (id ?? '').toLowerCase();
  final n = (name ?? '').toLowerCase();
  final p = (providerId ?? '').toLowerCase();
  final hay = '$i $n $p';

  if (isAutoRoutedModelName(n) ||
      isAutoRoutedModelName(i.split(':').last) ||
      _reAutoRouted.hasMatch(hay)) {
    return ProviderBrand.auto;
  }
  /* xAI Grok 常经 Anthropic 协议代理接入 —— 必须在 anthropic 之前判, 否则挂成 Claude */
  if (_reXai.hasMatch(i) || hay.contains('grok') || hay.contains('xai')) {
    return ProviderBrand.xai;
  }
  if (_reAnthropic.hasMatch(i) ||
      hay.contains('claude') ||
      hay.contains('anthropic')) {
    return ProviderBrand.anthropic;
  }
  /* Google 家的出图模型不叫 gemini —— nano-banana 是 Gemini 图像模型代号, imagen 是另一条线 */
  if (_reGemini.hasMatch(i) ||
      hay.contains('gemini') ||
      _reNanoBanana.hasMatch(i) ||
      hay.contains('nano-banana') ||
      hay.contains('nanobanana') ||
      hay.contains('imagen')) {
    return ProviderBrand.gemini;
  }
  if (_reOpenaiHead.hasMatch(i) ||
      _reOpenaiHay.hasMatch(hay) ||
      _reOpenaiImage.hasMatch(hay) ||
      hay.contains('openai')) {
    return ProviderBrand.openai;
  }
  if (_reKimi.hasMatch(i) || hay.contains('kimi') || hay.contains('moonshot')) {
    return ProviderBrand.kimi;
  }
  if (_reMimo.hasMatch(i) || hay.contains('mimo') || hay.contains('xiaomi')) {
    return ProviderBrand.mimo;
  }
  if (_reDeepseek.hasMatch(i) || hay.contains('deepseek')) {
    return ProviderBrand.deepseek;
  }
  if (_reGlm.hasMatch(i) || hay.contains('glm') || hay.contains('zhipu')) {
    return ProviderBrand.glm;
  }
  if (_reDoubao.hasMatch(i) ||
      hay.contains('doubao') ||
      hay.contains('seedream') ||
      hay.contains('seedance') ||
      hay.contains('bytedance')) {
    return ProviderBrand.doubao;
  }
  if (_reQwen.hasMatch(i) || hay.contains('qwen')) {
    return ProviderBrand.qwen;
  }
  if (_reMistral.hasMatch(i) || hay.contains('mistral')) {
    return ProviderBrand.mistral;
  }
  /* minimax 要在 mistral 之后 —— 两个都是 mi- 开头 */
  if (_reMinimax.hasMatch(i) || hay.contains('minimax') || hay.contains('abab')) {
    return ProviderBrand.minimax;
  }
  if (_reHunyuan.hasMatch(i) || hay.contains('hunyuan') || _reHunyuan.hasMatch(hay)) {
    return ProviderBrand.hunyuan;
  }
  return ProviderBrand.generic;
}

/// 画成 currentColor 的单色 mark (要跟主题染色); 其余 svg 自带品牌色
const _kMonoBrands = {ProviderBrand.openai, ProviderBrand.kimi, ProviderBrand.mimo, ProviderBrand.xai};

/// 厂商 mark。
///
/// auto 和 generic 都用 Neox 自己的彩色圆环 —— 认不出品牌是常态 (第三方聚合渠道
/// 天天上新模型), 让它变成视觉缺口会使列表参差不齐。
class ProviderBrandIcon extends StatelessWidget {
  const ProviderBrandIcon({
    super.key,
    this.id,
    this.name,
    this.providerId,
    this.size = 18,
  });

  final String? id;
  final String? name;
  final String? providerId;
  final double size;

  @override
  Widget build(BuildContext context) {
    final brand = inferProviderBrand(id: id, name: name, providerId: providerId);
    /* 自动路由和我们自己的模型 (Neox Free 等) 才用 Neox 标 */
    final ownModel = brand == ProviderBrand.generic &&
        '${id ?? ''} ${name ?? ''}'.toLowerCase().contains('neox');
    if (brand == ProviderBrand.auto || ownModel) {
      return Image.asset(
        'assets/brand/mark-clay.png',
        width: size,
        height: size,
        filterQuality: FilterQuality.medium,
      );
    }
    /* 认不出厂牌: 中性的灰色小图标, 不拿 Neox 自己的标冒充模型厂商 (4.0.2 用户:「不要显示我们自己的图标」) */
    if (brand == ProviderBrand.generic) {
      return Icon(Icons.hub_outlined, size: size * 0.9, color: Theme.of(context).colorScheme.onSurfaceVariant);
    }
    /* 只有单色 (currentColor) 的 mark 跟着主题染前景色, 暗色下不染就是隐形;
     * 彩色的 (DeepSeek 蓝鲸 / Claude 橙 / Gemini 渐变 …) 保持原色 —— 原来一律染成墨色, 全变成黑剪影 */
    if (!_kMonoBrands.contains(brand)) {
      return SvgPicture.asset('assets/icons/providers/${brand.name}.svg', width: size, height: size);
    }
    final tint = Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.9);
    return SvgPicture.asset(
      'assets/icons/providers/${brand.name}.svg',
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(tint, BlendMode.srcIn),
    );
  }
}
