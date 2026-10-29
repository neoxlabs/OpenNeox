/// clock_tool.dart — 当前时间/日期工具 (模型没有实时时钟).
library;

import '../types.dart';

class ClockTool implements AgentTool {
  ClockTool({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;

  @override
  ToolSpec get spec => const ToolSpec(
        name: 'clock',
        description: '获取当前的本地日期时间 (含星期、时区偏移)。任何涉及"今天/现在/明天"的任务先调它。',
        parameters: {'type': 'object', 'properties': {}},
      );

  static const _weekdays = ['一', '二', '三', '四', '五', '六', '日'];

  @override
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx) async {
    final n = _now();
    final tz = n.timeZoneOffset;
    final sign = tz.isNegative ? '-' : '+';
    final h = tz.inHours.abs().toString().padLeft(2, '0');
    final m = (tz.inMinutes.abs() % 60).toString().padLeft(2, '0');
    return ToolResult.ok(
      '${n.year}-${_p(n.month)}-${_p(n.day)} ${_p(n.hour)}:${_p(n.minute)}:${_p(n.second)} '
      '周${_weekdays[n.weekday - 1]} (UTC$sign$h:$m)',
    );
  }

  String _p(int v) => v.toString().padLeft(2, '0');
}
