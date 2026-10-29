/// execute_shell —— 在手机里的 Linux 上跑命令 (2026-10-12, 「完全体」)。
///
/// 名字跟桌面同名工具一致, 时间线的卡片 (tool_renderers) 直接认。
/// 没装 Linux 时不报晦涩的错: 告诉模型「请用户去补全」, 页面上那张补全卡由用户点。
library;

import 'dart:io';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../linux_env.dart';

class ShellTool implements sdk.AgentTool {
  ShellTool({required this.rootDir});

  final Directory rootDir;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'execute_shell',
        description: '在这台手机自带的 Linux (Alpine, 有 root) 里跑 shell 命令。当前目录 /workspace = 对话工作区 '
            '(用户发来的文件在 /workspace/uploads/, 生成的文件放 /workspace/ 下, 用户在对话里就能拿到)。\n'
            '已装: python3 / pip / node / npm / bash / git / curl / requests / pillow / openpyxl / python-docx / python-pptx / zip / unzip / pdftotext / pdftoppm '
            '(旧版工具包可能缺其中几样: 报找不到就 pip install / apk add nodejs npm zip unzip poppler-utils 补上)。缺什么自己装: '
            'apk add <包> (如 ffmpeg py3-pandas py3-matplotlib font-wqy-zenhei imagemagick build-base go), pip install <包>, npm i <包>; '
            '做 Excel / Word / PPT 先用 office_edit (内置, 公式图表都行), 大批量数据处理才在这里用 openpyxl / pandas; '
            '已经配好国内镜像。画中文图表先 apk add font-wqy-zenhei。\n'
            '⚠️ Java (JDK / Maven / Gradle) 在手机上跑不起来 (安卓不允许 App 里的 JVM 运行), 不要装; Java 项目只能读改代码, 编译运行请用户连电脑。\n'
            '适合: 数据处理、画图表、转格式 (PDF / 图片 / 音视频)、写脚本跑、git、Node / Python 项目开发。一次一条命令 (可以用 && 串), 默认 120 秒超时, 装包可给 timeout_sec=600。'
            '输出太长只留最后 3 万字 —— 大结果写文件再看。',
        parameters: {
          'type': 'object',
          'properties': {
            'command': {'type': 'string', 'description': 'sh -lc 执行的命令'},
            'timeout_sec': {'type': 'integer', 'description': '超时秒数, 默认 120, 最多 1800'},
          },
          'required': ['command'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    if (!Platform.isAndroid) return const sdk.ToolResult.error('只有安卓手机有本地 Linux');
    final cmd = '${args['command'] ?? ''}'.trim();
    if (cmd.isEmpty) return const sdk.ToolResult.error('command 是空的');
    final st = await LinuxEnv.status();
    if (!st.installed) {
      return sdk.ToolResult.error(st.supported
          ? '这台手机还没下载工具包 (约 200MB)。用大白话告诉用户 (别说 Linux / Python 这类词): 到 设置 → 工具包 点「下载」, 装好后就能处理数据、转格式、写代码跑程序; 现在先用别的办法完成。'
          : '这台手机不支持本地 Linux (只支持 arm64 安卓)。用别的办法完成。');
    }
    final t = ((args['timeout_sec'] as num?)?.toInt() ?? 120).clamp(5, 1800);
    final before = _snapshot();
    final r = await LinuxEnv.exec(cmd, workspace: rootDir.absolute.path, timeoutSec: t);
    if (r['error'] != null) return sdk.ToolResult.error('${r['error']}');
    final out = '${r['stdout'] ?? ''}';
    final err = '${r['stderr'] ?? ''}';
    final code = r['exitCode'];
    /* 这条命令在工作区新建 / 改过的文件 —— 列在回执末尾, 对话里据此挂下载卡 (phone_local_agent._localArtifactsOf) */
    final after = _snapshot();
    final produced = [
      for (final e in after.entries)
        if (before[e.key] != e.value) e.key,
    ]..sort();
    final text = [
      if (r['timedOut'] == true) '(超时 $t 秒被杀掉)',
      'exit $code',
      if (out.trim().isNotEmpty) out.trimRight(),
      if (err.trim().isNotEmpty) '[stderr]\n${err.trimRight()}',
      if (produced.isNotEmpty) '$producedMarker\n${produced.take(20).join('\n')}',
    ].join('\n');
    return code == 0 ? sdk.ToolResult.ok(text) : sdk.ToolResult.error(text);
  }

  /// 回执里「产出文件」那一段的抬头
  static const producedMarker = '[工作区里新建 / 改过的文件]';

  /// 工作区文件 → 修改时间 (最多看 3000 个, 不进隐藏目录)
  Map<String, int> _snapshot() {
    final root = rootDir.absolute.path;
    final out = <String, int>{};
    try {
      for (final e in rootDir.listSync(recursive: true, followLinks: false)) {
        if (out.length >= 3000) break;
        if (e is! File) continue;
        final rel = e.path.substring(root.length + 1);
        if (rel.split('/').any((s) => s.startsWith('.'))) continue;
        out[rel] = e.statSync().modified.millisecondsSinceEpoch;
      }
    } catch (_) {}
    return out;
  }
}
