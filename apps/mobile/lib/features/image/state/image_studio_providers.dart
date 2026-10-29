/// image_studio_providers.dart — 图片工作台会话 / 发送编排.
///
/// 会话存在手机本地 Drift (kind=image), 完全不依赖桌面.
/// 发送走 ImageDirectService, 事件写入 session_events 供 Timeline 复用.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:drift/drift.dart' show Value;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../core/errors/friendly_error.dart';
import '../../../core/execution/run_target.dart';
import '../../../core/image/image_direct_models.dart';
import '../../../core/image/image_model_pick.dart';
import '../../../core/image/image_request_control.dart';
import '../../../core/image/image_size_pref.dart';
import '../../../core/image/image_direct_service.dart';
import 'image_model_pref.dart';
import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/storage/database.dart';
import '../../home/state/current_session_provider.dart';
import '../../home/state/selected_model_provider.dart';
import '../../timeline/state/timeline_state.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 图片页当前会话 — 与主页 currentSessionProvider 隔离,
/// 进图片页不污染聊天会话; 出图片页也不清空聊天.
final imageStudioSessionProvider =
    StateNotifierProvider<ImageStudioSessionController, String?>(
      (ref) => ImageStudioSessionController(ref),
    );

class ImageStudioSessionController extends StateNotifier<String?> {
  ImageStudioSessionController(this._ref) : super(null);
  final Ref _ref;

  void set(String? id) => state = id;

  /// 确保有一个 kind=image 的本地会话; 返回 sessionId.
  Future<String> ensureSession({String? titleHint}) async {
    final existing = state;
    if (existing != null) {
      final mirror = await _ref
          .read(appDatabaseProvider)
          .sessionMirrorDao
          .findById(existing);
      if (mirror != null) return existing;
    }
    final id = await _createImageSession(title: titleHint);
    state = id;
    return id;
  }

  /// 新画布 = 回到空白, **不落库**. 第一次发送时 [ensureSession] 才建会话 (标题取 prompt).
  ///
  /// 原来这里直接建一条「新图片」会话: 点一次「+」就在「我画过的」里多一张空画布,
  /// 连点几下就是一排空白。跟聊天那边"发第一条才建会话"保持同一个规则。
  void newCanvas() => state = null;

  Future<String> _createImageSession({String? title}) async {
    final db = _ref.read(appDatabaseProvider);
    final now = DateTime.now().millisecondsSinceEpoch;
    final id =
        'img-$now-${Random.secure().nextInt(0xffffff).toRadixString(16)}';
    /* 图片会话的 model_id 记的是**出图**模型, 不是聊天模型。
     * 原来读 selectedModelProvider, 于是图片会话卡上显示的是
     * deepseek-v4-flash 这种文字模型 —— 跟这条会话干的事没关系
     * (2026-09-18 用户: 「图片工作台…显示的还是文字的」)。
     * 没选过偏好时留空: 出图那一刻自动挑, 这里写个具体型号是编的。 */
    final modelId = _ref.read(imageModelPrefProvider) ?? '';
    await db.sessionMirrorDao.upsert(
      SessionMirrorCompanion(
        id: Value(id),
        desktopDeviceId: const Value(kPhoneLocalDeviceId),
        title: Value(
          (title == null || title.trim().isEmpty) ? '新图片' : title.trim(),
        ),
        workspaceName: const Value('图片'),
        lastMessageAt: Value(now),
        lastSeq: const Value(1),
        createdAt: Value(now),
        kind: const Value('image'),
      ),
    );
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(id),
        seq: const Value(1),
        ts: Value(now),
        kind: const Value('session_meta'),
        payload: Value(
          jsonEncode({
            'run_target': 'phoneLocal',
            'kind': 'image',
            'model_id': modelId,
          }),
        ),
      ),
    );
    _ref.read(streamBufferProvider.notifier).updateLatestDriftSeq(id, 1);
    return id;
  }
}

/// data:image/png;base64,xxx → 字节 + mime + 扩展名; 不是 data URL 返回 null。
({Uint8List bytes, String mime, String ext})? _decodeDataUrl(String url) {
  final m = RegExp(r'^data:([^;,]+);base64,(.*)$', dotAll: true).firstMatch(url);
  if (m == null) return null;
  try {
    final mime = m.group(1)!;
    final ext = switch (mime) { 'image/jpeg' => 'jpg', 'image/webp' => 'webp', 'image/gif' => 'gif', _ => 'png' };
    return (bytes: base64Decode(m.group(2)!), mime: mime, ext: ext);
  } catch (_) {
    return null;
  }
}

