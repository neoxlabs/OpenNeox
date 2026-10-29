/// app_update_test.dart — 版本比较 (强更判定的唯一依据).
///
/// 为什么必须钉死 (2026-08-08):
///   compareVersions 是"要不要把用户锁进全屏强更页"的唯一判据。判反了的后果
///   是不对称的:
///     · 该强更没强更 → 用户继续用不兼容的旧版, 得到"发出去没反应"这种查不出
///       原因的故障 (但至少 app 还能开)
///     · 不该强更却强更 → 用户被锁在一个出不去的页面里, app 完全不可用
///   所以宁可漏判也绝不能误判 —— 下面那几条"脏输入"用例就是在守这条线。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/startup/app_update.dart';

void main() {
  group('compareVersions 基本序', () {
    test('相等', () {
      expect(compareVersions('3.1.20', '3.1.20'), 0);
    });

    test('主/次/修订各级都能分出大小', () {
      expect(compareVersions('3.1.20', '4.0.0'), -1);
      expect(compareVersions('3.1.20', '3.2.0'), -1);
      expect(compareVersions('3.1.20', '3.1.21'), -1);
      expect(compareVersions('4.0.0', '3.9.9'), 1);
    });

    test('数字按数值比而不是字典序 (9 < 10, 不是 "9" > "1")', () {
      expect(compareVersions('3.1.9', '3.1.10'), -1);
      expect(compareVersions('3.9.0', '3.10.0'), -1);
      expect(compareVersions('9.0.0', '10.0.0'), -1);
    });

    test('段数不齐时短的补 0', () {
      expect(compareVersions('3.2', '3.2.0'), 0);
      expect(compareVersions('3', '3.0.0'), 0);
      expect(compareVersions('3.2', '3.2.1'), -1);
      expect(compareVersions('3.3', '3.2.9'), 1);
    });
  });

  group('后缀与脏输入 — 一律不能造成误判', () {
    test('预发布/构建号后缀被忽略, 只比数字段', () {
      expect(compareVersions('3.1.20-beta.1', '3.1.20'), 0);
      expect(compareVersions('3.1.20+6', '3.1.20'), 0);
      expect(compareVersions('3.1.20-rc1', '3.1.21'), -1);
    });

    test('解析不出来的段当 0 — 不会把用户误判成需要强更', () {
      // 关键: 空串/垃圾串必须落在"不小于"那一侧, 否则 min_supported 一旦
      // 传了个畸形值, 全体用户会被一起锁进强更页。
      expect(compareVersions('', ''), 0);
      expect(compareVersions('3.1.20', ''), 1);
      expect(compareVersions('3.1.20', 'not-a-version'), 1);
      expect(compareVersions('', '3.1.20'), -1);
    });

    test('两边空白被忽略', () {
      expect(compareVersions(' 3.1.20 ', '3.1.20'), 0);
    });
  });

  group('AppUpdateStatus 的对外语义', () {
    test('没查到最新版 → 既没有更新也不强更 (接口未上线的常态)', () {
      const s = AppUpdateStatus(currentVersion: '3.1.20');
      expect(s.hasUpdate, isFalse);
      expect(s.mandatory, isFalse);
    });

    test('最新版更高 + 有下载地址 → hasUpdate', () {
      const s = AppUpdateStatus(
        currentVersion: '3.1.20',
        latestVersion: '3.2.0',
        downloadUrl: 'https://dl.neox-dev.com/mobile/3.2.0/neox-3.2.0.apk',
      );
      expect(s.hasUpdate, isTrue);
    });

    test('有新版但没有下载地址 → 不提示', () {
      // 清单里该平台没发包 / 下载被运维关掉。提示了用户也拿不到东西,
      // 只会得到一个点了没反应的横幅。
      const s = AppUpdateStatus(currentVersion: '3.1.20', latestVersion: '3.2.0');
      expect(s.hasUpdate, isFalse);
    });

    test('已经是最新 (甚至更高) → 不提示', () {
      const url = 'https://dl.neox-dev.com/mobile/3.2.0/neox-3.2.0.apk';
      const same = AppUpdateStatus(
        currentVersion: '3.2.0',
        latestVersion: '3.2.0',
        downloadUrl: url,
      );
      expect(same.hasUpdate, isFalse);
      // 本地跑的开发版可能比线上更高, 不该提示"更新"
      const ahead = AppUpdateStatus(
        currentVersion: '3.3.0',
        latestVersion: '3.2.0',
        downloadUrl: url,
      );
      expect(ahead.hasUpdate, isFalse);
    });

    test('包大小按 MB 显示 —— 90MB 不是小数目, 下载前要让用户知道', () {
      const s = AppUpdateStatus(
        currentVersion: '3.1.20',
        sizeBytes: 92870285, // 线上 latest.json 里的真实值
      );
      expect(s.sizeLabel, '88.6 MB');
      expect(const AppUpdateStatus(currentVersion: '1.0.0').sizeLabel, '');
    });

    test('unknown 是安全默认值', () {
      expect(AppUpdateStatus.unknown.hasUpdate, isFalse);
      expect(AppUpdateStatus.unknown.mandatory, isFalse);
    });
  });

  group('重检节流 — 进入更新页/设置页时该不该重拉清单', () {
    /* 2026-09-22「app 端怎么更新 404??」: appUpdateStatusProvider 的缓存整个进程
     * 都不释放 (首页强更闸门常驻 watch), 页面不主动重检就一直在看过期清单 ——
     * 里面的下载直链指向的 APK 早被发包脚本按流程清掉了, 点更新直接 404。 */

    test('本进程还没查过 → 必须查', () {
      expect(isUpdateCheckStale(null), isTrue);
    });

    test('刚查过 → 窗口内不重复查 (连续切页不白打服务端)', () {
      final t = DateTime(2026, 9, 22, 10, 0, 0);
      expect(
        isUpdateCheckStale(t, now: t.add(const Duration(seconds: 5))),
        isFalse,
      );
      expect(
        isUpdateCheckStale(t, now: t.add(const Duration(seconds: 29))),
        isFalse,
      );
    });

    test('过了窗口 → 必须重查, 边界值也算', () {
      final t = DateTime(2026, 9, 22, 10, 0, 0);
      expect(
        isUpdateCheckStale(t, now: t.add(kAppUpdateRecheckAfter)),
        isTrue,
        reason: '刚到窗口边界就该重查',
      );
      expect(
        isUpdateCheckStale(t, now: t.add(const Duration(minutes: 30))),
        isTrue,
        reason: '隔久了必须拿到当下那份清单',
      );
    });
  });
}
