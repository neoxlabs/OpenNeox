import React from 'react';

type PricedModel = { id: string; name?: string; payAsYouGoPrice?: { inputPerMtok: number; outputPerMtok: number } | null };

/** -promo 款相对原价款的价格比 (0~1); 不是特惠款或比不出来返回 undefined。纯函数。 */
export function paygPromoRatio(model: PricedModel, all: readonly PricedModel[]): number | undefined {
  const id = String(model.id ?? model.name ?? '');
  if (!/-promo$/.test(id)) return undefined;
  const baseId = id.replace(/-promo$/, '');
  const base = all.find((m) => String(m.id ?? m.name) === baseId);
  const p = model.payAsYouGoPrice;
  const b = base?.payAsYouGoPrice;
  if (!p || !b || !(b.inputPerMtok > 0)) return undefined;
  const ratio = p.inputPerMtok / b.inputPerMtok;
  return ratio > 0 && ratio < 1 ? ratio : undefined;
}

export function renderPaygPromoTag(ratio: number | undefined, isZh: boolean): React.ReactElement | null {
  if (!ratio) return null;
  return <span className="atl-model__item-promo">{isZh ? '限时特惠' : 'Limited offer'}</span>;
}
