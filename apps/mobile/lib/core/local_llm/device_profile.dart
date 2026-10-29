/// 这台手机能跑多大的本地模型 (2026-09-30 用户: 「检测手机配置, 天玑或高通什么配置能运行什么样的模型」)。
///
/// 判据两条取小:
///   · 芯片档: ro.soc.model (Android 12+) → 型号表; 拿不到退到 Build.HARDWARE / BOARD 的代号
///   · 内存档: 总内存。模型权重要整个进内存, 再给系统和 App 留 3~4GB
/// 芯片认不出时只按内存, 且最多给到「中端」—— 宁可推荐小一号, 不让用户下 2.5GB 跑不动。
///
/// 加速能力由原生侧探测 (LiteRtLmBridge.probe): 有 OpenCL = LiteRT 能走 GPU;
/// 带了联发科 NPU 调度库 + 芯片是天玑 9300/9400/9500 = 能跑对应芯片的 NPU 预编译模型。
/// GGUF (llama.cpp) 一律 CPU。
library;

import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/services.dart';

enum DeviceTier { flagship, mid, entry }

class DeviceProfile {
  const DeviceProfile({
    required this.socModel,
    required this.socName,
    required this.vendor,
    required this.ramGb,
    required this.tier,
    required this.freeDiskBytes,
    required this.arm64,
    this.gpu = false,
    this.npuReady = false,
  });

  /// 有 OpenCL, LiteRT 模型能走 GPU
  final bool gpu;

  /// NPU 能用: 联发科 (MT6989/6991/6993) 且安装包里带了调度库
  final bool npuReady;

  /// 能用的加速, 给页面显示
  String get accelSummary => [if (npuReady) 'NPU', if (gpu) 'GPU', 'CPU'].join(' · ');

  /// 原始型号 (SM8650 / MT6991 / 代号)
  final String socModel;

  /// 给人看的名字 (骁龙 8 Gen 3 / 天玑 9400); 认不出时等于 [socModel]
  final String socName;

  /// 'qualcomm' | 'mediatek' | 'google' | 'samsung' | 'hisilicon' | 'unknown'
  final String vendor;
  final double ramGb;
  final DeviceTier tier;
  final int freeDiskBytes;

  /// 本地大模型只有 arm64 的库
  final bool arm64;

  bool get canRunLocalLlm => arm64 && ramGb >= 3.5;
}

class _Soc {
  const _Soc(this.name, this.vendor, this.tier);
  final String name;
  final String vendor;
  final DeviceTier tier;
}

/* 型号表: 只收最近几代, 更老的按「前缀」兜底到对应档 */
const Map<String, _Soc> _kSocTable = {
  // Qualcomm
  'SM8850': _Soc('骁龙 8 Elite Gen 5', 'qualcomm', DeviceTier.flagship),
  'SM8750': _Soc('骁龙 8 Elite', 'qualcomm', DeviceTier.flagship),
  'SM8650': _Soc('骁龙 8 Gen 3', 'qualcomm', DeviceTier.flagship),
  'SM8635': _Soc('骁龙 8s Gen 3', 'qualcomm', DeviceTier.flagship),
  'SM8550': _Soc('骁龙 8 Gen 2', 'qualcomm', DeviceTier.flagship),
  'SM8475': _Soc('骁龙 8+ Gen 1', 'qualcomm', DeviceTier.mid),
  'SM8450': _Soc('骁龙 8 Gen 1', 'qualcomm', DeviceTier.mid),
  'SM8350': _Soc('骁龙 888', 'qualcomm', DeviceTier.mid),
  'SM7675': _Soc('骁龙 7+ Gen 3', 'qualcomm', DeviceTier.mid),
  'SM7550': _Soc('骁龙 7 Gen 3', 'qualcomm', DeviceTier.mid),
  'SM7475': _Soc('骁龙 7+ Gen 2', 'qualcomm', DeviceTier.mid),
  // MediaTek
  'MT6993': _Soc('天玑 9500', 'mediatek', DeviceTier.flagship),
  'MT6991': _Soc('天玑 9400', 'mediatek', DeviceTier.flagship),
  'MT6989': _Soc('天玑 9300', 'mediatek', DeviceTier.flagship),
  'MT6985': _Soc('天玑 9200', 'mediatek', DeviceTier.flagship),
  'MT6983': _Soc('天玑 9000', 'mediatek', DeviceTier.mid),
  'MT6899': _Soc('天玑 8400', 'mediatek', DeviceTier.mid),
  'MT6897': _Soc('天玑 8300', 'mediatek', DeviceTier.mid),
  'MT6896': _Soc('天玑 8200', 'mediatek', DeviceTier.mid),
  'MT6895': _Soc('天玑 8100', 'mediatek', DeviceTier.mid),
  'MT6886': _Soc('天玑 7200', 'mediatek', DeviceTier.mid),
  'MT6878': _Soc('天玑 7300', 'mediatek', DeviceTier.mid),
};

