/// pilot_specialist_starter.dart — 专员会话零消息时的开场 (2026-10-18)。
///
/// 用户点进「财务管家」「家务管家」这类专员的窗口, 原来一句话没有就是一片白:
/// 不知道它是谁、能问它什么。这里给它一句自我介绍 (服务端目录里的 duty) 和
/// 三条它管得着的示例 —— 示例点了只填进输入框, 不直接发 (跟主管的开场一个规矩)。
///
/// 示例按专员 id 给, 都在它能看的记录范围里 (见 packages/pilot-data-sdk/src/team.ts):
/// 财务管家问花销、健康教练问睡眠运动, 问到范围外的事它答不上来, 所以不写。
/// 本文件不 import flutter, 纯逻辑跑单测 (test/features/pilot/pilot_specialist_starter_test.dart)。
library;

import '../../core/i18n/tr.dart';
import '../../core/pilot/pilot_records.dart';

const _examples = <String, List<String>>{
  'health': ['这周我睡了多久、运动够不够', '帮我排下周的训练', '我最近的体重变化怎么样'],
  'finance': ['这个月我花了多少', '有哪些订阅在自动扣钱', '上个月月报给我看看'],
  'home': ['这个月账单都交了吗', '车险年检什么时候到期', '家里有什么快到期的要办'],
  'social': ['最近谁该联系了', '两周内有哪些生日纪念日', '给小王送什么好'],
  'work': ['这周要交的东西有哪些', '帮我列本周三件事', '上周做出来的成品在哪'],
  'travel': ['我到外地了，天气和要带什么', '附近有什么好吃的', '上次去那个城市是什么时候'],
};

/// 认不出的专员 (服务端新加了人 / 老版本目录): 问它管什么、有什么要提醒、记一笔
const _fallback = <String>['你最近都替我看了些什么', '有什么要提醒我的', '帮我记一笔'];

/// 这位专员的 3 条示例 (点了填进输入框)
List<String> specialistStarterExamples(PilotSpecialist s) => _examples[s.id] ?? _fallback;

/// 开场那一句: 「我是财务管家，管花销、收入、资产、订阅，每月出月报。」
/// 目录里没写 duty 就只报名字, 不硬编一段描述。
String specialistIntro(PilotSpecialist s) =>
    s.duty.trim().isEmpty ? tr('我是${s.name}。') : tr('我是${s.name}，管${s.duty}。');
