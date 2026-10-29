/// Neox mobile 入口 —— 开源版 (没有账号 / 订阅 / 托管服务, 每项能力都是
/// core/edition/edition.dart 里的默认实现)。
///
/// 商业仓里这个文件是 lib/main_open.dart (`flutter run -t lib/main_open.dart`);
/// 导出到开源树时它原样成为 lib/main.dart (scripts/public-overlay)。
library;

import 'bootstrap.dart';
import 'core/edition/edition.dart';

Future<void> main() => runNeoxApp(const OpenEdition());
