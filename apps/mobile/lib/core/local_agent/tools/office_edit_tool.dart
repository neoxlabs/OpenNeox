/// office_edit_tool.dart — 手机 Agent 改 / 新建 PPT、Word、Excel 的工具 (2026-10-11)。
///
/// 文件都在 Agent 工作区里: 用户发来的 Office 原件落在 uploads/ (见 phone_local_agent 收附件那段),
/// 改完另存一份新文件, 对话里挂下载卡 (_localArtifactsOf 认 save_as)。原件不覆盖 —— 改坏了还有退路。
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:neox_agent_sdk/neox_agent_sdk.dart' as sdk;

import '../office/docx_builder.dart';
import '../office/office_doc.dart';
import '../office/pptx_builder.dart';
import '../office/xlsx_builder.dart';

class OfficeEditTool implements sdk.AgentTool {
  OfficeEditTool({required this.rootDir});

  final Directory rootDir;

  @override
  sdk.ToolSpec get spec => const sdk.ToolSpec(
        name: 'office_edit',
        description: '在手机上直接看 / 改 / 新建 PPT(.pptx)、Word(.docx)、Excel(.xlsx), 文件在工作区里 '
            '(用户发来的原件在 uploads/ 下)。先 op=outline 看结构 (每段 / 每个格子带 id), 再 op=edit 一次给一串改动, '
            '改完另存为新文件 (save_as), 用户在对话里直接下载。原件不会被覆盖。\n'
            'edits 里每项一个 action:\n'
            '  replace {find, replace} 全文查找替换 (三种都行)\n'
            '  set_text {id, text} 整段改写, id 来自 outline (PPT 如 s2.p1, Word 如 p5)\n'
            '  delete_slide {slide} / duplicate_slide {slide} (复制的插在原页后) / move_slide {slide, to} —— 仅 PPT, 页码按当时的顺序\n'
            '  set_cell {cell, value} 仅 Excel, cell 如 "Sheet1!B3", 数字存数字, "=" 开头存真公式 (打开时重算)\n'
            '  set_format {range, format} 仅 Excel, 如 {range: "Sheet1!G2:G6", format: "percent"} (percent / money / thousands / decimal / int / date), 原样式保留\n'
            '  add_chart {sheet?, type, title, categories, series, anchor?} 仅 Excel, 在原表上加原生图表, 参数同 create_xlsx 的 charts\n'
            '  改用户发来的表: 用 edit (set_cell 加公式列 / 合计行 + set_format + add_chart), 别用 create_xlsx 重建 —— 重建会丢掉原文件的格式、其它表和图。\n'
            'op=create_docx {save_as, content}: content 用 Markdown 写: # / ## / ### 标题 (Word 真标题样式), - 列表, 1. 编号, '
            '| 表头 | 表头 | 表格 (第二行 |---|), **加粗**, > 引用, 单独一行 --- 分页。每行一段。\n'
            'op=create_xlsx {save_as, sheets}: 原生 Excel, 不用装任何东西。sheets 每项 {name, rows[][], formats?, merges?, charts?}:\n'
            '  rows 第一行是表头 (自动加粗底色 + 冻结); "=" 开头的格子是真公式 (如 "=SUM(B2:G2)" "=B2/\$H\$5"), 改数自动重算, 显示值也预先算好;\n'
            '    "12%" "¥3,000" "1,200" 会存成数字带格式; 「合计/总计」开头的行自动加粗。\n'
            '  formats {"区域": 格式}: percent / money (¥) / thousands / decimal / int / date, 如 {"H2:H5": "percent"}\n'
            '  merges ["A1:D1"] 合并单元格\n'
            '  charts [{type: bar|barh|line|pie, title, categories: "A2:A4", series: [{name: "B1", values: "B2:B4"}], anchor?: "J2"}] 原生图表 (Excel / WPS 里可编辑)\n'
            '  简单表也可以直接给 rows (只有一张表)。\n'
            'op=create_pptx {save_as, theme, slides}: 从零新建 PPT (16:9, 排版配色自动)。theme: blue 商务 / red 年会喜庆 / green / purple / orange / dark。\n'
            '  slides 每项 {layout, title, ...}, layout:\n'
            '    cover {title, subtitle} 封面 · closing {title, subtitle} 结束页\n'
            '    section {title, subtitle} 章节过渡页: title 写章节名 (如「活动流程」), 序号 01/02 自动加, 别写「PART 01」\n'
            '    bullets {title, subtitle?, bullets[]} 要点 (「小标题：说明」冒号前自动加粗, 一页 3~6 条最好看)\n'
            '    two_column {title, left_title, left[], right_title, right[]} 左右对比\n'
            '    table {title, rows[][]} 表格 (第一行表头, 流程 / 预算 / 分工 / 时间表用它)\n'
            '    stats {title, stats[{value, label}], bullets[]?} 2~4 个大数字\n'
            '    image {title, subtitle?, image} 整页大图 + 底部标题带\n'
            '  配图: 任何页都可以带 image (工作区里的 png / jpg 路径)。cover / closing / bullets 带图时图放右半边。\n'
            '    图从哪来: 先用 generate_image 画 (回执里的 images/xxx.png), 或用户发来的照片 (uploads/), '
            '或本地 Linux 里用 matplotlib 画的图表 (先存成 png)。封面和章节配一张主题图, 数据页放图表, 会好看很多。\n'
            '  一份像样的 PPT: 封面 → 每章 section + 2~4 页内容 (版式交替用, 别全是 bullets) → closing。\n'
            '改不了: PPT / Word 的动画、切换效果、原生图表 (PPT 里图表用图片代替; Excel 的原生图表用 create_xlsx 的 charts)。',
        parameters: {
          'type': 'object',
          'properties': {
            'op': {
              'type': 'string',
              'enum': ['outline', 'edit', 'create_docx', 'create_xlsx', 'create_pptx'],
            },
            'path': {'type': 'string', 'description': '要看 / 改的文件, 相对工作区, 如 "uploads/汇报.pptx"'},
            'edits': {
              'type': 'array',
              'items': {
                'type': 'object',
                'properties': {
                  'action': {
                    'type': 'string',
                    'enum': ['replace', 'set_text', 'delete_slide', 'duplicate_slide', 'move_slide', 'set_cell', 'set_format', 'add_chart'],
                  },
                  'range': {'type': 'string'},
                  'format': {'type': 'string'},
                  'sheet': {'type': 'string'},
                  'type': {'type': 'string', 'enum': ['bar', 'barh', 'line', 'pie']},
                  'title': {'type': 'string'},
                  'categories': {'type': 'string'},
                  'series': {
                    'type': 'array',
                    'items': {
                      'type': 'object',
                      'properties': {'name': {'type': 'string'}, 'values': {'type': 'string'}},
                    },
                  },
                  'anchor': {'type': 'string'},
                  'find': {'type': 'string'},
                  'replace': {'type': 'string'},
                  'id': {'type': 'string'},
                  'text': {'type': 'string'},
                  'slide': {'type': 'integer'},
                  'to': {'type': 'integer'},
                  'cell': {'type': 'string'},
                  'value': {'type': 'string'},
                },
                'required': ['action'],
              },
            },
            'save_as': {'type': 'string', 'description': '输出文件, 相对工作区; 不填就在原名后加「-修改版」'},
            'content': {'type': 'string', 'description': 'create_docx 的正文'},
            'rows': {
              'type': 'array',
              'items': {'type': 'array', 'items': {'type': 'string'}},
              'description': 'create_xlsx 只有一张表时的简写',
            },
            'sheets': {
              'type': 'array',
              'description': 'create_xlsx 的工作表',
              'items': {
                'type': 'object',
                'properties': {
                  'name': {'type': 'string'},
                  'rows': {'type': 'array', 'items': {'type': 'array', 'items': {'type': 'string'}}},
                  'formats': {'type': 'object', 'additionalProperties': {'type': 'string'}},
                  'merges': {'type': 'array', 'items': {'type': 'string'}},
                  'charts': {
                    'type': 'array',
                    'items': {
                      'type': 'object',
                      'properties': {
                        'type': {'type': 'string', 'enum': ['bar', 'barh', 'line', 'pie']},
                        'title': {'type': 'string'},
                        'categories': {'type': 'string'},
                        'series': {
                          'type': 'array',
                          'items': {
                            'type': 'object',
                            'properties': {'name': {'type': 'string'}, 'values': {'type': 'string'}},
                          },
                        },
                        'anchor': {'type': 'string'},
                      },
                    },
                  },
                },
              },
            },
            'theme': {'type': 'string', 'enum': ['blue', 'red', 'green', 'purple', 'orange', 'dark'], 'description': 'create_pptx 的配色'},
            'slides': {
              'type': 'array',
              'description': 'create_pptx 的每一页',
              'items': {
                'type': 'object',
                'properties': {
                  'layout': {'type': 'string', 'enum': ['cover', 'section', 'bullets', 'two_column', 'table', 'stats', 'image', 'closing']},
                  'image': {'type': 'string', 'description': '配图, 工作区里的 png / jpg 路径'},
                  'title': {'type': 'string'},
                  'subtitle': {'type': 'string'},
                  'bullets': {'type': 'array', 'items': {'type': 'string'}},
                  'left_title': {'type': 'string'},
                  'left': {'type': 'array', 'items': {'type': 'string'}},
                  'right_title': {'type': 'string'},
                  'right': {'type': 'array', 'items': {'type': 'string'}},
                  'rows': {'type': 'array', 'items': {'type': 'array', 'items': {'type': 'string'}}},
                  'stats': {
                    'type': 'array',
                    'items': {
                      'type': 'object',
                      'properties': {'value': {'type': 'string'}, 'label': {'type': 'string'}},
                    },
                  },
                },
                'required': ['layout'],
              },
            },
          },
          'required': ['op'],
        },
      );

