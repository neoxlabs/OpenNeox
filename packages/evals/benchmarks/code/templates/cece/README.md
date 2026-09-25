# 🐾 Cece 宠物管理系统

全功能宠物护理管理平台 — 追踪遛狗、喂食、健康、医疗、美容、提醒，支持家庭共享和数据洞察。

## 功能

### 核心模块
- **🐕 宠物管理** — 详细档案（芯片号、绝育、过敏、保险等 15+ 字段）
- **🦮 遛狗管理** — 记录时长/距离/路线/心情，活动目标追踪，趋势图表
- **🍖 喂食管理** — 喂食记录，食物库存管理，摄入量分析
- **💊 健康管理** — 疫苗、驱虫、体重、体温/BCS 等健康指标追踪
- **🏥 医疗记录** — 就诊记录、药品管理、服务商管理、附件上传
- **💇 美容护理** — 美容记录和护理计划
- **📅 护理计划** — 遛狗/喂食日程管理
- **🔔 提醒中心** — 自动生成提醒（疫苗/驱虫/复诊等），支持完成、贪睡、删除
- **📄 文档管理** — 疫苗证书、驱虫证明、医疗账单上传和查看

### 增强功能
- **🔍 全局搜索/筛选/分页** — 列表页统一搜索栏 + 宠物筛选 + 日期范围
- **📊 数据洞察** — 体重趋势、活动趋势、成本分析、连续打卡统计
- **👨‍👩‍👧‍👦 家庭共享** — 邀请已注册照护者，权限：仅查看 / 可编辑 / 可管理
- **📤 数据导出** — 健康与日常记录 CSV 导出（含可访问的共享宠物）
- **📑 月报 / 宠物身份证** — 按宠打印月报与身份卡片
- **🌗 深色模式** — 完整深色/浅色主题切换
- **📱 响应式 + 可安装 PWA** — 桌面/平板/手机适配；提供 manifest 与基础离线缓存（非完整离线应用）

### 已知边界
- 品种建议 `/breed/suggest` 目前为 **mock 数据**，非正式 AI 能力
- 库存、服务商等账号级资源不随宠物分享
- 邮件推送、PDF 导出、设备追踪等尚未实现
- 无完整自动化测试套件（仅有语法检查与启动烟测）

## 技术栈

- **后端**: Node.js + Express
- **视图**: EJS 模板引擎
- **数据库**: SQLite (better-sqlite3)
- **图表**: Chart.js
- **认证**: Session-based（CSRF + Helmet + 登录限流）

## 快速开始

```bash
# 安装依赖
npm install

# 初始化数据库 + 种子数据
npm run db:seed

# 启动服务
npm start

# 语法检查 + 启动烟测
npm test
```

访问 http://localhost:3000

> `npm run dev` 当前与 `npm start` 相同（直接 `node app.js`），未配置自动重启。

## 默认账号

种子数据会创建示例账号：
- 用户名: `admin` / 密码: `admin123`

## 项目结构

```
cece/
├── app.js              # 应用入口（配置、安全中间件、路由挂载）
├── config/
│   ├── database.js     # 数据库初始化 + 表定义
│   ├── pagination.js   # 通用分页/筛选工具
│   ├── scheduler.js    # 提醒定时任务
│   └── upload.js       # 文件上传配置
├── middleware/
│   └── auth.js         # 登录与宠物访问权限
├── utils/
│   └── access.js       # 可访问宠物聚合 / 记录级鉴权
├── models/             # 数据模型 (~18)
├── routes/             # 路由处理 (~17)
├── views/              # EJS 视图模板
│   ├── partials/       # 可复用组件
│   ├── pets/           # 宠物相关页面
│   ├── walks/          # 遛狗相关页面
│   ├── feedings/       # 喂食相关页面
│   ├── health/         # 健康相关页面
│   ├── medical/        # 医疗相关页面
│   ├── grooming/       # 美容相关页面
│   ├── reminders/      # 提醒相关页面
│   ├── documents/      # 文档管理页面
│   ├── family/         # 家庭共享页面
│   ├── dashboard/      # 数据总览
│   └── calendar/       # 日历视图
├── public/
│   ├── css/style.css   # 全局样式
│   ├── js/main.js      # 客户端脚本（含 CSRF 注入）
│   ├── icons/          # PWA 图标
│   ├── manifest.json   # Web App Manifest
│   ├── sw.js           # Service Worker（基础缓存）
│   └── uploads/        # 上传文件
└── database/
    └── seed.js         # 种子数据脚本
```

## 数据库表

| 表名 | 说明 |
|------|------|
| users | 用户账号 |
| pets | 宠物档案 (15+字段) |
| walks / walk_schedules | 遛狗记录 & 计划 |
| feedings / feeding_schedules | 喂食记录 & 计划 |
| vaccines / dewormings | 疫苗 & 驱虫 |
| weight_records | 体重记录 |
| health_metrics | 健康指标 (体温/BCS等) |
| medical_records / medications | 就诊 & 药品 |
| grooming_records / grooming_schedules | 美容记录 & 计划 |
| reminders | 提醒任务 |
| care_providers | 服务商 (兽医等) |
| food_inventory | 食物库存 |
| activity_goals | 活动目标 |
| pet_shares | 家庭共享 |
| documents | 文档附件 |
| attachments | 医疗附件 |
