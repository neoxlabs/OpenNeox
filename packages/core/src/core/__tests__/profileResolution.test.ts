/**
 * Profile System Integration Tests
 *
 * 验证 Profile 匹配机制的正确性：
 * - 不同 protocol/model 组合是否匹配到正确的 Profile
 * - deepMerge 是否正确覆盖
 * - ARE Profile 是否正确传递
 *
 * 这是集成测试：测试 resolver.ts + defaults.ts 的协作
 */

import { describe, it, expect } from 'vitest';
import { resolveModelProfile } from '@neoxlabs/kernel/profiles/resolver.js';
import { BUILTIN_MODEL_PROFILES } from '@neoxlabs/kernel/profiles/defaults.js';

describe('Profile Resolution', () => {
    // ========================================================================
    // 1. GPT 系列
    // ========================================================================
    describe('GPT models', () => {
        it('gpt-4o → OPENAI_CHAT_PROFILE + GPT4_SERIES_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'gpt-4o',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('openai-chat');
            expect(profile.sourceProfileIds).toContain('gpt-4-series');
            expect(profile.completion?.detectToolEnvelopeLeak).toBe(true);
            expect(profile.completion?.nudgeToolUsageOnTextOnly).toBe(true);
        });

        it('gpt-5.3-codex → matches highest priority profile', () => {
            const profile = resolveModelProfile({
                protocol: 'openai-responses',
                model: 'gpt-5.3-codex',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('gpt-5.3-codex');
            expect(profile.transport?.openai?.forceResponsesAPI).toBe(true);
            expect(profile.prompt?.style).toBe('codex_official');
            expect(profile.completion?.detectContinuationIntent).toBe(false);
            expect(profile.loop?.strategy).toBe('fast_converge');
        });
    });

    // ========================================================================
    // 2. Claude / Anthropic
    // ========================================================================
    describe('Claude models', () => {
        it('claude-sonnet-4-5 → ANTHROPIC_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'anthropic',
                model: 'claude-sonnet-4-5-20250929',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('anthropic');
            // Claude 不需要 GPT 的各种检测
            expect(profile.completion?.detectToolEnvelopeLeak).toBe(false);
            expect(profile.completion?.nudgeToolUsageOnTextOnly).toBe(false);
            expect(profile.completion?.detectContinuationIntent).toBe(false);
            expect(profile.completion?.blockIntermediateFinalization).toBe(false);
        });

        it('claude-opus-4 → ARE maxLevel should be 1 (LIGHT)', () => {
            const profile = resolveModelProfile({
                protocol: 'anthropic',
                model: 'claude-opus-4-20250514',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.are?.maxLevel).toBe(1);
            expect(profile.are?.minIterationForGate).toBe(2);
            expect(profile.are?.verificationThreshold).toBe(5);
        });

        it('anthropic-openai protocol → also matches ANTHROPIC_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'anthropic-openai',
                model: 'claude-sonnet-4',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('anthropic');
        });
    });

    // ========================================================================
    // 3. DeepSeek
    // ========================================================================
    describe('DeepSeek models', () => {
        it('deepseek-chat → OPENAI_CHAT + DEEPSEEK_PROFILE (overrides)', () => {
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'deepseek-chat',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('openai-chat');
            expect(profile.sourceProfileIds).toContain('deepseek');
            // DeepSeek 应该覆盖为 strict
            expect(profile.completion?.unknownTaskFallback).toBe('strict');
            expect(profile.completion?.detectToolEnvelopeLeak).toBe(true);
        });

        it('deepseek-coder → ARE maxLevel should be 2', () => {
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'deepseek-coder',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.are?.maxLevel).toBe(2);
        });
    });

    // ========================================================================
    // 4. Kimi
    // ========================================================================
    describe('Kimi models', () => {
        it('kimi-k2.5 → KIMI_PROFILE (not OPENAI_CHAT)', () => {
            const profile = resolveModelProfile({
                protocol: 'kimi',
                model: 'kimi-k2.5',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('kimi');
            // 不应该匹配 openai-chat (kimi 已被移除)
            expect(profile.sourceProfileIds).not.toContain('openai-chat');
            expect(profile.completion?.detectToolEnvelopeLeak).toBe(false);
        });
    });

    // ========================================================================
    // 5. Gemini
    // ========================================================================
    describe('Gemini models', () => {
        it('gemini-3.0-pro → GEMINI_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'gemini',
                model: 'gemini-3.0-pro',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('gemini');
            expect(profile.are?.maxLevel).toBe(1);
            expect(profile.completion?.nudgeToolUsageOnTextOnly).toBe(false);
        });
    });

    // ========================================================================
    // 6. Doubao
    // ========================================================================
    describe('Doubao models', () => {
        it('doubao-seed → OPENAI_CHAT + DOUBAO_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'doubao-seed-241212',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('doubao');
            expect(profile.prompt?.language).toBe('zh');
            expect(profile.are?.promptLanguage).toBe('zh');
            expect(profile.completion?.unknownTaskFallback).toBe('strict');
        });

        it('ep-xxx (endpoint ID) → matches DOUBAO_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'ep-20241212',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('doubao');
        });
    });

    // ========================================================================
    // 7. GLM
    // ========================================================================
    describe('GLM models', () => {
        it('glm-4-plus → GLM_PROFILE', () => {
            const profile = resolveModelProfile({
                protocol: 'glm',
                model: 'glm-4-plus',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('glm');
            expect(profile.prompt?.language).toBe('zh');
            expect(profile.completion?.unknownTaskFallback).toBe('strict');
        });
    });

    // ========================================================================
    // 8. 未知模型 → 兜底
    // ========================================================================
    describe('Unknown models → fallback', () => {
        it('unknown protocol/model → BASE_MODEL_PROFILE only', () => {
            const profile = resolveModelProfile({
                protocol: 'openai' as any,
                model: 'some-unknown-model',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(profile.sourceProfileIds).toContain('default');
            expect(profile.sourceProfileIds).toContain('openai-chat');
        });
    });

    // ========================================================================
    // 9. deepMerge 正确性
    // ========================================================================
    describe('deepMerge correctness', () => {
        it('higher priority profile should override lower priority', () => {
            // DeepSeek (priority 25) should override OpenAI Chat (priority 20)
            const profile = resolveModelProfile({
                protocol: 'openai',
                model: 'deepseek-chat',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            // `unknownTaskFallback` should be 'strict' from DEEPSEEK, not 'lenient' from OPENAI_CHAT
            expect(profile.completion?.unknownTaskFallback).toBe('strict');
        });
    });

    // ========================================================================
    // 10. ARE Profile 差异化验证
    // ========================================================================
    describe('ARE Profile differentiation', () => {
        it('Claude should have lower ARE maxLevel than GPT', () => {
            const claudeProfile = resolveModelProfile({
                protocol: 'anthropic',
                model: 'claude-sonnet-4',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            const gptProfile = resolveModelProfile({
                protocol: 'openai',
                model: 'gpt-4o',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(claudeProfile.are?.maxLevel).toBeLessThan(gptProfile.are?.maxLevel ?? 2);
        });

        it('Claude should have higher verification threshold than GPT', () => {
            const claudeProfile = resolveModelProfile({
                protocol: 'anthropic',
                model: 'claude-opus-4',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            const gptProfile = resolveModelProfile({
                protocol: 'openai',
                model: 'gpt-4o',
                candidates: BUILTIN_MODEL_PROFILES,
            });
            expect(claudeProfile.are?.verificationThreshold ?? 3)
                .toBeGreaterThan(gptProfile.are?.verificationThreshold ?? 3);
        });
    });
});
