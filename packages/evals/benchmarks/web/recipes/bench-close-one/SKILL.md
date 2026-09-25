---
name: bench-close-one
description: 复跑一段录好的浏览器操作「Bench 工单台: 关闭 3 号工单并在确认弹窗点确认 (登录后从 /tickets 起步)」—— 共 9 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 关闭 3 号工单并在确认弹窗点确认 (登录后从 /tickets 起步)

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-close-one" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/tickets` (open /tickets)
2. 刷新 (force fresh load)
3. 等待 `#tbl tbody tr[data-id="3"] button.close` (wait list rendered)
4. 断言 `#tbl tbody tr[data-id="3"] td:nth-child(4) .pill` (#3 is open (precondition))
5. 点击 `#tbl tbody tr[data-id="3"] button.close` (click 关闭 on #3)
6. 断言 `#dlgmsg` (confirm dialog shown)
7. 点击 `#dlg #yes` (click 确认)
8. 断言 `#toast` (server accepted close)
9. 断言 `#tbl tbody tr[data-id="3"] td:nth-child(4) .pill` (row 3 now closed)

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-close-one",
  "description": "Bench 工单台: 关闭 3 号工单并在确认弹窗点确认 (登录后从 /tickets 起步)",
  "createdAt": "2026-09-10T15:52:31.952Z",
  "updatedAt": "2026-09-10T15:52:31.952Z",
  "healCount": 0,
  "steps": [
    {
      "action": "navigate",
      "args": {
        "url": "http://127.0.0.1:8910/tickets"
      },
      "label": "open /tickets"
    },
    {
      "action": "reload",
      "args": {},
      "label": "force fresh load"
    },
    {
      "action": "wait_for",
      "args": {
        "kind": "selector",
        "selector": "#tbl tbody tr[data-id=\"3\"] button.close",
        "state": "visible",
        "timeout": 8000
      },
      "label": "wait list rendered",
      "anchors": [
        {
          "text": "关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#tbl tbody tr[data-id=\"3\"] td:nth-child(4) .pill",
        "text": "open"
      },
      "label": "#3 is open (precondition)",
      "anchors": [
        {
          "text": "closed"
        },
        {
          "selector": "#tbl tbody tr[data-id=\"3\"] td:nth-child(4) .pill"
        }
      ]
    },
    {
      "action": "click",
      "args": {
        "selector": "#tbl tbody tr[data-id=\"3\"] button.close"
      },
      "expectChange": {
        "watch": {
          "selector": "#dlg[open]"
        }
      },
      "label": "click 关闭 on #3",
      "anchors": [
        {
          "text": "关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#dlgmsg",
        "text": "确认关闭工单 #3?"
      },
      "label": "confirm dialog shown",
      "anchors": [
        {
          "text": "确认关闭工单 #3?"
        },
        {
          "selector": "#dlgmsg"
        }
      ]
    },
    {
      "action": "click",
      "args": {
        "selector": "#dlg #yes"
      },
      "expectChange": {
        "watch": {
          "selector": "#tbl tbody tr[data-id=\"3\"] td:nth-child(4) .pill"
        }
      },
      "label": "click 确认",
      "anchors": [
        {
          "text": "确认"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#toast",
        "text": "已关闭 #3"
      },
      "label": "server accepted close",
      "anchors": [
        {
          "text": "已关闭 #3"
        },
        {
          "selector": "#toast"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#tbl tbody tr[data-id=\"3\"] td:nth-child(4) .pill",
        "text": "closed"
      },
      "label": "row 3 now closed",
      "anchors": [
        {
          "text": "closed"
        },
        {
          "selector": "#tbl tbody tr[data-id=\"3\"] td:nth-child(4) .pill"
        }
      ]
    }
  ]
}
```
