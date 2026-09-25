---
name: bench-urgent-page2
description: 复跑一段录好的浏览器操作「Bench 工单台: 筛出「未关闭 + 紧急」的工单并逐行确认关闭, 断言列表清空 (含分页兜底)」—— 共 8 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 筛出「未关闭 + 紧急」的工单并逐行确认关闭, 断言列表清空 (含分页兜底)

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-urgent-page2" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/tickets` (打开工单台)
2. 刷新 (强制重载 (重置筛选与分页))
3. 等待 `#tbl tbody tr` (等列表渲染)
4. 选择 `#st` (状态=未关闭)
5. 选择 `#pr` (优先级=紧急)
6. repeat
7. 断言 `#pginfo` (断言: 紧急且未关闭已清零)
8. 断言 `#empty` (断言: 空列表提示)

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-urgent-page2",
  "description": "Bench 工单台: 筛出「未关闭 + 紧急」的工单并逐行确认关闭, 断言列表清空 (含分页兜底)",
  "createdAt": "2026-09-10T15:55:15.765Z",
  "updatedAt": "2026-09-10T15:55:15.765Z",
  "healCount": 0,
  "steps": [
    {
      "action": "navigate",
      "args": {
        "url": "http://127.0.0.1:8910/tickets"
      },
      "label": "打开工单台"
    },
    {
      "action": "reload",
      "label": "强制重载 (重置筛选与分页)"
    },
    {
      "action": "wait_for",
      "args": {
        "selector": "#tbl tbody tr",
        "timeout": 6000
      },
      "label": "等列表渲染"
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#st",
        "value": "open"
      },
      "expectChange": {
        "watch": {
          "selector": "#pginfo"
        },
        "timeoutMs": 8000
      },
      "label": "状态=未关闭",
      "anchors": [
        {
          "text": "全部状态\n未关闭\n已关闭"
        }
      ]
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#pr",
        "value": "urgent"
      },
      "expectChange": {
        "watch": {
          "selector": "#pginfo"
        },
        "timeoutMs": 8000
      },
      "label": "优先级=紧急",
      "anchors": [
        {
          "text": "全部优先级\n紧急\n高\n普通\n低"
        }
      ]
    },
    {
      "action": "repeat",
      "untilGone": "#tbl tbody tr",
      "do": [
        {
          "action": "click",
          "args": {
            "selector": "#tbl tbody tr:first-child button.close"
          },
          "expectChange": {
            "watch": {
              "selector": "#dlgmsg"
            }
          }
        },
        {
          "action": "click",
          "args": {
            "selector": "#yes"
          },
          "expectChange": {
            "watch": {
              "selector": "#pginfo"
            }
          }
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 0 条",
        "timeout": 8000
      },
      "label": "断言: 紧急且未关闭已清零",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 0 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "visible",
        "selector": "#empty",
        "timeout": 8000
      },
      "label": "断言: 空列表提示",
      "anchors": [
        {
          "text": "没有符合条件的工单"
        }
      ]
    }
  ]
}
```
