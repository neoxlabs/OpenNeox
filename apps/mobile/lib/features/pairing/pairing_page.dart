/// pairing_page.dart — Mode A 配对 UI (2026-10-14 陶土 v5 稿「连接电脑」).
///
/// 两页 (底部文字链切换): 扫码 | 手输备份码 (含 mDNS 发现的电脑 + 手动地址).
///   - 优选扫码 (电脑设置里弹 QR, 手机扫一下完成)
///   - 没相机/扫码不便 → 选同 Wi-Fi 找到的电脑 + 手输 8 位备份码
///
/// 配对成功 → SnackBar + 跳回 sessions tab.
/// 只换外观: provider / 扫码 / 配对 / 发现 / 错误分类的逻辑一行没动。
library;

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/device/phone_identity.dart';
import '../../core/discovery/mdns_scanner.dart';
import '../../core/errors/friendly_error.dart';
import '../../core/execution/unpaired_desktops_provider.dart';
import '../../core/network/pair_client.dart';
import '../../core/network/self_hosted_relay.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/storage/database.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

class PairingPage extends ConsumerStatefulWidget {
  const PairingPage({super.key});

  @override
  ConsumerState<PairingPage> createState() => _PairingPageState();
}

class _PairingPageState extends ConsumerState<PairingPage>
    with SingleTickerProviderStateMixin {
  late final TabController _tab;

  @override
  void initState() {
    super.initState();
    _tab = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tab.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ClayPage(
      title: tr('连接电脑'),
      body: TabBarView(
        controller: _tab,
        children: const [_ScanTab(), _BackupCodeTab()],
      ),
      /* 底部文字链: 扫码页 → 去备份码; 备份码页 → 回扫码 */
      bottom: ListenableBuilder(
        listenable: _tab,
        builder: (context, _) {
          final c = ClayInk.of(context);
          final onScan = _tab.index == 0;
          final links = onScan
              ? <Widget>[
                  ClayButton(
                    kind: ClayButtonKind.text,
                    size: ClayButtonSize.small,
                    label: tr('输入 8 位备份码'),
                    onTap: () => _tab.animateTo(1),
                  ),
                  Text('·', style: TextStyle(color: c.faint)),
                  ClayButton(
                    kind: ClayButtonKind.text,
                    size: ClayButtonSize.small,
                    label: tr('手动填地址'),
                    onTap: () => _tab.animateTo(1),
                  ),
                ]
              : <Widget>[
                  ClayButton(
                    kind: ClayButtonKind.text,
                    size: ClayButtonSize.small,
                    label: tr('扫码连接'),
                    onTap: () => _tab.animateTo(0),
                  ),
                ];
          /* Wrap: 英文两条链接一行放不下 (模拟器实测溢出 39px), 放不下就折行 */
          return Wrap(alignment: WrapAlignment.center, crossAxisAlignment: WrapCrossAlignment.center, children: links);
        },
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// QR 扫码 tab
// ────────────────────────────────────────────────────────────────

class _ScanTab extends ConsumerStatefulWidget {
  const _ScanTab();

  @override
  ConsumerState<_ScanTab> createState() => _ScanTabState();
}

class _ScanTabState extends ConsumerState<_ScanTab>
    with SingleTickerProviderStateMixin {
  /* 用 mobile_scanner 5.2.3 的默认设置 — 实测过度调优 (formats/cameraResolution/
   *  noDuplicates) 反而导致某些 Android 设备 onDetect 不触发. 默认最稳. */
  final MobileScannerController _scanner = MobileScannerController();
  bool _busy = false;
  String _busyStatus = '';
  bool _torchOn = false;

  /* 取景框里来回走的蓝线 (纯装饰, 不影响识别) */
  late final AnimationController _line = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )..repeat(reverse: true);

  @override
  void initState() {
    super.initState();
    /* mobile_scanner 5.x: 传 controller 时不会自动开相机, 必须显式 start.
     * 不 start 的话 widget 只渲染黑屏, onDetect 永远不触发. */
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      try {
        await _scanner.start();
        debugPrint('[pairing/scan] scanner started OK');
      } catch (e, st) {
        debugPrint('[pairing/scan] scanner.start() failed: $e\n$st');
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(friendlyError(e, fallback: tr('相机启动失败，请检查权限')))),
          );
        }
      }
    });
  }

  @override
  void dispose() {
    _line.dispose();
    _scanner.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture cap) async {
    /* 每帧打个心跳 — 看 scanner 到底有没有在跑 (用户报"扫不到"时排查
     *  "scanner 没工作" vs "工作但识别失败"). */
    debugPrint(
      '[pairing/scan] onDetect: ${cap.barcodes.length} barcodes raw=${cap.raw}',
    );
    if (_busy) {
      debugPrint('[pairing/scan] busy, skip');
      return;
    }
    if (cap.barcodes.isEmpty) {
      debugPrint('[pairing/scan] no barcodes in capture');
      return;
    }
    final code = cap.barcodes.first.rawValue;
    debugPrint(
      '[pairing/scan] rawValue len=${code?.length ?? 0} starts="${code?.substring(0, code.length > 30 ? 30 : code.length)}..."',
    );
    if (code == null || code.isEmpty) return;

    /* 即时反馈 — 让用户立刻知道 QR 已识别 (不然就是黑屏 spinner 不知道在干啥) */
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(tr('已识别二维码，开始连接…')),
        duration: Duration(seconds: 2),
      ),
    );

    setState(() {
      _busy = true;
      _busyStatus = tr('识别二维码…');
    });
    try {
      await _scanner.stop();
      final ident = await ref.read(phoneIdentityProvider.future);
      final db = ref.read(appDatabaseProvider);
      final client = PairClient(
        db: db,
        onProgress: (msg) {
          debugPrint('[pairing/scan] progress: $msg');
          if (mounted) setState(() => _busyStatus = msg);
        },
      );
      debugPrint('[pairing/scan] calling pairWithQR...');
      final result = await client
          .pairWithQR(
            qrText: code,
            phoneDeviceId: ident.deviceId,
            phoneDeviceName: ident.deviceName,
            phonePublicKeyRaw: ident.rawPublicKey,
            phonePrivateKeyRaw: ident.rawPrivateKey,
          )
          /* 兜底 timeout — 25s 总配对超时 (multi-host 各 5s 网络 + handshake) */
          .timeout(
            const Duration(seconds: 25),
            onTimeout: () => throw PairingException(
              code: PairingErrorCode.network,
              message: tr('连接超时，请确认手机和电脑在同一 Wi-Fi'),
            ),
          );
      debugPrint(
        '[pairing/scan] pairWithQR success: ${result.desktopDeviceName}',
      );
      if (!mounted) return;
      _showSuccess(context, result, ref);
    } on PairingException catch (e) {
      debugPrint(
        '[pairing/scan] PairingException: ${e.code.name} - ${e.message}',
      );
      if (!mounted) return;
      await _showErrorDialog(context, e);
      await _scanner.start();
    } catch (e, st) {
      debugPrint('[pairing/scan] unexpected error: $e\n$st');
      if (!mounted) return;
      await _showErrorDialog(
        context,
        PairingException(
          code: PairingErrorCode.network,
          message: tr('暂时连接不上电脑，请检查网络后重试'),
        ),
      );
      await _scanner.start();
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _busyStatus = '';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          /* 取景框: 圆角泥面里的相机画面 (稿: 相机画在圆角卡片里, 四角白框 + 蓝线) */
          AspectRatio(
            aspectRatio: 1.2,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(20),
              child: LayoutBuilder(
                builder: (context, box) {
                  /* 取景框 = 中央的正方形 (画面的 72%), 只做引导; 识别是全画面的 */
                  final size = box.biggest;
                  final side = (size.width < size.height ? size.width : size.height) * 0.72;
                  final frame = Rect.fromLTWH(
                    (size.width - side) / 2,
                    (size.height - side) / 2,
                    side,
                    side,
                  );
                  return Stack(
                    children: [
                      /* scanWindow 在 mobile_scanner 5.2.3 已知 buggy (坐标映射不对,
                       * 实测 QR 在框内却扫不到). 改全屏扫, 用 UI 框只做引导. */
                      MobileScanner(
                        controller: _scanner,
                        onDetect: _onDetect,
                        fit: BoxFit.cover,
                        errorBuilder: (_, error) =>
                            _CameraError(message: '${error.errorCode}'),
                      ),
                      /* 四角 + 扫描线 (不再压暗画面) */
                      Positioned.fill(
                        child: IgnorePointer(
                          child: AnimatedBuilder(
                            animation: _line,
                            builder: (context, _) => CustomPaint(
                              painter: _ScanOverlayPainter(
                                window: frame,
                                progress: _line.value,
                                lineColor: c.cobalt,
                              ),
                            ),
                          ),
                        ),
                      ),
                      /* 底部 toolbar — torch + 切换前后置 */
                      Positioned(
                        bottom: 14,
                        left: 0,
                        right: 0,
                        child: Center(
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: Colors.black.withValues(alpha: 0.45),
                              borderRadius: BorderRadius.circular(24),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                _ScannerToolBtn(
                                  icon: _torchOn ? Icons.flash_on : Icons.flash_off,
                                  active: _torchOn,
                                  onTap: () async {
                                    try {
                                      await _scanner.toggleTorch();
                                      if (mounted) setState(() => _torchOn = !_torchOn);
                                    } catch (_) {}
                                  },
                                ),
                                const SizedBox(width: 4),
                                _ScannerToolBtn(
                                  icon: Icons.cameraswitch,
                                  active: false,
                                  onTap: () async {
                                    try {
                                      await _scanner.switchCamera();
                                    } catch (_) {}
                                  },
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      if (_busy)
                        Positioned.fill(
                          child: ColoredBox(
                            color: Colors.black.withValues(alpha: 0.55),
                            child: Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const CircularProgressIndicator(color: Colors.white),
                                  const SizedBox(height: 16),
                                  Container(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 16,
                                      vertical: 8,
                                    ),
                                    decoration: BoxDecoration(
                                      color: Colors.black.withValues(alpha: 0.4),
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: Text(
                                      _busyStatus.isEmpty ? tr('连接中…') : _busyStatus,
                                      style: const TextStyle(
                                        color: Colors.white,
                                        fontSize: 14.5,
                                        fontFamily: NeoxMono.family,
                                        fontFamilyFallback: NeoxMono.fallback,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                    ],
                  );
                },
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Text(
              tr('扫电脑上 Neox 显示的二维码（设置 → 远程访问）'),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13.5, color: c.grey, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Scanner UI helpers
// ────────────────────────────────────────────────────────────────

class _CameraError extends StatelessWidget {
  const _CameraError({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.black,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            tr('相机不可用: $message\n检查 APK 是否有相机权限'),
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, fontSize: 14.5),
          ),
        ),
      ),
    );
  }
}

class _ScannerToolBtn extends StatelessWidget {
  const _ScannerToolBtn({
    required this.icon,
    required this.active,
    required this.onTap,
  });
  final IconData icon;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? Colors.white.withValues(alpha: 0.2) : Colors.transparent,
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 40,
          child: Icon(icon, color: Colors.white, size: 20),
        ),
      ),
    );
  }
}

/// 取景框四角 (白) + 框内来回走的一道蓝线.
class _ScanOverlayPainter extends CustomPainter {
  _ScanOverlayPainter({
    required this.window,
    required this.progress,
    required this.lineColor,
  });
  final Rect window;

  /// 0..1, 扫描线在框内的位置
  final double progress;
  final Color lineColor;

  @override
  void paint(Canvas canvas, Size size) {
    /* 1. 四角 highlight */
    final corner = 26.0;
    final stroke = 3.0;
    final paint = Paint()
      ..color = Colors.white
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    final r = window;
    // TL
    canvas.drawLine(
      Offset(r.left, r.top + corner),
      Offset(r.left, r.top),
      paint,
    );
    canvas.drawLine(
      Offset(r.left, r.top),
      Offset(r.left + corner, r.top),
      paint,
    );
    // TR
    canvas.drawLine(
      Offset(r.right - corner, r.top),
      Offset(r.right, r.top),
      paint,
    );
    canvas.drawLine(
      Offset(r.right, r.top),
      Offset(r.right, r.top + corner),
      paint,
    );
    // BL
    canvas.drawLine(
      Offset(r.left, r.bottom - corner),
      Offset(r.left, r.bottom),
      paint,
    );
    canvas.drawLine(
      Offset(r.left, r.bottom),
      Offset(r.left + corner, r.bottom),
      paint,
    );
    // BR
    canvas.drawLine(
      Offset(r.right - corner, r.bottom),
      Offset(r.right, r.bottom),
      paint,
    );
    canvas.drawLine(
      Offset(r.right, r.bottom),
      Offset(r.right, r.bottom - corner),
      paint,
    );
    /* 2. 扫描线 */
    final y = r.top + r.height * progress;
    canvas.drawLine(
      Offset(r.left + 10, y),
      Offset(r.right - 10, y),
      Paint()
        ..color = lineColor
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(covariant _ScanOverlayPainter old) =>
      old.window != window ||
      old.progress != progress ||
      old.lineColor != lineColor;
}

// ────────────────────────────────────────────────────────────────
// 备份码 tab (含 mDNS Desktop 列表)
// ────────────────────────────────────────────────────────────────

class _BackupCodeTab extends ConsumerStatefulWidget {
  const _BackupCodeTab();

  @override
  ConsumerState<_BackupCodeTab> createState() => _BackupCodeTabState();
}

class _BackupCodeTabState extends ConsumerState<_BackupCodeTab> {
  final TextEditingController _codeCtrl = TextEditingController();
  final TextEditingController _manualAddrCtrl = TextEditingController();
  DesktopBeacon? _selectedBeacon;
  bool _busy = false;
  String? _statusError;

  @override
  void dispose() {
    _codeCtrl.dispose();
    _manualAddrCtrl.dispose();
    super.dispose();
  }

  /// 手动地址 (SSH 隧道中转 / mDNS 不通网络): 从 health 端点拿桌面标识.
  /// 返回等价 beacon; 失败抛用户可读错误.
  Future<DesktopBeacon> _resolveManualAddress(String addr) async {
    final parts = addr.split(':');
    final host = parts.first.trim();
    final port = parts.length > 1 ? int.tryParse(parts[1].trim()) : null;
    if (host.isEmpty || port == null || port <= 0 || port > 65535) {
      throw PairingException(
        code: PairingErrorCode.qrInvalid,
        message: tr('地址格式: 主机:端口 (手机本地 SSH 转发填 127.0.0.1:转发端口)'),
      );
    }
    final dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 5),
        receiveTimeout: const Duration(seconds: 5),
      ),
    );
    try {
      final resp = await dio.get<Map<String, dynamic>>(
        'http://$host:$port/api/v1/health',
        options: Options(responseType: ResponseType.json),
      );
      final data = resp.data;
      final deviceId = (data?['device_id'] as String?) ?? '';
      if (deviceId.isEmpty) {
        throw PairingException(
          code: PairingErrorCode.serverRejected,
          message: tr('电脑端版本过旧 (health 未返回设备标识), 请升级电脑端'),
        );
      }
      return DesktopBeacon(
        deviceId: deviceId,
        deviceName: (data?['device_name'] as String?) ?? host,
        host: host,
        port: port,
        pubkeyFingerprint: '',
        protocolVersion: (data?['protocol_version'] as num?)?.toInt() ?? 1,
        lastSeenAt: DateTime.now(),
      );
    } on DioException {
      throw PairingException(
        code: PairingErrorCode.network,
        message: tr('连不上 $host:$port — 检查隧道/防火墙, 确认电脑端 Neox 已打开'),
      );
    }
  }

  /// 同一 Wi-Fi 点一下: 发请求 → 电脑弹窗确认。等待时手机上显示同一个核对码, 可以取消。
  Future<void> _requestPair(DesktopBeacon b) async {
    setState(() {
      _selectedBeacon = b;
      _busy = true;
      _statusError = null;
    });
    final cancel = CancelToken();
    var dialogOpen = false;
    void closeDialog() {
      if (dialogOpen && mounted) Navigator.of(context, rootNavigator: true).pop();
    }
    try {
      final ident = await ref.read(phoneIdentityProvider.future);
      if (!mounted) return;
      final code = pairCheckCode(ident.rawPublicKey);
      dialogOpen = true;
      unawaited(showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => _PairWaitDialog(desktopName: b.deviceName, code: code),
      ).then((_) {
        /* 用户在手机上点了取消 (请求还挂着) → 放弃请求; 我们自己关的时候 dialogOpen 已经是 false */
        if (dialogOpen) cancel.cancel();
        dialogOpen = false;
      }));
      final result = await PairClient(db: ref.read(appDatabaseProvider)).pairByRequest(
        host: b.host,
        port: b.port,
        desktopDeviceId: b.deviceId,
        desktopDeviceName: b.deviceName,
        desktopPubkeyFingerprint: b.pubkeyFingerprint,
        phoneDeviceId: ident.deviceId,
        phoneDeviceName: ident.deviceName,
        phonePublicKeyRaw: ident.rawPublicKey,
        phonePrivateKeyRaw: ident.rawPrivateKey,
        cancel: cancel,
      );
      closeDialog();
      dialogOpen = false;
      if (!mounted) return;
      _showSuccess(context, result, ref);
    } on DioException {
      /* 用户点了取消: 什么都不提示 */
    } on PairingException catch (e) {
      closeDialog();
      dialogOpen = false;
      if (mounted) unawaited(_showErrorDialog(context, e));
    } catch (e) {
      closeDialog();
      dialogOpen = false;
      if (mounted) setState(() => _statusError = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    var beacon = _selectedBeacon;
    /* 中文输入法下打出来的全角「：」「。」「－」归一成半角, 不然地址 / 备份码对不上 */
    String halfWidth(String s) => s.replaceAll('：', ':').replaceAll('。', '.').replaceAll('－', '-').replaceAll('　', ' ');
    final manualAddr = halfWidth(_manualAddrCtrl.text).trim();
    final code = halfWidth(_codeCtrl.text).trim();
    if (beacon == null && manualAddr.isEmpty) {
      setState(() => _statusError = tr('从列表选一台电脑, 或填手动地址'));
      return;
    }
    /* 没填备份码: 跟点列表里的电脑一样, 发请求让电脑上点「允许」 */
    if (code.isEmpty) {
      try {
        beacon ??= await _resolveManualAddress(manualAddr);
      } on PairingException catch (e) {
        if (mounted) setState(() => _statusError = e.message);
        return;
      }
      if (mounted) await _requestPair(beacon);
      return;
    }
    setState(() {
      _busy = true;
      _statusError = null;
    });
    try {
      /* 手动地址优先级低于列表选择 — 都填了以选中的为准 */
      beacon ??= await _resolveManualAddress(manualAddr);
      final ident = await ref.read(phoneIdentityProvider.future);
      final db = ref.read(appDatabaseProvider);
      // 备份码路径要求 Desktop pubkey, 但 mDNS 只广播 fingerprint.
      // 协议 Phase 1.C 没办法纯靠 mDNS 拿 pubkey → Desktop /api/v1/pair-by-code
      // 不依赖 phone 提交 desktop_pubkey, server 自己拿. fingerprint 自检走 response
      // 里返的 desktop_pubkey 推导.
      // 这里 desktopPubkeyBase64Url 留空, _pair() 内部直接用 response 的 desktop_pubkey
      // 计算 relay_session_key + fingerprint 自检, 跟 QR 路径一致.
      final client = PairClient(db: db);
      final result = await client.pairWithBackupCode(
        host: beacon.host,
        port: beacon.port,
        desktopDeviceId: beacon.deviceId,
        desktopDeviceName: beacon.deviceName,
        desktopPubkeyBase64Url: '', // 不需要; 内部不再校验
        backupCode: code,
        phoneDeviceId: ident.deviceId,
        phoneDeviceName: ident.deviceName,
        phonePublicKeyRaw: ident.rawPublicKey,
        phonePrivateKeyRaw: ident.rawPrivateKey,
      );
      if (!mounted) return;
      _showSuccess(context, result, ref);
    } on PairingException catch (e) {
      if (!mounted) return;
      setState(() => _statusError = e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _statusError = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final beaconsAsync = ref.watch(desktopBeaconsProvider);
    return ListView(
      padding: const EdgeInsets.only(bottom: 16),
      children: [
        // 1) 已发现 Desktop 列表
        ClaySectionLabel(tr('同 Wi-Fi 找到的电脑')),
        beaconsAsync.when(
          data: (list) {
            if (list.isEmpty) {
              return ClayGroup(
                children: [
                  ClayRow(
                    icon: Icons.wifi_tethering_off,
                    title: tr('没有找到电脑'),
                    subtitle: tr('请确认手机和电脑在同一 Wi-Fi，并在电脑上打开「设置 → 手机连接 → 添加手机」。'),
                  ),
                ],
              );
            }
            return ClayGroup(
              children: [
                ClayRow(
                  icon: Icons.touch_app_outlined,
                  title: tr('点一下要连的电脑'),
                  subtitle: tr('电脑上会弹出确认，核对两边数字一致后点「允许」。'),
                ),
                for (final b in list)
                  _BeaconTile(
                    beacon: b,
                    selected: _selectedBeacon?.deviceId == b.deviceId,
                    onTap: _busy ? () {} : () => _requestPair(b),
                  ),
              ],
            );
          },
          loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: Center(child: ClaySpinner()),
          ),
          error: (e, _) => ClayGroup(
            children: [
              ClayRow(
                icon: Icons.error_outline,
                title: tr('没找到电脑'),
                subtitle: friendlyError(e, fallback: tr('自动发现失败，请稍后重试')),
                danger: true,
              ),
            ],
          ),
        ),

        /* 1.5) 手动地址 — SSH 隧道中转 / mDNS 不通的网络 (BYOK 零账号中转方案) */
        ClaySectionLabel(tr('或手动填电脑地址')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              /* 2026-10-28: 原来这里教 SSH 隧道 (ssh -L / ssh -R) 做"自建中转"。现在有自托管中继
               * (cloud/relay, 端到端加密), 出门在外走它; 这一栏只剩"同 Wi-Fi 找不到电脑时手填局域网地址"。 */
              Text(
                tr('同一 Wi-Fi 下找不到电脑时, 填电脑「设置 → 手机连接」里显示的地址。\n'
                '出门在外不用这里: 在电脑上配好自托管中继, 配对后手机自动经中继连回电脑, 全程端到端加密。'),
                style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.5),
              ),
              const SizedBox(height: 12),
              _Input(
                controller: _manualAddrCtrl,
                hint: tr('例如 192.168.1.5:63907'),
                icon: Icons.lan_outlined,
                keyboardType: TextInputType.url,
              ),
            ],
          ),
        ),

        // 2) 备份码输入
        ClaySectionLabel(tr('备份码')),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                tr('输入电脑上显示的 8 位备份码。不填就在电脑上弹窗确认。'),
                style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.5),
              ),
              const SizedBox(height: 10),
              _Input(
                controller: _codeCtrl,
                hint: 'ABCD-1234',
                icon: Icons.vpn_key_outlined,
                mono: true,
                textCapitalization: TextCapitalization.characters,
                keyboardType: TextInputType.visiblePassword,
                inputFormatters: [
                  UpperCaseTextFormatter(),
                  FilteringTextInputFormatter.allow(RegExp(r'[A-Z0-9-]')),
                  LengthLimitingTextInputFormatter(9),
                ],
              ),
              const SizedBox(height: 16),
              ClayButton(
                label: tr('连接'),
                icon: Icons.link,
                expand: true,
                busy: _busy,
                onTap: _busy ? null : _submit,
              ),
              if (_statusError != null) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: c.redSoft,
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Text(
                    _statusError!,
                    style: TextStyle(color: c.redInk, fontSize: 13.5, height: 1.4),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// 输入格 —— 和 clay.dart 的 ClayField 同一个长相。ClayField 不支持大写 / 输入过滤,
/// 备份码要用, 所以页内自己画 (不改共享组件)。
class _Input extends StatelessWidget {
  const _Input({
    required this.controller,
    required this.hint,
    required this.icon,
    this.mono = false,
    this.textCapitalization = TextCapitalization.none,
    this.inputFormatters,
    this.keyboardType,
  });

  final TextEditingController controller;
  final String hint;
  final IconData icon;
  final bool mono;
  final TextCapitalization textCapitalization;
  final List<TextInputFormatter>? inputFormatters;

  /// 地址 / 备份码都只有英文字符: 给英文键盘, 拼音输入法下不会把 ":" 打成全角「：」、字母进候选
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final style = TextStyle(
      fontSize: 15,
      color: c.ink,
      fontFamily: mono ? NeoxMono.family : null,
      fontFamilyFallback: mono ? NeoxMono.fallback : null,
    );
    return Container(
      constraints: const BoxConstraints(minHeight: 50),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        color: c.dark ? c.well : const Color(0xFFFBF9F5),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.line, width: 1),
      ),
      child: Row(
        children: [
          Icon(icon, size: 19, color: c.grey),
          const SizedBox(width: 10),
          Expanded(
            child: TextField(
              controller: controller,
              style: style,
              textCapitalization: textCapitalization,
              inputFormatters: inputFormatters,
              keyboardType: keyboardType,
              autocorrect: false,
              enableSuggestions: false,
              cursorColor: c.cobalt,
              decoration: InputDecoration(
                isDense: true,
                hintText: hint,
                hintStyle: style.copyWith(color: c.faint),
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                disabledBorder: InputBorder.none,
                filled: false,
                contentPadding: const EdgeInsets.symmetric(vertical: 14),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 「点一下连接」等电脑确认: 核对码 + 转圈 + 取消
class _PairWaitDialog extends StatelessWidget {
  const _PairWaitDialog({required this.desktopName, required this.code});

  final String desktopName;
  final String code;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return AlertDialog(
      title: Text(tr('在电脑上点「允许」')),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            tr('「$desktopName」上弹出了连接请求。核对电脑上显示的数字和下面一致，再点允许。'),
            style: TextStyle(fontSize: 13.5, color: c.grey, height: 1.5),
          ),
          const SizedBox(height: 18),
          Text(
            '${code.substring(0, 3)} ${code.substring(3)}',
            style: TextStyle(
              fontSize: 34,
              fontWeight: FontWeight.w700,
              letterSpacing: 4,
              color: c.ink,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 18),
          const ClaySpinner(),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(tr('取消')),
        ),
      ],
    );
  }
}

class _BeaconTile extends StatelessWidget {
  const _BeaconTile({
    required this.beacon,
    required this.selected,
    required this.onTap,
  });

  final DesktopBeacon beacon;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ClayRow(
      icon: Icons.laptop_mac,
      title: beacon.deviceName,
      subtitle: '${beacon.host}:${beacon.port}',
      selected: selected,
      onTap: onTap,
    );
  }
}

class UpperCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    return newValue.copyWith(text: newValue.text.toUpperCase());
  }
}

// ────────────────────────────────────────────────────────────────
// 共用: 成功 / 失败 提示
// ────────────────────────────────────────────────────────────────

void _showSuccess(BuildContext context, PairingResult r, WidgetRef ref) {
  /* 用户重新扫码 = 明确信任这台, 从解除拒绝名单拿掉 */
  ref.read(unpairedDesktopsProvider.notifier).allow(r.desktopDeviceId);
  /* 电脑配了自托管中继: 记下来, 出门就走它 (没配的电脑不清别人给的) */
  if (r.relay != null) {
    ref.read(selfHostedRelayProvider.notifier).apply(r.relay);
  }
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(tr('已配对「${r.desktopDeviceName}」')),
      duration: const Duration(seconds: 3),
    ),
  );
  /* 配对成功立即走统一智能连接入口 — 先同 Wi-Fi, 不通再远程兜底。 */
  ref.read(wsClientProvider.notifier).connectToDesktop(r.desktopDeviceId);
  /* 配好了直接落到这台电脑的页面 (它的会话 + 新建), 首页垫底: 返回 = 首页 */
  context.go('/');
  context.push('/remote/${Uri.encodeComponent(r.desktopDeviceId)}');
}

/// 用 AlertDialog 显示配对失败 — 比 SnackBar 显眼, 不会自动消失, 用户必看到.
/// 附带分类信息 + 排查建议.
Future<void> _showErrorDialog(BuildContext context, PairingException e) async {
  final theme = Theme.of(context);
  final hints = pairingErrorHints(e.code, statusCode: e.statusCode);
  final message = pairingErrorMessage(e);
  await showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: NeoxRadius.chipR),
      title: Row(
        children: [
          Icon(Icons.error_outline, color: theme.colorScheme.error, size: 20),
          const SizedBox(width: 8),
          Text(tr('连接失败')),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectableText(message, style: theme.textTheme.bodyMedium),
          if (hints.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              tr('可能原因'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            for (final h in hints)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('• ', style: theme.textTheme.bodySmall),
                    Expanded(child: Text(h, style: theme.textTheme.bodySmall)),
                  ],
                ),
              ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(ctx),
          child: Text(tr('重试')),
        ),
      ],
    ),
  );
}

