/// weather.dart — 「今天」页顶上那一行的天气 (Open-Meteo, 不要 key; 半小时内同一处不重查)。
///
/// 只要一句人话: 「晴 23°」「小雨 16° · 15 点雨停」「多云 21° · 15 点有雨」。
library;

import 'dart:convert';
import 'dart:io';

class WeatherNow {
  const WeatherNow({required this.text, required this.temp, this.rainAt, this.rainStopsAt, required this.code});
  /// 晴 / 多云 / 阴 / 雾 / 小雨 / 雨 / 大雨 / 雪 / 雷雨
  final String text;
  final int temp;
  /// 接下来 12 小时第一个下雨概率 ≥ 50% 的钟点 (现在不下雨时)
  final int? rainAt;
  /// 正在下雨时, 雨停的钟点
  final int? rainStopsAt;
  /// WMO 天气码 (画场景用: 晴 0 / 云 1~3 / 雾 45,48 / 雨 51~67,80~82 / 雪 71~77,85,86 / 雷 95~99)
  final int code;

  bool get raining => isRainCode(code);

  /// 一行: 「多云 21° · 15 点有雨」
  String get line {
    final tail = raining
        ? (rainStopsAt == null ? '' : ' · $rainStopsAt 点雨停')
        : (rainAt == null ? '' : ' · $rainAt 点有雨');
    return '$text $temp°$tail';
  }

  static bool isRainCode(int c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
}

String _wmo(int c) => switch (c) {
      0 => '晴',
      1 || 2 => '多云',
      3 => '阴',
      45 || 48 => '雾',
      51 || 53 || 55 || 56 || 57 || 61 || 80 => '小雨',
      63 || 66 || 81 => '雨',
      65 || 67 || 82 => '大雨',
      71 || 73 || 75 || 77 || 85 || 86 => '雪',
      >= 95 => '雷雨',
      _ => '多云',
    };

final _cache = <String, (DateTime, WeatherNow)>{};

Future<WeatherNow?> fetchWeather(double lat, double lng) async {
  final key = '${lat.toStringAsFixed(2)},${lng.toStringAsFixed(2)}';
  final hit = _cache[key];
  if (hit != null && DateTime.now().difference(hit.$1).inMinutes < 30) return hit.$2;
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
  try {
    final uri = Uri.parse('https://api.open-meteo.com/v1/forecast?latitude=${lat.toStringAsFixed(3)}&longitude=${lng.toStringAsFixed(3)}'
        '&current=temperature_2m,weather_code&hourly=precipitation_probability,weather_code&forecast_hours=12&timezone=auto');
    final res = await (await client.getUrl(uri)).close().timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) return null;
    final j = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, dynamic>;
    final cur = j['current'] as Map<String, dynamic>;
    final code = (cur['weather_code'] as num).toInt();
    final h = j['hourly'] as Map<String, dynamic>;
    final times = (h['time'] as List).cast<String>();
    final probs = (h['precipitation_probability'] as List).map((e) => (e as num?)?.toInt() ?? 0).toList();
    final codes = (h['weather_code'] as List).map((e) => (e as num?)?.toInt() ?? 0).toList();
    int? hourOf(int i) => int.tryParse(times[i].substring(11, 13));
    int? rainAt, stopsAt;
    if (WeatherNow.isRainCode(code)) {
      for (var i = 1; i < codes.length; i++) {
        if (!WeatherNow.isRainCode(codes[i]) && probs[i] < 40) { stopsAt = hourOf(i); break; }
      }
    } else {
      for (var i = 1; i < probs.length; i++) {
        if (probs[i] >= 50) { rainAt = hourOf(i); break; }
      }
    }
    final w = WeatherNow(text: _wmo(code), temp: (cur['temperature_2m'] as num).round(), rainAt: rainAt, rainStopsAt: stopsAt, code: code);
    _cache[key] = (DateTime.now(), w);
    return w;
  } catch (_) {
    return null;
  } finally {
    client.close(force: true);
  }
}