  @override
  Future<sdk.ToolResult> run(Map<String, Object?> args, sdk.ToolContext ctx) async {
    final op = (args['op'] as String?) ?? '';
    try {
      switch (op) {
        case 'outline':
          final f = _file(args['path']);
          return sdk.ToolResult.ok(OfficeDoc.open(f.path, await f.readAsBytes()).outline());
        case 'edit':
          return _edit(args);
        case 'create_docx':
          final out = _file(args['save_as'], mustExist: false, ext: 'docx');
          final content = (args['content'] as String?) ?? '';
          if (content.trim().isEmpty) return const sdk.ToolResult.error('content 是空的');
          final doc = DocxBuilder(content);
          await _save(out, doc.build());
          return sdk.ToolResult.ok('已新建 ${_rel(out)}\n${doc.report.describe()}');
        case 'create_xlsx':
          final out = _file(args['save_as'], mustExist: false, ext: 'xlsx');
          final sheets = _sheetsOf(args);
          if (sheets.isEmpty || sheets.every((s) => s.rows.isEmpty)) {
            return const sdk.ToolResult.error('表是空的 —— 给 sheets[{name, rows}] (或简写 rows)');
          }
          final builder = XlsxBuilder(sheets);
          await _save(out, builder.build());
          /* 回执照实写: 写进了几个真公式 / 图表 / 格式。旧版只说「已新建 (N 行)」, 模型就自己编「公式已生效」 */
          /* 第一行格式别动: phone_local_agent 按「已新建 <路径> (N 行)」挂下载卡 */
          return sdk.ToolResult.ok('已新建 ${_rel(out)} (${sheets.fold<int>(0, (a, s) => a + s.rows.length)} 行)\n'
              '${sheets.length > 1 ? '${sheets.map((s) => '「${s.name}」${s.rows.length} 行').join('、')} · ' : ''}'
              '${builder.report.describe()}');
        case 'create_pptx':
          final out = _file(args['save_as'], mustExist: false, ext: 'pptx');
          final slides = [
            for (final s in (args['slides'] as List?) ?? const [])
              if (s is Map) PptSlide.fromJson(s.cast<String, Object?>()),
          ];
          if (slides.isEmpty) return const sdk.ToolResult.error('slides 是空的 —— 至少给一页 (封面 + 内容 + 结束页最好)');
          /* 配图: 工作区里的图片读进来; 找不到 / 不是 png·jpg 的如实报, 那页照常出 (不带图) */
          final images = <String, Uint8List>{};
          final missing = <String>[];
          for (final s in slides) {
            final p = s.image;
            if (p == null || images.containsKey(p)) continue;
            try {
              images[p] = await _file(p).readAsBytes();
            } on OfficeEditError {
              missing.add(p);
            }
          }
          await _save(out, PptxBuilder(slides: slides, theme: '${args['theme'] ?? 'blue'}', images: images).build());
          return sdk.ToolResult.ok('已新建 ${_rel(out)} (${slides.length} 页)'
              '${missing.isEmpty ? '' : '\n这些配图在工作区里没找到, 那几页没放图: ${missing.join('、')}'}');
        default:
          return sdk.ToolResult.error('未知 op "$op" (outline / edit / create_docx / create_xlsx / create_pptx)');
      }
    } on OfficeEditError catch (e) {
      return sdk.ToolResult.error(e.message);
    }
  }

