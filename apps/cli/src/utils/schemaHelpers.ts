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
import { L } from '../i18n/index.js';

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
    description: L('示例：任务总结 Schema，可作为自定义 Schema 的起点', 'Example: task summary schema, a starting point for custom schemas'),
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['ok', 'needs_attention', 'error'],
          description: L('本次任务的最终状态', 'Final status of this task'),
        },
        summary: {
          type: 'string',
          description: L('对任务的简要总结，1-3 句话', 'Brief summary of the task, 1-3 sentences'),
        },
        steps: {
          type: 'array',
          description: L('执行步骤列表', 'List of execution steps'),
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
          description: L('需要跟进的动作', 'Follow-up actions needed'),
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
    cliPrintln(colors.success(L(`[v] 示例 Schema 已生成: ${outPath}`, `[v] Example schema generated: ${outPath}`)));
    cliPrintln(colors.dim(L('使用方式:', 'Usage:')));
    cliPrintln(colors.dim(L(`  1. 根据需要修改字段/描述`, `  1. Edit fields and descriptions as needed`)));
    cliPrintln(colors.dim(L(`  2. 启动 CLI: neox --output-schema ${targetPath || defaultName}`, `  2. Start the CLI: neox --output-schema ${targetPath || defaultName}`)));
    cliPrintln(colors.dim(L(`  3. CLI 会强制输出符合该 Schema 的 JSON`, `  3. The CLI will force output to match this schema as JSON`)));
    cliPrintln('');
    cliPrintln(colors.highlight(L('示例结构 (摘录):', 'Example structure (excerpt):')));
    cliPrintln(colors.dim(JSON.stringify(example.schema, null, 2)));
  } catch (error: any) {
    cliPrintln(colors.error(L(`[x] 生成示例 Schema 失败: ${error.message}`, `[x] Failed to generate example schema: ${error.message}`)));
  }
}
