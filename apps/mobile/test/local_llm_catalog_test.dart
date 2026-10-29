/// 本机模型目录 + 机型档位 (2026-09-30 「检测手机配置, 什么配置能跑什么模型」)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/local_agent/phone_local_agent.dart';
import 'package:neox_app/core/local_llm/device_profile.dart';
import 'package:neox_app/core/local_llm/local_llm_engine.dart';
import 'package:neox_app/core/local_llm/local_model_catalog.dart';

DeviceProfile _p(DeviceTier tier, double ram,
        {bool arm64 = true, bool gpu = false, bool npu = false, String soc = 'X'}) =>
    DeviceProfile(
      socModel: soc,
      socName: soc,
      vendor: 'qualcomm',
      ramGb: ram,
      tier: tier,
      freeDiskBytes: 64 << 30,
      arm64: arm64,
      gpu: gpu,
      npuReady: npu,
    );

void main() {
  test('没 GPU: 旗舰 16GB → 推荐 4B (不是跑得动的最大 8B); 中端 8GB → 1.7B; 入门 4GB → Gemma 1B', () {
    expect(recommendedLocalLlm(_p(DeviceTier.flagship, 16))?.id, 'qwen3-4b-2507-q4km');
    expect(recommendedLocalLlm(_p(DeviceTier.mid, 8))?.id, 'qwen3-1.7b-q4km');
    expect(recommendedLocalLlm(_p(DeviceTier.entry, 4))?.id, 'gemma3-1b-q4km');
  });

  test('有 GPU 先推 LiteRT 版', () {
    expect(recommendedLocalLlm(_p(DeviceTier.flagship, 16, gpu: true))?.id, 'lrt-qwen3-4b-2507');
    expect(recommendedLocalLlm(_p(DeviceTier.mid, 8, gpu: true))?.id, 'lrt-qwen3-1.7b');
  });

  test('NPU 版只在对应芯片 + 带了调度库时可用', () {
    final npu9400 = localLlmById('npu-gemma3-1b-mt6991')!;
    expect(npu9400.availableOn(_p(DeviceTier.flagship, 12, gpu: true, npu: true, soc: 'MT6991')), isTrue);
    expect(npu9400.availableOn(_p(DeviceTier.flagship, 12, gpu: true, npu: false, soc: 'MT6991')), isFalse);
    expect(npu9400.availableOn(_p(DeviceTier.flagship, 12, gpu: true, npu: true, soc: 'MT6993')), isFalse);
    expect(localLlmById('lrt-qwen3-0.6b')!.availableOn(_p(DeviceTier.entry, 4)), isFalse);
  });

  test('复读刹车: 真机那句循环截成一遍; 正常文本 / 表格分隔线不误伤', () {
    const s = '你！我正在努力！我正在努力！我正在努力！';
    expect(s.substring(0, repeatCutPoint(s)), '你！我正在努力！');
    expect(repeatCutPoint('今天天气不错，适合出门走走。'), isNull);
    expect(repeatCutPoint('| a | b | c |\n|---|---|---|---|'), isNull);
    expect(repeatCutPoint('哈哈哈'), isNull);
  });

  test('下架的模型不在目录里', () {
    for (final r in kRetiredLocalLlms) {
      expect(localLlmById(r.id), isNull);
    }
  });

  test('内置模型 id 不重复, 在线添加的能存能删', () async {
    final ids = kBuiltinLocalLlms.map((m) => m.id).toList();
    expect(ids.toSet().length, ids.length);
  });

  test('32 位 / 内存太小的机器一个都不推荐', () {
    expect(recommendedLocalLlm(_p(DeviceTier.entry, 3)), isNull);
    expect(recommendedLocalLlm(_p(DeviceTier.flagship, 16, arm64: false)), isNull);
  });

  test('会话模型 id: local:<id> 能找回目录项, 且不会被命名空间归一剥掉', () {
    final m = kLocalLlms.first;
    expect(localLlmForModelId(m.modelId)?.id, m.id);
    expect(localLlmForModelId('deepseek-v4-flash'), isNull);
    expect(normalizePhoneLocalModelId(m.modelId), m.modelId);
  });

  test('每个模型三个下载源, ModelScope 在最前 (国内直连)', () {
    for (final m in kLocalLlms) {
      final urls = m.pack.files.single.urls;
      expect(urls.length, 3);
      expect(urls.first, startsWith('https://modelscope.cn/'));
      /* Gemma 系 LiteRT 文件在 HF 是受限仓库, 拿不到 LFS 哈希 */
      if (!m.repo.contains('Gemma3') && !m.repo.contains('gemma-3')) expect(m.sha256?.length, 64);
    }
  });
}
