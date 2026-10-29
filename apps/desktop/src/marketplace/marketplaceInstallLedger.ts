import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface MarketplaceInstallRecord {
  sourceId: string;
  type: 'plugin' | 'skill';
  slug: string;
  pluginName?: string;
  version: string;
  installedAt: string;
  updatedAt?: string;
}

export class MarketplaceInstallLedger {
  constructor(private readonly filePath = path.join(os.homedir(), '.neox', 'marketplace-install-ledger.json')) {}

  async list(): Promise<MarketplaceInstallRecord[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { version: 1; records: MarketplaceInstallRecord[] };
      return value.version === 1 && Array.isArray(value.records) ? value.records : [];
    } catch { return []; }
  }

  async upsert(record: MarketplaceInstallRecord): Promise<void> {
    const records = await this.list();
    const index = records.findIndex((item) => item.sourceId === record.sourceId && item.type === record.type && item.slug === record.slug);
    if (index >= 0) records[index] = record; else records.push(record);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }
}
