/// 手机上能跑的本地大模型目录: 内置一批 + 用户在线搜索添加的。
///
/// 两种引擎:
///   · GGUF (llama.cpp) —— CPU, 哪台手机都能跑, 在线搜索添加的也是这种
///   · LiteRT (.litertlm, Google LiteRT-LM) —— GPU (OpenCL, 天玑 Mali / 高通 Adreno 都行), 以及按芯片
///     预编译的 NPU 版 (联发科 APU: mt6989 天玑 9300 / mt6991 天玑 9400 / mt6993 天玑 9500)
/// 每个文件三个源, 按顺序试: ModelScope (国内直连快, 连 Gemma 这类 HF 要登录的也能匿名下) → hf-mirror →
/// HuggingFace; 断点续传 (Range), 有 sha256 的下完校验 (取自 HuggingFace LFS 元数据; 受限仓库拿不到就不校验)。
///
/// 内置的挑 llama_flutter_android 里那版 llama.cpp (b8201) 确定支持、模板也对得上的:
/// Qwen2.5 / Qwen3 / SmolLM2 (chatml) 与 Gemma 3 (gemma)。Llama 3 / Phi / DeepSeek 的对话模板
/// 这个插件没有, 硬套 chatml 会答非所问, 所以不进内置 (搜索添加时模板交给插件按文件名猜)。
library;

import 'dart:convert';

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
import 'package:shared_preferences/shared_preferences.dart';

import '../models/model_store.dart';
import 'device_profile.dart';

/// 这台设备能不能跑本机模型 —— 所有入口 (模型菜单「本机模型」组 / 我的模型「本地部署」) 都问它。
/// 两个引擎都只有安卓端: llama_flutter_android 的 iOS 实现编不过 (ios/Podfile 里换成了桩),
/// LiteRT 走的是 LiteRtLmBridge.kt。iOS 上入口整个不出现, 而不是点进去下 2GB 再报不支持。
bool get kLocalLlmSupported => defaultTargetPlatform == TargetPlatform.android;

class LocalLlm {
  const LocalLlm({
    required this.id,
    required this.name,
    required this.params,
    required this.repo,
    required this.file,
    required this.size,
    required this.sha256,
    required this.template,
    required this.minTier,
    required this.minRamGb,
    this.hybridThinking = false,
    this.blurb = '',
    this.custom = false,
    this.engine = LlmEngineKind.gguf,
    this.npuSocs = const [],
  });

  /// 用哪个推理引擎跑
  final LlmEngineKind engine;

  /// 非空 = 按这些芯片预编译的 NPU 专用模型 (小写 SoC 型号, 如 'mt6991'), 只在这些手机上出现、只能走 NPU
  final List<String> npuSocs;

  bool get isNpu => npuSocs.isNotEmpty;

  final String id;
  final String name;

  /// 「1.7B」这类, 列表上显示
  final String params;

  /// HuggingFace / ModelScope 上的仓库名 (两边同名)
  final String repo;
  final String file;
  final int size;
  final String? sha256;

  /// llama_flutter_android 的对话模板名; null = 让插件按文件名猜 (搜索添加的)
  final String? template;
  final DeviceTier minTier;
  final double minRamGb;

  /// Qwen3 混合思考模型: 默认先想一大段再答 —— 手机上太慢, 发消息时关掉
  final bool hybridThinking;
  final String blurb;

  /// 用户在线搜索添加的 (可以从列表移除)
  final bool custom;

  /// 会话里的模型 id: `local:<id>`, 跟订阅 / BYOK 的 id 区分开
  String get modelId => 'local:$id';

  ModelPack get pack => ModelPack(
        kind: 'llm',
        id: id,
        title: name,
        approxBytes: size,
        files: [
          ModelFile(
            name: file,
            size: size,
            sha256: sha256,
            urls: [
              'https://modelscope.cn/models/$repo/resolve/master/$file',
              'https://hf-mirror.com/$repo/resolve/main/$file',
              'https://huggingface.co/$repo/resolve/main/$file',
            ],
          ),
        ],
      );

  /// 这台机器能不能用: NPU 版要芯片对得上且带了 NPU 调度库; LiteRT 通用版要有 OpenCL (没有就只能 CPU, 不如 GGUF)
  bool availableOn(DeviceProfile d) {
    if (isNpu) return d.npuReady && npuSocs.contains(d.socModel.toLowerCase());
    if (engine == LlmEngineKind.litert) return d.gpu;
    return true;
  }

  bool fits(DeviceProfile d) =>
      d.canRunLocalLlm && availableOn(d) && d.tier.index <= minTier.index && d.ramGb >= minRamGb;