  Future<sdk.ToolResult> _edit(Map<String, Object?> args) async {
    final src = _file(args['path']);
    final doc = OfficeDoc.open(src.path, await src.readAsBytes());
    final edits = (args['edits'] as List?) ?? const [];
    if (edits.isEmpty) return const sdk.ToolResult.error('edits 是空的 —— 先 outline 看结构, 再给改动');
    final log = <String>[];
    for (final (i, raw) in edits.indexed) {
      if (raw is! Map) continue;
      final e = raw.cast<String, Object?>();
      String s(String k) => '${e[k] ?? ''}';
      int n(String k) => (e[k] as num?)?.toInt() ?? int.tryParse(s(k)) ?? -1;
      try {
        switch (s('action')) {
          case 'replace':
            final c = doc.replace(s('find'), s('replace'));
            log.add(c == 0 ? '没找到「${s('find')}」' : '「${s('find')}」→「${s('replace')}」$c 处');
          case 'set_text':
            doc.setText(s('id'), s('text'));
            log.add('${s('id')} 已改写');
          case 'delete_slide':
            doc.deleteSlide(n('slide'));
            log.add('删了第 ${n('slide')} 页');
          case 'duplicate_slide':
            doc.duplicateSlide(n('slide'));
            log.add('复制了第 ${n('slide')} 页');
          case 'move_slide':
            doc.moveSlide(n('slide'), n('to'));
            log.add('第 ${n('slide')} 页挪到第 ${n('to')} 页');
          case 'set_cell':
            final v = doc.setCell(s('cell'), s('value'));
            log.add(!s('value').trim().startsWith('=')
                ? '${s('cell')} = ${s('value')}'
                : v == null
                    ? '${s('cell')} 写了公式 ${s('value').trim()} (这里算不出值, 打开时由 Excel / WPS 算)'
                    : '${s('cell')} 写了公式 ${s('value').trim()} → ${v is double ? XlsxBuilder.numText(v) : v}');
          case 'set_format':
            final n = doc.setFormat(s('range'), s('format'));
            log.add(n == 0
                ? '${s('range')} 里没有内容格, 没改格式'
                : '${s('range')} 设成${XlsxBuilder.formatLabel(XlsxBuilder.normalizeFormat(s('format')))}格式 ($n 格)');
          case 'add_chart':
            final chart = _chartOf(e);
            if (chart == null) {
              log.add('第 ${i + 1} 项图表缺 categories / series');
            } else {
              doc.addChart(chart, sheet: e['sheet'] == null ? null : s('sheet'));
              log.add('加了${XlsxBuilder.chartNames[chart.type] ?? '柱状图'}「${chart.title}」(原生图表, ${chart.series.length} 组数据)');
            }
          default:
            log.add('第 ${i + 1} 项 action 不认识: ${s('action')}');
        }
      } on OfficeEditError catch (err) {
        /* 一项失败不连坐: 其余照改, 失败的如实报 */
        log.add('第 ${i + 1} 项没改成: ${err.message}');
      }
    }
    final out = args['save_as'] == null || '${args['save_as']}'.trim().isEmpty
        ? File(_defaultOut(src.path))
        : _file(args['save_as'], mustExist: false, ext: src.path.split('.').last);
    await _save(out, doc.save());
    /* 最后一行格式别动: phone_local_agent 按「已保存为 <路径>」挂下载卡 */
    final hint = log.any((l) => l.contains(' → ')) ? '\n(回复里提到的数字以上面 → 后的值为准)' : '';
    return sdk.ToolResult.ok('${log.join('\n')}$hint\n已保存为 ${_rel(out)}');
  }

