import * as fs from 'node:fs';
import * as path from 'node:path';
import { readDocx } from '../../lib/docx.mjs';
import { assert, runCheck, workdirFromArgv } from '../../lib/check-helpers.mjs';

runCheck(async () => {
  const workdir = workdirFromArgv();
  const file = path.join(workdir, 'report.docx');
  assert(fs.existsSync(file), 'report.docx 不见了');

  const { paragraphs, headings } = readDocx(file);
  const text = paragraphs.map((p) => p.text);
  const joined = text.join('\n');

  assert(text.some((line) => line.trim() === '风险：供应商交付延迟两周' || line.trim() === '风险: 供应商交付延迟两周'), '风险段落没有改对');
  assert(!text.some((line) => /^风险[：:]\s*无\s*$/.test(line.trim())), '原来的「风险：无」还在');
  assert(text.some((line) => line.trim() === '负责人：李雷' || line.trim() === '负责人: 李雷'), '末尾没有追加「负责人：李雷」');

  assert(joined.includes('进度：登录模块已完成 80%'), '原有进度段落被改动了');
  assert(joined.includes('计划：下周完成联调'), '原有计划段落被改动了');
  assert(headings.some((h) => h.text.includes('项目周报')), '文档标题丢了');
  assert(headings.some((h) => h.text.trim() === '风险'), '「风险」标题丢了');

  const nonEmpty = text.filter((line) => line.trim().length > 0).length;
  assert(nonEmpty >= 7, `段落数不对 (非空 ${nonEmpty} 段)`);
});
