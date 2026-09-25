export type AssistantLane = 'chat' | 'leader_request' | 'steward_commitment';
export type AssistantComplexity = 'low' | 'medium' | 'high';
export type AssistantRisk = 'low' | 'medium' | 'high';

export interface TriageInput {
  userMessage: string;
  recentContext?: string;
  activeWorkerCount?: number;
  activeTeamCount?: number;
}

export interface TriageOutput {
  lane: AssistantLane;
  complexity: AssistantComplexity;
  needsLeader: boolean;
  needsCommitment: boolean;
  needsClarification: boolean;
  canProceedWithoutClarification: boolean;
  risk: AssistantRisk;
  reason: string;
}

const STEWARD_PATTERNS = /(长期|持续|每天|定时|监控|观察|提醒|跟进|托管|24小时|自动管理|watch|monitor|follow up|remind)/i;
const LEADER_PATTERNS = /(帮我|帮忙|查一下|查下|找一下|找下|看下|看看|定位|修复|改一下|改下|实现|创建|新建|分析项目|搜索项目|代码|文件|命令|测试|review|评审|架构|方案|team|leader|并行|多阶段|多角色|页面|样式|组件|模块|接口|登录|美化|重构)/i;
const PROJECT_CONTEXT_PATTERNS = /(src\/|pages\/|components\/|modules\/|login|signup|register|\.tsx?|\.jsx?|\.vue|\.py|\.java|\.go|\.rs|页面|文件|代码|项目|模块|接口|样式|组件|登录|美化|玻璃拟态)/i;
const STRONG_PROJECT_CONTEXT_PATTERNS = /(src\/|pages\/|components\/|modules\/|\.tsx?|\.jsx?|\.vue|\.py|\.java|\.go|\.rs|这个文件|当前项目|当前仓库|代码库|登录页|页面|样式|重构|美化|玻璃拟态)/i;
const AFFIRMATION_PATTERNS = /^(开始吧|开始|继续|就这么做|按这个来|搞吧|去做吧|可以开始了|行|好的|好啊|来吧|开干|玻璃拟态开始吧)$/i;
const HIGH_RISK_PATTERNS = /(删除|付款|转账|生产|线上|发布|发邮件|发消息|外部联系人)/i;
const CLARIFY_PATTERNS = /(这个|那个|上次那个|它|这里|那里|处理一下|搞一下)/i;
const CONCEPT_CHAT_PATTERNS = /(解释一下|介绍一下|讲讲|聊聊|是什么|为什么|如何|原理|虚拟\s*dom|virtual\s*dom)/i;
const DESIGN_CHAT_PATTERNS = /(想一下|想想|怎么设计|如何设计|设计一下|方案|思路|建议)/i;
const HARD_EXECUTION_PATTERNS = /(查一下|查下|找一下|找下|看下|看看|定位|修复|改一下|改下|实现|创建|新建|分析项目|搜索项目|review|评审|重构|美化)/i;

export class TaskTriageEngine {
  triage(input: TriageInput): TriageOutput {
    const message = input.userMessage.trim();
    const normalized = message.toLowerCase();
    const recentContext = (input.recentContext || '').trim();

    if (!message) {
      return {
        lane: 'chat',
        complexity: 'low',
        needsLeader: false,
        needsCommitment: false,
        needsClarification: false,
        canProceedWithoutClarification: true,
        risk: 'low',
        reason: 'empty_message',
      };
    }

    const isQuestion = /[?？]|为什么|怎么|如何|啥|什么|介绍|解释|分析一下概念/.test(message);
    const hasStrongProjectContext = STRONG_PROJECT_CONTEXT_PATTERNS.test(`${message}\n${recentContext}`);
    const isConceptChat = isQuestion && CONCEPT_CHAT_PATTERNS.test(message) && !hasStrongProjectContext;
    const isDesignChat = isQuestion && DESIGN_CHAT_PATTERNS.test(message) && !hasStrongProjectContext;
    const isSteward = STEWARD_PATTERNS.test(message);
    const isLeader = (LEADER_PATTERNS.test(message) || PROJECT_CONTEXT_PATTERNS.test(message))
      && !isConceptChat
      && !(isDesignChat && !HARD_EXECUTION_PATTERNS.test(message));
    const isContinuation = AFFIRMATION_PATTERNS.test(message) && PROJECT_CONTEXT_PATTERNS.test(recentContext);
    const isHighRisk = HIGH_RISK_PATTERNS.test(message);
    const needsClarification = CLARIFY_PATTERNS.test(message) && message.length < 30 && !isContinuation;
    const mentionsComplexity = /(并行|多阶段|评审|架构|方案|重构|长期|持续|团队|team|leader)/i.test(`${message}
${recentContext}`);

    if (isSteward) {
      return {
        lane: 'steward_commitment',
        complexity: mentionsComplexity ? 'high' : 'medium',
        needsLeader: true,
        needsCommitment: true,
        needsClarification,
        canProceedWithoutClarification: !needsClarification,
        risk: isHighRisk ? 'high' : 'medium',
        reason: 'long_running_or_monitoring_request',
      };
    }

    if (isLeader || isContinuation) {
      return {
        lane: 'leader_request',
        complexity: mentionsComplexity ? 'high' : 'medium',
        needsLeader: true,
        needsCommitment: false,
        needsClarification,
        canProceedWithoutClarification: !needsClarification,
        risk: isHighRisk ? 'high' : 'low',
        reason: 'execution_or_tool_request',
      };
    }

    return {
      lane: 'chat',
      complexity: isQuestion && normalized.length > 40 ? 'medium' : 'low',
      needsLeader: false,
      needsCommitment: false,
      needsClarification: false,
      canProceedWithoutClarification: true,
      risk: 'low',
      reason: isQuestion ? 'question_answering' : 'default_chat',
    };
  }
}
