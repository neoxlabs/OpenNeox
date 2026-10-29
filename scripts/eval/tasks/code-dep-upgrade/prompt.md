项目依赖 `vendor/strutil` 从 1.x 升到了 2.0，旧 API 被删了，测试因此跑不起来。

请先看 `vendor/strutil/CHANGELOG.md`，再修 `src/` 里对旧 API 的用法，让 `node --test` 全绿。

要求：
- 函数对外行为保持不变（`formatRow` 左右对齐、`shorten` 按字符截断并加 `…`）；
- 不许改 `vendor/` 和 `test/` 下的文件。
