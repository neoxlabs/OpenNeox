/// uploaded_images.dart — 用户发来的图一律落进工作区 (chat:C4-09).
///
/// 以前只在「工作模式」(带工具) 才存: 对话模式发来的图不落盘, 而对话模式
/// 恰恰是用户最常发图改图的地方 —— 于是模型只能说「请给我图片路径」,
/// 用户明明已经把图发过去了。
///
/// 现在两种模式都存。抽成这个函数是为了能单测: 真正的写盘动作由调用方传进来
/// (`phone_local_agent._saveUpload` 负责挑工作区、重名不覆盖)。
library;

/// 一张用户发来的图 (已经解码好的字节).
typedef UploadedImage = ({String name, List<int> bytes});

/// 把用户发来的图逐张存进工作区, 返回 (文件名, 工作区相对路径)。
///
/// 存不下 (没有工作区 / 写盘失败) 的那张直接跳过 —— 不能因为存盘失败
/// 就把这一轮聊天也拦掉, 图本身还能直接给模型看。
Future<List<({String name, String path})>> persistUploadedImages(
  List<UploadedImage> images, {
  required Future<String?> Function(String name, List<int> bytes) save,
  DateTime? now,
}) async {
  final out = <({String name, String path})>[];
  /* 毫秒时间戳 + 序号: 同一毫秒发两张、文件名都空时也不会互相覆盖 */
  final stamp = (now ?? DateTime.now()).millisecondsSinceEpoch;
  for (var i = 0; i < images.length; i++) {
    final img = images[i];
    final name = img.name.trim().isEmpty
        ? 'photo-$stamp${i == 0 ? '' : '-$i'}.jpg'
        : img.name;
    final rel = await save(name, img.bytes);
    if (rel != null) out.add((name: img.name, path: rel));
  }
  return out;
}
