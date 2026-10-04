/**
 * 验证审批档位的实际行为和判定顺序。
 *
 *   档位语义:
 *     dangerous = 完全无人托管, 一条都不弹, critical 也不弹 —— "删了也是我自己选的"。
 *     auto      = 只有 critical (删根/家目录、mkfs、dd 写盘、写 shell 启动文件、SQL DROP …) 才问;
 *                 high (git reset --hard / rm -rf 子目录 …) 是开发日常, 直接跑。
 *     manual    = 非只读一律问, high 也问。
 *
 *   这个闸把**判定顺序**钉住: sandbox → dangerous → auto(critical) → high → manual。
 *   判定顺序必须是 sandbox → dangerous → auto(critical) → high → manual，
 *   以确保沙箱和显式放行策略不会被审批档位绕过。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateToolRisk, isHighRiskLevel } from '../toolRiskEvaluator';

const HERE = dirname(fileURLToPath(import.meta.url));
const PM = readFileSync(resolvePath(HERE, '../permissions/PermissionManager.ts'), 'utf8');

const levelOf = (command: string): string =>
  (evaluateToolRisk({ toolName: 'execute_shell', args: { command } } as never) as { level: string }).level;

/** 复刻 resolveEffectivePermission 的判定顺序。下面第一条测试校验它没跟源码跑偏。 */
function decide(
  scopeMode: 'auto' | 'manual' | 'dangerous',
  level: string,
): 'ASK' | 'ALLOW' | 'DENY' {
  if (scopeMode === 'dangerous') return 'ALLOW';
  if (scopeMode === 'auto') return level === 'critical' ? 'ASK' : 'ALLOW';
  if (isHighRiskLevel(level as never)) return 'ASK';
  return 'ASK';
}

describe('判定顺序是这条闸的全部依据', () => {
  it('源码里 sandbox → dangerous → auto(critical) → high → manual, 顺序不能变', () => {
    const i = PM.indexOf('private resolveEffectivePermission');
    expect(i).toBeGreaterThan(0);
    const block = PM.slice(i, i + 3200);
    const order = [
      block.indexOf("s.domain === 'sandbox'"),
      block.indexOf("scopeMode === 'dangerous'"),
      block.indexOf("scopeMode === 'auto'"),
      block.indexOf('isHighRiskLevel(risk.level)'),
      block.indexOf("scopeMode === 'manual'"),
    ];
    expect(order.every((n) => n > 0), '五个判定有缺失').toBe(true);
    /* 沙箱是用户主动开的范围约束, 必须压过一切档位 (含 dangerous)。 */
    expect(order[0], 'sandbox 判定不在最前').toBeLessThan(order[1]);
    /* dangerous 必须排在最前的档位判定 —— 反过来就是"开了全部放行还弹卡"。 */
    expect(order[1], 'dangerous 落到了 auto 后面').toBeLessThan(order[2]);
    /* auto 必须排在 high 之前 —— 反过来 high 命令在 Auto 档又开始弹卡。 */
    expect(order[2], 'auto 分支落到了 isHighRiskLevel 后面').toBeLessThan(order[3]);
    /* auto 分支里必须还有 critical 判定 —— 删掉就是删家目录在 Auto 档静默执行。 */
    expect(block.slice(order[2], order[3])).toContain("risk.level === 'critical'");
  });
});

describe('Auto 档: 只有关键危险命令问, 开发日常放行', () => {
  it.each([
    ['rm -rf ./build', 'high'],
    ['rm -rf node_modules', 'high'],
    ['git reset --hard', 'high'],
    ['git clean -fd', 'high'],
  ])('%s 是 %s, 在 Auto 档直接放行', (cmd, expected) => {
    expect(levelOf(cmd)).toBe(expected);
    expect(decide('auto', levelOf(cmd))).toBe('ALLOW');
  });

  it.each(['rm -rf /', 'rm -rf ~'])('%s 是 critical, Auto 档仍然问', (cmd) => {
    expect(levelOf(cmd)).toBe('critical');
    expect(decide('auto', levelOf(cmd))).toBe('ASK');
  });

  it.each(['npm test', 'ls -la', 'git status', 'npm run build && npm test'])(
    '%s 在 Auto 档直接放行 (不看 configuredPermission 的 ASK 白名单)',
    (cmd) => {
      expect(isHighRiskLevel(levelOf(cmd) as never), `${cmd} 被误判成高风险`).toBe(false);
      expect(decide('auto', levelOf(cmd))).toBe('ALLOW');
    },
  );
});

describe('dangerous 档: 一条都不弹', () => {
  it('rm -rf / 是 critical, 但 yolo 下照跑 —— 用户选的就是无托管', () => {
    expect(levelOf('rm -rf /')).toBe('critical');
    expect(decide('dangerous', 'critical')).toBe('ALLOW');
  });

  it('high 同样放行', () => {
    expect(decide('dangerous', 'high')).toBe('ALLOW');
  });
});

describe('risk 判据本身不能误报 —— 误报会让人练出"一路点确认"的肌肉记忆', () => {
  it('命令文本里出现 SQL 关键字 ≠ 在执行 SQL', () => {
    expect(levelOf('grep -rn "DROP TABLE" packages/')).toBe('low');
    expect(levelOf('git commit -m "docs: 说明 TRUNCATE TABLE 的用法"')).toBe('low');
  });

  it('真的调 DB 客户端才判 critical', () => {
    expect(levelOf('psql -c "TRUNCATE TABLE foo"')).toBe('critical');
    expect(levelOf('mysql -e "DROP TABLE users"')).toBe('critical');
  });

  it('sudo rm 按目标分级: 系统目录 critical, 临时目录 high', () => {
    expect(levelOf('sudo rm -rf /usr')).toBe('critical');
    expect(levelOf('sudo rm -rf /')).toBe('critical');
    expect(levelOf('sudo rm -rf /tmp/build-cache')).toBe('high');
  });

  it('sudo + 磁盘级命令无论目标都是 critical', () => {
    expect(levelOf('sudo dd if=/dev/zero of=/dev/disk2')).toBe('critical');
    expect(levelOf('sudo mkfs.ext4 /dev/sdb1')).toBe('critical');
  });
});
