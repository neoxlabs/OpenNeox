`src/runtime.mjs` 里的 `parseDuration` 混在一个大文件里不好维护。请把它原样搬到一个新文件 `src/time/parseDuration.mjs`（默认导出不要，保持具名导出 `parseDuration`），并把所有用到它的文件改成从新路径 import。

要求：
- `src/runtime.mjs` 里不再保留 `parseDuration`，也不要写转发再导出。
- 其它导出（如 `formatCount`）保持不变。
- 现有测试（`node --test`）必须继续通过，不许改 `test/` 下的文件。
