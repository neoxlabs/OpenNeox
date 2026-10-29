把 `calculateTotal` 的签名从

```js
calculateTotal(items, taxRate)
```

改成

```js
calculateTotal(items, options = {})
```

其中 `options.taxRate`（默认 0）和 `options.discount`（默认 0）都是可选的；折扣先从商品小计里扣掉再计税，扣完不能为负。返回值保留两位小数。

要求：
- 把 `src/` 里所有调用点都改成新签名，不要留兼容旧签名的分支。
- 现有测试（`node --test`）必须继续通过，不许改 `test/` 下的文件。
