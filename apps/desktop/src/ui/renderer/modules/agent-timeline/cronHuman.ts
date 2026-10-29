/* cron 表达式 → 人话 (「每周五 17:00」)。定时卡和 Work 进度行用; 认不出的原样返回。
 * 10-21: 卡片上原来摊着「0 17 * * 5」, 普通用户看不懂。 */
import { defaultIsZh } from '../../hooks/useI18n';

const ZH_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function cronToHuman(expr: string, zh = defaultIsZh()): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return zh ? `每 ${everyMin[1]} 分钟` : `Every ${everyMin[1]} min`;
  }
  if (!/^\d+$/.test(min)) return expr;
  const everyHour = hour === '*' && dom === '*' && mon === '*' && dow === '*';
  if (everyHour) return zh ? `每小时第 ${min} 分` : `Hourly at :${min.padStart(2, '0')}`;
  if (!/^\d+$/.test(hour) || mon !== '*') return expr;
  const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return zh ? `每天 ${time}` : `Daily ${time}`;
  if (dom === '*' && dow === '1-5') return zh ? `工作日 ${time}` : `Weekdays ${time}`;
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = dow.split(',').map((d) => Number(d) % 7);
    const names = days.map((d) => (zh ? ZH_DAYS : EN_DAYS)[d]);
    return zh ? `每${names.join('、')} ${time}` : `Every ${names.join(', ')} ${time}`;
  }
  if (/^\d+$/.test(dom) && dow === '*') return zh ? `每月 ${dom} 号 ${time}` : `Monthly on day ${dom} ${time}`;
  return expr;
}
