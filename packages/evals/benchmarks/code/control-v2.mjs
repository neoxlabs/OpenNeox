/**
 * 正向对照: 手工套一份"正确答案", verify 必须判通过 —— 证明验收不是不可能完成的。
 *   (selfcheck 证明"没做判失败", 这个证明"做对判通过", 两个都过才算验收可信)
 *   node control-v2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { TASKS, ROOT } from './tasks-v2.mjs';

const rw = (dir, f, from, to) => { const p = path.join(dir, f); const s = fs.readFileSync(p, 'utf8'); if (!s.includes(from)) throw new Error('miss ' + f); fs.writeFileSync(p, s.replace(from, to)); };
const put = (dir, f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };

const FIX = {
  'v2-streak'(dir) {
    rw(dir, 'models/Achievement.js', 'UNION SELECT created_at as d FROM feedings', 'UNION SELECT feed_date as d FROM feedings');
    put(dir, 'test/streak-feed.test.js', "const { test } = require('node:test');\ntest('feed streak', () => {});\n");
  },
  'v2-export'(dir) {
    rw(dir, 'routes/walks.js', '// Add walk form', `router.get('/export.csv', (req, res) => {
  const allPets = getAccessiblePets(req.session.user.id);
  const walks = collectByAccessiblePets(allPets, (ownerId) => Walk.findByUser(ownerId));
  const { rows } = paginate(walks, req.query, { searchFields: ['notes', 'route', 'mood'], dateFields: ['walk_date'], perPage: 1e9 });
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['日期,宠物,时长(分钟),距离(km),心情', ...rows.map((w) => [w.walk_date, w.pet_name, w.duration_minutes, w.distance_km, w.mood].map(esc).join(','))];
  res.set('content-type', 'text/csv; charset=utf-8');
  res.send('\\uFEFF' + lines.join('\\r\\n'));
});

// Add walk form`);
    const v = path.join(dir, 'views/walks/index.ejs'); fs.writeFileSync(v, '<a href="/walks/export.csv">导出 CSV</a>\n' + fs.readFileSync(v, 'utf8'));
    put(dir, 'test/walk-export.test.js', "const { test } = require('node:test');\ntest('export', () => {});\n");
  },
  'v2-security'(dir) {
    put(dir, 'SECURITY_REVIEW.md', `# 审查\n\n## 1. 撤销共享不校验归属\nPetShare.revoke 的 UPDATE 没带 owner_id, 任何登录用户 POST /family/:id/revoke 可撤销别人的共享。\n\n## 2. view 权限可删除遛狗记录\nroutes/walks.js 删除走 requireRecordPetAccess(..., 'view'), 只读用户能删除。\n`);
  },
  'v2-vague-ui'(dir) {
    const v = path.join(dir, 'views/pets/detail.ejs'); fs.writeFileSync(v, fs.readFileSync(v, 'utf8') + '\n<!-- tidy -->\n');
  },
  'v2-startup'(dir) {
    rw(dir, 'app.js', "require('./routes/breed')", "require('./routes/breeds')");
    rw(dir, 'config/database.js', 'walks(pet_id, walk_dat)', 'walks(pet_id, walk_date)');
  },
};

for (const t of TASKS) {
  if (!FIX[t.id]) { console.log(`- ${t.id} (无自动对照, 人工评)`); continue; }
  const dir = path.join(ROOT, 'work', `control-${t.id}`);
  t.setup(dir);
  FIX[t.id](dir);
  const v = await t.verify(dir, '');
  console.log(`${v.ok ? '✓ 做对判通过' : '✗ 做对却判失败!'} ${t.id.padEnd(14)} ${v.why || ''}`.slice(0, 300));
}