/// 电脑拒绝连接时把服务端原因原样显示 —— 例如账号不一致 / 配对码过期,
/// 比统一换成“重新生成二维码”更能告诉用户该做什么。
String pairingErrorMessage(PairingException e) {
  switch (e.code) {
    case PairingErrorCode.network:
      return (e.message.contains('超时') ||
              e.message.toLowerCase().contains('timed out') ||
              e.message.toLowerCase().contains('timeout'))
          ? tr('连接超时，请确认手机和电脑在同一 Wi-Fi')
          : tr('暂时连接不上电脑，请检查网络后重试');
    case PairingErrorCode.qrExpired:
      return tr('二维码已过期，请在电脑端重新生成');
    case PairingErrorCode.qrInvalid:
      return tr('二维码无法识别，请扫描电脑端 Neox 显示的二维码');
    case PairingErrorCode.serverRejected:
      return e.message.isNotEmpty
          ? e.message
          : tr('电脑拒绝了这次连接，请重新生成二维码后再试');
    case PairingErrorCode.fingerprintMismatch:
      return tr('连接校验不一致，请换一个网络或重新生成二维码');
    case PairingErrorCode.cryptoFailed:
      return tr('连接校验失败，请重试');
    case PairingErrorCode.storageFailed:
      return tr('保存连接信息失败，请检查手机存储空间');
  }
}