  /// 列表上的加速标签
  String get accelLabel => isNpu ? 'NPU' : engine == LlmEngineKind.litert ? 'GPU' : 'CPU';

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'params': params,
        'repo': repo,
        'file': file,
        'size': size,
        'sha256': sha256,
        'template': template,
        'minTier': minTier.name,
        'minRamGb': minRamGb,
        'hybridThinking': hybridThinking,
      };

  static LocalLlm? fromJson(Object? j) {
    if (j is! Map) return null;
    try {
      return LocalLlm(
        id: j['id'] as String,
        name: j['name'] as String,
        params: (j['params'] as String?) ?? '',
        repo: j['repo'] as String,
        file: j['file'] as String,
        size: (j['size'] as num).toInt(),
        sha256: j['sha256'] as String?,
        template: j['template'] as String?,
        minTier: DeviceTier.values.firstWhere((t) => t.name == j['minTier'], orElse: () => DeviceTier.mid),
        minRamGb: (j['minRamGb'] as num?)?.toDouble() ?? 6,
        hybridThinking: j['hybridThinking'] == true,
        custom: true,
      );
    } catch (_) {
      return null;
    }
  }
}

enum LlmEngineKind { gguf, litert }

const List<LocalLlm> kBuiltinLocalLlms = [
  /* ── LiteRT: GPU 加速 (OpenCL) ─────────────────────────────────── */
  LocalLlm(
    id: 'lrt-qwen3-4b-2507',
    name: 'Qwen3 4B Instruct',
    params: '4B',
    repo: 'litert-community/Qwen3-4B-Instruct-2507',
    file: 'qwen3_4b_instruct_2507_mixed_int4.litertlm',
    size: 2659057664,
    sha256: '9e48b165836256f5344d9d044930607b9c47f6ef34e27f82e96881664f3ba2fd',
    template: null,
    minTier: DeviceTier.flagship,
    minRamGb: 11,
    engine: LlmEngineKind.litert,
    blurb: '最聪明, 要旗舰机',
  ),
  LocalLlm(
    id: 'lrt-gemma4-e2b',
    name: 'Gemma 4 E2B',
    params: '2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    file: 'gemma-4-E2B-it-gpu.litertlm',
    size: 2008432640,
    sha256: 'a53a59001894c58e6bdb5b9b227709f91a2e3e556baa7d85acf9c55402ba5cf5',
    template: null,
    minTier: DeviceTier.flagship,
    minRamGb: 8,
    engine: LlmEngineKind.litert,
    blurb: '多语言, 英文强',
  ),
  LocalLlm(
    id: 'lrt-qwen3-1.7b',
    name: 'Qwen3 1.7B',
    params: '1.7B',
    repo: 'litert-community/Qwen3-1.7B',
    file: 'Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm',
    size: 977184032,
    sha256: '2eeffef7b51bc3e1225ea69fe7aa5f417397934b56a5b6c20cc068d6fd2c918b',
    template: null,
    minTier: DeviceTier.mid,
    minRamGb: 6,
    engine: LlmEngineKind.litert,
    blurb: '中文好, 速度和质量平衡',
  ),
  LocalLlm(
    id: 'lrt-qwen3-0.6b',
    name: 'Qwen3 0.6B',
    params: '0.6B',
    repo: 'litert-community/Qwen3-0.6B',
    file: 'Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm',
    size: 344671744,
    sha256: '03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856',
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    blurb: '最小最快, 日常问答',
  ),
  LocalLlm(
    id: 'lrt-gemma3-1b',
    name: 'Gemma 3 1B',
    params: '1B',
    repo: 'litert-community/Gemma3-1B-IT',
    file: 'gemma3-1b-it-int4.litertlm',
    size: 584417280,
    sha256: null,
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    blurb: '英文更好',
  ),
  /* ── LiteRT: 联发科 NPU (APU) 预编译 —— 只在对应芯片上出现 ───────────────── */
  LocalLlm(
    id: 'npu-gemma3-1b-mt6991',
    name: 'Gemma 3 1B · NPU',
    params: '1B',
    repo: 'litert-community/Gemma3-1B-IT',
    file: 'Gemma3-1B-IT_q4_ekv1280_mt6991.litertlm',
    size: 1033814016,
    sha256: null,
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    npuSocs: ['mt6991'],
    blurb: '天玑 9400 专用',
  ),
  LocalLlm(
    id: 'npu-gemma3-1b-mt6989',
    name: 'Gemma 3 1B · NPU',
    params: '1B',
    repo: 'litert-community/Gemma3-1B-IT',
    file: 'Gemma3-1B-IT_q4_ekv1280_mt6989.litertlm',
    size: 1032830976,
    sha256: null,
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    npuSocs: ['mt6989'],
    blurb: '天玑 9300 专用',
  ),
  LocalLlm(
    id: 'npu-gemma3-1b-mt6993',
    name: 'Gemma 3 1B · NPU',
    params: '1B',
    repo: 'litert-community/Gemma3-1B-IT',
    file: 'Gemma3-1B-IT_q4_ekv1280_mt6993.litertlm',
    size: 1020411904,
    sha256: null,
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    npuSocs: ['mt6993'],
    blurb: '天玑 9500 专用',
  ),
  LocalLlm(
    id: 'npu-qwen3-0.6b-mt6993',
    name: 'Qwen3 0.6B · NPU',
    params: '0.6B',
    repo: 'litert-community/Qwen3-0.6B',
    file: 'Qwen3-0.6B.mediatek.mt6993.litertlm',
    size: 1202913280,
    sha256: 'cc87c8a3df6eb680266a385c22fc3e867824495ff676583716ebe77e6ddd6c97',
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    npuSocs: ['mt6993'],
    blurb: '天玑 9500 专用',
  ),
  /* ── GGUF (llama.cpp): CPU, 哪台都能跑 ─────────────────────────────── */
  LocalLlm(
    id: 'qwen3-0.6b-q4km',
    name: 'Qwen3 0.6B',
    params: '0.6B',
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    size: 396705472,
    sha256: 'ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a',
    template: 'chatml',
    minTier: DeviceTier.entry,
    minRamGb: 3.5,
    hybridThinking: true,
    blurb: '最小最快, 日常问答',
  ),
  LocalLlm(
    id: 'gemma3-1b-q4km',
    name: 'Gemma 3 1B',
    params: '1B',
    repo: 'unsloth/gemma-3-1b-it-GGUF',
    file: 'gemma-3-1b-it-Q4_K_M.gguf',
    size: 806058272,
    sha256: '8270790f3ab69fdfe860b7b64008d9a19986d8df7e407bb018184caa08798ebd',
    template: 'gemma',
    minTier: DeviceTier.entry,
    minRamGb: 4,
    blurb: '英文更好',
  ),
  LocalLlm(
    id: 'smollm2-1.7b-q4km',
    name: 'SmolLM2 1.7B',
    params: '1.7B',
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
    file: 'smollm2-1.7b-instruct-q4_k_m.gguf',
    size: 1055609536,
    sha256: 'decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33',
    template: 'chatml',
    minTier: DeviceTier.mid,
    minRamGb: 6,
    blurb: '英文小模型',
  ),
  LocalLlm(
    id: 'qwen2.5-1.5b-q4km',
    name: 'Qwen2.5 1.5B',
    params: '1.5B',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    size: 1117320736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    template: 'chatml',
    minTier: DeviceTier.mid,
    minRamGb: 6,
    blurb: '不思考, 直接答',
  ),
  LocalLlm(
    id: 'qwen2.5-coder-1.5b-q4km',
    name: 'Qwen2.5 Coder 1.5B',
    params: '1.5B',
    repo: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    file: 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf',
    size: 1117320768,
    sha256: 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046',
    template: 'chatml',
    minTier: DeviceTier.mid,
    minRamGb: 6,
    blurb: '写代码',
  ),
  LocalLlm(
    id: 'qwen3-1.7b-q4km',
    name: 'Qwen3 1.7B',
    params: '1.7B',
    repo: 'unsloth/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    size: 1107409472,
    sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    template: 'chatml',
    minTier: DeviceTier.mid,
    minRamGb: 6,
    hybridThinking: true,
    blurb: '中文好, 速度和质量平衡',
  ),
  LocalLlm(
    id: 'qwen2.5-3b-q4km',
    name: 'Qwen2.5 3B',
    params: '3B',
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    size: 2104932768,
    sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
    template: 'chatml',
    minTier: DeviceTier.flagship,
    minRamGb: 8,
    blurb: '中文, 比 1.5B 聪明一截',
  ),
  LocalLlm(
    id: 'qwen3-4b-2507-q4km',
    name: 'Qwen3 4B Instruct',
    params: '4B',
    repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    size: 2497281120,
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
    template: 'chatml',
    minTier: DeviceTier.flagship,
    minRamGb: 11,
    blurb: '最聪明, 要旗舰机',
  ),
  LocalLlm(
    id: 'qwen3-4b-q4km',
    name: 'Qwen3 4B',
    params: '4B',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
    size: 2497280256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    template: 'chatml',
    minTier: DeviceTier.flagship,
    minRamGb: 11,
    hybridThinking: true,
    blurb: '会思考的版本, 更慢',
  ),
  LocalLlm(
    id: 'gemma3-4b-q4km',
    name: 'Gemma 3 4B',
    params: '4B',
    repo: 'unsloth/gemma-3-4b-it-GGUF',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    size: 2489894016,
    sha256: '04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19',
    template: 'gemma',
    minTier: DeviceTier.flagship,
    minRamGb: 11,
    blurb: '多语言, 英文强',
  ),
  LocalLlm(
    id: 'qwen3-8b-q4km',
    name: 'Qwen3 8B',
    params: '8B',
    repo: 'unsloth/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    size: 5027784512,
    sha256: '120307ba529eb2439d6c430d94104dabd578497bc7bfe7e322b5d9933b449bd4',
    template: 'chatml',
    minTier: DeviceTier.flagship,
    minRamGb: 15,
    hybridThinking: true,
    blurb: '16GB 以上的旗舰才跑得动',
  ),
];

