
export interface PlatformPreset {
  id: string;
  label: string;
  labelEn: string;
  w: number;
  h: number;
  fit: 'cover' | 'pad';
}

export const PLATFORM_PRESETS: PlatformPreset[] = [
  { id: 'taobao', label: '淘宝/天猫主图', labelEn: 'Taobao main', w: 800, h: 800, fit: 'pad' },
  { id: 'pdd', label: '拼多多主图', labelEn: 'PDD main', w: 750, h: 750, fit: 'pad' },
  { id: 'jd', label: '京东主图', labelEn: 'JD main', w: 800, h: 800, fit: 'pad' },
  { id: 'amazon', label: '亚马逊主图', labelEn: 'Amazon main', w: 2000, h: 2000, fit: 'pad' },
  { id: 'xhs', label: '小红书 (3:4)', labelEn: 'RedNote 3:4', w: 1242, h: 1656, fit: 'cover' },
  { id: 'douyin', label: '抖音竖版 (9:16)', labelEn: 'Douyin 9:16', w: 1080, h: 1920, fit: 'cover' },
  { id: 'x', label: 'X / 推特 (16:9)', labelEn: 'X post 16:9', w: 1600, h: 900, fit: 'cover' },
  { id: 'moments', label: '微信朋友圈 (1:1)', labelEn: 'WeChat 1:1', w: 1080, h: 1080, fit: 'cover' },
];
