/**
 * Tool wrappers - Convert CodeInterpreter to Neox Tool format
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { createContextualResult } from '@neoxlabs/kernel/core/types/toolResult.js';
import { CodeInterpreter, executeCode } from './code-interpreter.js';
import type { CodeExecutionConfig, CodeExecutionResult, SupportedLanguage } from './types.js';

function formatOrPrecondition(tool: string, language: string, result: CodeExecutionResult): string {
  if (result.runtimeMissing) {
    return JSON.stringify(createContextualResult(
      tool,
      'error',
      `No ${language} runtime on this machine`,
      result.error,
      { error: 'runtime_not_installed', precondition: true, metadata: { language } },
    ));
  }
  return CodeInterpreter.formatResult(result);
}

/**
 * Create a code interpreter tool with custom configuration
 */
export function createCodeInterpreterTool(config?: CodeExecutionConfig): Tool {
  const interpreter = new CodeInterpreter(config);

  return {
    name: 'execute_code',
    description: `Execute code in multiple languages (Python, JavaScript, TypeScript, Bash/Shell).
Supports data analysis, calculations, file operations, and more.
Can capture generated images (matplotlib plots, etc.) if configured.

Configuration:
- Timeout: ${config?.timeout || 30000}ms
- Network access: ${config?.allowNetwork !== false ? 'Enabled' : 'Disabled'}
- File system access: ${config?.allowFileSystem !== false ? 'Enabled' : 'Disabled'}
- Image capture: ${config?.captureImages ? 'Enabled' : 'Disabled'}`,

    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code to execute',
        },
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'typescript', 'bash', 'shell'],
          description: 'Programming language to use',
        },
      },
      required: ['code', 'language'],
    },

    async function({ code, language }: { code: string; language: SupportedLanguage }) {
      const result = await interpreter.execute(code, language);
      return formatOrPrecondition('execute_code', language, result);
    },
  };
}

/**
 * Python-specific code interpreter
 */
export const executePython: Tool = {
  name: 'execute_python',
  description: `Execute Python code for calculations, data analysis, and scripting.
Useful for: math calculations, data processing, file operations, web scraping, etc.
Libraries commonly available: numpy, pandas, matplotlib, requests, etc.`,

  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Python code to execute',
      },
      capture_images: {
        type: 'boolean',
        description: 'Capture matplotlib plots and other images',
      },
    },
    required: ['code'],
  },

  async function({ code, capture_images = false }: { code: string; capture_images?: boolean }) {
    const result = await executeCode(code, 'python', {
      captureImages: capture_images,
    });
    return formatOrPrecondition('execute_python', 'Python', result);
  },
};

/**
 * JavaScript/Node.js code interpreter
 */
export const executeJavaScript: Tool = {
  name: 'execute_javascript',
  description: `Execute JavaScript (Node.js) code for calculations, data processing, and scripting.
Useful for: JSON processing, string manipulation, async operations, etc.
Has access to Node.js built-in modules.`,

  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to execute',
      },
    },
    required: ['code'],
  },

  async function({ code }: { code: string }) {
    const result = await executeCode(code, 'javascript');
    return formatOrPrecondition('execute_javascript', 'Node.js', result);
  },
};

/**
 * Bash/Shell script interpreter
 */
export const executeBash: Tool = {
  name: 'execute_bash',
  description: `Execute Bash/Shell scripts for system operations and file management.
Useful for: file operations, text processing, system commands, git operations, etc.
Has full access to system commands and utilities.`,

  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Bash script to execute',
      },
    },
    required: ['code'],
  },

  async function({ code }: { code: string }) {
    const result = await executeCode(code, 'bash');
    return formatOrPrecondition('execute_bash', 'Bash', result);
  },
};

/**
 * Default code interpreter with standard configuration
 */
export const defaultCodeInterpreter = createCodeInterpreterTool({
  timeout: 30000,
  allowNetwork: true,
  allowFileSystem: true,
  captureImages: true,
  maxOutputSize: 10000,
});

/**
 * Restricted code interpreter (no network, limited file access)
 */
export const restrictedCodeInterpreter = createCodeInterpreterTool({
  timeout: 10000,
  allowNetwork: false,
  allowFileSystem: false,
  captureImages: false,
  maxOutputSize: 5000,
});
