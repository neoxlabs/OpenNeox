/**
 * 极简版的壁纸替身 —— **不 import 任何图**。
 *
 * 极简版只给浅色/深色两档主题, 那 18 张壁纸 (源 25 MB / 出包约 40 MB) 一张都用不到。
 * 但静态 import 只要还在, 图就一定进包 —— 所以极简版构建时由 vite alias 换成这个文件。
 *
 * 返回空串: 消费端是 `url("${wpX}")`, 空串会得到 `url("")` —— 浏览器当作没有背景图,
 * 不会报错也不会去请求。比给个 undefined 安全 (那会渲染成 url("undefined") 然后 404)。
 */
const none = '';

export const wpLiuli = none;
export const wpChenguang = none;
export const wpNuanyang = none;
export const wpMoye = none;
export const wpMuyunqing = none;
export const wpDianyajin = none;
export const wpDingxiangzi = none;
export const wpChenshazhu = none;
export const wpSongyanmo = none;
export const wpWumoyan = none;
export const wpSakura = none;
export const wpMusanzi = none;
export const wpQingkong = none;
export const wpHaiyue = none;
export const wpNeonlight = none;
export const wpMatrix = none;
export const wpJiguang = none;
export const wpVaporwave = none;