/* 高通板级代号 (ro.soc.model 拿不到的老系统, Build.BOARD 常是这个) */
const Map<String, String> _kQcomBoards = {
  'sun': 'SM8750',
  'pineapple': 'SM8650',
  'cliffs': 'SM8635',
  'kalama': 'SM8550',
  'taro': 'SM8450',
  'lahaina': 'SM8350',
  'crow': 'SM7550',
};

_Soc? _lookup(String raw) {
  final m = raw.toUpperCase().trim();
  if (m.isEmpty) return null;
  final hit = _kSocTable[m];
  if (hit != null) return hit;
  final board = _kQcomBoards[raw.toLowerCase().trim()];
  if (board != null) return _kSocTable[board];
  /* 前缀兜底: SM8xxx 旗舰线 / SM7xxx 中端 / SM6xxx 以下入门; MT69xx 高端线 / MT68xx 中端 */
  if (m.startsWith('SM8')) return _Soc(m, 'qualcomm', DeviceTier.mid);
  if (m.startsWith('SM7')) return _Soc(m, 'qualcomm', DeviceTier.mid);
  if (m.startsWith('SM') || m.startsWith('SDM')) return _Soc(m, 'qualcomm', DeviceTier.entry);
  if (m.startsWith('MT69')) return _Soc(m, 'mediatek', DeviceTier.mid);
  if (m.startsWith('MT')) return _Soc(m, 'mediatek', DeviceTier.entry);
  if (m.contains('TENSOR') || m.startsWith('GS')) return _Soc('Google Tensor', 'google', DeviceTier.mid);
  if (m.startsWith('S5E9') || m.contains('EXYNOS')) return _Soc('Exynos $m', 'samsung', DeviceTier.mid);
  if (m.contains('KIRIN') || m.startsWith('HI')) return _Soc(m, 'hisilicon', DeviceTier.mid);
  return null;
}

DeviceTier _ramTier(double gb) {
  if (gb >= 11) return DeviceTier.flagship;
  if (gb >= 7) return DeviceTier.mid;
  return DeviceTier.entry;
}

DeviceTier _min(DeviceTier a, DeviceTier b) => a.index >= b.index ? a : b;

Future<String> _getprop(String key) async {
  try {
    final r = await Process.run('getprop', [key]).timeout(const Duration(seconds: 2));
    return (r.stdout as String).trim();
  } catch (_) {
    return '';
  }
}

DeviceProfile? _cached;

Future<DeviceProfile> detectDeviceProfile() async {
  final c = _cached;
  if (c != null) return c;
  final info = await DeviceInfoPlugin().androidInfo;
  final ramGb = info.physicalRamSize / 1024.0; // physicalRamSize 单位是 MB
  final candidates = [
    await _getprop('ro.soc.model'),
    info.hardware,
    info.board,
    await _getprop('ro.board.platform'),
  ];
  _Soc? soc;
  var raw = '';
  for (final c in candidates) {
    soc = _lookup(c);
    if (soc != null) {
      raw = c;
      break;
    }
  }
  final ramTier = _ramTier(ramGb);
  final tier = soc == null ? _min(ramTier, DeviceTier.mid) : _min(soc.tier, ramTier);
  var gpu = false;
  var npuMtk = false;
  try {
    final p = await const MethodChannel('neox.llm/litert').invokeMapMethod<String, dynamic>('probe');
    gpu = p?['opencl'] == true;
    npuMtk = p?['npuMediatek'] == true;
  } catch (_) {}
  const npuSocs = {'MT6989', 'MT6991', 'MT6993'};
  return _cached = DeviceProfile(
    gpu: gpu,
    npuReady: npuMtk && npuSocs.contains(raw.toUpperCase().trim()),
    socModel: raw.isEmpty ? (info.hardware.isEmpty ? info.board : info.hardware) : raw,
    socName: soc?.name ?? (raw.isEmpty ? info.hardware : raw),
    vendor: soc?.vendor ?? 'unknown',
    ramGb: ramGb,
    tier: tier,
    freeDiskBytes: info.freeDiskSize,
    arm64: info.supported64BitAbis.contains('arm64-v8a'),
  );
}
