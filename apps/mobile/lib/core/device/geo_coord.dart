/// geo_coord.dart — 手机定位 (WGS-84) 在中国大陆要换成 GCJ-02 才能用 (2026-10-11)。
///
/// 用户: 「定位没有对不同国家地区进行适配, 像中国现在就有偏移」。
/// Android / iOS 系统定位给的是 GPS 原始坐标 (WGS-84); 中国大陆的地图 (高德 / 腾讯 / 苹果地图国内版,
/// 以及 geo: 深链打开的国产地图) 都用国测局坐标 GCJ-02, 直接拿 WGS-84 去用会偏几百米 ——
/// 「附近」「走过去多久」「导航到这」全会错。港澳台和海外不加密, 原样用。
/// 百度地图是在 GCJ-02 上再偏一次 (BD-09), 这里一并给出, 模型要拼百度链接时用。
library;

import 'dart:math' as math;

/// 在中国大陆境内 (要做 GCJ-02 偏移) —— 外接框 + 剔掉港澳台。
/// 边境附近会有几十公里的误判, 那里的偏移量本来也随算法衰减, 影响可忽略。
bool needsGcj02(double lat, double lng) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return false;
  /* 台湾 */
  if (lng > 119.3 && lng < 122.5 && lat > 21.8 && lat < 25.5) return false;
  /* 香港: 两段框, 北边贴着深圳河 (深圳福田 22.52、蛇口 113.92/22.48 都要留在大陆) */
  if (lng > 114.0 && lng < 114.45 && lat > 22.15 && lat < 22.505) return false;
  if (lng > 113.83 && lng <= 114.0 && lat > 22.15 && lat < 22.41) return false;
  /* 澳门 (珠海 22.25 以北留在大陆) */
  if (lng > 113.52 && lng < 113.6 && lat > 22.1 && lat < 22.22) return false;
  return true;
}

const double _a = 6378245.0;
const double _ee = 0.00669342162296594323;

double _tLat(double x, double y) {
  var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(x.abs());
  r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0;
  r += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0;
  r += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0;
  return r;
}

double _tLng(double x, double y) {
  var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(x.abs());
  r += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0;
  r += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0;
  r += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0;
  return r;
}

/// WGS-84 → GCJ-02。不在大陆境内原样返回。
(double lat, double lng) wgs84ToGcj02(double lat, double lng) {
  if (!needsGcj02(lat, lng)) return (lat, lng);
  var dLat = _tLat(lng - 105.0, lat - 35.0);
  var dLng = _tLng(lng - 105.0, lat - 35.0);
  final radLat = lat / 180.0 * math.pi;
  var magic = math.sin(radLat);
  magic = 1 - _ee * magic * magic;
  final sqrtMagic = math.sqrt(magic);
  dLat = (dLat * 180.0) / ((_a * (1 - _ee)) / (magic * sqrtMagic) * math.pi);
  dLng = (dLng * 180.0) / (_a / sqrtMagic * math.cos(radLat) * math.pi);
  return (lat + dLat, lng + dLng);
}

/// GCJ-02 → BD-09 (百度地图)。
(double lat, double lng) gcj02ToBd09(double lat, double lng) {
  const xPi = math.pi * 3000.0 / 180.0;
  final z = math.sqrt(lng * lng + lat * lat) + 0.00002 * math.sin(lat * xPi);
  final theta = math.atan2(lat, lng) + 0.000003 * math.cos(lng * xPi);
  return (z * math.sin(theta) + 0.006, z * math.cos(theta) + 0.0065);
}