  /// sheets[] 或简写 rows → 工作表; 模型偶尔把数字直接给成 number / 把 formats 给成数组, 都收
  static List<XlsxSheetSpec> _sheetsOf(Map<String, Object?> args) {
    List<List<String>> rowsOf(Object? raw) => [
          for (final r in (raw as List?) ?? const [])
            [for (final c in (r is List ? r : [r])) c is double && c == c.roundToDouble() ? '${c.toInt()}' : '${c ?? ''}'],
        ];
    final raw = args['sheets'];
    if (raw is! List || raw.isEmpty) {
      return [XlsxSheetSpec(name: 'Sheet1', rows: rowsOf(args['rows']))];
    }
    return [
      for (final (i, s) in raw.indexed)
        if (s is Map)
          XlsxSheetSpec(
            name: '${s['name'] ?? 'Sheet${i + 1}'}',
            rows: rowsOf(s['rows']),
            formats: {
              if (s['formats'] is Map)
                for (final e in (s['formats'] as Map).entries) '${e.key}': '${e.value}'
              else if (s['formats'] is List)
                for (final f in (s['formats'] as List).whereType<Map>()) '${f['range'] ?? f['cells'] ?? ''}': '${f['format'] ?? f['type'] ?? ''}',
            },
            merges: [for (final m in (s['merges'] as List?) ?? const []) '$m'],
            charts: [
              for (final c in (s['charts'] as List?) ?? const [])
                if (c is Map) ?_chartOf(c),
            ],
          ),
    ];
  }

