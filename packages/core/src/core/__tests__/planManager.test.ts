/**
 * PlanManager Unit Tests — 计划状态管理
 *
 * 测试任务分解和执行追踪：
 * 1. 创建计划（多步骤）
 * 2. 步骤推进 (pending → in_progress → completed)
 * 3. 跳过步骤
 * 4. 进度计算
 * 5. 计划完成检测
 *
 * 不需要 API — 纯状态机测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PlanManager } from '../planManager.js';

describe('PlanManager', () => {
    let pm: PlanManager;

    beforeEach(() => {
        pm = new PlanManager();
    });

    // ========================================================================
    // 1. 创建计划
    // ========================================================================
    describe('Create plan', () => {
        it('should create plan with steps', () => {
            const plan = pm.createPlan([
                { description: '分析需求' },
                { description: '实现功能' },
                { description: '编写测试' },
            ]);

            expect(plan.steps.length).toBe(3);
            expect(plan.steps[0].id).toBe('step_1');
            expect(plan.steps[0].status).toBe('pending');
            expect(plan.currentStepIndex).toBe(-1); // 未开始
        });

        it('should support activeForm description', () => {
            const plan = pm.createPlan([
                { description: '分析需求', activeForm: '正在分析需求...' },
            ]);

            expect(plan.steps[0].activeForm).toBe('正在分析需求...');
        });
    });

    // ========================================================================
    // 2. 步骤推进
    // ========================================================================
    describe('Step progression', () => {
        beforeEach(() => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
                { description: '步骤三' },
            ]);
        });

        it('should advance to first pending step', () => {
            const result = pm.updateCurrentStep('步骤一');
            expect(result).toBe(true);

            const current = pm.getCurrentStep();
            expect(current).toBeTruthy();
            expect(current!.status).toBe('in_progress');
            expect(current!.description).toBe('步骤一');
        });

        it('should complete a step', () => {
            pm.updateCurrentStep('步骤一');
            const result = pm.completeStep('step_1');
            expect(result).toBe(true);

            const plan = pm.getCurrentPlan();
            expect(plan!.steps[0].status).toBe('completed');
        });

        it('should advance to next step after completion', () => {
            pm.updateCurrentStep('步骤一');
            pm.completeStep('step_1');
            pm.updateCurrentStep('步骤二');

            const current = pm.getCurrentStep();
            expect(current!.description).toBe('步骤二');
            expect(current!.status).toBe('in_progress');
        });
    });

    // ========================================================================
    // 3. 跳过步骤
    // ========================================================================
    describe('Skip step', () => {
        it('should skip a step', () => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
            ]);

            const result = pm.skipStep('step_1');
            expect(result).toBe(true);

            const plan = pm.getCurrentPlan();
            expect(plan!.steps[0].status).toBe('skipped');
        });
    });

    // ========================================================================
    // 4. 进度统计
    // ========================================================================
    describe('Progress tracking', () => {
        it('should calculate progress', () => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
                { description: '步骤三' },
                { description: '步骤四' },
            ]);

            pm.updateCurrentStep('步骤一');
            pm.completeStep('step_1');

            const progress = pm.getProgress();
            expect(progress).toBeTruthy();
            expect(progress!.completed).toBe(1);
            expect(progress!.total).toBe(4);
            expect(progress!.percentage).toBe(25);
        });

        it('should return null when no plan', () => {
            expect(pm.getProgress()).toBeNull();
        });
    });

    // ========================================================================
    // 5. 计划完成检测
    // ========================================================================
    describe('Plan completion', () => {
        it('should detect complete plan', () => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
            ]);

            expect(pm.isPlanComplete()).toBe(false);

            pm.completeStep('step_1');
            expect(pm.isPlanComplete()).toBe(false);

            pm.completeStep('step_2');
            expect(pm.isPlanComplete()).toBe(true);
        });

        it('skipped + completed = complete', () => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
            ]);

            pm.completeStep('step_1');
            pm.skipStep('step_2');
            expect(pm.isPlanComplete()).toBe(true);
        });
    });

    // ========================================================================
    // 6. 清除计划
    // ========================================================================
    describe('Clear plan', () => {
        it('should clear all state', () => {
            pm.createPlan([{ description: '步骤' }]);
            pm.clearPlan();
            expect(pm.getCurrentPlan()).toBeNull();
            expect(pm.getCurrentStep()).toBeNull();
            expect(pm.getProgress()).toBeNull();
        });
    });

    // ========================================================================
    // 7. 边界情况
    // ========================================================================
    describe('Edge cases', () => {
        it('should return false for operations without plan', () => {
            expect(pm.updateCurrentStep('x')).toBe(false);
            expect(pm.completeStep('x')).toBe(false);
            expect(pm.skipStep('x')).toBe(false);
        });

        it('should return false for invalid step ID', () => {
            pm.createPlan([{ description: '步骤' }]);
            expect(pm.completeStep('nonexistent')).toBe(false);
        });

        it('getNextPendingStep should find next pending', () => {
            pm.createPlan([
                { description: '步骤一' },
                { description: '步骤二' },
            ]);
            pm.completeStep('step_1');

            const next = pm.getNextPendingStep();
            expect(next).toBeTruthy();
            expect(next!.id).toBe('step_2');
        });
    });
});
