/// model_gateway_client.dart — 手机本机模式的"托管模型网关"契约.
///
/// 托管网关 = 不用自己的 Key、由服务方代付并计量的那条模型通道 (订阅计费)。
/// BYOK 直连是另一条 (core/byok/), 两条计费彻底隔离。
///
/// 网关是托管服务, 由发行版提供 (见 core/edition/edition.dart 的 modelGateway):
/// 商业版注册 NeoxCloud 的实现; 没有网关的发行版拿到 [UnavailableModelGateway] ——
/// 行为跟商业版"未登录"时一样: 列模型报错 (手机本地模式据此退到 BYOK), 发请求报错。
library;

import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../edition/edition.dart';
import '../llm/sse.dart' show CancelToken;
import 'package:neox_app/core/i18n/tr.dart';

class GatewayModel {
  const GatewayModel({
    required this.id,
    required this.name,
    this.family,
    this.isByok = false,
    this.modalities = const [],
    this.isImageGeneration = false,
    this.relativeCost,
    this.payAsYouGo = false,
  });

  /// 按量模型的 id 前缀 (跟桌面同一个 providerId): 不走订阅额度, 从平台余额按官方价扣
  static const String paygPrefix = 'neox-cloud-payg:';

  final String id;

  /// 按量模型 (id 带 [paygPrefix]) —— 选择器里单独成组, 也不参与"默认挑最省的"
  final bool payAsYouGo;
  final String name;
  final String? family;

  /// true = 用户自己的 Key (byok/ 前缀), 计费走厂商; false = 订阅模型走网关.
  final bool isByok;

  /// 'chat' / 'image' —— 服务端按 model_channels 的 api_protocol 算出来的。
  /// 空 = 服务端没给 (老版本), 按能聊天处理, 别把正常模型误滤掉。
  final List<String> modalities;

  /// 按张计费的出图模型 (服务端 image_billing_mode 非空)。
  ///
  /// 光看 modalities 判不出来: nano-banana-2 走 gemini-generate-content 协议,
  /// 按协议算出来是 'chat', 于是它混在对话的模型选择器里 —— 真机实测就漏了它。
  final bool isImageGeneration;

  /// 额度消耗速度 (基准模型 = 1.0, 已含倍率)。null = 服务端没给 (BYOK / 基准缺失),
  /// 这时**不画**速度条 —— 画一条灰的会被当成"消耗极低"。
  final double? relativeCost;

  /// 能不能拿来聊天。出图模型不该出现在对话的模型选择器里 —— 出图在图片工作台。
  bool get canChat =>
      !isImageGeneration && (modalities.isEmpty || modalities.contains('chat'));
}

abstract class ModelGatewayClient {
  /// 网关上当前账号能用的模型。不可用 (未登录 / 断网 / 没有网关) 时抛错, 由调用方兜底。
  Future<List<GatewayModel>> listModels();

  /// 纯聊天流式调用, 返回完整回复。
  Future<String> streamChat({
    required String modelId,
    required List<Map<String, Object?>> messages,
    required void Function(String delta) onDelta,
    CancelToken? cancel,
  });

  /// 平台按量目录 (id 带 [GatewayModel.paygPrefix])。没有就空列表, 不抛错。
  Future<List<GatewayModel>> listPayAsYouGoModels();

  /// Agent SDK 工具循环用 — 现算网关流式端点 + 带新鲜凭证的 headers.
  /// [payg] = 这一发按量计费 (只扣平台余额, 不碰订阅额度)。
  Future<({String url, Map<String, String> headers})> streamAuth({bool payg = false});

  /// 有没有托管网关 (订阅的声音据此决定能不能选; 登没登录另算)。
  bool get hosted;

  /// 语音合成 (订阅附带, 计在套餐里): 一句话 → 音频字节。
  Future<Uint8List> speech({required String text, required String model, required String voice, String format = 'mp3'});

  /// 网关错误文案 (公开给 SDK connector 复用).
  String gatewayErrorText(int status, String body);
}

/// 没有托管网关 —— 所有调用都如实报"没有", 让手机本地模式退到自己的 Key。
class UnavailableModelGateway implements ModelGatewayClient {
  const UnavailableModelGateway();

  static String get _reason => tr('没有可用的托管模型 — 请在「我的模型」里接入自己的 Key，或下载本机模型');

  @override
  Future<List<GatewayModel>> listModels() async => throw StateError(_reason);

  @override
  Future<String> streamChat({
    required String modelId,
    required List<Map<String, Object?>> messages,
    required void Function(String delta) onDelta,
    CancelToken? cancel,
  }) async => throw StateError(_reason);

  @override
  Future<List<GatewayModel>> listPayAsYouGoModels() async => const [];

  @override
  Future<({String url, Map<String, String> headers})> streamAuth({bool payg = false}) async =>
      throw StateError(_reason);

  @override
  bool get hosted => false;

  @override
  Future<Uint8List> speech({required String text, required String model, required String voice, String format = 'mp3'}) async =>
      throw StateError(_reason);

  @override
  String gatewayErrorText(int status, String body) => tr('模型请求失败 ($status)');
}

final modelGatewayClientProvider = Provider<ModelGatewayClient>(
  (ref) => ref.watch(editionProvider).modelGateway(ref),
);
