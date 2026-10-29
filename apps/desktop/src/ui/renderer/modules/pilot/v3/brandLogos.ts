const FILES = import.meta.glob('../../../media/brands/*.{webp,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** 按文件名直接取 (「连接」页的 Mac 自带 App: mac-calendar 这类) */
export function fileOf(key: string): string | null {
  const hit = Object.keys(FILES).find((p) => /\/([^/]+)\.(webp|svg)$/.exec(p)?.[1] === key);
  return hit ? FILES[hit] : null;
}

/* 名字里出现这些词 → 那家的 logo (先长后短, 「招商银行信用卡」也认得) */
const RULES: Array<[RegExp, string]> = [
  [/招商|招行|cmb/i, 'cmb'],
  [/工商|工行|icbc/i, 'icbc'],
  [/建设银行|建行|ccb/i, 'ccb'],
  [/农业银行|农行/i, 'abc'],
  [/中国银行|中行/i, 'boc'],
  [/交通银行|交行/i, 'bocom'],
  [/平安/i, 'pingan'],
  [/民生/i, 'cmbc'],
  [/兴业/i, 'cib'],
  [/浦发/i, 'spdb'],
  [/中信/i, 'citic'],
  [/邮储|邮政/i, 'psbc'],
  [/余额宝|支付宝|花呗|借呗|蚂蚁|alipay/i, 'alipay'],
  [/微信|零钱通|财付通|wechat/i, 'wechat'],
  [/云闪付|银联|unionpay/i, 'unionpay'],
  [/中国移动|移动话费|10086/i, 'cmcc'],
  [/联通/i, 'unicom'],
  [/电信/i, 'telecom'],
  [/爱奇艺|iqiyi/i, 'iqiyi'],
  [/优酷/i, 'youku'],
  [/哔哩|b站|bilibili/i, 'bilibili'],
  [/网易云/i, 'ncm'],
  [/qq音乐/i, 'qqmusic'],
  [/酷狗/i, 'kugou'],
  [/百度网盘/i, 'baidunetdisk'],
  [/wps/i, 'wps'],
  [/美团/i, 'meituan'],
  [/滴滴/i, 'didi'],
  [/keep/i, 'keep'],
  [/icloud/i, 'icloud'],
  [/apple|苹果/i, 'apple'],
  [/netflix|奈飞/i, 'netflix'],
  [/spotify/i, 'spotify'],
  [/youtube/i, 'youtube'],
  /* 常见商户 (「最近」那几笔) */
  [/优衣库|uniqlo/i, 'uniqlo'],
  [/喜茶/i, 'heytea'],
  [/瑞幸|luckin/i, 'luckin'],
  [/星巴克|starbucks/i, 'starbucks'],
  [/麦当劳|mcdonald/i, 'mcd'],
  [/盒马/i, 'hema'],
  [/海底捞/i, 'haidilao'],
  /* 只认上海地铁: 别的城市的「地铁」挂大都会就错了, 宁可画线条图标 */
  [/大都会|上海地铁/i, 'metro'],
];

export function brandLogo(...names: Array<string | null | undefined>): string | null {
  const text = names.filter(Boolean).join(' ');
  if (!text) return null;
  for (const [re, key] of RULES) if (re.test(text)) return fileOf(key);
  return null;
}
