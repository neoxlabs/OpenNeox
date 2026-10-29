/// phone_batch.dart — 一次做完一串手机操控动作 (pilot:D-05, 2026-10-18).
///
/// 以前每一步都要一轮: snapshot → tap → snapshot → type → snapshot … 十步下单要十几次模型往返,
/// 每次还得把整屏控件重新发一遍。这里把「已经看清屏幕、后面几步不用改主意」的连续动作合成一次调用:
/// 模型给一串 steps, 手机按顺序做完, 只回每步一行 + 最后整屏。
///
/// 两条不肯省的规矩:
///   · 中途某步失败就停, 不再往下点 —— 界面已经不是模型设想的那一屏了。
///   · 最后一步是 phone_ui 时强制 full=true 回整屏: 中间那几步的屏幕没给模型看,
///     不能让它拿「[3-12] 同上」去点一屏自己没见过的界面 (pilot:D-04 的增量只对看得见的上一次有效)。
///
/// 只做操控类动作 (phone_ui / open_app)。发短信、打电话、付钱这类不可逆的事单独调,
/// 让批准卡 / PayGuard 一次只面对一件事。
library;

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

/// 一次最多几步 —— 再多模型自己也记不住中间状态, 分成几次做更稳
const int phoneBatchMaxSteps = 12;

/// batch 里允许的步骤工具 (只做操控, 不做发消息 / 打电话 / 拍照)
const Set<String> phoneBatchAllowedTools = {'phone_ui', 'open_app'};

/// batch 里允许的 phone_ui op —— 截图 / read_text 的结果要么是图片要么是一大段文字,
/// 中间步骤的它们看不到, 放进来只会白做
const Set<String> phoneBatchUiOps = {'snapshot', 'tap', 'tap_at', 'type', 'scroll', 'back', 'home'};

/// 按名字取工具 (phone_tools.dart 里就是同一个工具表)
typedef PhoneBatchResolver = sdk.AgentTool? Function(String name);

class PhoneBatchStep {
  const PhoneBatchStep({required this.tool, required this.args});

  final String tool;
  final Map<String, Object?> args;

  String get op => '${args['op'] ?? ''}'.trim();
}

/// 解析 steps. 出错时 steps 为 null、error 是给模型看的一句中文.
///
/// 两种写法都认:
///   {tool: 'phone_ui', args: {op: 'tap', target: 3}}   —— 显式
///   {op: 'tap', target: 3}                            —— 省略 tool 时按 phone_ui
({List<PhoneBatchStep>? steps, String? error}) parsePhoneBatchSteps(Object? raw) {
  if (raw is! List || raw.isEmpty) {
    return (steps: null, error: 'steps 要是非空数组, 每项是一步动作');
  }
  if (raw.length > phoneBatchMaxSteps) {
    return (steps: null, error: '一次最多 $phoneBatchMaxSteps 步 (现在是 ${raw.length} 步): 分成几次做');
  }
  final out = <PhoneBatchStep>[];
  for (var i = 0; i < raw.length; i++) {
    final at = i + 1;
    final item = raw[i];
    if (item is! Map) return (steps: null, error: '第 $at 步不是对象');
    final m = <String, Object?>{for (final e in item.entries) e.key.toString(): e.value};

    late final String tool;
    late final Map<String, Object?> args;
    if (m.containsKey('tool')) {
      tool = '${m['tool'] ?? ''}'.trim();
      final a = m['args'];
      if (a != null && a is! Map) return (steps: null, error: '第 $at 步的 args 要是对象');
      args = a is Map ? <String, Object?>{for (final e in a.entries) e.key.toString(): e.value} : <String, Object?>{};
    } else {
      tool = 'phone_ui';
      args = m;
    }

    if (tool.isEmpty) return (steps: null, error: '第 $at 步没有 tool');
    if (tool == 'batch') return (steps: null, error: '第 $at 步不能再套 batch: 把里面的动作直接平铺到 steps');
    if (!phoneBatchAllowedTools.contains(tool)) {
      return (steps: null, error: 'batch 里只做 phone_ui / open_app; 第 $at 步是 $tool, 单独调它');
    }
    if (tool == 'phone_ui' && !phoneBatchUiOps.contains('${args['op'] ?? ''}'.trim())) {
      return (steps: null, error: '第 $at 步 phone_ui op 只能是 ${phoneBatchUiOps.join(' / ')} (截图 / 读长文放 batch 里看不到结果, 单独调)');
    }
    out.add(PhoneBatchStep(tool: tool, args: args));
  }
  return (steps: out, error: null);
}

/// 批量动作原语: 一次工具调用里按顺序做几步.
class PhoneBatchTool implements sdk.AgentTool {
  PhoneBatchTool(this._resolve);

