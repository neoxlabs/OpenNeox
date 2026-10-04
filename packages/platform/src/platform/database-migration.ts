
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NeoxDatabase } from './database.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const MIGRATION_KEY = 'migration:json_to_sqlite';

function getConfigDir(): string {
    const profile = (process.env.NEOX_PROFILE || '').toLowerCase();
    const isElectronDev = !!(process as any).versions?.electron
        && process.env.NODE_ENV === 'development'
        && profile !== 'prod';
    const appName = isElectronDev ? 'Neox Dev' : 'Neox';
    const platform = process.platform;
    if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (platform === 'win32') {
        return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), appName);
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdgConfig, isElectronDev ? 'neox-dev' : 'neox');
}

interface MigrationResult {
    sessionsImported: number;
    messagesImported: number;
    tokenRecordsImported: number;
    errors: string[];
    durationMs: number;
}

/**
 * 执行从 JSON/JSONL 到 SQLite 的迁移
 * 幂等操作：已迁移过则跳过
 */
export function migrateToSqlite(db: NeoxDatabase): MigrationResult | null {
    // 检查是否已迁移
    const migrated = db.getAppState<{ completed: boolean }>(MIGRATION_KEY);
    if (migrated?.completed) {
        return null; // 已完成迁移
    }

    const startTime = Date.now();
    const result: MigrationResult = {
        sessionsImported: 0,
        messagesImported: 0,
        tokenRecordsImported: 0,
        errors: [],
        durationMs: 0,
    };

    const configDir = getConfigDir();
    const metadataDir = path.join(configDir, 'sessions');
    const jsonlDir = path.join(os.homedir(), NEOX_HOME_DIRNAME, 'sessions');

    // ==================== 1. 迁移 Session Metadata ====================
    try {
        if (fs.existsSync(metadataDir)) {
            const files = fs.readdirSync(metadataDir).filter(f => f.endsWith('.json'));
            db.transaction(() => {
                for (const file of files) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(metadataDir, file), 'utf-8'));
                        db.upsertSession({
                            id: data.id,
                            name: data.name || `Session ${data.id}`,
                            modelId: data.modelId || 'unknown',
                            workspacePath: data.workspacePath || '',
                            createdAt: data.createdAt || Date.now(),
                            updatedAt: data.updatedAt || Date.now(),
                            totalTokens: data.totalTokens || 0,
                            contextUsed: data.contextUsed || 0,
                            contextWindow: data.contextWindow,
                            fileRollbackCheckpointId: data.fileRollbackCheckpointId,
                            fileReapplyCheckpointId: data.fileReapplyCheckpointId,
                            fileRevertedMap: data.fileRevertedMap || {},
                            fileConfirmedMap: data.fileConfirmedMap || {},
                        });

                        // 迁移 timeline
                        if (Array.isArray(data.timeline) && data.timeline.length > 0) {
                            db.setTimeline(data.id, data.timeline);
                        }

                        result.sessionsImported++;
                    } catch (err: any) {
                        result.errors.push(`Session ${file}: ${err.message}`);
                    }
                }
            });
        }
    } catch (err: any) {
        result.errors.push(`Session metadata dir: ${err.message}`);
    }

    // ==================== 2. 迁移 JSONL Messages ====================
    try {
        if (fs.existsSync(jsonlDir)) {
            const files = fs.readdirSync(jsonlDir).filter(f => f.endsWith('.jsonl'));
            for (const file of files) {
                try {
                    const sessionId = file.replace(/\.jsonl$/, '');
                    // 只迁移有对应 session metadata 的 JSONL
                    const session = db.getSession(sessionId);
                    if (!session) continue;

                    const content = fs.readFileSync(path.join(jsonlDir, file), 'utf-8');
                    const lines = content.split('\n').filter(line => line.trim());

                    const items: Array<{ seq: number; itemType: string; itemData: any; timestamp: number }> = [];
                    for (const line of lines) {
                        try {
                            const entry = JSON.parse(line);
                            items.push({
                                seq: entry.seq || items.length,
                                itemType: entry.item?.type || 'unknown',
                                itemData: entry.item?.data || {},
                                timestamp: entry.timestamp || Date.now(),
                            });
                        } catch {
                            // 跳过无效行
                        }
                    }

                    if (items.length > 0) {
                        db.insertMessagesBatch(sessionId, items);
                        result.messagesImported += items.length;
                    }
                } catch (err: any) {
                    result.errors.push(`JSONL ${file}: ${err.message}`);
                }
            }
        }
    } catch (err: any) {
        result.errors.push(`JSONL dir: ${err.message}`);
    }

    // ==================== 3. 迁移 Token Usage ====================
    try {
        const usageFile = path.join(configDir, 'token-usage.json');
        if (fs.existsSync(usageFile)) {
            const data = JSON.parse(fs.readFileSync(usageFile, 'utf-8'));
            const records = data.records || [];

            if (records.length > 0) {
                // 批量插入（事务内）
                const rawDb = db.getRawDb();
                const insert = rawDb.prepare(`
          INSERT OR IGNORE INTO token_usage
            (id, timestamp, provider, model, input_tokens, billable_input_tokens, output_tokens, total_tokens,
             cached_tokens, cache_read_tokens, cache_write_tokens, openai_cached, anthropic_cache_read, anthropic_cache_create,
             anthropic_cache_5m, anthropic_cache_1h, duration, success, error, session_id, request_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

                rawDb.transaction(() => {
                    for (const r of records) {
                        insert.run(
                            r.id || `${r.timestamp}-${Math.random().toString(36).slice(2, 9)}`,
                            r.timestamp || Date.now(),
                            r.provider || 'unknown',
                            r.model || 'unknown',
                            r.inputTokens || 0,
                            r.billableInputTokens || 0,
                            r.outputTokens || 0,
                            r.totalTokens || 0,
                            r.cachedTokens || 0,
                            r.cacheReadTokens || 0,
                            r.cacheWriteTokens || 0,
                            r.openaiCachedTokens || 0,
                            r.anthropicCacheReadTokens || 0,
                            r.anthropicCacheCreationTokens || 0,
                            r.anthropicCacheCreation5mTokens || 0,
                            r.anthropicCacheCreation1hTokens || 0,
                            r.duration || 0,
                            r.success ? 1 : 0,
                            r.error || null,
                            r.sessionId || null,
                            r.requestType || 'chat',
                        );
                        result.tokenRecordsImported++;
                    }
                })();
            }
        }
    } catch (err: any) {
        result.errors.push(`Token usage: ${err.message}`);
    }

    // ==================== 4. 迁移 App State ====================
    try {
        const uiStateFile = path.join(configDir, 'ui-state.json');
        if (fs.existsSync(uiStateFile)) {
            const uiState = JSON.parse(fs.readFileSync(uiStateFile, 'utf-8'));
            // 将各个字段分别存入 app_state
            for (const [key, value] of Object.entries(uiState)) {
                db.setAppState(`ui:${key}`, value);
            }
        }
    } catch (err: any) {
        result.errors.push(`UI state: ${err.message}`);
    }

    // ==================== 5. 标记迁移完成 ====================
    result.durationMs = Date.now() - startTime;
    if (result.errors.length === 0) {
        db.setAppState(MIGRATION_KEY, {
            completed: true,
            completedAt: Date.now(),
            result,
        });
    } else {
        console.warn(`[Migration] ⚠️ 迁移有 ${result.errors.length} 个错误, 不写完成标记 (幂等迁移, 下次启动重试)`);
    }

    console.log(`[Migration] ${result.errors.length === 0 ? '✅ JSON → SQLite 迁移完成:' : '⚠️ JSON → SQLite 迁移部分完成:'}`);
    console.log(`  Sessions: ${result.sessionsImported}`);
    console.log(`  Messages: ${result.messagesImported}`);
    console.log(`  Token records: ${result.tokenRecordsImported}`);
    console.log(`  Duration: ${result.durationMs}ms`);
    if (result.errors.length > 0) {
        console.warn(`  ⚠️ Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.warn(`    - ${e}`));
    }

    return result;
}
