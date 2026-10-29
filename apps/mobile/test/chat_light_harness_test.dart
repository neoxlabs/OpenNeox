/// 轻聊天 (Chat 标签) harness —— 2026-10-17.
///
/// 用户: 「Chat 应该非常简单、非常省 token, 效果非常好、反应非常快。现在 Chat 的
/// harness 很有问题, 把它做成了 agent 的聊天。」
///
/// 这份用例守三件事:
///   1. 搜索一轮最多 10 次 (并发发、同时跑), 到顶在工具层就拦住 (不打网关、不再往上下文里塞结果);
///   2. 画图不限张数; 同工具同参数重复调用由 ChatRepeatGuard 直接拦;
///   3. Chat 的 system prompt 只提它真有的两个工具, 且足够短。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;
import 'package:neox_app/core/local_agent/chat_repeat_guard.dart';
import 'package:neox_app/core/local_agent/chat_budget.dart';
import 'package:neox_app/core/local_agent/chat_light_prompt.dart';
import 'package:neox_app/core/local_agent/hosted_web_search.dart';

class _FakeSearch implements HostedWebSearch {
  int calls = 0;

  @override
  bool get available => true;

  @override
  Future<List<WebSearchHit>> search(String query, {int count = 8}) async {
    calls++;
    return [
      WebSearchHit(
        title: '结果 $calls',
        url: 'https://example.com/$calls',
        snippet: '摘要 $calls',
      ),
    ];
  }
}

/// 画图假工具 —— 只数调用次数, 不碰网络 / 文件系统.
class _FakeImage implements sdk.AgentTool, sdk.ParallelSafeTool {
  int calls = 0;

  @override
  bool get parallelSafe => true;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'generate_image',
        description: '画图',
        parameters: {
          'type': 'object',
          'properties': {
            'prompt': {'type': 'string'},
          },
          'required': ['prompt'],
        },
      );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    calls++;
    return const sdk.ToolResult.ok('图片: images/a.png');
  }
}

/// 第一次失败、之后成功 —— 验证「失败后同参数重试是正当的」.
class _FlakyImage implements sdk.AgentTool {
  int calls = 0;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'generate_image',
        description: '画图',
        parameters: {
          'type': 'object',
          'properties': {
            'prompt': {'type': 'string'},
          },
          'required': ['prompt'],
        },
      );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    calls++;
    if (calls == 1) return const sdk.ToolResult.error('网络断了');
    return const sdk.ToolResult.ok('图片: images/a.png');
  }
}

/// 慢出图 (120ms) —— 用来验证「在飞的同参数调用」也被拦住.
class _SlowImage implements sdk.AgentTool {
  int calls = 0;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'generate_image',
        description: '画图',
        parameters: {
          'type': 'object',
          'properties': {
            'prompt': {'type': 'string'},
          },
          'required': ['prompt'],
        },
      );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async {
    calls++;
    await Future<void>.delayed(const Duration(milliseconds: 120));
    return const sdk.ToolResult.ok('图片: images/a.png');
  }
}

/// 不声明并发安全的工具 (写盘 / 跑命令那一类).
class _SerialTool implements sdk.AgentTool {
  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'execute_shell',
        description: '串行工具',
        parameters: {'type': 'object', 'properties': {}},
      );

  @override
  Future<sdk.ToolResult> run(
    Map<String, Object?> args,
    sdk.ToolContext ctx,
  ) async =>
      const sdk.ToolResult.ok('ok');
}

