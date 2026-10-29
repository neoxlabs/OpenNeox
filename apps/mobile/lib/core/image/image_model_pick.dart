/// image_model_pick.dart — 从网关模型列表里挑一个能出图的.
///
/// 起因 (2026-08-11): 生图一直报「该模型已停用, 请选择其他模型」。
/// 查下来是两层错叠在一起:
///   1. 图片工作台把**聊天**模型 (selectedModelProvider, 比如 deepseek-v4-flash)
///      当图片模型发过去 —— 纯文本模型请求 /n1/images/generations 必然被拒;
///   2. 去掉之后回落到 service 里**硬编码**的 `gpt-image-1` —— 而网关早就换代了,
///      现在在列的是 gpt-image-2 / gpt-image-2-pro / nano-banana-2, 老名字同样被拒。
///
/// 硬编码一个模型名就是在赌服务端永远不换代, 而服务端一定会换。这里改成从
/// `/n1/models` 的真实列表里挑, 换代了自动跟上。
///
/// 排序是"最可能是用户想要的那个"而不是字母序:
///   显式偏好 > 已知出图家族里版本号最大的 > 名字里带 image 的 > 都没有则 null
/// (null 时调用方仍会发请求, 由服务端给出权威错误 —— 我们不替它编一个)。
library;

/// 一个模型 id 看起来像不像出图模型.
///
/// 只认名字, 因为 `/n1/models` 的 OpenAI 兼容形状里没有 modality 字段。
/// 宁可漏认 (退回 null 让服务端说话), 也不要把聊天模型误判成图片模型 ——
/// 那正是这个 bug 的成因。
bool looksLikeImageModel(String id) {
  final s = id.toLowerCase();
  if (s.contains('image')) return true;
  /* 出图家族的专有名字 —— 名字里没有 image 但确实是画图的 */
  const families = ['nano-banana', 'flux', 'dall-e', 'dalle', 'seedream', 'imagen'];
  return families.any(s.contains);
}

/// 从 [available] 里挑一个出图模型; 挑不出返回 null.
///
/// [preferred] 是用户在图片页显式选过的 —— 只要它还在列表里就优先用, 不替用户改主意。
String? pickImageModel(List<String> available, {String? preferred}) {
  final images = available.where(looksLikeImageModel).toList();
  if (images.isEmpty) return null;

  final want = preferred?.trim();
  if (want != null && want.isNotEmpty && images.contains(want)) return want;

  /* 同族里挑版本号最大的: gpt-image-2 > gpt-image-1。
   * -pro / -max 这类加强版排在同版本号前面, 但不跨版本号压过更新的。 */
  int score(String id) {
    final s = id.toLowerCase();
    final ver = RegExp(r'(\d+(?:\.\d+)?)').allMatches(s).isEmpty
        ? 0.0
        : double.tryParse(
              RegExp(r'(\d+(?:\.\d+)?)').allMatches(s).last.group(1)!,
            ) ??
            0.0;
    final tier = s.contains('-pro') || s.contains('-max') ? 1 : 0;
    return (ver * 10).round() + tier;
  }

  final sorted = [...images]..sort((a, b) {
      final d = score(b).compareTo(score(a));
      return d != 0 ? d : a.compareTo(b);
    });
  return sorted.first;
}