/// [statusCode] 是「点一下连接」的结果 (电脑拒绝 / 没人确认 / 忙) 时, 提示语本身已经说清楚了, 不再列原因。
/// [hasAccounts] = 发行版有账号体系 (开源版没有, 不提「同一个账号」)。
List<String> pairingErrorHints(PairingErrorCode code, {int? statusCode, bool? hasAccounts}) {
  if (const {403, 408, 429}.contains(statusCode)) return const [];
  switch (code) {
    case PairingErrorCode.network:
      return [
        tr('手机和电脑是否在同一 Wi-Fi'),
        tr('Mac 防火墙是否拦截了本地连接'),
        tr('电脑端“设置 → 远程访问”是否正在运行'),
        tr('二维码是否过期，请重新生成'),
      ];
    case PairingErrorCode.qrExpired:
      return [tr('在电脑端重新生成二维码')];
    case PairingErrorCode.qrInvalid:
      return [tr('确认扫描的是 Neox 的二维码'), tr('相机距离太近或太远时可以调整一下')];
    case PairingErrorCode.serverRejected:
      return [
        if (hasAccounts ?? friendlyErrorHasAccounts) tr('手机和电脑是否登录同一个账号'),
        tr('二维码是否已过期或被使用'),
        tr('电脑端版本是否过旧'),
      ];
    case PairingErrorCode.fingerprintMismatch:
      return [tr('连接校验不一致，请换一个 Wi-Fi 后重试'), tr('重启电脑端后再试')];
    case PairingErrorCode.cryptoFailed:
      return [tr('手机端密钥损坏，请重新安装 App')];
    case PairingErrorCode.storageFailed:
      return [tr('手机存储不足或权限受限')];
  }
}
