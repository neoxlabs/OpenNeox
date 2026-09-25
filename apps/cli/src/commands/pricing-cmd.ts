/**
 * Pricing Command Handlers
 * 模型定价配置管理
 */

import type { SelectionChoice } from '../cliTypes.js';
import { saveConfig, type ModelPricingConfig, type NeoxConfig } from '@neoxlabs/platform/utils/config.js';
import { t } from '../i18n/index.js';

export interface PricingCommandContext {
  userConfig: NeoxConfig;
  promptSelect: (
    question: string,
    choices: SelectionChoice[],
    defaultValue?: string,
    hint?: string
  ) => Promise<string>;
  promptInput: (
    prompt: string,
    defaultValue?: string
  ) => Promise<string>;
  logInfo: (message: string, details?: string) => void;
  updateConfig: (config: NeoxConfig) => void;
}

/**
 * 获取定价配置列表
 */
function getPricingList(config: NeoxConfig): ModelPricingConfig[] {
  return config.modelPricing || [];
}

/**
 * 格式化定价显示
 */
function formatPricing(p: ModelPricingConfig): string {
  const cached = p.cachedInputPrice !== undefined ? ` / cached: $${p.cachedInputPrice}` : '';
  return `${p.pattern}: in $${p.inputPrice} / out $${p.outputPrice}${cached}`;
}

/**
 * 查看定价配置
 */
async function viewPricing(ctx: PricingCommandContext): Promise<void> {
  const pricingList = getPricingList(ctx.userConfig);

  if (pricingList.length === 0) {
    ctx.logInfo(t().pricing.noPricing, t().pricing.noPricingHint);
    return;
  }

  const lines: string[] = [
    '',
    `${t().pricing.title}`,
    '',
  ];

  for (const p of pricingList) {
    lines.push(`  • ${p.pattern}`);
    lines.push(`    Input:  $${p.inputPrice} ${t().pricing.perMillionTokens}`);
    lines.push(`    Output: $${p.outputPrice} ${t().pricing.perMillionTokens}`);
    if (p.cachedInputPrice !== undefined) {
      lines.push(`    Cached: $${p.cachedInputPrice} ${t().pricing.perMillionTokens}`);
    }
    lines.push('');
  }

  ctx.logInfo(lines.join('\n'));
}

/**
 * 添加定价配置
 */
async function addPricing(ctx: PricingCommandContext): Promise<void> {
  try {
    // 输入模型名称/模式
    const pattern = await ctx.promptInput(
      `${t().pricing.modelPattern} (${t().pricing.modelPatternHint})`,
      ''
    );
    if (!pattern.trim()) {
      return;
    }

    // 输入价格
    const inputPriceStr = await ctx.promptInput(t().pricing.inputPrice, '');
    const inputPrice = parseFloat(inputPriceStr);
    if (isNaN(inputPrice) || inputPrice < 0) {
      ctx.logInfo(t().pricing.invalidNumber);
      return;
    }

    // 输出价格
    const outputPriceStr = await ctx.promptInput(t().pricing.outputPrice, '');
    const outputPrice = parseFloat(outputPriceStr);
    if (isNaN(outputPrice) || outputPrice < 0) {
      ctx.logInfo(t().pricing.invalidNumber);
      return;
    }

    // 缓存价格 (可选)
    const cachedPriceStr = await ctx.promptInput(t().pricing.cachedPrice + ' ' + t().pricing.cachedPriceHint, '');
    let cachedInputPrice: number | undefined;
    if (cachedPriceStr.trim()) {
      cachedInputPrice = parseFloat(cachedPriceStr);
      if (isNaN(cachedInputPrice) || cachedInputPrice < 0) {
        ctx.logInfo(t().pricing.invalidNumber);
        return;
      }
    }

    // 保存配置
    const pricingList = getPricingList(ctx.userConfig);
    const newPricing: ModelPricingConfig = {
      pattern: pattern.trim(),
      inputPrice,
      outputPrice,
      cachedInputPrice,
      currency: 'USD',
    };

    // 检查是否已存在相同 pattern
    const existingIndex = pricingList.findIndex(p => p.pattern === pattern.trim());
    if (existingIndex >= 0) {
      pricingList[existingIndex] = newPricing;
    } else {
      pricingList.push(newPricing);
    }

    const updatedConfig: NeoxConfig = {
      ...ctx.userConfig,
      modelPricing: pricingList,
    };
    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);

    ctx.logInfo(t().pricing.pricingAdded, formatPricing(newPricing));
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('Error', error?.message);
    }
  }
}

/**
 * 编辑定价配置
 */
