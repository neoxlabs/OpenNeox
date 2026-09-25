/**
 * Output Style Manager Unit Tests
 *
 * Tests:
 * - setOutputStyle / getOutputStyle round-trip
 * - getStylePromptAppend returns empty for standard, non-empty for others
 * - getStyleConfig returns correct label/icon/description
 * - OUTPUT_STYLE_LIST has all 4 styles
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setOutputStyle,
  getOutputStyle,
  setOutputStyleChangeCallback,
  getStylePromptAppend,
  getStyleConfig,
  getAllStyles,
  getStyleInfo,
  OUTPUT_STYLE_LIST,
  type OutputStyle,
} from '../outputStyleManager.js';

describe('outputStyleManager', () => {
  beforeEach(() => {
    setOutputStyle('standard');
    setOutputStyleChangeCallback(null);
  });

  // ========================================================================
  // 1. setOutputStyle / getOutputStyle round-trip
  // ========================================================================
  describe('setOutputStyle / getOutputStyle', () => {
    it('defaults to standard', () => {
      expect(getOutputStyle()).toBe('standard');
    });

    it.each<OutputStyle>(['concise', 'standard', 'detailed', 'code_only'])(
      'round-trips style: %s',
      (style) => {
        setOutputStyle(style);
        expect(getOutputStyle()).toBe(style);
      },
    );
  });

  // ========================================================================
  // 2. Change callback
  // ========================================================================
  describe('change callback', () => {
    it('fires callback on style change', () => {
      const cb = vi.fn();
      setOutputStyleChangeCallback(cb);
      setOutputStyle('concise');
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith('concise');
    });

    it('does not fire after callback removed', () => {
      const cb = vi.fn();
      setOutputStyleChangeCallback(cb);
      setOutputStyleChangeCallback(null);
      setOutputStyle('detailed');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // 3. getStylePromptAppend
  // ========================================================================
  describe('getStylePromptAppend', () => {
    it('returns empty string for standard', () => {
      expect(getStylePromptAppend('standard')).toBe('');
    });

    it('returns non-empty string for concise', () => {
      const append = getStylePromptAppend('concise');
      expect(append.length).toBeGreaterThan(0);
      expect(append).toContain('CONCISE');
    });

    it('returns non-empty string for detailed', () => {
      const append = getStylePromptAppend('detailed');
      expect(append.length).toBeGreaterThan(0);
      expect(append).toContain('DETAILED');
    });

    it('returns non-empty string for code_only', () => {
      const append = getStylePromptAppend('code_only');
      expect(append.length).toBeGreaterThan(0);
      expect(append).toContain('CODE ONLY');
    });

    it('uses current style when no argument', () => {
      setOutputStyle('detailed');
      const append = getStylePromptAppend();
      expect(append).toContain('DETAILED');
    });
  });

  // ========================================================================
  // 4. getStyleConfig
  // ========================================================================
  describe('getStyleConfig', () => {
    it('concise has correct label and icon', () => {
      const config = getStyleConfig('concise');
      expect(config.label).toBe('Concise');
      expect(config.icon).toBeTruthy();
      expect(config.description).toBeTruthy();
      expect(config.promptAppend).toBeTruthy();
    });

    it('standard has correct label and empty prompt', () => {
      const config = getStyleConfig('standard');
      expect(config.label).toBe('Standard');
      expect(config.promptAppend).toBe('');
    });

    it('detailed has correct label', () => {
      const config = getStyleConfig('detailed');
      expect(config.label).toBe('Detailed');
    });

    it('code_only has correct label', () => {
      const config = getStyleConfig('code_only');
      expect(config.label).toBe('Code Only');
    });

    it('uses current style when no argument', () => {
      setOutputStyle('code_only');
      const config = getStyleConfig();
      expect(config.label).toBe('Code Only');
    });
  });

  // ========================================================================
  // 5. getStyleInfo
  // ========================================================================
  describe('getStyleInfo', () => {
    it('returns icon, label, color for each style', () => {
      const styles: OutputStyle[] = ['concise', 'standard', 'detailed', 'code_only'];
      const expectedColors = ['yellow', 'cyan', 'green', 'magenta'];

      for (let i = 0; i < styles.length; i++) {
        const info = getStyleInfo(styles[i]);
        expect(info.icon).toBeTruthy();
        expect(info.label).toBeTruthy();
        expect(info.color).toBe(expectedColors[i]);
      }
    });

    it('uses current style when no argument', () => {
      setOutputStyle('concise');
      expect(getStyleInfo().label).toBe('Concise');
    });
  });

  // ========================================================================
  // 6. OUTPUT_STYLE_LIST
  // ========================================================================
  describe('OUTPUT_STYLE_LIST', () => {
    it('has exactly 4 styles', () => {
      expect(OUTPUT_STYLE_LIST).toHaveLength(4);
    });

    it('contains all expected styles', () => {
      expect(OUTPUT_STYLE_LIST).toContain('concise');
      expect(OUTPUT_STYLE_LIST).toContain('standard');
      expect(OUTPUT_STYLE_LIST).toContain('detailed');
      expect(OUTPUT_STYLE_LIST).toContain('code_only');
    });
  });

  // ========================================================================
  // 7. getAllStyles
  // ========================================================================
  describe('getAllStyles', () => {
    it('returns array of all styles', () => {
      const styles = getAllStyles();
      expect(styles).toHaveLength(4);
      expect(styles).toEqual(OUTPUT_STYLE_LIST);
    });
  });
});