/// 粗估 token (偏保守, 用来卡上限): 中日韩字符按 1 字符 = 1 token,
/// 其余按 3.5 字符 = 1 token。真实分词器对中文通常在 0.6~0.75 token/字,
/// 所以估出来 < 1500 就一定真的 < 1500。
int _estimateTokens(String s) {
  var cjk = 0;
  var other = 0;
  for (final rune in s.runes) {
    final isCjk = (rune >= 0x2E80 && rune <= 0x9FFF) ||
        (rune >= 0xF900 && rune <= 0xFAFF) ||
        (rune >= 0xFF00 && rune <= 0xFFEF) ||
        (rune >= 0x3000 && rune <= 0x303F);
    if (isCjk) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + (other / 3.5).ceil();
}

void main() {
  test('轻聊天搜索: 一轮最多 ${kChatSearchLimit} 次, 到顶后再调不打网关', () async {
    final fake = _FakeSearch();
    final tool = CappedWebSearchTool(WebSearchTool(fake), maxCalls: kChatSearchLimit);
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());

    for (var i = 0; i < kChatSearchLimit; i++) {
      final r = await tool.run({'query': 'q$i'}, ctx);
      expect(r.isError, isFalse, reason: '第 ${i + 1} 次应该放行');
    }
    expect(fake.calls, kChatSearchLimit);

    final blocked = await tool.run({'query': 'one-too-many'}, ctx);
    expect(blocked.isError, isTrue, reason: '到上限要明确告诉模型别再搜');
    expect(blocked.output, contains('$kChatSearchLimit 次'));
    expect(blocked.output, contains('直接回答'));
    expect(fake.calls, kChatSearchLimit, reason: '到上限后不能再去打网关');
    expect(tool.used, kChatSearchLimit);
  });

  test('搜索上限是 10 —— 够一次问好几件事 (查天气 + 查限行 + 查票价…)', () {
    expect(kChatSearchLimit, 10);
  });

  test('轻聊天搜索: 每次发送新建一份计数 (上一轮用满不影响下一轮)', () async {
    final fake = _FakeSearch();
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());
    final first = CappedWebSearchTool(WebSearchTool(fake), maxCalls: kChatSearchLimit);
    for (var i = 0; i < kChatSearchLimit; i++) {
      await first.run({'query': 'a$i'}, ctx);
    }
    final second = CappedWebSearchTool(WebSearchTool(fake), maxCalls: kChatSearchLimit);
    final r = await second.run({'query': 'b0'}, ctx);
    expect(r.isError, isFalse);
    expect(fake.calls, kChatSearchLimit + 1);
  });

  test('轻聊天搜索: 模型看到的 spec 仍是 web_search (换名字它会不认识)', () {
    final tool = CappedWebSearchTool(WebSearchTool(_FakeSearch()));
    expect(tool.spec.name, 'web_search');
    expect(tool.spec.parameters['required'], ['query']);
  });

  test('画图不再有张数上限: 一轮连画 3 张不同的图, 每次都真的出图', () async {
    final fake = _FakeImage();
    final tool = ChatRepeatGuard(fake);
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());

    for (final prompt in ['一只猫', '一只狗', '一只鸟']) {
      final r = await tool.run({'prompt': prompt}, ctx);
      expect(r.isError, isFalse, reason: '「$prompt」应该真去画');
    }
    expect(fake.calls, 3);
    /* 换名字模型会不认识这个工具 */
    expect(tool.spec.name, 'generate_image');
  });

  test('防跑飞: 同工具同参数重复调用直接拦 (不重复出图 / 不重复搜索)', () async {
    final fake = _FakeImage();
    final tool = ChatRepeatGuard(fake);
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());

    expect((await tool.run({'prompt': '一只猫'}, ctx)).isError, isFalse);
    final again = await tool.run({'prompt': '一只猫'}, ctx);
    expect(again.isError, isTrue);
    expect(again.output, contains('同样的参数'));
    expect(again.output, contains('不要重复调用'));
    expect(fake.calls, 1, reason: '重复调用不能再真去出图');

    /* 换了参数照常执行 */
    expect((await tool.run({'prompt': '一只狗'}, ctx)).isError, isFalse);
    expect(fake.calls, 2);
  });

  test('防跑飞: 上一次失败时, 同样的参数重试是正当的', () async {
    final failing = _FlakyImage();
    final tool = ChatRepeatGuard(failing);
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());

    expect((await tool.run({'prompt': '一只猫'}, ctx)).isError, isTrue);
    expect((await tool.run({'prompt': '一只猫'}, ctx)).isError, isFalse);
    expect(failing.calls, 2);
  });

  test('防跑飞: 并发批次里两个同参数调用只真跑一次 (在飞也要拦)', () async {
    final fake = _SlowImage();
    final tool = ChatRepeatGuard(fake);
    final ctx = sdk.ToolContext(cancel: sdk.AgentCancelToken());

    /* 同一轮的多个工具调用是并发跑的: 第二个在第一个还没返回时就到了 */
    final results = await Future.wait([
      tool.run({'prompt': '同一只猫'}, ctx),
      tool.run({'prompt': '同一只猫'}, ctx),
    ]);

    expect(fake.calls, 1, reason: '同样的图不能画两遍 (白花钱)');
    expect(results.where((r) => r.isError), hasLength(1));
    expect(results.firstWhere((r) => r.isError).output, contains('不要重复调用'));
  });

  test('包装层不吃掉并发能力: 搜索 cap / 重复拦截之后仍标 parallelSafe', () {
    final search = CappedWebSearchTool(WebSearchTool(_FakeSearch()));
    expect(search, isA<sdk.ParallelSafeTool>());
    expect((search as sdk.ParallelSafeTool).parallelSafe, isTrue,
        reason: '多个搜索要同时跑, 不是排队');

    final guarded = ChatRepeatGuard(_FakeImage());
    expect((guarded as sdk.ParallelSafeTool).parallelSafe, isTrue);

    /* 委托而不是写死 true: 内层不并发安全的, 包装后也照样串行 */
    final guardedSerial = ChatRepeatGuard(_SerialTool());
    expect((guardedSerial as sdk.ParallelSafeTool).parallelSafe, isFalse);
  });

  test('轮次上限只是保险丝: 远大于正常所需 (搜 10 次 + 画 3 张 = 工具轮 + 作答轮)', () {
    expect(kChatLightMaxTurns, greaterThanOrEqualTo(20));
    expect(kChatLightMaxTurns, greaterThan(4), reason: '回到 4 轮就会重现「画不完」');
  });

  test('轻聊天提示词: 只提 Chat 真有的两个工具', () {
    final persona = chatLightPersona();
    expect(persona, contains('web_search'));
    expect(persona, contains('generate_image'));
    /* Work / Code 的工具名一个都不能出现 —— 提了模型就会去调一个不存在的工具 */
    for (final gone in [
      'get_location',
      'calculator',
      'http_fetch',
      'execute_shell',
      'office_edit',
      'workspace_files',
      'phone_call',
    ]) {
      expect(persona, isNot(contains(gone)), reason: 'Chat 里没有 $gone');
    }
    /* 提示词要求「多个方面一次并发搜」「多张图一次并发画」—— 不再写小额度 */
    expect(persona, contains('并发'));
    expect(persona, isNot(contains('最多 3 次')));
    expect(persona, isNot(contains('最多 1 张')));
  });

  /* chat:C2-05 —— 单一源。手机和桌面的人设都由
   * packages/core/src/runtime/prompts/chatPersona.source.json 生成
   * (scripts/bake-chat-persona.mjs), 改了一边另一边不会不知道。 */
  test('chat:C2-05 手机人设逐字等于仓库唯一源拼出来的文本', () {
    final source = _personaSource();
    final zh = source['zh'] as Map<String, Object?>;
    for (final search in [true, false]) {
      for (final image in [true, false]) {
        expect(
          chatLightPersona(search: search, image: image),
          _composePersona(zh, search: search, image: image),
          reason: 'zh search=$search image=$image 跟单一源不一致 —— 改完源 JSON 要跑 '
              'node scripts/bake-chat-persona.mjs',
        );
      }
    }
  });

  test('chat:C2-04 手机人设 ≤350 字符 (每条消息都要付它)', () {
    for (final search in [true, false]) {
      for (final image in [true, false]) {
        final p = chatLightPersona(search: search, image: image);
        expect(p.length, lessThanOrEqualTo(350), reason: 'zh $search$image 太长');
        expect(_estimateTokens(p), lessThan(400));
      }
    }
  });

  test('chat:C2-06 回答长度按问题复杂度分三档, 条件可判定', () {
    final p = chatLightPersona();
    expect(p, contains('回答长度跟问题复杂度走'));
    /* 一档: 打招呼 / 是非题 */
    expect(p, contains('打招呼/是非题: 最多 2 句，不列点'));
    /* 二档: 普通问题 —— 1~3 句理由, 列点 ≤5 条 */
    expect(p, contains('普通问题: 先结论，再 1~3 句理由；列点≤5 条'));
    /* 三档: 多步 / 对比 / 长内容 */
    expect(p, contains('多步/对比/长文: 才用小标题、表格'));
    /* 从上往下读: 短 → 普通 → 复杂 */
    final simple = p.indexOf('打招呼/是非题');
    final ordinary = p.indexOf('普通问题');
    final complex = p.indexOf('多步/对比');
    expect(ordinary, greaterThan(simple));
    expect(complex, greaterThan(ordinary));
  });

  test('没有搜索时人设不说「能搜」, 也不承诺来源 (不静默降级成编造)', () {
    final p = chatLightPersona(search: false);
    expect(p, isNot(contains('web_search')));
    expect(p, contains('没有联网搜索'));
    expect(p, isNot(contains('来源')));
  });
}

