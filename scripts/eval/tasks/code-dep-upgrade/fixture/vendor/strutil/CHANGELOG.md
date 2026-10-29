# strutil 2.0.0

## Breaking changes

- 删除 `padLeft(text, width)` / `padRight(text, width)`。
  改用 `pad(text, width, { side: 'left' | 'right', fill })`，`side` 默认 `'right'`，`fill` 默认空格。
- `truncate(text, max, { suffix })` 现在按 Unicode 码点计数（emoji 算 1 个字符），不再按 UTF-16 长度。

其余函数不变。
