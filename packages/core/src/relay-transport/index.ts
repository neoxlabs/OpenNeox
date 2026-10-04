/**
 * relay-transport — Neox cloud-relay 共享传输层.
 *
 *   抽出公共 envelope 加密 + JSON schema, 让 desktop host / desktop consumer / pod
 *   三方共享同一份实现. 单源避免 crypto 漂移.
 *
 *   详见 内部设计文档 §3.2
 */
export {
  NONCE_LEN,
  KEY_LEN,
  TAG_LEN,
  randomNonce,
  encryptAesGcm,
  decryptAesGcm,
} from './envelopeCrypto.js';

export type {
  Envelope,
  RelayControlFrame,
  RpcMessage,
  RawWsData,
} from './envelopeSchema.js';

export {
  parseEnvelope,
  makeEnvelope,
  serializeRpcMessage,
  parseRpcMessage,
  isPeerOfflineFrame,
} from './envelopeSchema.js';
