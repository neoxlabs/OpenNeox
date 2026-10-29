import alarm from './art/alarm.png';
import calendar from './art/calendar.png';
import calls from './art/calls.png';
import decide from './art/decide.png';
import eye from './art/eye.png';
import files from './art/files.png';
import lunch from './art/lunch.png';
import map from './art/map.png';
import memory from './art/memory.png';
import phone from './art/phone.png';
import reports from './art/reports.png';
import weatherCloud from './art/weather-cloud.png';
import weatherNight from './art/weather-night.png';
import weatherRain from './art/weather-rain.png';
import weatherSnow from './art/weather-snow.png';
import weatherSun from './art/weather-sun.png';
import wrench from './art/wrench.png';

export const ART = { alarm, calendar, calls, decide, eye, files, lunch, map, memory, phone, reports, wrench } as const;
export type ArtName = keyof typeof ART;

/** WMO 天气码 → 图 */
export function weatherArt(code: number, isDay: boolean): string {
  if ([71, 73, 75, 77, 85, 86].includes(code)) return weatherSnow;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return weatherRain;
  if (code <= 1) return isDay ? weatherSun : weatherNight;
  return weatherCloud;
}
