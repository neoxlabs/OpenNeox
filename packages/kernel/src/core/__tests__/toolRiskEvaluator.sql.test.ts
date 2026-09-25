/**
 * SQL 风险检测 —— 覆盖 shell 包装后的调用形态。
 *
 * SQL 检查作用于 execute_shell，命令通常被 `psql -c "…"` 或 `mysql -e '…'` 包裹。
 * 用例验证风险分析先剥离包装，再识别 SQL 语句本身。
 */

import { describe, it, expect } from 'vitest';
import { evaluateToolRisk } from '../toolRiskEvaluator.js';

function assess(command: string) {
  const a = evaluateToolRisk({ toolName: 'execute_shell', args: { command } } as any);
  return { level: a.level, sql: a.signals.filter((s) => s.domain === 'sql').map((s) => s.code) };
}

describe('SQL 风险 · 真实 shell 包装', () => {
  /* 判据收紧: SQL 规则只在"这条命令确实在调 DB 客户端"时才跑。
   *   原因是同一套正则会把 `grep -rn "DROP TABLE" src/`、commit message 里提到 TRUNCATE、
   *   heredoc 写迁移脚本全判成 critical —— 那些在 Auto 档就是白弹卡。
   *   代价是"裸 SQL 当 shell 命令传"不再被判高 —— 但那本来也不是可执行的 shell 命令
   *   (`DELETE FROM users;` 丢给 bash 只会 command not found)。真·裸 SQL 的入口是
   *   工具参数里的 query/sql 字段, 那条路的保护见下面一条。 */
  it('裸 SQL 文本当 shell 命令传 → 不再误判 (它根本不是可执行命令)', () => {
    const r = assess('DELETE FROM users;');
    expect(r.sql).toEqual([]);
  });

  it('工具参数里的裸 SQL 仍然判高 (回归保护)', () => {
    const a = evaluateToolRisk({ toolName: 'execute_shell', args: { command: 'psql', sql: 'DELETE FROM users;' } } as any);
    const codes = a.signals.filter((s) => s.domain === 'sql').map((s) => s.code);
    expect(codes).toContain('sql:delete-no-where');
    expect(a.level).toBe('high');
  });

  it('命令文本里出现 SQL 关键字但没在跑 SQL → 零信号', () => {
    expect(assess('grep -rn "DROP TABLE" packages/').sql).toEqual([]);
    expect(assess('git commit -m "docs: TRUNCATE TABLE 的用法"').sql).toEqual([]);
  });

  it('psql -c 包裹的 DELETE 不再漏', () => {
    const r = assess('psql -c "DELETE FROM users;"');
    expect(r.sql).toContain('sql:delete-no-where');
    expect(r.level).toBe('high');
  });

  it('mysql -e 包裹的 UPDATE 不再漏', () => {
    const r = assess(`mysql -e "UPDATE accounts SET balance=0;"`);
    expect(r.sql).toContain('sql:update-no-where');
    expect(r.level).toBe('high');
  });

  it('单引号 + 带连接参数的 psql 也认', () => {
    const r = assess(`psql -h db.internal -U admin -d prod -c 'DELETE FROM sessions;'`);
    expect(r.sql).toContain('sql:delete-no-where');
  });

  it('sqlite3 位置参数形式也认', () => {
    const r = assess(`sqlite3 app.db "DELETE FROM cache;"`);
    expect(r.sql).toContain('sql:delete-no-where');
  });

  it('带 WHERE 的不误报', () => {
    expect(assess(`psql -c "DELETE FROM users WHERE id = 1;"`).sql).toHaveLength(0);
    expect(assess(`mysql -e "UPDATE accounts SET balance=0 WHERE id=9;"`).sql).toHaveLength(0);
  });

  it('普通 shell 命令不误报', () => {
    expect(assess('ls -la /tmp').sql).toHaveLength(0);
    expect(assess('git log --oneline -5').sql).toHaveLength(0);
    expect(assess('echo "update the docs please"').sql).toHaveLength(0);
  });
});
