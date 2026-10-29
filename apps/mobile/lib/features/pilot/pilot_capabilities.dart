/// pilot_capabilities.dart — 「我能帮你做什么」的内容 (2026-10-18)。
///
/// 只收 `docs/pilot/01-场景清单与可行性矩阵.md` 里标「现在能做」的场景:
/// 提醒 / 记账 / 微信回消息 / 短信验证码 / 打电话 / 通知摘要 / 情境提醒 / 电脑上干活。
/// 「要研发」的下单、打车、早报不往这里放 —— 用户点进来看到的必须是真能办成的。
///
/// 每项一句能力 + 一句示例说法 + 需要的权限。示例点了只填进输入框, 不直接发。
/// 本文件不 import flutter, 纯逻辑跑单测 (test/features/pilot/pilot_capabilities_test.dart)。
library;

import 'pilot_keepalive_guide.dart';

class PilotCapability {
  const PilotCapability({
    required this.id,
    required this.icon,
    required this.title,
    required this.ability,
    required this.example,
    required this.permission,
    this.keepAliveId,
    this.starter = false,
    this.trial = false,
  });

  /// 对应场景清单的编号 (S03 …), 方便回查依据
  final String id;

  /// 开场列表里的表情 (跟原来的空状态一个风格, 不额外引图标)
  final String icon;

  /// 一句话能力
  final String title;

  /// 它具体怎么做 (一句大白话)
  final String ability;

  /// 示例说法: 点了填进输入框
  final String example;

  /// 需要的权限 (大白话)
  final String permission;

  /// 对应保活检查页能检测的项 (accessibility / notifications / battery)。
  /// null = 这项权限系统查不了 (短信 / 拨号 / 定位 / 电脑连接), 只能提示用户自己确认。
  final String? keepAliveId;

  /// 新会话空状态里露出的最常用几项
  final bool starter;

  /// 只在模拟器上验过、还没上真机 (S03 / S13), 标一下不夸大
  final bool trial;
}

/// 按「天天用、风险低」排; 空状态取 starter 的前几项
const kPilotCapabilities = <PilotCapability>[
  PilotCapability(
    id: 'S05',
    icon: '⏰',
    title: '到点提醒你',
    ability: '写进日历、定系统闹钟；提醒没理它，5 分钟再响一次。',
    example: '明早 8 点提醒我交房租',
    permission: '通知',
    keepAliveId: 'notifications',
    starter: true,
  ),
  PilotCapability(
    id: 'S06',
    icon: '💰',
    title: '自动记账',
    ability: '付款通知和短信在手机上认金额，原文不出手机；每晚问你一句今天花了多少。',
    example: '这个月我吃饭花了多少',
    permission: '通知使用权',
    keepAliveId: 'notifications',
    starter: true,
  ),
  PilotCapability(
    id: 'S03',
    icon: '💬',
    title: '回微信消息',
    ability: '看着屏幕替你回，发送之前把发给谁、发什么念给你听。',
    example: '帮我回微信，跟小王说明天到',
    permission: '无障碍',
    keepAliveId: 'accessibility',
    starter: true,
    trial: true,
  ),
  PilotCapability(
    id: 'S04',
    icon: '✉️',
    title: '看短信、读验证码',
    ability: '直接读短信和验证码；要替你回一条时，先问过你收件人和内容。',
    example: '刚才的验证码是多少',
    permission: '短信',
    starter: true,
  ),
  PilotCapability(
    id: 'S11',
    icon: '📞',
    title: '替你打电话',
    ability: '有拨号权限就直接拨；没有就把号码填好，你按一下。名字对不上人时会先问。',
    example: '打给我妈',
    permission: '拨号',
    starter: true,
  ),
  PilotCapability(
    id: 'S14',
    icon: '🔔',
    title: '通知摘要',
    ability: '谁找过你、快递到哪了，一句话说清；没有要紧事就不打扰。',
    example: '今天有人找我吗',
    permission: '通知使用权',
    keepAliveId: 'notifications',
  ),
  PilotCapability(
    id: 'S13',
    icon: '🚗',
    title: '情境提醒',
    ability: '出门、到家、下车时提醒你一句；每条一天最多一次，半夜不响。',
    example: '我到家了提醒我拿快递',
    permission: '定位和通知',
    keepAliveId: 'notifications',
    trial: true,
  ),
  PilotCapability(
    id: 'S12',
    icon: '💻',
    title: '让电脑干活',
    ability: '把活派给连着的电脑：做表格、改代码、查文件；电脑没连就如实说。',
    example: '在电脑上把上周的数据做成表',
    permission: '电脑已连接',
  ),
];

/// 新会话空状态里露出的示例 (5 项, 加上「拍小票」正好一屏)
List<PilotCapability> pilotStarterCapabilities() => [
      for (final c in kPilotCapabilities)
        if (c.starter) c,
    ];

/// 这项能力需要的权限现在开没开
enum PilotCapState { on, off, unknown }

PilotCapState pilotCapState(PilotCapability cap, PilotKeepAliveStatus? status) {
  final id = cap.keepAliveId;
  if (status == null || id == null) return PilotCapState.unknown;
  final s = status.stateOf(id);
  if (s == null) return PilotCapState.unknown;
  return s ? PilotCapState.on : PilotCapState.off;
}

/// 没开 / 查不了的项有几件 (页头一句话用)
int pilotCapMissingCount(List<PilotCapability> caps, PilotKeepAliveStatus? status) =>
    caps.where((c) => pilotCapState(c, status) == PilotCapState.off).length;