/* ── 用户在线搜索添加的 ─────────────────────────────────────────────── */

const String _kCustomKey = 'local_llm.custom';
List<LocalLlm> _custom = const [];
bool _customLoaded = false;

/// 启动时读一次 (幂等)。
Future<void> loadCustomLocalLlms() async {
  if (_customLoaded) return;
  final sp = await SharedPreferences.getInstance();
  final raw = sp.getString(_kCustomKey);
  if (raw != null) {
    try {
      final list = jsonDecode(raw);
      if (list is List) _custom = list.map(LocalLlm.fromJson).whereType<LocalLlm>().toList();
    } catch (_) {}
  }
  _customLoaded = true;
}

Future<void> _saveCustom() async {
  final sp = await SharedPreferences.getInstance();
  await sp.setString(_kCustomKey, jsonEncode([for (final m in _custom) m.toJson()]));
}

Future<void> addCustomLocalLlm(LocalLlm m) async {
  await loadCustomLocalLlms();
  _custom = [..._custom.where((x) => x.id != m.id), m];
  await _saveCustom();
}

Future<void> removeCustomLocalLlm(String id) async {
  await loadCustomLocalLlms();
  _custom = _custom.where((x) => x.id != id).toList();
  await _saveCustom();
}

/// 内置 + 自己加的
List<LocalLlm> get kLocalLlms => [...kBuiltinLocalLlms, ..._custom];