  final PhoneBatchResolver _resolve;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'batch',
        description: '一次做完一串手机操控动作 (最多 $phoneBatchMaxSteps 步), 少来回几轮: 看清一屏后, 把同一屏上不用改主意的连续点按 / 填字 / 翻页 / 返回放进 steps, 按顺序做完。'
            '每步写 {tool:"phone_ui"|"open_app", args:{…}}, 省略 tool 时按 phone_ui (直接写 {op:"tap", target:3})。'
            '步骤是盲做的: 某一步换了界面, 后面的编号可能已经不对 —— 换屏后先单独 snapshot 再排下一批。'
            '某步失败就停, 回每步一行 + 最后整屏 (最后一步是 phone_ui 时整屏回, 不是的话要再看屏幕再 snapshot)。'
            '只做操控; 发短信 / 打电话 / 付钱单独调。',
        parameters: {
          'type': 'object',
          'properties': {
            'steps': {
              'type': 'array',
              'description': '按顺序做的动作, 最多 $phoneBatchMaxSteps 步',
              'items': {
                'type': 'object',
                'properties': {
                  'tool': {'type': 'string', 'enum': ['phone_ui', 'open_app'], 'description': '默认 phone_ui'},
                  'args': {'type': 'object', 'description': '该工具的参数 (phone_ui 的 op / target / text / direction / x / y)'},
                },
              },
            },
          },
          'required': ['steps'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final parsed = parsePhoneBatchSteps(args['steps']);
    if (parsed.error != null) return sdk.ToolResult.error(parsed.error!);
    final steps = parsed.steps!;
    /* 最后一步是 phone_ui 才要整屏; 中间步骤的屏幕不给模型看, 用增量省下来的那点反而会误导它 */
    final last = steps.length - 1;
    final log = <String>[];

    for (var i = 0; i < steps.length; i++) {
      ctx.cancel.throwIfCancelled();
      final step = steps[i];
      final tool = _resolve(step.tool);
      if (tool == null) {
        return sdk.ToolResult.error(await _failure(log, steps, i, '这台手机上找不到 ${step.tool}', ctx));
      }
      final call = <String, Object?>{...step.args};
      final finalScreen = i == last && step.tool == 'phone_ui';
      if (finalScreen) call['full'] = true;

      sdk.ToolResult r;
      try {
        r = await tool.run(call, ctx);
      } catch (e) {
        r = sdk.ToolResult.error(e.toString());
      }
      if (r.isError) {
        return sdk.ToolResult.error(await _failure(log, steps, i, r.output, ctx));
      }
      log.add('${i + 1}. ${_label(step)} → ${_firstLine(r.output)}');
      if (finalScreen) return sdk.ToolResult.ok(_success(log, r.output));
    }

    /* 最后一步不是读屏: 如实说要看屏幕得再调一次, 不假装这就是现在的界面 */
    return sdk.ToolResult.ok(_success(log, null));
  }

  static String _label(PhoneBatchStep step) => step.op.isEmpty ? step.tool : '${step.tool} ${step.op}';

  static String _firstLine(String text) {
    final line = text.trim().split('\n').first.trim();
    return line.length <= 200 ? line : '${line.substring(0, 200)}…';
  }

  static String _success(List<String> log, String? screen) {
    final head = '批量 ${log.length} 步全部完成 (没有失败):';
    if (screen == null) {
      return '$head\n${log.join('\n')}\n(最后一步不是读屏: 要看当前屏幕再 phone_ui snapshot)';
    }
    return '$head\n${log.join('\n')}\n最终屏幕 (整屏):\n$screen';
  }

  Future<String> _failure(
    List<String> log,
    List<PhoneBatchStep> steps,
    int at,
    String why,
    sdk.ToolContext ctx,
  ) async {
    final left = steps.length - at - 1;
    final head = '批量 ${steps.length} 步: 第 ${at + 1} 步失败, 后面 $left 步没做。';
    final screen = await _currentScreen(ctx);
    return '$head\n${log.isEmpty ? '(还没有做成功的步骤)' : log.join('\n')}\n'
        '第 ${at + 1} 步 (${_label(steps[at])}) 失败: $why\n'
        '现在的屏幕 (整屏):\n$screen';
  }

  /// 失败后补一次整屏: 失败那一步可能只回了半屏增量, 模型得看清现在到底停在哪
  Future<String> _currentScreen(sdk.ToolContext ctx) async {
    final tool = _resolve('phone_ui');
    if (tool == null) return '(读不到屏幕: phone_ui 不在工具表里)';
    try {
      final r = await tool.run(const {'op': 'snapshot', 'full': true}, ctx);
      return r.isError ? '(读屏也失败了: ${r.output})' : r.output;
    } catch (e) {
      return '(读屏也失败了: $e)';
    }
  }
}