/// 图片页发送编排 — 写 user + pending/ok/error direct_image 事件.
class ImageStudioSender {
  ImageStudioSender(this._ref);
  final Ref _ref;

  /// 正在出的图 (turn_id → 取消开关) —— 出图卡的「取消」按这个停 (chat:C4-05)。
  static final Map<String, ImageRequestControl> inflightControls = {};

  /// 取消某一轮出图的等待。任务若已提交到网关, 服务器上照跑, 钱不退 ——
  /// 卡上会照实写「可能仍在生成」。
  static void cancel(String turnId) => inflightControls[turnId]?.cancel();

  Future<void> send({
    required String prompt,
    List<String> referenceDataUrls = const [],
  }) async {
    final text = prompt.trim();
    if (text.isEmpty && referenceDataUrls.isEmpty) {
      throw StateError(tr('请先描述你想要的图片'));
    }

    final sessionCtrl = _ref.read(imageStudioSessionProvider.notifier);
    final sessionId = await sessionCtrl.ensureSession(titleHint: text);
    /* 同步到主 currentSession, 让 StageInput / Timeline 共用同一套 watch */
    _ref.read(currentSessionProvider.notifier).set(sessionId);

    final db = _ref.read(appDatabaseProvider);
    final buf = _ref.read(streamBufferProvider.notifier);
    final timeline = _ref.read(timelineStateProvider(sessionId).notifier);

    final turnId =
        'img-${DateTime.now().millisecondsSinceEpoch}-${Random.secure().nextInt(0xffff).toRadixString(16)}';
    final now = DateTime.now().millisecondsSinceEpoch;

    final shownText = text.isEmpty ? tr('改图') : text;
    /* 参考图留底, 气泡上显示「拿哪张图改的」—— 跟对话页同一套 (LocalAttachmentStore 按文本 + 时间配回)。
     * 以前只写文字, 改图的气泡里看不到原图 (2026-10-05 用户实拍)。 */
    final refs = await LocalAttachmentStore.instance.save(
      sessionId,
      shownText,
      [
        for (var i = 0; i < referenceDataUrls.length; i++)
          if (_decodeDataUrl(referenceDataUrls[i]) case final d?)
            (kind: 'image', name: 'reference-${i + 1}.${d.ext}', mime: d.mime, bytes: d.bytes),
      ],
      ts: now,
    );
    buf.setPendingUserText(sessionId, shownText, attachments: refs);
    timeline.markAgentStarting();

    var seq = (await db.sessionEventsDao.getMaxSeq(sessionId)) ?? 1;
    seq += 1;
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(seq),
        ts: Value(now),
        kind: const Value('user_message'),
        payload: Value(
          jsonEncode({'text': shownText, 'turn_id': turnId}),
        ),
      ),
    );
    buf.clearPendingUserText(sessionId);
    buf.updateLatestDriftSeq(sessionId, seq);

    /* pending 图卡 */
    seq += 1;
    final pendingSeq = seq;
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(pendingSeq),
        ts: Value(now + 1),
        kind: const Value('direct_image'),
        payload: Value(
          jsonEncode({
            'turn_id': turnId,
            'status': 'pending',
            'prompt': text,
            'chip': referenceDataUrls.isEmpty ? tr('创建图片') : tr('改图'),
            /* 占位跟成品同尺寸 —— 出图那一下不跳版 (chat:C4-07) */
            'size': (_ref.read(imageSizePrefProvider) ?? ImageSize.square).wire,
          }),
        ),
      ),
    );
    buf.updateLatestDriftSeq(sessionId, pendingSeq);

    /* 自动标题 */
    await _maybeRename(sessionId, text);

    try {
      /* 图片模型从**网关真实列表**里挑, 不用聊天模型、也不写死型号.
       *
       * 两层错叠出来的 bug (2026-08-11 实测):
       *   1. 原来读 selectedModelProvider —— 那是**聊天**模型。用户在对话里选了
       *      deepseek-v4-flash 再进图片页, 就拿纯文本模型去请求
       *      /n1/images/generations, 必被拒;
       *   2. 去掉之后回落到 service 里硬编码的 `gpt-image-1` —— 网关早换代了,
       *      现在在列的是 gpt-image-2 / gpt-image-2-pro / nano-banana-2, 同样被拒。
       * 写死型号就是在赌服务端不换代, 而服务端一定会换。 */
      final models = await _ref.read(availableModelsProvider.future);
      /* 用户在图片页显式选过就用他选的 (2026-09-18 起那一行真的能选了,
       * 见 image_model_pref.dart); 没选过仍然自动挑, 换代自动跟上。 */
      final imageModel = pickImageModel(
        [for (final m in models) m.id],
        preferred: _ref.read(imageModelPrefProvider),
      );
      _inflightTurns.add(turnId);
      final chip = referenceDataUrls.isEmpty ? tr('创建图片') : tr('改图');
      /* 取消开关 + 尺寸 (chat:C4-05 / C4-07): 卡片上的取消 / 尺寸都来自这里 */
      final control = ImageRequestControl();
      inflightControls[turnId] = control;
      final size = _ref.read(imageSizePrefProvider) ?? ImageSize.square;
      final result = await _ref
          .read(imageDirectServiceProvider)
          .generate(
            ImageDirectRequest(
              prompt: text.isEmpty ? 'edit the reference image' : text,
              model: imageModel,
              size: size.wire,
              referenceImages: referenceDataUrls,
              control: control,
              /* 任务号落库: 进程被杀后 resumePending 按它取回 (同一个 turn_id, 卡片就地更新) */
              onJobSubmitted: (jobId) => unawaited(_writeImageEvent(sessionId, {
                'turn_id': turnId,
                'status': 'pending',
                'prompt': text,
                'chip': chip,
                'size': size.wire,
                'job_id': jobId,
                'model': imageModel,
              })),
            ),
          );

      final doneAt = DateTime.now().millisecondsSinceEpoch;
      /* 结果必须用**新 seq**, 不能复写 pendingSeq.
       *
       * TimelineState._applyDrift 按 seq 去重 (_appliedDriftSeqs), 同一个 seq
       * 第二次到达会被直接丢掉 —— 于是 DB 里明明已经是 error/ok, 界面永远停在
       * 「正在生成…」。2026-08-11 模拟器实测: 生图失败后转圈转到天荒地老,
       * 用户不知道它已经死了。
       * 渲染层按 turn_id 归一 (entry id = direct_image-$turnId), 所以新 seq
       * 不会多出一张卡, 只会把同一张卡就地更新。 */
      final doneSeq =
          ((await db.sessionEventsDao.getMaxSeq(sessionId)) ?? pendingSeq) + 1;
      await db.sessionEventsDao.insertEvent(
        SessionEventsCompanion(
          sessionId: Value(sessionId),
          seq: Value(doneSeq),
          ts: Value(doneAt),
          kind: const Value('direct_image'),
          payload: Value(
            jsonEncode({
              'turn_id': turnId,
              'status': result.ok ? 'ok' : 'error',
              'prompt': text,
              'chip': referenceDataUrls.isEmpty ? tr('创建图片') : tr('改图'),
              'size': size.wire,
              'paths': result.paths,
              'error': result.error,
              'mode': result.mode,
              'model': result.model,
              'latency_ms': result.latencyMs,
            }),
          ),
        ),
      );
      buf.updateLatestDriftSeq(sessionId, doneSeq);
    } catch (e) {
      final doneAt = DateTime.now().millisecondsSinceEpoch;
      final errSeq =
          ((await db.sessionEventsDao.getMaxSeq(sessionId)) ?? pendingSeq) + 1;
      await db.sessionEventsDao.insertEvent(
        SessionEventsCompanion(
          sessionId: Value(sessionId),
          seq: Value(errSeq),
          ts: Value(doneAt),
          kind: const Value('direct_image'),
          payload: Value(
            jsonEncode({
              'turn_id': turnId,
              'status': 'error',
              'prompt': text,
              /* 跟成功 / 进行中那两张卡同一个判据 —— 改图失败以前标成「创建图片」 */
              'chip': referenceDataUrls.isEmpty ? tr('创建图片') : tr('改图'),
              /* 走 friendlyError: e.toString() 会把 "Bad state: " 这种 Dart
               * 异常前缀原样漏给用户 (实测卡片上就是「Bad state: 该模型已停用」)。 */
              'error': friendlyError(e, fallback: tr('生图失败，请稍后重试')),
            }),
          ),
        ),
      );
      buf.updateLatestDriftSeq(sessionId, errSeq);
      rethrow;
    } finally {
      _inflightTurns.remove(turnId);
      inflightControls.remove(turnId);
      timeline.markAgentIdle();
    }
  }

  /// 这个进程里还在等结果的出图 (turn_id)。resumePending 跳过它们, 免得同一张图取两遍。
  static final Set<String> _inflightTurns = {};

  /// 追加一条 direct_image 事件 (新 seq; 渲染层按 turn_id 归一成同一张卡, 就地更新)。
  Future<void> _writeImageEvent(String sessionId, Map<String, Object?> payload) async {
    final db = _ref.read(appDatabaseProvider);
    final seq = ((await db.sessionEventsDao.getMaxSeq(sessionId)) ?? 1) + 1;
    await db.sessionEventsDao.insertEvent(
      SessionEventsCompanion(
        sessionId: Value(sessionId),
        seq: Value(seq),
        ts: Value(DateTime.now().millisecondsSinceEpoch),
        kind: const Value('direct_image'),
        payload: Value(jsonEncode(payload)),
      ),
    );
    _ref.read(streamBufferProvider.notifier).updateLatestDriftSeq(sessionId, seq);
  }

  /// 把还停在「正在生成」的图接着取回来 —— 进出图页、App 回到前台时调。
  ///
  /// 2026-10-05 用户: 「切出去再切回来, 图片生成好了它自己会加载显示, 这些都要处理好」。
  /// 切后台一分钟的那次 (模拟器实测) 服务器 43 秒就出好了图, 手机却判了失败; 进程在后台被杀的话
  /// 连失败都写不上, 卡片永远转圈。这里按落库的任务号 (job_id) 去网关取, 网关结果留 30 分钟。
  Future<void> resumePending(String sessionId) async {
    final db = _ref.read(appDatabaseProvider);
    final events = await db.sessionEventsDao.getBySessionId(sessionId);
    final latest = <String, Map<String, dynamic>>{};
    final startedAt = <String, int>{};
    for (final ev in events) {
      if (ev.kind != 'direct_image') continue;
      Map<String, dynamic> p;
      try {
        p = jsonDecode(ev.payload) as Map<String, dynamic>;
      } catch (_) {
        continue;
      }
      final turn = p['turn_id'];
      if (turn is! String) continue;
      startedAt.putIfAbsent(turn, () => ev.ts);
      /* 同一张卡的后写覆盖先写; 但 pending 不能把已经带上的 job_id 覆盖掉 */
      final prev = latest[turn];
      latest[turn] = {...?prev, ...p};
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final entry in latest.entries) {
      final turn = entry.key;
      final p = entry.value;
      if (p['status'] != 'pending' || _inflightTurns.contains(turn)) continue;
      final jobId = p['job_id'];
      final base = {
        'turn_id': turn,
        'prompt': p['prompt'],
        'chip': p['chip'],
      };
      if (jobId is! String || jobId.isEmpty) {
        /* 没拿到任务号就断了 (提交那一下被杀): 服务器上也没有这张图, 照实说; 给 2 分钟余量免得抢跑 */
        if (now - (startedAt[turn] ?? now) > 2 * 60 * 1000) {
          await _writeImageEvent(sessionId, {
            ...base,
            'status': 'error',
            'error': tr('生成被中断了, 请重试'),
          });
        }
        continue;
      }
      _inflightTurns.add(turn);
      unawaited(() async {
        try {
          final r = await _ref.read(imageDirectServiceProvider).resumeCloudJob(
                jobId,
                prompt: '${p['prompt'] ?? ''}',
                model: p['model'] as String?,
              );
          await _writeImageEvent(sessionId, {
            ...base,
            'status': r.ok ? 'ok' : 'error',
            'paths': r.paths,
            'error': r.error,
            'mode': r.mode,
            'model': r.model,
            'latency_ms': r.latencyMs,
          });
        } catch (e) {
          await _writeImageEvent(sessionId, {
            ...base,
            'status': 'error',
            'error': friendlyError(e, fallback: tr('生图失败，请稍后重试')),
          });
        } finally {
          _inflightTurns.remove(turn);
        }
      }());
    }
  }

  Future<void> _maybeRename(String sessionId, String text) async {
    if (text.trim().isEmpty) return;
    final db = _ref.read(appDatabaseProvider);
    final mirror = await db.sessionMirrorDao.findById(sessionId);
    if (mirror == null) return;
    final current = (mirror.title ?? '').trim();
    if (current.isNotEmpty && current != '新图片') return;
    final title = text.trim().replaceAll(RegExp(r'\s+'), ' ');
    await db.sessionMirrorDao.upsert(
      SessionMirrorCompanion(
        id: Value(sessionId),
        desktopDeviceId: const Value(kPhoneLocalDeviceId),
        title: Value(title.length > 28 ? '${title.substring(0, 28)}…' : title),
        workspaceName: const Value('图片'),
        lastMessageAt: Value(DateTime.now().millisecondsSinceEpoch),
        createdAt: Value(mirror.createdAt),
        lastSeq: Value(mirror.lastSeq),
        kind: const Value('image'),
      ),
    );
  }
}

final imageStudioSenderProvider = Provider<ImageStudioSender>(
  (ref) => ImageStudioSender(ref),
);