/* ── chat:C2-05 的测试辅助: 读唯一源, 按烘焙脚本同一套顺序拼一遍 ─────────── */

/// flutter test 的 cwd 是 apps/mobile; 兼容从仓库根跑的情况。
Map<String, Object?> _personaSource() {
  for (final rel in [
    '../../packages/core/src/runtime/prompts/chatPersona.source.json',
    'packages/core/src/runtime/prompts/chatPersona.source.json',
  ]) {
    final f = File(rel);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, Object?>;
    }
  }
  fail('找不到单一源 packages/core/src/runtime/prompts/chatPersona.source.json');
}

/// 跟 scripts/bake-chat-persona.mjs 的 composePersona 同一套顺序。
String _composePersona(
  Map<String, Object?> b, {
  required bool search,
  required bool image,
  String style = 'card',
}) {
  final lines = <String>[b['core']! as String];
  final count = (search ? 1 : 0) + (image ? 1 : 0);
  lines.add((b['toolsHeader']! as Map)[count.toString()]! as String);
  final tool = b['tool']! as Map;
  final missing = b['missing']! as Map;
  final closing = b['closing']! as Map;
  if (search) lines.add(tool['search']! as String);
  if (image) lines.add(tool['image']! as String);
  if (!search) lines.add(missing['search']! as String);
  if (!image) lines.add(missing['image']! as String);
  if (count == 0) lines.add(missing['none']! as String);
  if (search && style == 'links') {
    lines.add(closing['links']! as String);
  } else if (count > 0) {
    lines.add(closing['card']! as String);
  }
  lines.add(b['noFiles']! as String);
  return lines.join('\n');
}
