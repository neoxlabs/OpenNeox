/**
 * Schema Helpers
 * Utility functions for structured output schema handling
 */

import * as fs from 'fs';
import * as path from 'path';
import type { StructuredOutputDefinition } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { colors } from '../constants.js';
import { cliPrintln } from '../utils/output.js';

/**
 * Normalize structured output schema from loaded data
 */
export function normalizeStructuredOutputSchema(
  data: any,
  filePath: string
): StructuredOutputDefinition {
  const fallbackName = path.basename(filePath, path.extname(filePath)) || 'structured_output';
  if (data && typeof data === 'object' && data.schema && typeof data.schema === 'object') {
    return {
      name: data.name || fallbackName,
      description: data.description,
      schema: data.schema,
      strict: data.strict ?? true,
    };
  }

  return {
    name: data?.title || fallbackName,
    schema: data || {},
    strict: true,
  };
}

/**
 * Load structured output definition from file
 */
export function loadStructuredOutputDefinition(
  schemaPath?: string
): StructuredOutputDefinition | undefined {
  const candidate = schemaPath || process.env.CD_OUTPUT_SCHEMA || process.env.NEOX_OUTPUT_SCHEMA;
  if (!candidate) {
    return undefined;
  }

  const resolved = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(process.cwd(), candidate);

  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    const definition = normalizeStructuredOutputSchema(parsed, resolved);
    cliLogger.info('SCHEMA', `Structured output schema loaded: ${definition.name}`);
    return definition;
  } catch (error: any) {
    cliLogger.error('SCHEMA', `Failed to load structured output schema from ${candidate}: ${error.message}`);
    throw error;
  }
}

/**
 * Generate example schema file
 */
export async function handleSchemaExampleCommand(
  workDir: string,
  targetPath?: string
): Promise<void> {
  const defaultName = 'structured-output-example.schema.json';
  const outPath = path.resolve(workDir, targetPath || defaultName);
  const example = {
    name: 'TaskSummary',
    description: '示例：任务总结 Schema，可作为自定义 Schema 的起点',
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ok', 'needs_attention', 'error'],
          description: '本次任务的最终状态',
        },
        summary: {
          type: 'string',
          description: '对任务的简要总结，1-3 句话',
        },
        steps: {
          type: 'array',
          description: '执行步骤列表',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              result: { type: 'string' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
        next_actions: {
          type: 'array',
          description: '需要跟进的动作',
          items: { type: 'string' },
        },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    },
    strict: true,
  };

  try {
    await fs.promises.writeFile(outPath, JSON.stringify(example, null, 2), 'utf-8');
    cliPrintln('');
    cliPrintln(colors.success(`[v] 示例 Schema 已生成: ${outPath}`));
    cliPrintln(colors.dim('使用方式:'));
    cliPrintln(colors.dim(`  1. 根据需要修改字段/描述`));
    cliPrintln(colors.dim(`  2. 启动 CLI: neox --output-schema ${targetPath || defaultName}`));
    cliPrintln(colors.dim(`  3. CLI 会强制输出符合该 Schema 的 JSON`));
    cliPrintln('');
    cliPrintln(colors.highlight('示例结构 (摘录):'));
    cliPrintln(colors.dim(JSON.stringify(example.schema, null, 2)));
  } catch (error: any) {
    cliPrintln(colors.error(`[x] 生成示例 Schema 失败: ${error.message}`));
  }
}