/// 下架的模型: 打开本地部署页时把已下载的文件删掉。
/// Gemma 3 270M (3.4.13 上过): 定位是拿来微调的底座, 中文聊天只会复读, 真机上一句话都答不对。
const List<LocalLlm> kRetiredLocalLlms = [
  LocalLlm(
    id: 'npu-gemma3-270m-mt6991',
    name: 'Gemma 3 270M · NPU',
    params: '270M',
    repo: 'litert-community/gemma-3-270m-it',
    file: 'gemma3-270m-it-q8.mediatek.mt6991.litertlm',
    size: 554467328,
    sha256: null,
    template: null,
    minTier: DeviceTier.entry,
    minRamGb: 4,
    engine: LlmEngineKind.litert,
    npuSocs: ['mt6991'],
  ),
];

LocalLlm? localLlmById(String id) {
  for (final m in kLocalLlms) {
    if (m.id == id) return m;
  }
  return null;
}

/// `local:<id>` → 目录项; 不是本地模型返回 null
LocalLlm? localLlmForModelId(String modelId) =>
    modelId.startsWith('local:') ? localLlmById(modelId.substring(6)) : null;

/// 给这台机器推荐哪个: 按"速度和质量平衡"的首选顺序, 取第一个跑得动的。
/// 不是"能跑的里最大的" —— 16GB 旗舰也跑得动 8B, 但 CPU 上每秒三四个字, 推荐它就是劝退。
const List<String> _kRecommendOrder = [
  /* 有 GPU 的先推 LiteRT (同样的模型, GPU 上首字快得多) */
  'lrt-qwen3-4b-2507',
  'lrt-qwen3-1.7b',
  'qwen3-4b-2507-q4km',
  'qwen3-1.7b-q4km',
  'lrt-qwen3-0.6b',
  'gemma3-1b-q4km',
  'qwen3-0.6b-q4km',
];

LocalLlm? recommendedLocalLlm(DeviceProfile d) {
  for (final id in _kRecommendOrder) {
    final m = localLlmById(id);
    if (m != null && m.fits(d)) return m;
  }
  return null;
}

/// 按文件大小粗估要多少内存 / 什么档位 (搜索添加的模型没有人工标注)
({DeviceTier tier, double ramGb}) estimateRequirement(int bytes) {
  final gb = bytes / (1 << 30);
  if (gb < 0.9) return (tier: DeviceTier.entry, ramGb: 4);
  if (gb < 1.6) return (tier: DeviceTier.mid, ramGb: 6);
  if (gb < 3.2) return (tier: DeviceTier.flagship, ramGb: 11);
  return (tier: DeviceTier.flagship, ramGb: 15);
}
