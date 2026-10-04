import type { Message } from '../types/index.js';
import { stripStaleImages } from '../utils/imageHistoryGuard.js';
import { prepareMessagesForWire } from '../utils/wireText.js';
import { enforceToolPairs } from './toolPairGuard.js';
import { cliLogger } from '../platform/cliLogger.js';

export function prepareWireMessages(messages: Message[]): Message[] {
  const _imgGuard = stripStaleImages(messages);
  const _visionGuard = _imgGuard;
  const _pairGuard = enforceToolPairs(_visionGuard.messages as any[]);
  const requestMessages = prepareMessagesForWire(_pairGuard.messages) as typeof _visionGuard.messages;
  if (_imgGuard.strippedImages > 0) {
    cliLogger.info('RUNNER',
      `[IMG_GUARD] stripped ${_imgGuard.strippedImages} stale image(s), freed ~${(_imgGuard.bytesFreed / 1024 / 1024).toFixed(2)}MB from request`);
  }
  return requestMessages;
}
