import 'package:flutter_test/flutter_test.dart';
import 'package:neox_app/core/storage/app_paths.dart';

void main() {
  const home = '/var/mobile/Containers/Data/Application/NEW-UUID';

  tearDown(() => AppPaths.debugHome = null);

  test('没 init (安卓 / 测试) 原样返回', () {
    const p = '/var/mobile/Containers/Data/Application/OLD-UUID/Documents/a.png';
    expect(AppPaths.rebase(p), p);
  });

  test('旧容器的 Documents / Library / tmp 换到当前容器', () {
    AppPaths.debugHome = home;
    expect(
      AppPaths.rebase('/var/mobile/Containers/Data/Application/OLD-UUID/Documents/neox-artifacts/x.png'),
      '$home/Documents/neox-artifacts/x.png',
    );
    expect(
      AppPaths.rebase('/var/mobile/Containers/Data/Application/OLD-UUID/Library/Caches/y.jpg'),
      '$home/Library/Caches/y.jpg',
    );
    expect(
      AppPaths.rebase('/var/mobile/Containers/Data/Application/OLD-UUID/tmp/z.png'),
      '$home/tmp/z.png',
    );
  });

  test('已经在当前容器 / 不是沙盒路径的不动', () {
    AppPaths.debugHome = home;
    expect(AppPaths.rebase('$home/Documents/a.png'), '$home/Documents/a.png');
    expect(AppPaths.rebase('/Users/me/Documents/a.png'), '/Users/me/Documents/a.png');
  });
}
