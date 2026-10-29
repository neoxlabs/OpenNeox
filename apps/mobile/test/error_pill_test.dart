/// error_pill_test.dart — 错误分类的口径.
///
/// 这颗药丸的全部价值是"一眼看出是谁的问题", 分错了比不显示更糟 —— 把登录失效
/// 说成网络问题, 用户会去重启路由器 (今天上午就真的发生了)。
///
/// 所以锁两件事: 分类判据本身, 以及"做不了什么就别给假按钮"。
library;

import 'package:flutter_test/flutter_test.dart';

import 'package:neox_app/core/errors/error_pill.dart';

void main() {
  group('按状态码分类', () {
    test('401 = 登录失效, 不是网络问题', () {
      expect(classifyError(statusCode: 401), ErrorKind.auth);
    });
    test('402 / 429 = 额度', () {
      expect(classifyError(statusCode: 402), ErrorKind.quota);
      expect(classifyError(statusCode: 429), ErrorKind.quota);
    });
    test('403 = 模型用不了 (套餐不含 / 无权限)', () {
      expect(classifyError(statusCode: 403), ErrorKind.model);
    });
    test('5xx = 服务器', () {
      expect(classifyError(statusCode: 500), ErrorKind.server);
      expect(classifyError(statusCode: 502), ErrorKind.server);
      expect(classifyError(statusCode: 503), ErrorKind.server);
    });
  });

  group('按错误码分类', () {
    test('AUTH_* / SESSION_EXPIRED 都是登录', () {
      expect(classifyError(code: 'AUTH_REFRESH_UNAVAILABLE'), ErrorKind.auth);
      expect(classifyError(code: 'SESSION_EXPIRED'), ErrorKind.auth);
      expect(classifyError(code: 'NOT_AUTHENTICATED'), ErrorKind.auth);
    });
    test('NETWORK_* 是网络', () {
      expect(classifyError(code: 'NETWORK_DNS'), ErrorKind.network);
      expect(classifyError(code: 'NETWORK_TIMEOUT'), ErrorKind.network);
    });
    test('错误码优先于状态码 —— 401 但码是 NETWORK 时按码走', () {
      expect(
        classifyError(statusCode: 401, code: 'NETWORK_TIMEOUT'),
        ErrorKind.network,
      );
    });
  });

  group('服务端原话兜底 (只认网关固定文案)', () {
    test('额度耗尽', () {
      expect(classifyError(message: '5 小时额度已用尽，2 小时后恢复'), ErrorKind.quota);
    });
    test('模型停用 —— 今天真实踩到的那句', () {
      expect(
        classifyError(message: '该模型已停用, 请选择其他模型'),
        ErrorKind.model,
      );
    });
    test('登录过期', () {
      expect(classifyError(message: '登录已过期，请重新登录'), ErrorKind.auth);
    });
    test('电脑没连上', () {
      expect(classifyError(message: '电脑没连上，这条改在手机上跑'), ErrorKind.desktop);
    });
  });

  group('认不出来时的默认', () {
    test('一律当服务器问题, 不去猜成网络', () {
      /* 把不认识的错误说成"网络连不上", 会让用户去重启路由器白折腾一轮 ——
       * 说"服务器出问题了"至少方向是对的: 他做什么都没用, 等就完事。 */
      expect(classifyError(), ErrorKind.server);
      expect(classifyError(message: '未知的什么东西'), ErrorKind.server);
      expect(classifyError(statusCode: 418), ErrorKind.server);
    });
  });

  group('别给点了没用的按钮', () {
    test('服务器挂了不给动作 —— 给"重试"是骗人', () {
      expect(ErrorKind.server.actionLabel, isNull);
    });
    test('其余每一类都必须有且只有一个明确动作', () {
      for (final k in [
        ErrorKind.network,
        ErrorKind.auth,
        ErrorKind.quota,
        ErrorKind.model,
        ErrorKind.desktop,
      ]) {
        expect(k.actionLabel, isNotNull, reason: '$k 缺出口');
        expect(k.actionLabel!.isNotEmpty, isTrue);
      }
    });
    test('每一类都有人话文案, 不漏技术词', () {
      for (final k in ErrorKind.values) {
        expect(k.label.isNotEmpty, isTrue);
        expect(k.label.contains('HTTP'), isFalse);
        expect(k.label.contains('null'), isFalse);
      }
    });
  });
}