  static XlsxChartSpec? _chartOf(Map c) {
    if (c['categories'] == null || c['series'] is! List) return null;
    final series = [
      for (final x in c['series'] as List)
        if (x is Map && x['values'] != null) (name: '${x['name'] ?? ''}', values: '${x['values']}'),
    ];
    if (series.isEmpty) return null;
    return XlsxChartSpec(
      type: '${c['type'] ?? 'bar'}',
      title: '${c['title'] ?? ''}',
      categories: '${c['categories']}',
      anchor: c['anchor'] == null ? null : '${c['anchor']}',
      series: series,
    );
  }

  File _file(Object? raw, {bool mustExist = true, String? ext}) {
    var rel = '${raw ?? ''}'.trim();
    if (rel.isEmpty) throw OfficeEditError(mustExist ? 'path 不能为空' : 'save_as 不能为空');
    if (ext != null && !rel.toLowerCase().endsWith('.$ext')) rel = '$rel.$ext';
    final root = rootDir.absolute.path;
    final f = File('$root/$rel').absolute;
    final norm = Uri.file(f.path).normalizePath().toFilePath();
    if (!norm.startsWith('$root/')) throw OfficeEditError('路径越出工作区: $rel');
    if (mustExist && !File(norm).existsSync()) {
      throw OfficeEditError('工作区里没有 $rel (用户发来的原件在 uploads/ 下, 用 workspace_files op=list 看看)');
    }
    return File(norm);
  }

  /// 「原名-修改版」; 已经有了就加序号 —— 上一版可能已经发给别人了, 不能悄悄盖掉
  String _defaultOut(String srcPath) {
    final dot = srcPath.lastIndexOf('.');
    final base = '${srcPath.substring(0, dot)}-修改版';
    final ext = srcPath.substring(dot);
    var out = '$base$ext';
    for (var i = 2; File(out).existsSync(); i++) {
      out = '$base$i$ext';
    }
    return out;
  }

  Future<void> _save(File f, List<int> bytes) async {
    await f.parent.create(recursive: true);
    await f.writeAsBytes(bytes, flush: true);
  }

  String _rel(File f) => f.path.substring(rootDir.absolute.path.length + 1);
}
