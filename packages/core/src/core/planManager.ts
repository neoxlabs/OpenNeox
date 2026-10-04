/**
 * Plan Manager - 计划状态管理器
 * 在 Runner 中使用，管理执行计划的状态
 */

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  activeForm?: string;  // 执行中的描述（进行时态）
}

export interface Plan {
  steps: PlanStep[];
  currentStepIndex: number;
  createdAt: number;
}

export class PlanManager {
  private currentPlan: Plan | null = null;

  /**
   * 创建新计划
   */
  createPlan(steps: Array<{ description: string; activeForm?: string }>): Plan {
    const planSteps: PlanStep[] = steps.map((step, index) => ({
      id: `step_${index + 1}`,
      description: step.description,
      activeForm: step.activeForm || step.description,
      status: 'pending' as const,
    }));

    this.currentPlan = {
      steps: planSteps,
      currentStepIndex: -1,  // 还未开始
      createdAt: Date.now(),
    };

    return this.currentPlan;
  }

  /**
   * 获取当前计划
   */
  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  /**
   * 更新当前步骤
   */
  updateCurrentStep(stepDescription: string): boolean {
    if (!this.currentPlan) {
      return false;
    }

    // 找到下一个 pending 的步骤
    const nextPendingIndex = this.currentPlan.steps.findIndex(
      (step) => step.status === 'pending'
    );

    if (nextPendingIndex === -1) {
      return false;  // 没有待执行的步骤
    }

    // 将当前步骤标记为 in_progress
    this.currentPlan.steps[nextPendingIndex].status = 'in_progress';
    this.currentPlan.currentStepIndex = nextPendingIndex;

    return true;
  }

  /**
   * 完成步骤
   */
  completeStep(stepId: string): boolean {
    if (!this.currentPlan) {
      return false;
    }

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) {
      return false;
    }

    step.status = 'completed';
    return true;
  }

  /**
   * 跳过步骤
   */
  skipStep(stepId: string): boolean {
    if (!this.currentPlan) {
      return false;
    }

    const step = this.currentPlan.steps.find((s) => s.id === stepId);
    if (!step) {
      return false;
    }

    step.status = 'skipped';
    return true;
  }

  /**
   * 获取当前正在执行的步骤
   */
  getCurrentStep(): PlanStep | null {
    if (!this.currentPlan || this.currentPlan.currentStepIndex === -1) {
      return null;
    }

    return this.currentPlan.steps[this.currentPlan.currentStepIndex] || null;
  }

  /**
   * 获取下一个待执行的步骤
   */
  getNextPendingStep(): PlanStep | null {
    if (!this.currentPlan) {
      return null;
    }

    return this.currentPlan.steps.find((step) => step.status === 'pending') || null;
  }

  /**
   * 检查计划是否完成
   */
  isPlanComplete(): boolean {
    if (!this.currentPlan) {
      return false;
    }

    return this.currentPlan.steps.every(
      (step) => step.status === 'completed' || step.status === 'skipped'
    );
  }

  /**
   * 清除当前计划
   */
  clearPlan(): void {
    this.currentPlan = null;
  }

  /**
   * 获取计划进度统计
   */
  getProgress(): { completed: number; total: number; percentage: number } | null {
    if (!this.currentPlan) {
      return null;
    }

    const total = this.currentPlan.steps.length;
    const completed = this.currentPlan.steps.filter(
      (step) => step.status === 'completed'
    ).length;

    return {
      completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }
}
