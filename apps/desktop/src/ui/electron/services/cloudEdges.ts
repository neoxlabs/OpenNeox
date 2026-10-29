import type { EdgeDef } from '@neoxlabs/platform';

export const DESKTOP_EDGE_SEED: EdgeDef[] = [
  { id: 'cf' },
  {
    id: 'hk',
    ip: '203.0.113.10',
    alias: {
      'neox-dev.com': 'hk.neox-dev.com',
      'app.neox-dev.com': 'hk.neox-dev.com',
      'gateway.neox-dev.com': 'gw-hk.neox-dev.com',
    },
  },
];