async function editPricing(ctx: PricingCommandContext): Promise<void> {
  const pricingList = getPricingList(ctx.userConfig);

  if (pricingList.length === 0) {
    ctx.logInfo(t().pricing.noPricing, t().pricing.noPricingHint);
    return;
  }

  try {
    // 选择要编辑的定价
    const choices: SelectionChoice[] = pricingList.map(p => ({
      label: p.pattern,
      value: p.pattern,
      description: `in: $${p.inputPrice} / out: $${p.outputPrice}`,
    }));
    choices.push({
      label: t().pricing.back,
      value: '__back__',
    });

    const selected = await ctx.promptSelect(
      t().pricing.selectToEdit,
      choices
    );

    if (selected === '__back__') {
      return;
    }

    const pricing = pricingList.find(p => p.pattern === selected);
    if (!pricing) {
      return;
    }

    // 编辑价格
    const inputPriceStr = await ctx.promptInput(
      t().pricing.inputPrice,
      pricing.inputPrice.toString()
    );
    const inputPrice = parseFloat(inputPriceStr);
    if (isNaN(inputPrice) || inputPrice < 0) {
      ctx.logInfo(t().pricing.invalidNumber);
      return;
    }

    const outputPriceStr = await ctx.promptInput(
      t().pricing.outputPrice,
      pricing.outputPrice.toString()
    );
    const outputPrice = parseFloat(outputPriceStr);
    if (isNaN(outputPrice) || outputPrice < 0) {
      ctx.logInfo(t().pricing.invalidNumber);
      return;
    }

    const cachedPriceStr = await ctx.promptInput(
      t().pricing.cachedPrice,
      pricing.cachedInputPrice?.toString() || ''
    );
    let cachedInputPrice: number | undefined;
    if (cachedPriceStr.trim()) {
      cachedInputPrice = parseFloat(cachedPriceStr);
      if (isNaN(cachedInputPrice) || cachedInputPrice < 0) {
        ctx.logInfo(t().pricing.invalidNumber);
        return;
      }
    }

    // 更新配置
    pricing.inputPrice = inputPrice;
    pricing.outputPrice = outputPrice;
    pricing.cachedInputPrice = cachedInputPrice;

    const updatedConfig: NeoxConfig = {
      ...ctx.userConfig,
      modelPricing: pricingList,
    };
    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);

    ctx.logInfo(t().pricing.pricingUpdated, formatPricing(pricing));
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('Error', error?.message);
    }
  }
}

/**
 * 删除定价配置
 */
async function deletePricing(ctx: PricingCommandContext): Promise<void> {
  const pricingList = getPricingList(ctx.userConfig);

  if (pricingList.length === 0) {
    ctx.logInfo(t().pricing.noPricing);
    return;
  }

  try {
    // 选择要删除的定价
    const choices: SelectionChoice[] = pricingList.map(p => ({
      label: p.pattern,
      value: p.pattern,
      description: `in: $${p.inputPrice} / out: $${p.outputPrice}`,
    }));
    choices.push({
      label: t().pricing.back,
      value: '__back__',
    });

    const selected = await ctx.promptSelect(
      t().pricing.selectToDelete,
      choices
    );

    if (selected === '__back__') {
      return;
    }

    // 确认删除
    const confirm = await ctx.promptSelect(
      t().pricing.confirmDelete,
      [
        { label: t().common.yes, value: 'yes' },
        { label: t().common.no, value: 'no' },
      ],
      'no'
    );

    if (confirm !== 'yes') {
      return;
    }

    // 删除
    const newList = pricingList.filter(p => p.pattern !== selected);
    const updatedConfig: NeoxConfig = {
      ...ctx.userConfig,
      modelPricing: newList,
    };
    ctx.updateConfig(updatedConfig);
    saveConfig(updatedConfig);

    ctx.logInfo(t().pricing.pricingDeleted, selected);
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('Error', error?.message);
    }
  }
}

/**
 * Handle /cost command - 模型定价配置
 */
export async function handlePricingCommand(
  ctx: PricingCommandContext,
  actionArg?: string
): Promise<void> {
  // 直接指定了操作
  if (actionArg) {
    switch (actionArg.toLowerCase()) {
      case 'view':
      case 'list':
        await viewPricing(ctx);
        return;
      case 'add':
        await addPricing(ctx);
        return;
      case 'edit':
        await editPricing(ctx);
        return;
      case 'delete':
      case 'remove':
        await deletePricing(ctx);
        return;
    }
  }

  // 交互式菜单
  try {
    const action = await ctx.promptSelect(
      t().pricing.title,
      [
        {
          label: t().pricing.viewPricing,
          value: 'view',
          description: t().pricing.viewPricingDesc,
        },
        {
          label: t().pricing.addPricing,
          value: 'add',
          description: t().pricing.addPricingDesc,
        },
        {
          label: t().pricing.editPricing,
          value: 'edit',
          description: t().pricing.editPricingDesc,
        },
        {
          label: t().pricing.deletePricing,
          value: 'delete',
          description: t().pricing.deletePricingDesc,
        },
        {
          label: t().pricing.back,
          value: 'back',
        },
      ],
      'view',
      t().pricing.hint
    );

    if (action === 'back') {
      return;
    }

    switch (action) {
      case 'view':
        await viewPricing(ctx);
        break;
      case 'add':
        await addPricing(ctx);
        break;
      case 'edit':
        await editPricing(ctx);
        break;
      case 'delete':
        await deletePricing(ctx);
        break;
    }
  } catch (error: any) {
    if (error?.message !== 'cancelled') {
      ctx.logInfo('Selection cancelled', error?.message);
    }
  }
}

/**
 * 根据模型名称查找匹配的定价配置
 */
export function findPricingForModel(
  config: NeoxConfig,
  modelId: string
): ModelPricingConfig | null {
  const pricingList = config.modelPricing || [];

  // 先精确匹配
  const exact = pricingList.find(p => p.pattern === modelId);
  if (exact) {
    return exact;
  }

  // 通配符匹配
  for (const pricing of pricingList) {
    if (pricing.pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pricing.pattern.replace(/\*/g, '.*') + '$'
      );
      if (regex.test(modelId)) {
        return pricing;
      }
    }
  }

  return null;
}

/**
 * 计算费用
 */
export function calculateCost(
  pricing: ModelPricingConfig,
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPrice;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPrice;
  let cachedCost = 0;
  if (cachedTokens && pricing.cachedInputPrice !== undefined) {
    cachedCost = (cachedTokens / 1_000_000) * pricing.cachedInputPrice;
  }
  return inputCost + outputCost + cachedCost;
}
