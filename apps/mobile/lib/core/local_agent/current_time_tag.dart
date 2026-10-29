/// current_time_tag.dart — 精确当前时间挂在**最新一条用户消息尾部** (2026-10-18).
///
/// 为什么不在 system / 环境段里放分钟级时间:
///   环境段要字节稳定, 里面一有分钟级时间, 同一会话两分钟后的请求前缀就变了,
///   前缀缓存全部打穿 (仓库通则: system 段字节稳定)。手机 Chat 首字提速还进一步
///   把环境段缓存起来复用, 缓存里的时间最多能差十几分钟 —— 用户问「现在几点」,
///   模型照着缓存答, 就答错。
///
/// 桌面的做法 (`packages/core/src/runtime/agenticRuntime.ts` 里 `<current-time>`):
///   system 段只留天级日期, 精确到分钟的时刻追加在**本轮用户消息末尾**的
///   `<current-time>…</current-time>` 里。历史消息内容不可变 → 前缀照常命中,
///   每轮又都有自己的时刻, 模型还能据此感知轮次间隔。手机照这个范式做,
///   两边不一致时以标签为准。
///
/// 只在**发给模型的副本**上加: 界面显示和本地落库用的都是 user_message 事件里的
/// 原文 (payload['text']), 这里既不读也不写它 —— [userMessageWithTimeTag] 返回新字符串,
/// 不改入参, 所以界面和落库永远看不到标签。
///
/// 每条用户消息挂的是**它自己落库那一刻**的时刻, 不是"现在":
/// 下一轮请求的历史是从数据库重建的, 只给最新一条挂标签的话, 上一条在下一轮里字节就
/// 变了, 前缀缓存从那里整段作废 (C2-16)。用落库时刻, 同一条消息每次重建都是同一串字节。
library;

/// 星期名, 跟桌面 `<current-time>` 同一套写法 (周一 … 周日).
const List<String> _kWeekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

String _p2(int v) => v.toString().padLeft(2, '0');

/// `2026-10-18 周日 03:25 (UTC+08:00)` — 本地时间 + 时区.
String formatCurrentTimeStamp(DateTime now) {
  final tz = now.timeZoneOffset;
  final sign = tz.isNegative ? '-' : '+';
  final hh = tz.inHours.abs().toString().padLeft(2, '0');
  final mm = (tz.inMinutes.abs() % 60).toString().padLeft(2, '0');
  return '${now.year}-${_p2(now.month)}-${_p2(now.day)} '
      '${_kWeekdays[now.weekday - 1]} '
      '${_p2(now.hour)}:${_p2(now.minute)} (UTC$sign$hh:$mm)';
}

/// 环境段 (system 侧) 的日期行 — **只到日期 + 星期**, 同一天内逐字不变.
///
/// 精确时刻走 [formatCurrentTimeStamp] + 消息尾标签, 不进这里。
String formatEnvironmentDateLine(DateTime now) =>
    '当前日期: ${now.year}-${_p2(now.month)}-${_p2(now.day)} '
    '${_kWeekdays[now.weekday - 1]}';

/// 精确当前时间的标签 (与桌面 `<current-time>` 同一个名字, 便于两端共用提示词).
String currentTimeTag(DateTime now) =>
    '<current-time>${formatCurrentTimeStamp(now)}</current-time>';

/// 给一条用户消息挂上**它自己的**时刻标签 (`<current-time>`).
///
/// [sentAt] 是这条消息落库的时间 (`session_events.ts`), 不是这一轮发请求的"现在" ——
/// 历史消息每次重建都必须得到同一串字节, 否则整段前缀缓存每轮作废 (C2-16)。
String userMessageWithTimeTag(String text, DateTime sentAt) {
  final tag = currentTimeTag(sentAt);
  return text.trim().isEmpty ? tag : '$text\n\n$tag';
}
