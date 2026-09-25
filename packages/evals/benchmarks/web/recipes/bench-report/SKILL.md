---
name: bench-report
description: 复跑一段录好的浏览器操作「Bench 工单台: 统计工单总数(23)/已关闭(5)/未分配(6) 并断言」—— 共 16 步, 不需要重新看页面写脚本。
---

# Bench 工单台: 统计工单总数(23)/已关闭(5)/未分配(6) 并断言

这是一段**录好的**浏览器操作。要复跑它, 调:

    browser_replay({ name: "bench-report" })

复跑不需要重新看页面、也不需要重新写选择器 —— 第一次已经花过那笔钱了。

## 步骤 (给人看的)

1. 打开 `http://127.0.0.1:8910/tickets` (打开工单页)
2. 执行脚本 (重置筛选并重载)
3. 断言 `#pginfo` (断言总数 23)
4. 断言 `#tbl tbody tr` (首页 10 行)
5. 选择 `#st` (筛已关闭)
6. 断言 `#pginfo` (断言已关闭 5)
7. 断言 `#tbl tbody tr` (已关闭行数 5)
8. 选择 `#st` (筛未关闭)
9. 断言 `#pginfo` (断言未关闭 18)
10. 选择 `#st` (清状态筛选)
11. 断言 `#pginfo` (回到全部 23)
12. 执行脚本 (翻页扫描未分配)
13. 选择 `#pr` (筛低优先级)
14. 断言 `#pginfo` (低优先级 6)
15. 断言 `#tbl tbody tr` (低优先级行数 6)
16. 断言 `#tbl tbody td span.muted` (断言未分配 6)

## 机器读的部分

⚠️ **回放只读下面这个代码块。** 上面那份步骤清单是给人看的说明, 改它不会改变行为 ——
要改行为就改下面的 JSON (改一个选择器、删一步、调一下 expectChange 都可以)。
两份真相里必须有一份说了算, 否则你会以为改了、其实没改。

```neox-browser-recipe
{
  "name": "bench-report",
  "description": "Bench 工单台: 统计工单总数(23)/已关闭(5)/未分配(6) 并断言",
  "createdAt": "2026-09-10T15:59:15.314Z",
  "updatedAt": "2026-09-10T15:59:15.314Z",
  "healCount": 0,
  "steps": [
    {
      "action": "navigate",
      "args": {
        "url": "http://127.0.0.1:8910/tickets"
      },
      "label": "打开工单页"
    },
    {
      "action": "eval",
      "args": {
        "expression": "async () => { const q=document.getElementById('q'), st=document.getElementById('st'), pr=document.getElementById('pr'); q.value=''; st.value=''; pr.value=''; st.dispatchEvent(new Event('input',{bubbles:true})); await load(); return document.getElementById('pginfo').textContent; }"
      },
      "label": "重置筛选并重载"
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 23 条",
        "timeout": 8000
      },
      "label": "断言总数 23",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 6 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "count",
        "selector": "#tbl tbody tr",
        "count": 10
      },
      "label": "首页 10 行"
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#st",
        "value": "closed"
      },
      "expectChange": {
        "watch": {
          "selector": "#tbl tbody tr"
        }
      },
      "label": "筛已关闭",
      "anchors": [
        {
          "text": "全部状态\n未关闭\n已关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 5 条"
      },
      "label": "断言已关闭 5",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 6 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "count",
        "selector": "#tbl tbody tr",
        "count": 5
      },
      "label": "已关闭行数 5"
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#st",
        "value": "open"
      },
      "expectChange": {
        "watch": {
          "selector": "#tbl tbody tr"
        }
      },
      "label": "筛未关闭",
      "anchors": [
        {
          "text": "全部状态\n未关闭\n已关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 18 条"
      },
      "label": "断言未关闭 18",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 6 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#st",
        "value": ""
      },
      "label": "清状态筛选",
      "anchors": [
        {
          "text": "全部状态\n未关闭\n已关闭"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 23 条"
      },
      "label": "回到全部 23",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 6 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "eval",
      "args": {
        "expression": "async () => { const st=document.getElementById('st'), pr=document.getElementById('pr'), q=document.getElementById('q'); st.value=''; pr.value=''; q.value=''; st.dispatchEvent(new Event('input',{bubbles:true})); const cells=[]; let guard=0; const grab=()=>{document.querySelectorAll('#tbl tbody tr').forEach(tr=>cells.push(tr.cells[4].textContent.trim()))}; grab(); while(document.getElementById('next') && !document.getElementById('next').disabled && guard++<10){ document.getElementById('next').click(); await new Promise(r=>setTimeout(r,20)); grab(); } const un=cells.filter(c=>c==='未分配').length; st.value=''; st.dispatchEvent(new Event('input',{bubbles:true})); const api=window.__all||[]; const report={pagesScanned:guard+1, rowsScanned:cells.length, total:api.length, closed:api.filter(t=>t.status==='closed').length, unassignedDom:un, unassignedApi:api.filter(t=>!t.assignee).length}; window.__benchReport=report; if(report.total!==23||report.closed!==5||report.unassignedDom!==6||report.unassignedDom!==report.unassignedApi){ throw new Error('统计不一致: '+JSON.stringify(report)); } return JSON.stringify(report); }"
      },
      "label": "翻页扫描未分配"
    },
    {
      "action": "select_option",
      "args": {
        "selector": "#pr",
        "value": "low"
      },
      "expectChange": {
        "watch": {
          "selector": "#tbl tbody tr"
        }
      },
      "label": "筛低优先级",
      "anchors": [
        {
          "text": "全部优先级\n紧急\n高\n普通\n低"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "text",
        "selector": "#pginfo",
        "text": "共 6 条"
      },
      "label": "低优先级 6",
      "anchors": [
        {
          "text": "第 1 / 1 页 · 共 6 条"
        },
        {
          "selector": "#pginfo"
        }
      ]
    },
    {
      "action": "expect",
      "args": {
        "kind": "count",
        "selector": "#tbl tbody tr",
        "count": 6
      },
      "label": "低优先级行数 6"
    },
    {
      "action": "expect",
      "args": {
        "kind": "count",
        "selector": "#tbl tbody td span.muted",
        "count": 6
      },
      "label": "断言未分配 6",
      "anchors": [
        {
          "text": "未分配"
        }
      ]
    }
  ]
}
```
