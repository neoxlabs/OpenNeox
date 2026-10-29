/// device_display_name.dart — 设备名怎么显示, 一处定义.
///
/// ## 为什么需要 (2026-09-22)
///
/// 配对记录里的 `deviceName` **可能是机器码**: 真机上「运行位置」chip 和设置页
/// 「连接」格都显示过 `JDMCVMPHIYKSSVX` —— 那是桌面端的 deviceId, 服务端上报的
/// 那一份被原样存进了 deviceName 字段。
///
/// 机器码不是名字。多台电脑时用户确实想知道"是哪台", 但机器码给不了这个信息,
/// 他看到只会以为界面坏了 —— 比显示一个笼统的「电脑」糟得多。
///
/// 之前这段判据只写在 `session_location_provider` 里 (修 chip 时加的), 而设置页
/// 「连接」格是**另一处独立实现**, 于是同一个毛病在两个地方各犯一次。抽到这里,
/// 谁要显示设备名都走它。
library;

/// 设备名是不是"人话" —— 机器码不算, 返回 null 由调用方决定退回什么.
///
/// 判据刻意保守: 宁可把某台真叫 `ABC12345` 的电脑退回「电脑」, 也不要把
/// `JDMCVMPHIYKSSVX` 这种东西摆到用户脸上。带空格、小写、中文、短于 8 位的
/// 名字都能过。
///
/// 2026-10-11 纠正: 上面说的 `JDMCVMPHIYKSSVX` **就是那台 Windows 的电脑名** (公司机的计算机名),
/// 不是 deviceId —— 设备 id 一律是 UUID。按「全大写字母数字」去藏, 把 `DESKTOP-07LLJV4` 这类
/// Windows 默认名也一起藏了, 电脑列表一排「未命名电脑」, 而连接页 (没走这道筛) 显示的是真名。
/// 现在只认 UUID / 十六进制串是机器码, 其余原样显示 —— 名字丑也是用户在电脑上看到的那个名字。
String? friendlyDeviceName(String? raw) {
  final s = raw?.trim();
  if (s == null || s.isEmpty) return null;
  /* uuid / 十六进制指纹才是机器码 */
  if (RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-').hasMatch(s)) return null;
  if (RegExp(r'^[0-9a-f]{16,}$').hasMatch(s)) return null;
  return s;
}
