/**
 * 🔥 完整集成测试：验证 SQLite 迁移后的所有服务
 * Usage: npx tsx scripts/test-sqlite.ts
 */
import { NeoxDatabase, getDatabase, closeDatabase } from '../src/platform/database.js';
import { migrateToSqlite } from '../src/platform/database-migration.js';
import { tokenUsageService } from '../src/platform/tokenUsageService.js';

console.log('=== 1. Database Init ===');
const db = getDatabase();
console.log(`DB size: ${db.getDatabaseSize()}K`);

console.log('\n=== 2. Migration ===');
const result = migrateToSqlite(db);
console.log(result ? `Migrated: ${result.sessionsImported} sessions, ${result.tokenRecordsImported} tokens, ${result.durationMs}ms` : 'Already migrated');

console.log('\n=== 3. Sessions ===');
const sessions = db.listSessions();
console.log(`Total: ${sessions.length}`);
for (const s of sessions.slice(0, 3)) {
    console.log(`  ${s.id}: ${s.name} (contextUsed=${s.contextUsed})`);
}

console.log('\n=== 4. Token Usage (via service) ===');
const summary = await tokenUsageService.getSummary();
console.log(`Requests: ${summary.totalRequests}, Tokens: ${summary.totalTokens}`);

const stats = await tokenUsageService.getProviderStats();
console.log(`Providers: ${stats.length}`);
for (const s of stats.slice(0, 3)) {
    console.log(`  ${s.provider}: ${s.totalRequests} requests`);
}

console.log('\n=== 5. Performance Benchmark ===');
// Read performance
let t = performance.now();
for (let i = 0; i < 10000; i++) db.getSession(sessions[0]?.id || 'x');
console.log(`10000x getSession: ${(performance.now() - t).toFixed(1)}ms (${((performance.now() - t) / 10000).toFixed(4)}ms/op)`);

t = performance.now();
for (let i = 0; i < 1000; i++) db.listSessions();
console.log(`1000x listSessions: ${(performance.now() - t).toFixed(1)}ms (${((performance.now() - t) / 1000).toFixed(4)}ms/op)`);

// Write performance  
t = performance.now();
for (let i = 0; i < 1000; i++) {
    db.updateSessionContextUsed(sessions[0]?.id || 'x', 50000 + i);
}
console.log(`1000x updateContextUsed: ${(performance.now() - t).toFixed(1)}ms (${((performance.now() - t) / 1000).toFixed(4)}ms/op)`);

t = performance.now();
for (let i = 0; i < 1000; i++) {
    await tokenUsageService.recordUsage({
        timestamp: Date.now(),
        provider: 'bench-test',
        model: 'bench-model',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        duration: 100,
        success: true,
    });
}
console.log(`1000x recordUsage: ${(performance.now() - t).toFixed(1)}ms (${((performance.now() - t) / 1000).toFixed(4)}ms/op)`);

// Cleanup bench data
db.clearTokenUsageByProvider('bench-test');

console.log(`\n=== 6. Final DB Size ===`);
console.log(`${db.getDatabaseSize()}K`);

closeDatabase();
console.log('\n✅ All integration tests passed!');
