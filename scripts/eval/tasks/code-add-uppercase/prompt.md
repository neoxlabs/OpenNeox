在 `src/format.mjs` 里加一个小功能（现有测试必须继续通过）：

1. `formatLine(text, options)` 支持 `options.uppercase`：为 true 时把 `text` 转成大写；`options.prefix` 保持原样，不参与大写；返回值末尾仍然只有一个换行符 `\n`。
2. `parseArgs(argv)` 支持 `--upper` 开关：出现该参数时返回的对象里 `uppercase` 为 `true`；不出现时 `uppercase` 为 `false`。

改完跑 `node --test` 确认现有测试全绿。不要修改 `test/` 下的测试文件。
