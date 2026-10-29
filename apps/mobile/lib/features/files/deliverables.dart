/// deliverables.dart — 「成品」: 手机上 Agent 做出来的文件 (幻灯片 / 表格 / 文档 / 图片 / 网页 …).
///
/// 成品页、侧栏「成品 128」角标、搜索里的「成品」组共用这一份扫描。
/// 只列给人拿走的东西: 跳过依赖和缓存目录, 跳过源码文件。
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../core/i18n/tr.dart';

enum DeliverableKind { slide, sheet, doc, image, web, media, other }

extension DeliverableKindX on DeliverableKind {
  String get label => switch (this) {
        DeliverableKind.slide => tr('幻灯片'),
        DeliverableKind.sheet => tr('表格'),
        DeliverableKind.doc => tr('文档'),
        DeliverableKind.image => tr('图片'),
        DeliverableKind.web => tr('网页'),
        DeliverableKind.media => tr('音视频'),
        DeliverableKind.other => tr('其他'),
      };

  IconData get icon => switch (this) {
        DeliverableKind.slide => Icons.slideshow_outlined,
        DeliverableKind.sheet => Icons.table_chart_outlined,
        DeliverableKind.doc => Icons.description_outlined,
        DeliverableKind.image => Icons.image_outlined,
        DeliverableKind.web => Icons.language_outlined,
        DeliverableKind.media => Icons.play_circle_outline,
        DeliverableKind.other => Icons.insert_drive_file_outlined,
      };
}

const _slideExt = {'pptx', 'ppt'};
const _sheetExt = {'xlsx', 'xls', 'csv'};
const _docExt = {'docx', 'doc', 'pdf', 'md', 'txt', 'rtf'};
const _webExt = {'html', 'htm'};
const _imageExt = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'};
const _mediaExt = {'mp3', 'mp4', 'm4a', 'wav', 'mov', 'ogg'};
const _otherExt = {'zip', 'json'};

/// 不往下钻的目录: 依赖 / 缓存 / 版本库
const _skipDirs = {'node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.npm', 'dist', 'build', '.next'};

DeliverableKind? deliverableKindOf(String name) {
  final i = name.lastIndexOf('.');
  if (i < 0) return null;
  final ext = name.substring(i + 1).toLowerCase();
  if (_slideExt.contains(ext)) return DeliverableKind.slide;
  if (_sheetExt.contains(ext)) return DeliverableKind.sheet;
  if (_docExt.contains(ext)) return DeliverableKind.doc;
  if (_webExt.contains(ext)) return DeliverableKind.web;
  if (_imageExt.contains(ext)) return DeliverableKind.image;
  if (_mediaExt.contains(ext)) return DeliverableKind.media;
  if (_otherExt.contains(ext)) return DeliverableKind.other;
  return null;
}

class Deliverable {
  Deliverable(this.file, this.rel, this.kind, this.stat);

  final File file;

  /// 相对工作区的路径 (第一段通常是会话 id 或 uploads)
  final String rel;
  final DeliverableKind kind;
  final FileStat stat;

  bool get uploaded => rel.startsWith('uploads/');
  String get name => rel.split('/').last;
  DateTime get modified => stat.modified;
}

/// 扫一遍工作区, 按修改时间倒序.
Future<List<Deliverable>> scanDeliverables({int limit = 2000}) async {
  final docs = await getApplicationDocumentsDirectory();
  final root = Directory('${docs.path}/agent_workspace');
  final out = <Deliverable>[];
  if (!await root.exists()) return out;
  final prefix = root.path.length + 1;
  Future<void> walk(Directory d, int depth) async {
    if (depth > 6 || out.length > limit) return;
    await for (final e in d.list(followLinks: false)) {
      final name = e.path.split('/').last;
      if (name.startsWith('.')) continue;
      if (e is Directory) {
        if (!_skipDirs.contains(name)) await walk(e, depth + 1);
      } else if (e is File) {
        final k = deliverableKindOf(name);
        if (k == null) continue;
        out.add(Deliverable(e, e.path.substring(prefix), k, await e.stat()));
      }
    }
  }

  await walk(root, 0);
  out.sort((a, b) => b.stat.modified.compareTo(a.stat.modified));
  return out;
}

/// 成品清单 (侧栏数量 / 搜索 / 成品页). 做了新文件后 invalidate 一下就刷新.
final deliverablesProvider = FutureProvider.autoDispose<List<Deliverable>>((ref) => scanDeliverables());
