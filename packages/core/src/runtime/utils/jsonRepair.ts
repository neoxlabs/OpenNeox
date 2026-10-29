/**
 * JSON Repair Utilities
 * Functions for attempting to repair invalid/truncated JSON strings
 */

import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

/**
 * Attempt to repair invalid JSON
 * Returns repaired JSON string or null if unable to repair
 */
export function isSyntacticallyComplete(jsonStr: string): boolean {
  try { JSON.parse(jsonStr); return true; } catch { return false; }
}

export function attemptJsonRepair(jsonStr: string): string | null {
  if (!jsonStr || jsonStr.trim().length === 0) {
    return null;
  }

  let fixed = jsonStr.trim();

  // 1. Try adding missing closing brace
  if (!fixed.endsWith('}')) {
    const testFixed = fixed + '}';
    try {
      JSON.parse(testFixed);
      cliLogger.debug('JsonRepair', '[JsonRepair] Fixed by adding closing }');
      return testFixed;
    } catch {
      // Continue trying
    }
  }

  // 2. Try removing trailing comma
  const noTrailingComma = fixed.replace(/,\s*$/, '');
  if (!noTrailingComma.endsWith('}')) {
    const testFixed = noTrailingComma + '}';
    try {
      JSON.parse(testFixed);
      cliLogger.debug('JsonRepair', '[JsonRepair] Fixed by removing trailing comma and adding }');
      return testFixed;
    } catch {
      // Continue trying
    }
  }

  // 3. Try to close unclosed string and object
  const lastQuote = fixed.lastIndexOf('"');
  if (lastQuote > 0) {
    // Check if string is unclosed
    let quoteCount = 0;
    let escaped = false;
    for (let i = 0; i < fixed.length; i++) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (fixed[i] === '\\') {
        escaped = true;
        continue;
      }
      if (fixed[i] === '"') {
        quoteCount++;
      }
    }

    // Odd number of quotes means unclosed string
    if (quoteCount % 2 === 1) {
      const testFixed = fixed + '"}';
      try {
        JSON.parse(testFixed);
        cliLogger.debug('JsonRepair', '[JsonRepair] Fixed by closing unclosed string');
        return testFixed;
      } catch {
        // Try more aggressive repair
      }
    }
  }

  // 4. Force close all open structures
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;

  for (const char of fixed) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }

  // If in string, close it
  if (inString) {
    fixed += '"';
  }

  // Close all unclosed structures
  while (bracketCount > 0) {
    fixed += ']';
    bracketCount--;
  }
  while (braceCount > 0) {
    fixed += '}';
    braceCount--;
  }

  try {
    JSON.parse(fixed);
    cliLogger.debug('JsonRepair', '[JsonRepair] Fixed by force-closing structures');
    return fixed;
  } catch {
    // All repair attempts failed
    return null;
  }
}

/**
 * Truncation detection result
 */
export interface TruncationResult {
  isTruncated: boolean;
  reason?: string;
}

/**
 * Detect if tool arguments are truncated
 */
export function detectTruncation(toolName: string, args: string): TruncationResult {
  if (!args || args.trim().length === 0) {
    return { isTruncated: false };
  }

  const trimmed = args.trim();

  // Check for incomplete JSON (doesn't end with })
  if (!trimmed.endsWith('}')) {
    return {
      isTruncated: true,
      reason: 'JSON structure incomplete - missing closing brace',
    };
  }

  // Check for missing required fields in file operations
  const normalizedTool = (toolName || '').toLowerCase();
  const isWriteTool = normalizedTool === 'write_file' || normalizedTool === 'write';
  const isEditTool = normalizedTool === 'edit_file' || normalizedTool === 'edit' || normalizedTool === 'str_replace_editor';

  if (isWriteTool) {
    if (!args.includes('"content"')) {
      return {
        isTruncated: true,
        reason: 'File content field is missing - likely truncated during streaming',
      };
    }

    // Check for truncated content field (ends abruptly)
    const contentMatch = args.match(/"content"\s*:\s*"([^]*)/);
    if (contentMatch) {
      const afterContent = contentMatch[1];
      // Count quotes to see if content string is closed
      let quoteCount = 0;
      let escaped = false;
      for (const char of afterContent) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          quoteCount++;
          break; // Found closing quote
        }
      }
      if (quoteCount === 0) {
        return {
          isTruncated: true,
          reason: 'Content string is unclosed - truncated during streaming',
        };
      }
    }
  }

  if (isEditTool) {
    const hasSingleEditPair = args.includes('"old_string"') && args.includes('"new_string"');
    const hasHunkEditPair = args.includes('"hunks"') && args.includes('"new_string"');
    const hasInsertPair = (args.includes('"insert_after"') || args.includes('"insert_before"')) && args.includes('"new_string"');
    if (!hasSingleEditPair && !hasHunkEditPair && !hasInsertPair) {
      return {
        isTruncated: true,
        reason: 'edit payload missing new_string/hunks - likely truncated during streaming',
      };
    }
  }

  return { isTruncated: false };
}
