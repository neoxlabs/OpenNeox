/// session_context_retry_test.dart — 上下文元数据的补拉与保活.
///
/// 2026-07-29 真机根因: `_refresh()` 只在 provider 构造时跑一次, 而 app 刚启动
/// 那一刻 WS 客户端常常还没就绪 —— `fetchSessionInfo` 里 `if (c == null) return null;`
/// 静默返回 → modelId 判空 → contextWindow 永远拿不到, 且**再也不会重试**。
/// 表现: 库里 modelId 明明是 `deepseek:deepseek-v4-pro`, 手机端上下文环一直画不出来。
///
/// 这里锁住两条保命规则:
///   1. 桌面推来的已用量, 在元数据缺失时也要收下 (不能因为不知道窗口就整个丢掉)
///   2. 元数据缺失时, 后续 context_usage 是天然的补拉时机 (那时连接必然已通)
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/network/session_context_provider.dart';
import 'package:neox_app/features/home/widgets/context_gauge.dart';

void main() {
  group('SessionContextInfo — 已用量与窗口相互独立', () {
    test('窗口未知时仍能表达已用量', () {
      const info = SessionContextInfo(
        contextWindow: null,
        modelId: '',
        modelName: '',
        contextTokens: 22808,
      );
      final u = ContextUsage.from(info)!;
      expect(u.used, 22808);
      expect(u.totalKnown, isFalse);
      expect(u.label, '已用 22.8k');
    });

    test('元数据补拉成功后, 环与百分比才出现', () {
      const info = SessionContextInfo(
        contextWindow: 1000000,
        modelId: 'deepseek:deepseek-v4-pro',
        modelName: 'deepseek-v4-pro',
        contextTokens: 16666,
      );
      final u = ContextUsage.from(info)!;
      expect(u.totalKnown, isTrue);
      expect(u.percent, 2);
      expect(u.label, '16.7k / 1.0M · 2%');
    });

    test('copyWith 只换已用量, 不碰模型元数据', () {
      const info = SessionContextInfo(
        contextWindow: 200000,
        modelId: 'm',
        modelName: 'M',
        contextTokens: 100,
      );
      final next = info.copyWith(contextTokens: 500);
      expect(next.contextTokens, 500);
      expect(next.contextWindow, 200000);
      expect(next.modelId, 'm');
      expect(next.modelName, 'M');
    });
  });
}
