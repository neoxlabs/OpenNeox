# 手艺: 让页面像设计师做的

## 一看就是 AI 生成的 (不要)
- 紫 / 粉 / 蓝的大面积渐变背景, 渐变文字到处用
- 所有东西居中; 一排三张一模一样的卡片 (图标 + 标题 + 一句话) 从头排到尾
- emoji 当图标 (🚀✨💡); 每个标题前都配图标
- 「赋能」「一站式」「领先的…平台」「为您提供优质服务」这类空话; Feature 1 / Lorem ipsum
- 灰色占位框写着「图片」; 假 logo 用色块糊弄
- 阴影很重、圆角忽大忽小、四五种强调色
- 每个区块都加进场动画、hover 时整卡大幅放大

## 要做的
- **层次靠字号和留白, 不靠颜色**: 标题 / 正文字号比 ≥ 2.2 倍; 区块之间留白明显大于区块内部
- **一个强调色**, 只用在主按钮、关键数字、当前状态上
- **网格对齐**: 内容最大宽 1120–1200px, 两侧对齐同一条线; 图文左右排时图占 55%
- **真实细节**: 具体数字 (「3 分钟出一份周报」)、具体人名和职位、具体日期地点
- **示意图用 HTML/CSS 画**: 产品界面画成带标题栏的窗口框, 里面放几行假数据和一个小图表, 比占位图好看得多

## 常用片段

按钮
```css
.btn{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 20px;border-radius:var(--radius);font:600 15px/1 var(--font-sans);border:1px solid transparent;cursor:pointer;transition:transform .15s ease,background .15s ease}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{transform:translateY(-1px)}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--line)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
```

区块与容器
```css
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
section{padding:96px 0}@media(max-width:640px){section{padding:64px 0}.wrap{padding:0 18px}}
.eyebrow{font:600 13px/1 var(--font-sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font:700 clamp(36px,6vw,64px)/1.1 var(--font-head);letter-spacing:-.02em}
h2{font:700 clamp(26px,3.6vw,40px)/1.2 var(--font-head)}
p{line-height:1.75;color:var(--muted)}
```

数字条
```html
<div class="stats"><div><b>3 分钟</b><span>出一份周报</span></div>…</div>
<style>.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:24px}.stats b{display:block;font:700 36px/1.1 var(--font-head);color:var(--text);font-variant-numeric:tabular-nums}.stats span{color:var(--muted);font-size:14px}</style>
```

线性图标 (24 视框, 1.75 描边; 其它图标照这个风格自己画路径)
```html
<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z"/><path d="M9 12l2 2 4-4"/></svg>
```

产品界面示意框
```html
<div class="mock"><div class="mock-bar"><i></i><i></i><i></i></div><div class="mock-body">…几行假数据 / 一个 SVG 小折线…</div></div>
<style>.mock{border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow);overflow:hidden}.mock-bar{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line)}.mock-bar i{width:10px;height:10px;border-radius:50%;background:var(--line)}.mock-body{padding:18px}</style>
```

进场动画 (只给首屏一处)
```css
@media (prefers-reduced-motion:no-preference){.rise{animation:rise .5s cubic-bezier(.2,.8,.2,1) both}@keyframes rise{from{opacity:0;transform:translateY(12px)}}}
```

## 截图自查清单 (1440 宽 + 390 宽各看一遍)
- [ ] 首屏 3 秒内看得懂这页是干嘛的、该点哪里
- [ ] 没有横向滚动、没有文字溢出 / 被裁、按钮没挤成两行
- [ ] 留白均匀: 没有忽大忽小的空隙, 左右边线对齐
- [ ] 只有一个强调色; 没有占位图 / 空话 / emoji 图标
- [ ] 深色模式下文字都看得清 (有做深色时)
- [ ] 中文: 全角标点, 中英文之间有空格, 行宽不超过约 36 字
