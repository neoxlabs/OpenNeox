/**
 * @deprecated 请改从 `./wireText.js` 导入. 本文件仅保留 re-export 兼容旧 import.
 */
export {
  assertStrictJsonSafe,
  hasLoneSurrogate,
  isStrictJsonSafe,
  prepareMessagesForWire,
  sanitizeUnicodeDeep,
  takeUtf16SafeTail,
  toWellFormedString,
  truncateMiddleUtf16Safe,
  truncateUtf16Safe,
  sliceUtf16Safe,
} from './wireText.js';
