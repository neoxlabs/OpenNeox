import React from 'react';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { ProviderBrandIcon, inferProviderBrand } from '../ProviderBrandIcon';
import { rowStepLegacyStep, type RowStep } from '../timelineRows';
import type { HistoryCellRow } from '../types';

/** 时间线里子 Agent 那一行: 返回它的模型 (空串 = 跟主 Agent 同款); 不是子 Agent 返回 null */
export function rowStepDelegationModel(s: RowStep): string | null {
  const c = (s as { kind?: string }).kind === 'cell'
    ? (s as HistoryCellRow).legacyContent
    : rowStepLegacyStep(s).content;
  return c && c.type === 'delegation' ? (c.model ?? '') : null;
}

export function useAgentModel(model?: string): string | undefined {
  const { selectedModel } = useNeoxRuntime();
  return model || selectedModel?.id || selectedModel?.name || undefined;
}

export const AgentBrandLogo: React.FC<{ model?: string; size?: number; fallback: React.ReactNode; className?: string }> = ({
  model, size = 15, fallback, className,
}) => {
  const m = useAgentModel(model);
  const brand = m ? inferProviderBrand({ id: m, name: m }) : 'generic';
  if (brand === 'generic') return <>{fallback}</>;
  return <ProviderBrandIcon brand={brand} size={size} className={className} />;
};
