/// plan_model.dart — 共享代码眼里的"套餐里的模型"只有这么多.
///
/// 会员 / 套餐是发行版的事 (商业版的 membership_provider)。模型列表要按套餐筛、
/// Pilot 要挑套餐里的对话模型 —— 这些共享页面只认这几个字段, 由发行版填。
/// 没有套餐的发行版 (开源版) 给 null。
library;

class PlanModel {
  const PlanModel({
    required this.modelId,
    required this.displayName,
    required this.allowed,
    this.modality = 'chat',
    this.vision,
  });

  final String modelId;
  final String displayName;

  /// 套餐里能不能用
  final bool allowed;

  /// 'chat' / 'image' / 'audio'
  final String modality;

  /// 能不能看图; null = 服务端没给
  final bool? vision;
}
