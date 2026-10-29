/**
 * Tests for Neox Native Patch Engine
 *
 * Covers:
 * - Format detection
 * - Codex patch parsing
 * - Unified diff parsing
 * - Fuzzy hunk application (all 5 levels)
 * - Multi-file patches
 * - Edge cases
 */

import { describe, it, expect } from 'vitest';
import { detectPatchFormat } from '../files/patch/formatDetector.js';
import { parseCodexPatch } from '../files/patch/codexPatchParser.js';
import { parseUnifiedDiff } from '../files/patch/unifiedDiffParser.js';
import { applyHunksToContent } from '../files/patch/fuzzyApplicator.js';
import { validatePatch } from '../files/patch/validator.js';
import { FuzzLevel } from '../files/patch/types.js';
import type { PatchHunk } from '../files/patch/types.js';

// ============================================================================
// Format Detection
// ============================================================================

describe('detectPatchFormat', () => {
  it('detects Codex format with *** Begin Patch', () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ function greet() {
-  console.log("Hi");
+  console.log("Hello");
*** End Patch`;
    expect(detectPatchFormat(patch)).toBe('codex');
  });

  it('detects Codex format without Begin/End markers', () => {
    const patch = `*** Update File: src/app.ts
@@ function greet() {
-  console.log("Hi");
+  console.log("Hello");`;
    expect(detectPatchFormat(patch)).toBe('codex');
  });

  it('detects unified diff format', () => {
    const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 function greet() {
-  console.log("Hi");
+  console.log("Hello");
 }`;
    expect(detectPatchFormat(patch)).toBe('unified');
  });

  it('detects unified diff with git header', () => {
    const patch = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 function greet() {
-  console.log("Hi");
+  console.log("Hello");
 }`;
    expect(detectPatchFormat(patch)).toBe('unified');
  });

  it('returns unknown for random text', () => {
    expect(detectPatchFormat('hello world')).toBe('unknown');
    expect(detectPatchFormat('')).toBe('unknown');
  });
});

// ============================================================================
// Codex Patch Parser
// ============================================================================

describe('parseCodexPatch', () => {
  it('parses Add File', () => {
    const patch = `*** Begin Patch
*** Add File: src/newfile.ts
+export function hello() {
+  return "Hello";
+}
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.format).toBe('codex');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('add');
    expect(result.files[0].filePath).toBe('src/newfile.ts');
    expect(result.files[0].newContent).toBe('export function hello() {\n  return "Hello";\n}');
  });

  it('parses Update File with @@ anchors', () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ function greet() {
-  console.log("Hi");
+  console.log("Hello, world!");
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('update');
    expect(result.files[0].hunks).toHaveLength(1);

    const hunk = result.files[0].hunks[0];
    expect(hunk.contextLines).toEqual(['function greet() {']);
    expect(hunk.removeLines).toEqual(['  console.log("Hi");']);
    expect(hunk.addLines).toEqual(['  console.log("Hello, world!");']);
  });

  it('parses Delete File', () => {
    const patch = `*** Begin Patch
*** Delete File: src/obsolete.ts
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('delete');
    expect(result.files[0].filePath).toBe('src/obsolete.ts');
  });

  it('parses multi-file patch', () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
*** Update File: src/existing.ts
@@ import { old } from './old';
-import { old } from './old';
+import { x } from './new';
*** Delete File: src/old.ts
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.files).toHaveLength(3);
    expect(result.files[0].action).toBe('add');
    expect(result.files[1].action).toBe('update');
    expect(result.files[2].action).toBe('delete');
  });

  it('parses Move to directive', () => {
    const patch = `*** Begin Patch
*** Update File: src/old-name.ts
*** Move to: src/new-name.ts
@@ export function foo()
-  return 1;
+  return 2;
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.files[0].moveTo).toBe('src/new-name.ts');
  });

  it('parses multiple hunks in same file', () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ function greet() {
-  console.log("Hi");
+  console.log("Hello");
@@ function farewell() {
-  console.log("Bye");
+  console.log("Goodbye");
*** End Patch`;

    const result = parseCodexPatch(patch);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].hunks[0].contextLines).toEqual(['function greet() {']);
    expect(result.files[0].hunks[1].contextLines).toEqual(['function farewell() {']);
  });

  it('handles patches without Begin/End markers', () => {
    const patch = `*** Update File: src/app.ts
@@ const x = 1;
-const x = 1;
+const x = 2;`;

    const result = parseCodexPatch(patch);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].hunks[0].removeLines).toEqual(['const x = 1;']);
    expect(result.files[0].hunks[0].addLines).toEqual(['const x = 2;']);
  });
});

// ============================================================================
// Unified Diff Parser
// ============================================================================

describe('parseUnifiedDiff', () => {
  it('parses basic unified diff', () => {
    const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 function greet() {
-  console.log("Hi");
+  console.log("Hello");
 }`;

    const result = parseUnifiedDiff(patch);
    expect(result.format).toBe('unified');
    expect(result.files).toHaveLength(1);
    expect(result.files[0].action).toBe('update');
    expect(result.files[0].filePath).toBe('src/app.ts');
    expect(result.files[0].hunks[0].originalLineHint).toBe(1);
  });

  it('detects new file from /dev/null', () => {
    const patch = `--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return "Hello";
+}`;

    const result = parseUnifiedDiff(patch);
    expect(result.files[0].action).toBe('add');
    expect(result.files[0].filePath).toBe('src/new.ts');
  });

  it('detects deleted file with /dev/null', () => {
    const patch = `--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export function hello() {
-  return "Hello";
-}`;

    const result = parseUnifiedDiff(patch);
    expect(result.files[0].action).toBe('delete');
    expect(result.files[0].filePath).toBe('src/old.ts');
  });

  it('parses multiple files', () => {
    const patch = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,1 @@
-const b = 1;
+const b = 2;`;

    const result = parseUnifiedDiff(patch);
    expect(result.files).toHaveLength(2);
  });

  it('detects rename from different paths', () => {
    const patch = `--- a/src/old.ts
+++ b/src/new.ts
@@ -1,1 +1,1 @@
-old
+new`;

    const result = parseUnifiedDiff(patch);
    expect(result.files[0].action).toBe('update');
    expect(result.files[0].filePath).toBe('src/old.ts');
    expect(result.files[0].moveTo).toBe('src/new.ts');
  });
});

// ============================================================================
// Fuzzy Hunk Applicator
// ============================================================================

describe('applyHunksToContent', () => {
  it('applies exact match hunk', () => {
    const content = 'function greet() {\n  console.log("Hi");\n}\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['function greet() {'],
      removeLines: ['  console.log("Hi");'],
      addLines: ['  console.log("Hello, world!");'],
    }];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(results[0].fuzzLevel).toBe(FuzzLevel.EXACT);
    expect(newContent).toBe('function greet() {\n  console.log("Hello, world!");\n}\n');
  });

  it('handles trimEnd matching (L1)', () => {
    // File has trailing spaces, patch doesn't
    const content = 'function greet() {  \n  console.log("Hi");\n}\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['function greet() {'],
      removeLines: ['  console.log("Hi");'],
      addLines: ['  console.log("Hello");'],
    }];

    const { results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(results[0].fuzzLevel).toBe(FuzzLevel.TRIM_END);
  });

  it('handles trim matching (L2)', () => {
    // File has different indentation
    const content = '  function greet() {\n    console.log("Hi");\n  }\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['function greet() {'],
      removeLines: ['console.log("Hi");'],
      addLines: ['    console.log("Hello");'],
    }];

    const { results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(results[0].fuzzLevel).toBe(FuzzLevel.TRIM);
  });

  it('handles unicode normalize matching (L3)', () => {
    // File uses smart quotes, patch uses ASCII quotes
    const content = 'const msg = \u201CHello\u201D;\n';
    const hunks: PatchHunk[] = [{
      contextLines: [],
      removeLines: ['const msg = "Hello";'],
      addLines: ['const msg = "World";'],
    }];

    const { results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(results[0].fuzzLevel).toBe(FuzzLevel.NORMALIZE);
  });

  it('applies multiple hunks in correct order', () => {
    const content = [
      'function a() {',
      '  return 1;',
      '}',
      '',
      'function b() {',
      '  return 2;',
      '}',
      '',
    ].join('\n');

    const hunks: PatchHunk[] = [
      {
        contextLines: ['function a() {'],
        removeLines: ['  return 1;'],
        addLines: ['  return 10;'],
      },
      {
        contextLines: ['function b() {'],
        removeLines: ['  return 2;'],
        addLines: ['  return 20;'],
      },
    ];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results.every(r => r.success)).toBe(true);
    expect(newContent).toContain('return 10;');
    expect(newContent).toContain('return 20;');
  });

  it('handles pure insertion (no remove lines)', () => {
    const content = 'line 1\nline 2\nline 3\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['line 2'],
      removeLines: [],
      addLines: ['inserted line'],
    }];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(newContent).toContain('line 2\ninserted line\nline 3');
  });

  it('handles pure deletion (no add lines)', () => {
    const content = 'line 1\nline to delete\nline 3\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['line 1'],
      removeLines: ['line to delete'],
      addLines: [],
    }];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(newContent).toBe('line 1\nline 3\n');
  });

  it('returns error for unfound hunk', () => {
    const content = 'function greet() {\n  console.log("Hi");\n}\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['function nonexistent() {'],
      removeLines: ['  xxx();'],
      addLines: ['  yyy();'],
    }];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Hunk not found');
    // Original content unchanged
    expect(newContent).toBe(content);
  });

  it('preserves Windows line endings', () => {
    const content = 'line 1\r\nline 2\r\nline 3\r\n';
    const hunks: PatchHunk[] = [{
      contextLines: ['line 1'],
      removeLines: ['line 2'],
      addLines: ['replaced line'],
    }];

    const { newContent } = applyHunksToContent(content, hunks);
    expect(newContent).toBe('line 1\r\nreplaced line\r\nline 3\r\n');
  });

  it('handles empty file', () => {
    const content = '';
    const hunks: PatchHunk[] = [{
      contextLines: [],
      removeLines: [],
      addLines: ['new content'],
    }];

    const { newContent, results } = applyHunksToContent(content, hunks);
    expect(results[0].success).toBe(true);
    expect(newContent).toContain('new content');
  });
});

// ============================================================================
// Validator
// ============================================================================

describe('validatePatch', () => {
  it('passes valid patch', () => {
    const result = validatePatch(
      {
        format: 'codex',
        files: [{
          action: 'update',
          filePath: 'src/app.ts',
          hunks: [{
            contextLines: ['test'],
            removeLines: ['old'],
            addLines: ['new'],
          }],
        }],
      },
      '/workspace',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects absolute paths', () => {
    const result = validatePatch(
      {
        format: 'codex',
        files: [{
          action: 'update',
          filePath: '/etc/passwd',
          hunks: [{
            contextLines: [],
            removeLines: ['old'],
            addLines: ['new'],
          }],
        }],
      },
      '/workspace',
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Absolute paths');
  });

  it('rejects path traversal', () => {
    const result = validatePatch(
      {
        format: 'codex',
        files: [{
          action: 'update',
          filePath: '../../../etc/passwd',
          hunks: [{
            contextLines: [],
            removeLines: ['old'],
            addLines: ['new'],
          }],
        }],
      },
      '/workspace',
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Path traversal');
  });

  it('rejects empty patch', () => {
    const result = validatePatch(
      { format: 'codex', files: [] },
      '/workspace',
    );
    expect(result.valid).toBe(false);
  });

  it('strips a/ b/ prefixes from paths', () => {
    const result = validatePatch(
      {
        format: 'unified',
        files: [{
          action: 'update',
          filePath: 'a/src/app.ts',
          hunks: [{
            contextLines: ['test'],
            removeLines: ['old'],
            addLines: ['new'],
          }],
        }],
      },
      '/workspace',
    );
    expect(result.valid).toBe(true);
    expect(result.normalized[0].filePath).toBe('src/app.ts');
  });
});

// ============================================================================
// Integration: Parse + Apply
// ============================================================================

describe('Integration: Codex parse + apply', () => {
  it('full roundtrip: parse Codex patch and apply to content', () => {
    const patch = `*** Begin Patch
*** Update File: src/app.ts
@@ function greet() {
-  console.log("Hi");
+  console.log("Hello, world!");
*** End Patch`;

    const fileContent = [
      'import { foo } from "./foo";',
      '',
      'function greet() {',
      '  console.log("Hi");',
      '}',
      '',
      'greet();',
      '',
    ].join('\n');

    const parsed = parseCodexPatch(patch);
    expect(parsed.files).toHaveLength(1);

    const hunk = parsed.files[0].hunks[0];
    const { newContent, results } = applyHunksToContent(fileContent, [hunk]);

    expect(results[0].success).toBe(true);
    expect(newContent).toContain('console.log("Hello, world!");');
    expect(newContent).not.toContain('console.log("Hi");');
    // Unchanged parts preserved
    expect(newContent).toContain('import { foo }');
    expect(newContent).toContain('greet();');
  });

  it('full roundtrip: multi-hunk Codex patch', () => {
    const patch = `*** Begin Patch
*** Update File: src/math.ts
@@ export function add(a: number, b: number) {
-  return a + b;
+  return a + b; // addition
@@ export function sub(a: number, b: number) {
-  return a - b;
+  return a - b; // subtraction
*** End Patch`;

    const fileContent = [
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
      '',
      'export function sub(a: number, b: number) {',
      '  return a - b;',
      '}',
      '',
    ].join('\n');

    const parsed = parseCodexPatch(patch);
    const { newContent, results } = applyHunksToContent(fileContent, parsed.files[0].hunks);

    expect(results.every(r => r.success)).toBe(true);
    expect(newContent).toContain('return a + b; // addition');
    expect(newContent).toContain('return a - b; // subtraction');
  });
});

describe('Integration: Unified diff parse + apply', () => {
  it('full roundtrip: parse unified diff and apply', () => {
    const patch = `--- a/src/app.ts
+++ b/src/app.ts
@@ -3,3 +3,3 @@ imports
 function greet() {
-  console.log("Hi");
+  console.log("Hello");
 }`;

    const fileContent = [
      'import { foo } from "./foo";',
      '',
      'function greet() {',
      '  console.log("Hi");',
      '}',
      '',
    ].join('\n');

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.files).toHaveLength(1);

    const { newContent, results } = applyHunksToContent(fileContent, parsed.files[0].hunks);
    expect(results[0].success).toBe(true);
    expect(newContent).toContain('console.log("Hello")');
  });
});
