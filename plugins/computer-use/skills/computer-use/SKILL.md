---
name: computer-use
description: 操作你电脑上的原生应用 —— 读界面元素、点按钮、填表单、按快捷键。目标是网页时不要用这个 (用浏览器工具), 终端也不要用 (用 shell 工具)。
---

# 操作原生应用 (macOS / Windows)

两个工具，就两个：`computer_snapshot` 看，`computer_run` 做。

## 基本节奏

**看一眼 → 写一段长脚本 → 只在失败时再看。**

```
computer_snapshot({app: "备忘录"})
  → 122. [Button] 新建
     130. [TextArea]
     ...

computer_run({app: "备忘录", steps: [
  {action: "click",     target: 122, label: "新建",   expectChange: {watch: {label: "新建备忘录"}}},
  {action: "set_value", target: 130, text: "会议纪要"},
  {action: "key",       key: "return"}
]})
```

不要一次只写一两步再回来看。脚本里一个动作 0–130ms，而你每回来一次就是一次完整的模型往返（约 4 秒）——**往返次数是唯一真正的成本**。`computer_run` 每次返回都自带 `screen`（当前界面现状），所以不需要额外调 snapshot 去"再看一眼"。

## expectChange：会改界面的步骤必须带

没有它，"点了但什么也没发生"会被当成成功，后面每一步都建立在错误前提上。

- `{watch: {label: "只在目标界面才有的文字"}}` —— **首选**，精确
- `{watch: {count: "ListItem"}}` —— 某类角色的数量变化。**角色名按平台给**：
  Windows 上是 `Button` / `Edit` / `ListItem` / `Text` / `TabItem`（UI Automation 的名字），
  macOS 上是 `AXButton` / `AXTextField` / `AXRow`（辅助功能的名字）。以 snapshot 里显示的为准。
- `{watch: "screen"}` —— 兜底，不知道目标界面长什么样时用

失败回报会分清两件事：**"元素找不到"**（编号写错了）和 **"点了没反应"**（元素对但动作没生效）。这两个的处置完全不同，别混着重试。

## 几条硬规矩

**编号只能来自 `computer_snapshot`，不能自己编。** 界面变过之后编号会自动重定位，但前提是那个编号确实是感知出来的。

**没有 sleep/wait 这个动作。** 要等就用 `expectChange`，它一变就走。写固定睡眠只会白白烧掉几秒。

**`set_value` 比 `type` 快一个量级。** 往输入框里塞文字优先用 `set_value`（直接写值），只有需要触发按键事件时才 `type`。元素不接受写值时运行时会自动改成键入，脚本不会因此卡死。

**网页不要用这个。** 目标是浏览器里的页面就用浏览器工具，那条路精确得多也快得多。

**终端不要用这个。** 用 shell 工具，又快又可审计。

## 一条路，任何应用

`computer_snapshot` 看，`computer_run` 做。弹层开着就扫弹层，关掉再扫主窗。编号表里有的就 `press` / `set_value`；表是空的（`axBlind`）就看附带截图、用 `click_at` 按比例点。**不要为某个软件、某个菜单预先记路径**，agent 自己看表、看图。

Windows 上同一套办公软件常有多个窗口（文字 / 演示 / 表格都叫类似进程名）。`app` **填你要操作的那扇窗的标题**（例如「演示文稿1 - WPS 2019」），不要只填 `wps` —— 否则会控到另一扇文档窗。

**`axBlind: true`** —— 没元素树（自绘界面，或这类窗口在辅助功能上会卡住）。**别硬编编号**。看截图，`click_at` 的 dx/dy 是窗口内 0~1 的比例。功能区/下拉图库常靠停住才展开时用 `hover`（同样的 dx/dy，只移光标不点），不要用 click_at 去「点开再被点关」。双击用 `double_click`，拖选用 `drag`（dx/dy 起点、dx2/dy2 终点），滚内容区用 `scroll`（同样的 dx/dy，滚轮落在截图上那一点），右键菜单用 `show_menu`（同样的 dx/dy），往自绘输入框打字用 `type` 带同样的 dx/dy（先点再打，焦点不丢）。点开菜单后下一步会自动稍等再点，不必插 sleep。会话列表/消息气泡经常是 Text：会编进可点清单，`click` 打到文字中心。点开表情 / @ 列表后等树变长（回执自带截图）；大弹层还开着时先 `escape` 再点发送，否则字会进搜索框。小且有名字的工具栏图（图片/文件）按编号点；「发送」右边没名字的小按钮是「发送菜单」。

**Java / Swing** 接到 Access Bridge 时和记事本一样走编号。模态对话框、属主弹出层（菜单、浮动列表）在桥上会卡住工作线程，这时 snapshot 会变成 `axBlind` 并附截图，照样用 `click_at`。不要改用某个软件的 MCP / HTTP API。树空且不是模态窗时，才是 JVM 没把辅助功能打开。

