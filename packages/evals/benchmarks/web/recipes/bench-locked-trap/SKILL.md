---
name: bench-locked-trap
description: 复跑一段录好的浏览器操作「Bench 工单台: 尝试关闭被锁定的 7 号工单 — 断言服务端拒绝(已锁定)且状态仍为 open」—— 共 10 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 尝试关闭被锁定的 7 号工单 — 断言服务端拒绝(已锁定)且状态仍为 open

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-locked-trap" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/tickets` (打开工单列表)
2. 刷新 (刷新到干净初始状态)
3. 等待 `#tbl tbody tr[data-id="7"] button.close` (等列表渲染)
4. 点击 `#tbl tbody tr[data-id="7"] button.close` (点 7 号工单的关闭)
5. 等待 `#yes` (等确认框)
6. 点击 `#yes` (确认关闭)
7. 等待 (等服务端拒绝提示)
8. 断言 `#tbl tbody tr[data-id="7"] td:nth-child(4)` (断言 7 号仍为 open)
9. 断言 `body` (断言有关闭失败提示)
10. 断言 `body` (断言锁定原因)

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-locked-trap",
  "description": "Bench 工单台: 尝试关闭被锁定的 7 号工单 — 断言服务端拒绝(已锁定)且状态仍为 open",
  "createdAt": "2026-09-10T15:57:17.396Z",
  "updatedAt": "2026-09-10T15:57:17.396Z",
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
      "action": "reload",
      "args": {},
      "label": "刷新到干净初始状态"
    },
    {
      "action": "wait_for",
      "args": {
        "kind": "selector",
        "selector": "#tbl tbody tr[data-id=\"7\"] button.close",
        "state": "visible",
        "timeout": 8000
      },
      "label": "等列表渲染",
      "anchors": [
        {
          "text": "关闭"
        }
      ]
    },
    {
      "action": "click",
      "args": {
        "selector": "#tbl tbody tr[data-id=\"7\"] button.close"
      },
      "label": "点 7 号工单的关闭",
      "anchors": [
        {
          "text": "关闭"
        }
      ]
    },
    {
      "action": "wait_for",
      "args": {
        "kind": "selector",
        "selector": "#yes",
        "state": "visible",
        "timeout": 5000
      },
      "label": "等确认框",
      "anchors": [
        {
          "text": "确认"
        }
      ]
    },
    {
      "action": "click",
      "args": {
        "selector": "#yes"
      },
      "label": "确认关闭",
      "anchors": [
        {
          "text": "确认"
        }
      ]
    },
    {
      "action": "wait_for",
      "args": {
        "kind": "function",
        "predicate": "document.body.innerText.includes('已锁定')",
        "timeout": 8000
      },
      "label": "等服务端拒绝提示"
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#tbl tbody tr[data-id=\"7\"] td:nth-child(4)",
        "text": "open"
      },
      "label": "断言 7 号仍为 open",
      "anchors": [
        {
          "text": "open"
        },
        {
          "selector": "#tbl tbody tr[data-id=\"7\"] td:nth-child(4)"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "body",
        "text": "关闭失败"
      },
      "label": "断言有关闭失败提示",
      "anchors": [
        {
          "selector": "body"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "body",
        "text": "这条工单已锁定, 不能改"
      },
      "label": "断言锁定原因",
      "anchors": [
        {
          "selector": "body"
        }
      ]
    }
  ]
}
```
