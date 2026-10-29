'use strict';
/* 装包时就把程序下好, 首次运行不用等。失败不让 npm install 报错 —— 第一次运行 neox 时会再下。 */
const { install, needsInstall } = require('./lib/binary.js');

if (process.env.NEOX_SKIP_DOWNLOAD !== '1' && needsInstall()) {
  install().catch(e => {
    process.stderr.write(`[neox] Download did not finish (${e.message}); it will retry the first time you run neox.\n`);
  });
}
