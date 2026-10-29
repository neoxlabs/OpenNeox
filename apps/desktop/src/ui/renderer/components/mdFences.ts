
/** 把 fn 作用在**围栏外**的每一段上; 围栏内 (``` 与 ~~~) 原样返回。 */
export function mapOutsideCodeFences(text: string, fn: (seg: string) => string): string {
  /* 奇数段 = 围栏内。~~~ 只认行首形式, 免得把正文里的删除线波浪号当围栏。 */
  const byBacktick = text.split('```');
  for (let a = 0; a < byBacktick.length; a += 2) {
    const byTilde = byBacktick[a].split('\n~~~');
    for (let b = 0; b < byTilde.length; b += 2) byTilde[b] = fn(byTilde[b]);
    byBacktick[a] = byTilde.join('\n~~~');
  }
  return byBacktick.join('```');
}
