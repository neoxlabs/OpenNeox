# 风格预设 (默认起点: 没有更好的整体设计时 8 选 1, token 抄进 :root)

通用字体栈 (国内外都不用下载):
```css
--font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", Roboto, sans-serif;
--font-serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", SimSun, Georgia, serif;
--font-mono: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
```

| 预设 | 适合 | 气质 |
|---|---|---|
| business 商务蓝 | 企业官网、产品介绍、方案、SaaS | 可信、清爽、信息清楚 |
| edu 清新教育 | 课程介绍、班级主页、学习资料、知识卡片 | 温和、友好、易读 |
| tech-dark 科技深色 | AI / 开发者产品、发布会、技术分享 | 冷静、精密、高级 |
| editorial 杂志编辑 | 年度报告、长文、故事、个人博客 | 有文化感、阅读感强 |
| event 活动 H5 | 邀请函、活动报名、促销、发布会预热 | 醒目、有冲击力、移动优先 |
| minimal 极简作品集 | 个人主页、简历、设计作品集、摄影 | 克制、留白、作品为主 |
| dashboard 数据看板 | 报表、监控、运营大屏 | 中性、密度高、数字优先 |
| guochao 国潮暖色 | 节日、传统文化、茶饮餐饮、文创 | 东方、温暖、有仪式感 |

---

## business 商务蓝
```css
:root{--bg:#F7F9FC;--surface:#FFFFFF;--text:#16233A;--muted:#5B6B82;--line:#E3E8F0;--accent:#2563EB;--accent-soft:#E8EFFE;--radius:10px;--shadow:0 1px 2px rgba(16,35,64,.06),0 8px 24px rgba(16,35,64,.06);--font-head:var(--font-sans)}
@media (prefers-color-scheme:dark){:root{--bg:#0E1420;--surface:#151D2B;--text:#E6ECF5;--muted:#93A1B5;--line:#253045;--accent:#5B8DEF;--accent-soft:#1B2A45}}
```
标题 600 字重、字距 -0.01em; 区块交替白底 / 浅灰底; 主按钮实心蓝, 次按钮描边; 截图 / 产品图放浅色圆角框里加 --shadow。

## edu 清新教育
```css
:root{--bg:#FBF8F3;--surface:#FFFFFF;--text:#2B2A26;--muted:#6E6A60;--line:#ECE6DA;--accent:#2E9E6B;--accent-2:#F2A541;--accent-soft:#E6F4EC;--radius:18px;--shadow:0 6px 20px rgba(60,50,30,.08);--font-head:var(--font-sans)}
@media (prefers-color-scheme:dark){:root{--bg:#1B1A17;--surface:#24231F;--text:#EEE9DF;--muted:#A9A397;--line:#36342E;--accent:#4CC48E;--accent-soft:#1F3329}}
```
大圆角卡片; 绿色做主色, 橙色只点缀 (标签、星标); 章节标题前放一个圆形色块图标; 用编号步骤 (①②③) 讲流程。

## tech-dark 科技深色
```css
:root{--bg:#0A0D14;--surface:#11161F;--text:#E8EDF5;--muted:#8A95A8;--line:#1E2633;--accent:#6E8BFF;--accent-soft:rgba(110,139,255,.12);--radius:12px;--shadow:0 0 0 1px var(--line);--font-head:var(--font-sans)}
```
(只做深色) 背景加淡网格 `background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:48px 48px` 再用径向渐变压暗四周; 大标题可用 `background:linear-gradient(180deg,#fff,#9AA6BD);-webkit-background-clip:text;color:transparent`; 代码 / 数字用 --font-mono; 强调色只用一个, 不要紫粉渐变满屏。

## editorial 杂志编辑
```css
:root{--bg:#F6F2EA;--surface:#FFFDF8;--text:#1C1A17;--muted:#6B655B;--line:#D9D1C3;--accent:#B5281E;--radius:2px;--shadow:none;--font-head:var(--font-serif)}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--surface:#1E1B18;--text:#ECE6DA;--muted:#A49C8E;--line:#3A352F;--accent:#E0574A}}
```
标题衬线、很大 (48–72px)、字重 700; 细分隔线代替卡片阴影; 正文单栏 680px 宽; 首段首字下沉可选; 引用用大号衬线 + 左侧红线; 数字用衬线大号。

## event 活动 H5
```css
:root{--bg:#FFF4E8;--surface:#FFFFFF;--text:#231A12;--muted:#7A6555;--line:#F1DCC6;--accent:#FF5A36;--accent-2:#1F2A44;--radius:20px;--shadow:0 10px 30px rgba(255,90,54,.18);--font-head:var(--font-sans)}
```
(只做浅色, 移动优先: 先按 390px 设计, 桌面居中 480px 宽的「手机框」或放大版面) 首屏: 超大日期 / 标题 (字重 800, 56px+), 色块拼贴背景; 信息块: 时间 · 地点 · 嘉宾 · 流程; 底部固定一个全宽主按钮 (报名 / 立即参加); 倒计时用大号数字。

## minimal 极简作品集
```css
:root{--bg:#FFFFFF;--surface:#FFFFFF;--text:#111111;--muted:#6F6F6F;--line:#EAEAEA;--accent:#111111;--radius:6px;--shadow:none;--font-head:var(--font-sans)}
@media (prefers-color-scheme:dark){:root{--bg:#0F0F0F;--surface:#151515;--text:#F2F2F2;--muted:#9A9A9A;--line:#262626;--accent:#F2F2F2}}
```
大量留白 (区块间 120px+); 名字 / 标题超大、字重 600、字距 -0.02em; 作品网格 2–3 列, 图片 4:3 统一裁切, hover 轻微放大; 文字链接下划线式交互; 不用彩色, 作品自己是颜色。

## dashboard 数据看板
```css
:root{--bg:#F4F6F9;--surface:#FFFFFF;--text:#1A2233;--muted:#667085;--line:#E4E7EC;--accent:#3366FF;--radius:12px;--shadow:0 1px 2px rgba(16,24,40,.05);--font-head:var(--font-sans);
--c1:#3366FF;--c2:#16B39A;--c3:#F5A524;--c4:#E5484D;--c5:#8E6CEF;--c6:#7C8BA1}
@media (prefers-color-scheme:dark){:root{--bg:#0D1117;--surface:#151B23;--text:#E6EDF3;--muted:#8B97A7;--line:#2A313C;--accent:#5B8CFF}}
```
顶部 KPI 一排 (大数字 + 环比箭头 + 迷你趋势线); 下面 12 栅格放图表卡; 数据色按 --c1…--c6 顺序用, 同一指标全页同色; 涨绿跌红 (国内股票口径相反时按用户习惯); 卡片标题写结论。

## guochao 国潮暖色
```css
:root{--bg:#F4EBDD;--surface:#FBF6EE;--text:#2A1F1A;--muted:#7D6A5C;--line:#E2D3BE;--accent:#B8322A;--accent-2:#C9A063;--radius:4px;--shadow:0 6px 18px rgba(90,50,20,.10);--font-head:var(--font-serif)}
```
(只做浅色) 衬线标题, 可竖排 (`writing-mode:vertical-rl`) 做装饰标题; 朱红 + 金色点缀; 云纹 / 回纹用 SVG 细线画在角落; 印章感标签 (红底白字小方块); 避免大面积纯红。
