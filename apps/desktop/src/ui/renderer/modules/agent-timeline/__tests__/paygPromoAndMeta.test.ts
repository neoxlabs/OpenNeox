import { describe, expect, test } from 'vitest';
import { paygPromoRatio } from '../paygPromo';
import { inferProviderBrand } from '../ProviderBrandIcon';

const price = (i: number, o: number) => ({ inputPerMtok: i, outputPerMtok: o });

describe('按量组限时折扣 (10-21)', () => {
  const list = [
    { id: 'deepseek-v4.1-flash', payAsYouGoPrice: price(0.3, 1.2) },
    { id: 'deepseek-v4.1-flash-promo', payAsYouGoPrice: price(0.15, 0.6) },
    { id: 'lonely-promo', payAsYouGoPrice: price(0.1, 0.2) },
    { id: 'pricey-promo', payAsYouGoPrice: price(0.5, 1) },
    { id: 'pricey', payAsYouGoPrice: price(0.4, 1) },
  ];
  test('-promo 款对比原价款得出 5 折', () => {
    expect(paygPromoRatio(list[1], list)).toBe(0.5);
  });
  test('不是特惠款 / 原价款不在 / 不比原价便宜 → 不标', () => {
    expect(paygPromoRatio(list[0], list)).toBeUndefined();
    expect(paygPromoRatio(list[2], list)).toBeUndefined();
    expect(paygPromoRatio(list[3], list)).toBeUndefined();
  });
});

describe('Meta 图标 (Muse / Llama)', () => {
  test('muse-wonder / muse-spark-open / llama 认成 meta', () => {
    expect(inferProviderBrand({ id: 'muse-wonder', name: 'muse-wonder' })).toBe('meta');
    expect(inferProviderBrand({ id: 'muse-spark-open', name: 'muse-spark-open' })).toBe('meta');
    expect(inferProviderBrand({ id: 'meta/llama-5-70b' })).toBe('meta');
  });
  test('不误伤别家', () => {
    expect(inferProviderBrand({ id: 'deepseek-v4.1-flash' })).toBe('deepseek');
    expect(inferProviderBrand({ id: 'grok-4.7' })).toBe('xai');
  });
});
