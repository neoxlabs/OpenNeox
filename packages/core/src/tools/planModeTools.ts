
import type { Tool } from '@neoxlabs/kernel/types/index.js';

// ==================== Plan Mode State ====================

export type PlanModeState = 'off' | 'planning' | 'awaiting_approval' | 'executing';

let planModeState: PlanModeState = 'off';
let currentPlan: string | null = null;
let prePlanPermissionMode: string | null = null;

// Callbacks
/** Permission level required for plan mode transitions */
export type PlanPermissionLevel = 'auto' | 'confirm' | 'manual';

let planPermissionLevel: PlanPermissionLevel = 'confirm'; // Default: require confirmation

let onPlanModeChange: ((state: PlanModeState, plan?: string) => void) | null = null;
let onPlanApprovalRequest: ((plan: string) => Promise<{ approved: boolean; editedPlan?: string }>) | null = null;
let onPlanPermissionRequest: ((action: 'enter' | 'exit', plan?: string) => Promise<boolean>) | null = null;

export function setPlanPermissionLevel(level: PlanPermissionLevel): void {
  planPermissionLevel = level;
}

export function getPlanPermissionLevel(): PlanPermissionLevel {
  return planPermissionLevel;
}

export function setPlanModeCallbacks(callbacks: {
  onChange?: (state: PlanModeState, plan?: string) => void;
  onApprovalRequest?: (plan: string) => Promise<{ approved: boolean; editedPlan?: string }>;
  onPermissionRequest?: (action: 'enter' | 'exit', plan?: string) => Promise<boolean>;
}): void {
  if (callbacks.onChange) onPlanModeChange = callbacks.onChange;
  if (callbacks.onApprovalRequest) onPlanApprovalRequest = callbacks.onApprovalRequest;
  if (callbacks.onPermissionRequest) onPlanPermissionRequest = callbacks.onPermissionRequest;
}

export function getPlanModeState(): PlanModeState {
  return planModeState;
}

export function getCurrentPlan(): string | null {
  return currentPlan;
}

export function isPlanMode(): boolean {
  return planModeState !== 'off';
}

export function resetPlanMode(): void {
  planModeState = 'off';
  currentPlan = null;
  prePlanPermissionMode = null;
}

// ==================== Tool Definitions ====================

export const enterPlanModeTool: Tool = {
  name: 'enter_plan_mode',
  description: 'Enter plan mode to preview and approve actions before execution. In plan mode, tool calls are collected into a plan for user review instead of being executed immediately. Use this when the task is complex and you want to get user approval before making changes.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {},
  },

  async function(): Promise<string> {
    if (planModeState !== 'off') {
      return JSON.stringify({
        error: 'Already in plan mode',
        currentState: planModeState,
      });
    }

    // Permission check (unless auto mode)
    if (planPermissionLevel !== 'auto' && onPlanPermissionRequest) {
      try {
        const permitted = await onPlanPermissionRequest('enter');
        if (!permitted) {
          return JSON.stringify({
            error: 'User denied entering plan mode.',
          });
        }
      } catch (error: any) {
        return JSON.stringify({
          error: `Permission request failed: ${error.message}`,
        });
      }
    }

    planModeState = 'planning';
    currentPlan = null;

    if (onPlanModeChange) {
      onPlanModeChange('planning');
    }

    return JSON.stringify({
      message: 'Entered plan mode. Tool calls will be collected into a plan for user approval instead of being executed immediately. When your plan is ready, use exit_plan_mode to present it for approval.',
      state: 'planning',
    });
  },
};

export const exitPlanModeTool: Tool = {
  name: 'exit_plan_mode',
  description: 'Exit plan mode and present the collected plan for user approval. If approved, the plan will be executed. The user may edit the plan before approving.',
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'safe',
  isReadOnly: true,

  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The execution plan to present for approval. Include step-by-step description of what will be done.',
      },
    },
    required: ['plan'],
  },

  async function(args: any): Promise<string> {
    const { plan } = args;

    if (planModeState === 'off') {
      return JSON.stringify({
        error: 'Not in plan mode. Use enter_plan_mode first.',
      });
    }

    currentPlan = plan;
    planModeState = 'awaiting_approval';

    if (onPlanModeChange) {
      onPlanModeChange('awaiting_approval', plan);
    }

    // If approval callback is set, wait for user response
    if (onPlanApprovalRequest) {
      try {
        const result = await onPlanApprovalRequest(plan);

        if (result.approved) {
          // Plan approved - switch to executing
          if (result.editedPlan) {
            currentPlan = result.editedPlan;
          }
          planModeState = 'executing';

          if (onPlanModeChange) {
            onPlanModeChange('executing', currentPlan!);
          }

          return JSON.stringify({
            approved: true,
            plan: currentPlan,
            planWasEdited: !!result.editedPlan,
            message: 'Plan approved. Proceeding with execution.',
          });
        } else {
          // Plan rejected - back to off
          planModeState = 'off';
          currentPlan = null;

          if (onPlanModeChange) {
            onPlanModeChange('off');
          }

          return JSON.stringify({
            approved: false,
            message: 'Plan rejected by user. Exited plan mode.',
          });
        }
      } catch (error: any) {
        planModeState = 'off';
        currentPlan = null;
        return JSON.stringify({
          error: `Plan approval failed: ${error.message}`,
        });
      }
    }

    // No approval callback - auto-approve (for non-interactive modes)
    planModeState = 'off';
    const savedPlan = currentPlan;
    currentPlan = null;

    if (onPlanModeChange) {
      onPlanModeChange('off');
    }

    return JSON.stringify({
      plan: savedPlan,
      message: 'Plan mode exited. No approval handler configured - plan returned for manual review.',
    });
  },
};
