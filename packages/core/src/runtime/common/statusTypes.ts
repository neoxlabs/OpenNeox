/**
 * 状态事件类型定义（用于状态/进度显示）
 */

export type StatusLanguage = 'zh' | 'en';

// ============ 进度（用于外部上报） ============

export interface StatusProgress {
  completed: number;
  total: number;
  percentage: number;
  currentStep?: string;
  source?: 'plan' | 'todo' | 'tools';
}

// ============ 状态事件（用于 eventSink） ============

export type StatusEvent =
  | {
      type: 'supervisor_status';
      sessionId: string;
      message: string;
      progress?: StatusProgress;
      timestamp: number;
    }
  | {
      type: 'supervisor_progress';
      sessionId: string;
      progress: StatusProgress;
      timestamp: number;
    }
  | {
      type: 'supervisor_message';
      sessionId: string;
      summary: string;
      detail?: string;
      timestamp: number;
    };

// 兼容旧名称
export type SupervisorLanguage = StatusLanguage;
export type SupervisorProgress = StatusProgress;
export type SupervisorEvent = StatusEvent;
