import fs from 'fs';
import os from 'os';
import path from 'path';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

export interface JsonListStore<T> {
  load(): T[];
  save(items: T[]): void;
}

const MAX_CHAT_META = 200;

export class PersistentChatMetaMap<V> extends Map<string, V> {
  private readonly store = desktopWatcherStore<[string, V]>('chat-meta');
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    for (const [k, v] of this.store?.load() ?? []) super.set(k, v);
  }

  override set(key: string, value: V): this {
    super.delete(key); /* 重新插到最后 = 最近用过, 超额时从最旧的删 */
    super.set(key, value);
    while (this.size > MAX_CHAT_META) super.delete(this.keys().next().value as string);
    if (this.store && !this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        try { this.store!.save([...this.entries()]); } catch { /* 落盘失败只影响重启后自动唤醒 */ }
      }, 500);
      this.saveTimer.unref?.();
    }
    return this;
  }
}

export function desktopWatcherStore<T>(name: 'monitors' | 'wakeups' | 'chat-meta'): JsonListStore<T> | undefined {
  if (!(process as { versions?: { electron?: string } }).versions?.electron) return undefined;
  const file = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'state', `${name}.json`);
  return {
    load(): T[] {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
    save(items: T[]): void {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(items));
      fs.renameSync(tmp, file);
    },
  };
}
