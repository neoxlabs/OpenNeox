---
name: bench-login
description: 复跑一段录好的浏览器操作「Bench 工单台: 用 admin/neox2026 登录并断言进入工单列表」—— 共 5 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 用 admin/neox2026 登录并断言进入工单列表

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-login" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/`
2. 填表
3. 点击 `登录`
4. 断言
5. 断言 `body`

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-login",
  "description": "Bench 工单台: 用 admin/neox2026 登录并断言进入工单列表",
  "createdAt": "2026-09-10T15:50:59.181Z",
  "updatedAt": "2026-09-10T15:50:59.181Z",
  "healCount": 0,
  "steps": [
    {
      "action": "navigate",
      "args": {
        "url": "http://127.0.0.1:8910/"
      }
    },
    {
      "action": "fill_form",
      "args": {
        "fields": [
          {
            "selector": "#u",
            "value": "admin"
          },
          {
            "selector": "#p",
            "value": "neox2026"
          }
        ]
      }
    },
    {
      "action": "click",
      "args": {
        "role": "button",
        "name": "登录"
      },
      "expectChange": {
        "watch": "url"
      },
      "anchors": [
        {
          "text": "登录"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "url",
        "pattern": "**/tickets"
      }
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "body",
        "text": "已登录: admin"
      },
      "anchors": [
        {
          "selector": "body"
        }
      ]
    }
  ]
}
```