Windows 上 Java 应用的效率要点（通用，不是某个 IDE 的菜单配方）：
- `app` 用产品名或进程名都可以（`IntelliJ IDEA` / `idea64` 都能找到）
- `key` 认具名键和写在 key 里的和弦：`insert`、`alt+insert`、`ctrl+alt+shift+s`。不要把组合键拆成先按 `alt` 再按 `1`
- **不要**在 `computer_run` 里插 `snapshot` 步骤、也**不要**给 Java 的 `key` / `type` 挂 `expectChange`：回执自带 `screen`，弹出层对不上 JAB 签名，空等 6–8 秒还可能把工作线程堵死。弹出层看图 `click_at`
- 一次脚本多写几步，感知（dump）在 Java 主窗上可能要几秒，每多一次模型往返更贵
- `computer_run` 在 Java 快捷键之后会等几百毫秒再拍屏。回执里的 `screen` 才是弹出后的界面；不要因为「刚按完还像主窗」就立刻重发同一组快捷键

**Electron 系应用**（QQ、VS Code、Slack…）能操作，但有两个脾气：
- 感知比原生应用慢（几百毫秒到 1 秒），所以更要一次写长脚本
- 切换界面后**旧界面的节点会在树里滞留一会儿**，`digest` 可能同时显示两个界面的内容。判断当前在哪个界面要用精确的 label 断言，别读 `digest` 下结论
- Windows 上第一次 snapshot 可能 `axBlind`（Chromium 还没把 UIA 树填满）。**看附带的那张图**，用 `click_at`。不要 `readfile` 截图路径，不要 `write_file` 写 OCR/PowerShell，不要用 shell 自己抠界面——截图已经作为图片进对话。`click_at` / `axBlind` 不要挂 6–8 秒的 `expectChange`（元素树对不上像素变化，只会空等）

## 平台差异（先看这一节，能省一整轮往返）

| | macOS | Windows |
|---|---|---|
| 底层 | 辅助功能 (AX) + CGEvent | UI Automation + SendInput；Java/Swing 再走 Java Access Bridge（同一套编号） |
| 授权 | 需要「辅助功能 + 屏幕录制」两项 | 同级应用直接可用。管理员应用要 **真权限**: 人点一次 UAC 把桥升到管理员完整性（`computer_check_access({prompt:true})`）。UAC 同意框本身必须由人点，不要代点。 |
| `press` / `set_value` / `focus` | 不抢焦点、不动光标，应用在后台也能操作 | 同样不抢焦点、不动光标 |
| `type` / `key` / `click_at` | 定向发给目标进程，后台也能收 | **需要目标窗口在前台，而且会真的移动鼠标** |
| `select_text` | 支持按文本片段选中 | 不支持 —— 用 `key` 发 `ctrl+a` 全选，或用 `set_value` 整段覆盖 |
| `icon` | 支持 | 不支持（卡片 logo 退成首字母，不影响操作） |

所以在 Windows 上：**能用 `set_value` 就别用 `type`**；用 `type` / `key` 时要知道脸会被抢过去（用户正在做的事会被打断），做完尽量把话说明白。

## 权限 / 自检

**macOS**: 授权条目是「Neox Computer Use」（辅助功能 + 屏幕录制两项），不是「Neox」。失败时先调 `computer_check_access` 看状态；`prompt: true` 会把系统窗和设置页一起开出来。

**macOS 上报错时别退回 shell 自己抠界面**（`screencapture` / `osascript` 遍历 AX 树）。shell 里截屏记在「Neox」名下，会弹屏幕录制授权窗，拿到的只有壁纸；AppleScript 逐层遍历一次十几秒。按报错里的 `hint` 改参数重试，还不行就如实告诉用户。

**Windows**: 普通应用不需要授权。`computer_check_access` 失败只意味着**桥不在或起不来**。若失败码是 `need_elevation`，目标是管理员完整性：再调 `computer_check_access({prompt: true})`，请用户点一次 Windows UAC「是」。UAC 同意框（consent.exe）永远由人点，不要改用别的办法绕。

**Windows 上报错时也别退回 shell 自己抠界面**（`screencapture` 没有对应物：不要 `Add-Type` 截屏、不要 Windows OCR、不要往仓外 `write_file`）。按工具回执里的图和 `hint` 改参数重试。`expectChange.watch` 必须是 `"screen"` / `{"label":"..."}` / `{"count":"Button"}`，空对象会直接被拒。

## 用户始终看得见

`computer_run` 每次调用都会弹审批卡，卡上逐条列出你要执行的动作。这是设计如此——鼠标点击没法静态判断风险，"点第 7 个按钮"可能是关窗口也可能是转账，所以由人来判。
（只有用户把档位调到 dangerous「完全无人托管」时才不弹。）

macOS 上操作全程走辅助功能接口：**不移动用户的鼠标、不抢焦点**，目标应用在后台也能操作。
Windows 上 `press` / `set_value` 同样如此，但 `type` / `key` / `click_at` 会占用前台——这是系统输入模型的限制，不是实现取舍。
