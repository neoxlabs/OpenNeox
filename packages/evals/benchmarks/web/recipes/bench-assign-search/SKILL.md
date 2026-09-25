---
name: bench-assign-search
description: 复跑一段录好的浏览器操作「Bench 工单台: 搜索「导出 CSV」并按 ID 最小的那条分配给赵六」—— 共 6 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 搜索「导出 CSV」并按 ID 最小的那条分配给赵六

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-assign-search" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/tickets` (打开工单列表)
2. 输入 `#q` (搜索「导出 CSV」)
3. 断言 `#tbl tbody tr` (断言命中 3 条)
4. 断言 `#tbl tbody tr:first-child` (断言首行是 ID 最小(#2))
5. 点击 `#tbl tbody tr:first-child button.assign` (分配 → 赵六)
6. 断言 `#tbl tbody tr:first-child` (断言负责人=赵六)

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-assign-search",
  "description": "Bench 工单台: 搜索「导出 CSV」并按 ID 最小的那条分配给赵六",
  "createdAt": "2026-09-10T15:53:45.477Z",
  "updatedAt": "2026-09-10T15:53:45.477Z",
  "healCount": 0,
  "steps": [
    {
      "action": "navigate",
      "args": {
        "url": "http://127.0.0.1:8910/tickets"
      },
      "label": "打开工单列表"
    },
    {
      "action": "type",
      "args": {
        "selector": "#q",
        "text": "导出 CSV"
      },
      "label": "搜索「导出 CSV」",
      "anchors": [
        {
          "selector": "#q"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "count",
        "selector": "#tbl tbody tr",
        "count": 3
      },
      "label": "断言命中 3 条",
      "anchors": [
        {
          "text": "2\t导出 CSV 缺最后一行 #2\tnormal\topen\t赵六\t分配 关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#tbl tbody tr:first-child",
        "text": "#2"
      },
      "label": "断言首行是 ID 最小(#2)",
      "anchors": [
        {
          "text": "2\t导出 CSV 缺最后一行 #2\tnormal\topen\t赵六\t分配 关闭"
        },
        {
          "selector": "#tbl tbody tr:first-child"
        }
      ]
    },
    {
      "action": "click",
      "args": {
        "selector": "#tbl tbody tr:first-child button.assign",
        "dialog": {
          "accept": true,
          "text": "赵六"
        }
      },
      "label": "分配 → 赵六",
      "anchors": [
        {
          "text": "分配"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#tbl tbody tr:first-child",
        "text": "赵六"
      },
      "label": "断言负责人=赵六",
      "anchors": [
        {
          "text": "2\t导出 CSV 缺最后一行 #2\tnormal\topen\t赵六\t分配 关闭"
        },
        {
          "selector": "#tbl tbody tr:first-child"
        }
      ]
    }
  ]
}
```
