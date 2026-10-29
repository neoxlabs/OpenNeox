/// sse.dart — SSE (text/event-stream) 解析 + 流取消原语.
///
/// 之前 model_gateway_client 用 LineSplitter + startsWith('data:') 手撕,
/// 有三个真实缺陷:
///   1. 多行 data 字段 (SSE 规范允许 data: 分多行, 需 join '\n') 会被拆成多帧解析失败
///   2. 'data: ' 与 'data:' 前缀空格处理靠 trim, 把 payload 内部前导空格也吃掉
///   3. 没有事件边界概念 (空行), comment 行 (': keep-alive') 会误进 JSON 解析
///
/// 这里按 WHATWG SSE 规范实现最小正确子集: field 解析 (data/event/id),
/// 事件在空行提交, comment 忽略, CR/CRLF/LF 三种行尾兼容.
/// BYOK 三协议适配器 + 网关客户端共用这一个实现.
library;

import 'dart:async';
import 'dart:convert';

/// 一个完整 SSE 事件 (空行边界提交).
class SseEvent {
  const SseEvent({this.event, required this.data});

  /// event: 字段 — Anthropic 用它区分 message_delta/content_block_delta 等.
  final String? event;

  /// data: 字段 (多行 join '\n').
  final String data;
}

/// bytes → SseEvent 流转换器.
///
/// 用法: `resp.stream.transform(const SseDecoder())`
class SseDecoder extends StreamTransformerBase<List<int>, SseEvent> {
  const SseDecoder();

  @override
  Stream<SseEvent> bind(Stream<List<int>> stream) async* {
    String? eventName;
    final dataLines = <String>[];
    var carry = '';

    Stream<String> lines() async* {
      /* utf8 流式解码 + 手工切行 (兼容 \r\n / \n / \r) — LineSplitter 不吐尾部
       * 未完行, 我们自己 carry. */
      await for (final chunk in stream.transform(const Utf8Decoder(allowMalformed: true))) {
        carry += chunk;
        while (true) {
          final nlIdx = carry.indexOf('\n');
          final crIdx = carry.indexOf('\r');
          int cut;
          int skip;
          if (nlIdx < 0 && crIdx < 0) break;
          if (crIdx >= 0 && (nlIdx < 0 || crIdx < nlIdx)) {
            /* \r 或 \r\n */
            if (crIdx == carry.length - 1) break; /* \r 在缓冲末尾, 等下个 chunk 判断是否 \r\n */
            cut = crIdx;
            skip = carry[crIdx + 1] == '\n' ? 2 : 1;
          } else {
            cut = nlIdx;
            skip = 1;
          }
          yield carry.substring(0, cut);
          carry = carry.substring(cut + skip);
        }
      }
      if (carry.isNotEmpty) yield carry;
    }

    await for (final line in lines()) {
      if (line.isEmpty) {
        /* 事件边界 — 有 data 才提交 */
        if (dataLines.isNotEmpty) {
          yield SseEvent(event: eventName, data: dataLines.join('\n'));
        }
        eventName = null;
        dataLines.clear();
        continue;
      }
      if (line.startsWith(':')) continue; /* comment / keep-alive */
      final colon = line.indexOf(':');
      final String field;
      String value;
      if (colon < 0) {
        field = line;
        value = '';
      } else {
        field = line.substring(0, colon);
        value = line.substring(colon + 1);
        /* 规范: 冒号后单个空格剥掉, 其余保留 */
        if (value.startsWith(' ')) value = value.substring(1);
      }
      switch (field) {
        case 'data':
          dataLines.add(value);
          break;
        case 'event':
          eventName = value;
          break;
        /* id / retry — 不需要 */
      }
    }
    /* 流结束时未闭合的事件也提交 (部分服务端最后一个事件后不发空行) */
    if (dataLines.isNotEmpty) {
      yield SseEvent(event: eventName, data: dataLines.join('\n'));
    }
  }
}

/// 取消令牌 — stop 按钮 → 掐断 in-flight HTTP 流.
///
/// http 包的 Request 无原生 abort; 适配器把响应流 race 本令牌:
/// cancel() 后 `guard()` 抛 [ChatCancelled], 调用方关闭流订阅走 finally 清理.
class CancelToken {
  final _completer = Completer<void>();

  bool get isCancelled => _completer.isCompleted;

  /// 取消发生时 resolve — 给"可取消等待"用 (Future.any 竞速).
  Future<void> get whenCancelled => _completer.future;

  void cancel() {
    if (!_completer.isCompleted) _completer.complete();
  }

  /// 已取消时立刻抛; 供循环内快速检查.
  void guard() {
    if (isCancelled) throw const ChatCancelled();
  }

  /// 把流包成"可取消流": 取消时 stream 立即以 [ChatCancelled] 结束.
  ///
  /// 关键: 内层 subscription 的 cancel future **不透传**给 controller.onCancel —
  /// `await for` 在错误传播前会等 onCancel 返回的 future, 而 async*/socket 的
  /// teardown 可能被 pending await 卡住几十秒 (实测卡满 idle 超时)。这里让
  /// teardown 后台自行完成, 消费者的 ChatCancelled 即时送达。
  Stream<T> wrap<T>(Stream<T> inner) {
    final controller = StreamController<T>();
    late StreamSubscription<T> sub;
    sub = inner.listen(
      controller.add,
      onError: controller.addError,
      onDone: controller.close,
    );
    _completer.future.then((_) {
      unawaited(sub.cancel().catchError((_) {}));
      if (!controller.isClosed) {
        controller.addError(const ChatCancelled());
        controller.close();
      }
    });
    controller.onCancel = () {
      unawaited(sub.cancel().catchError((_) {}));
    };
    return controller.stream;
  }
}

class ChatCancelled implements Exception {
  const ChatCancelled();
  @override
  String toString() => 'ChatCancelled';
}
