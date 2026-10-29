import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { toolPackRegistry } from '../../tools/packs/toolPack.js';
import { ALWAYS_ACTIVE_TOOLS } from '../../tools/toolTree.js';
import { appendDiagLog } from '../agent/diagLogFile.js';
import { JevToolPreloader } from './jevToolPreloader.js';

export const sharedJevToolPreloader = new JevToolPreloader({
  getPacks: () => toolPackRegistry.getAll(),
  alwaysActive: ALWAYS_ACTIVE_TOOLS,
  log: (event, data) => appendDiagLog(event, data),
  info: (message) => cliLogger.info('TOOL_TREE', message),
});
