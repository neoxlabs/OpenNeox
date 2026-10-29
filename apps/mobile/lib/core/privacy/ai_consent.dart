/// ai_consent.dart — 第一次把内容发给 AI 模型之前, 说清楚会发给谁、问一次同意.
///
/// App Store 审核指南 5.1.2(i) (2025-11 起): 个人数据发给第三方 (明确包括第三方 AI) 之前,
/// 必须清楚告知并拿到明确许可。手机上的对话、附件、语音、出图描述都会经 Neox 网关或用户自己的 Key
/// 发给模型厂商 —— 不问这一次, AI 类 App 现在按这条直接打回。
///
/// 只问一次 (prefs 记住); 不同意就不发, 输入框里的字原样留着。入口: 输入框发送 (对话 / 出图),
/// 语音对话开始, Pilot 页打开。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../shared/clay/clay.dart';
import '../edition/edition.dart';
import '../i18n/tr.dart';
import '../neox_constants.dart';

const _kConsentKey = 'neox.ai_data_consent.v1';

bool? _cached;

/// 已同意返回 true; 没同意过就弹一次, 用户点同意才 true。
Future<bool> ensureAiDataConsent(BuildContext context) async {
  if (_cached == true) return true;
  final prefs = await SharedPreferences.getInstance();
  if (prefs.getBool(_kConsentKey) == true) return _cached = true;
  if (!context.mounted) return false;
  final ok = await showClaySheet<bool>(context, builder: (ctx) => const AiConsentSheet());
  if (ok != true) return false;
  await prefs.setBool(_kConsentKey, true);
  return _cached = true;
}

/// 稿 v5-consent: 盾牌陶土 + 标题 + 三行 (方块图标 + 一句) + 隐私政策 › + [暂不] [同意并继续] 同排一样大.
class AiConsentSheet extends StatelessWidget {
  const AiConsentSheet({super.key, this.officialServices});

  /// 不给 = 按当前发行版 (editionProvider); 截图 harness 没有 ProviderScope 时直接给
  final bool? officialServices;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final official = officialServices ?? ProviderScope.containerOf(context, listen: false).read(editionProvider).officialServices;
    Widget line(IconData icon, String text) => Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, size: 20, color: c.ink),
              ),
              const SizedBox(width: 14),
              Expanded(child: Text(text, style: TextStyle(fontSize: 15, color: c.ink, height: 1.45))),
            ],
          ),
        );

    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 4, 24, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const ClayArt('consent', width: 76),
          const SizedBox(height: 14),
          Text(tr('发送前说明一下'), style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: c.ink)),
          const SizedBox(height: 20),
          line(Icons.person_outline_rounded, tr('你发的内容（消息、附件、语音文字、出图描述）会交给你选的模型厂商来生成回复')),
          /* 没有官方服务的发行版 (开源版): 没有订阅、没有我们的服务器, 也没有我们的隐私政策页 */
          if (official) ...[
            line(Icons.dns_outlined, tr('用订阅时经 Neox 服务器转发；用自己的 Key 时直连厂商')),
            /* 跟隐私政策「Not used for training」一段同一口径: 只承诺我们自己, 厂商按各家条款 */
            line(Icons.verified_user_outlined, tr('Neox 不用你的内容训练模型；厂商如何处理以各家条款为准')),
            InkWell(
              onTap: () => launchUrl(Uri.parse(kNeoxPrivacyPolicyUrl), mode: LaunchMode.externalApplication),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text('${tr('隐私政策')} ›', style: TextStyle(fontSize: 14.5, color: c.grey)),
              ),
            ),
          ] else ...[
            line(Icons.dns_outlined, tr('用你自己的 Key 直连厂商，或在你自己的电脑上运行；不经过任何第三方服务器')),
            line(Icons.verified_user_outlined, tr('厂商如何处理你的内容，以各家条款为准')),
          ],
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(child: ClayButton(label: tr('暂不'), size: ClayButtonSize.large, expand: true, onTap: () => Navigator.of(context).pop(false))),
              const SizedBox(width: 12),
              Expanded(child: ClayButton.ink(label: tr('同意并继续'), size: ClayButtonSize.large, expand: true, onTap: () => Navigator.of(context).pop(true))),
            ],
          ),
        ],
      ),
    );
  }
}
