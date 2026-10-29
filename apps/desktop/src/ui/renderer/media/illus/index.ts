import illusAgent from './agent.webp';
import illusAnywhere from './anywhere.webp';
import illusBoard from './board.webp';
import illusClean from './clean.webp';
import illusCode from './code.webp';
import illusDocx from './docx.webp';
import illusFiles from './files.webp';
import illusGit from './git.webp';
import illusImage from './image.webp';
import illusKnowledge from './knowledge.webp';
import illusLife from './life.webp';
import illusMcp from './mcp.webp';
import illusMemory from './memory.webp';
import illusNomatch from './nomatch.webp';
import illusOnboardCode from './onboard-code.webp';
import illusOnboardWork from './onboard-work.webp';
import illusAboutRadar from './about-radar.webp';
import illusCtxCompact from './ctx-compact.webp';
import illusRouteFailover from './route-failover.webp';
import illusRouteHero from './route-hero.webp';
import illusCtxHero from './ctx-hero.webp';
import illusCtxTank from './ctx-tank.webp';
import illusUpdateReady from './update-ready.webp';
import illusFitEdit from './fit-edit.webp';
import illusSaDepth from './sa-depth.webp';
import illusSaHero from './sa-hero.webp';
import illusSaTeam from './sa-team.webp';
import illusSaTitle from './sa-title.webp';
import illusStoreBackup from './store-backup.webp';
import illusStoreClean from './store-clean.webp';
import illusStoreHero from './store-hero.webp';
import illusExpHero from './exp-hero.webp';
import illusExpFgts from './exp-fgts.webp';
import illusExpPtc from './exp-ptc.webp';
import illusExpSnap from './exp-snap.webp';
import illusExpParse from './exp-parse.webp';
import illusExpJev from './exp-jev.webp';
import illusRemoteHero from './remote-hero.webp';
import illusRemoteLan from './remote-lan.webp';
import illusRemoteCloud from './remote-cloud.webp';
import illusCodeHero from './code-hero.webp';
import illusCodeRebuild from './code-rebuild.webp';
import illusCodeExclude from './code-exclude.webp';
import illusMemHero from './mem-hero.webp';
import illusMemRemember from './mem-remember.webp';
import illusMemRecent from './mem-recent.webp';
import illusMemAuto from './mem-auto.webp';
import illusWebHero from './web-hero.webp';
import illusWebNative from './web-native.webp';
import illusWebBocha from './web-bocha.webp';
import illusWebSerper from './web-serper.webp';
import illusWebCustom from './web-custom.webp';
import illusMcpHero from './mcp-hero.webp';
import illusSkillHero from './skill-hero.webp';
import illusApiHero from './api-hero.webp';
import illusAgentCommit from './agent-commit.webp';
import illusAgentSandbox from './agent-sandbox.webp';
import illusAgentRedact from './agent-redact.webp';
import illusAgentTerminal from './agent-terminal.webp';
import illusAgentModel from './agent-model.webp';
import illusBrowserHero from './browser-hero.webp';
import illusConvType from './conv-type.webp';
import illusProfileHero from './profile-hero.webp';
import illusBillingHero from './billing-hero.webp';
import illusUsageHero from './usage-hero.webp';
import illusEditorHero from './editor-hero.webp';
import illusTtsHero from './tts-hero.webp';
import illusGithubHero from './github-hero.webp';
import illusRedeemHero from './redeem-hero.webp';
import illusConvComposerStd from './conv-composer-std.webp';
import illusConvComposerMin from './conv-composer-min.webp';
import illusConvDensityMin from './conv-density-min.webp';
import illusConvDensityNormal from './conv-density-normal.webp';
import illusConvDensityFull from './conv-density-full.webp';
import illusNotifyHero from './notify-hero.webp';
import illusNotifySound from './notify-sound.webp';
import illusNotifyQuiet from './notify-quiet.webp';
import illusFitHero from './fit-hero.webp';
import illusFitNote from './fit-note.webp';
import illusFitRetry from './fit-retry.webp';
import illusFitSerial from './fit-serial.webp';
import illusFitStrict from './fit-strict.webp';
import illusFitTrunc from './fit-trunc.webp';
import illusModeAgent from './mode-agent.webp';
import illusRunCloud from './run-cloud.webp';
import illusRunLocal from './run-local.webp';
import illusModeChat from './mode-chat.webp';
import illusPdf from './pdf.webp';
import illusPermAuto from './perm-auto.webp';
import illusPermManual from './perm-manual.webp';
import illusPermYolo from './perm-yolo.webp';
import illusPet from './pet.webp';
import illusPlan from './plan.webp';
import illusPptx from './pptx.webp';
import illusQuota from './quota.webp';
import illusRouting from './routing.webp';
import illusSheet from './sheet.webp';
import illusSkill from './skill.webp';
import illusDiagHero from './diag-hero.webp';
import illusShareHero from './share-hero.webp';
import illusStyleCode from './style-code.webp';
import illusStyleConcise from './style-concise.webp';
import illusStyleDetailed from './style-detailed.webp';
import illusStyleStandard from './style-standard.webp';
import illusTask from './task.webp';
import illusTeam from './team.webp';
import illusWeb from './web.webp';
import illusWork from './work.webp';

export const NeoxIllus = {
  /** 一句话 → 三块工具 → 一份成品。用于"还没有东西/还没跑过"这类通用空态 */
  agent: illusAgent,
  /** 手机 · 云 · 电脑一根线串起来。用于连接/运行位置相关 */
  anywhere: illusAnywhere,
  board: illusBoard,
  /** 空的收纳托盘 + 归位的一叠 + 一枚蓝勾。用于**"都处理完了"**这类好状态空态
   *  (Git 工作区干净、收件箱清空)。跟 agent/files 那种"还没有东西"的真空态分开:
   *  一个是"做完了", 一个是"还没开始", 表情不该一样。 */
  clean: illusClean,
  /** 笔电 + 代码行 + 文件层。用于代码/项目相关 */
  code: illusCode,
  /** 立着的文档 + 平放的纸 + 笔筒 + 笔。用于 Word / .docx */
  docx: illusDocx,
  /** 文件架 + 立着的文件卡 + 一叠 + 散页。用于文件管理器空态 */
  files: illusFiles,
  /** 底板上一串提交节点 + 一条分叉。用于 Git / 版本历史 */
  git: illusGit,
  /** 两张图叠着。用于图片工作台 */
  image: illusImage,
  /** 竖排的板 + 一张摊开的。用于知识库 */
  knowledge: illusKnowledge,
  /** 一部手机 + 飘出的文字条。用于对话相关 */
  life: illusLife,
  /** 底座 + 三个接头, 留一个空槽。用于 MCP 服务器 */
  mcp: illusMcp,
  /** 层叠的薄板, 抽出一张。用于记忆 */
  memory: illusMemory,
  /** 放大镜横搭在一叠空白卡片上 + 旁边一个空槽。用于**筛过之后什么都没剩下**
   *  (搜索无结果 / 过滤没匹配)。跟 clean (做完了) 和 agent/files (还没开始) 是三件事:
   *  这一张说的是"东西可能在, 只是你这个条件没捞着", 所以画的是工具而不是空容器。 */
  nomatch: illusNomatch,
  onboardWork: illusOnboardWork,
  /** 引导页「编码」卡: 代码窗 (一行是蓝的) + 终端块 + 分支。出图流程同上 */
  onboardCode: illusOnboardCode,
  /** 折角的纸堆 + 后面立着一张。用于 PDF */
  pdf: illusPdf,
  runLocal: illusRunLocal,
  runCloud: illusRunCloud,
  diagHero: illusDiagHero,
  shareHero: illusShareHero,
  styleStandard: illusStyleStandard,
  styleConcise: illusStyleConcise,
  styleDetailed: illusStyleDetailed,
  styleCode: illusStyleCode,
  fitHero: illusFitHero,
  fitStrict: illusFitStrict,
  fitRetry: illusFitRetry,
  fitSerial: illusFitSerial,
  fitTrunc: illusFitTrunc,
  /** 贴满补丁的旧页 + 立着的蓝色整页 (老是改不对文件 → 整文件重写) */
  fitEdit: illusFitEdit,
  /** 小钉板上一张蓝色便签 + 一支笔 (给这个模型写专属叮嘱) */
  fitNote: illusFitNote,
  ctxHero: illusCtxHero,
  ctxTank: illusCtxTank,
  updateReady: illusUpdateReady,
  ctxCompact: illusCtxCompact,
  storeHero: illusStoreHero,
  storeBackup: illusStoreBackup,
  storeClean: illusStoreClean,
  expHero: illusExpHero,
  expFgts: illusExpFgts,
  expPtc: illusExpPtc,
  expSnap: illusExpSnap,
  expParse: illusExpParse,
  expJev: illusExpJev,
  remoteHero: illusRemoteHero,
  remoteLan: illusRemoteLan,
  remoteCloud: illusRemoteCloud,
  codeHero: illusCodeHero,
  codeRebuild: illusCodeRebuild,
  codeExclude: illusCodeExclude,
  memHero: illusMemHero,
  memRemember: illusMemRemember,
  memRecent: illusMemRecent,
  memAuto: illusMemAuto,
  webHero: illusWebHero,
  webNative: illusWebNative,
  webBocha: illusWebBocha,
  webSerper: illusWebSerper,
  webCustom: illusWebCustom,
  mcpHero: illusMcpHero,
  skillHero: illusSkillHero,
  apiHero: illusApiHero,
  agentCommit: illusAgentCommit,
  agentSandbox: illusAgentSandbox,
  agentRedact: illusAgentRedact,
  agentTerminal: illusAgentTerminal,
  agentModel: illusAgentModel,
  browserHero: illusBrowserHero,
  convType: illusConvType,
  convComposerStd: illusConvComposerStd,
  convComposerMin: illusConvComposerMin,
  convDensityMin: illusConvDensityMin,
  convDensityNormal: illusConvDensityNormal,
  convDensityFull: illusConvDensityFull,
  notifyHero: illusNotifyHero,
  notifySound: illusNotifySound,
  notifyQuiet: illusNotifyQuiet,
  profileHero: illusProfileHero,
  billingHero: illusBillingHero,
  usageHero: illusUsageHero,
  editorHero: illusEditorHero,
  ttsHero: illusTtsHero,
  githubHero: illusGithubHero,
  /** 订阅页「兑换与控制台」卡: 兑换券 (打孔是蓝的) 立在浏览器小窗前 —— 这张卡上的事都在网页里做 */
  redeemHero: illusRedeemHero,
  aboutRadar: illusAboutRadar,
  routeHero: illusRouteHero,
  routeFailover: illusRouteFailover,
  saHero: illusSaHero,
  saTitle: illusSaTitle,
  saDepth: illusSaDepth,
  saTeam: illusSaTeam,
  modeAgent: illusModeAgent,
  /** 对话方式 聊天: 两个立着的对话气泡, 前面小的是蓝的 */
  modeChat: illusModeChat,
  permAuto: illusPermAuto,
  /** manual: 传送带上一个方块停在放大镜 (蓝圈) 下 —— 每一步都过目 */
  permManual: illusPermManual,
  /** dangerous: 敞开的拱门 + 一路通过的方块, 地上一块蓝色箭头砖 —— 都不问 */
  permYolo: illusPermYolo,
  /** 空的圆形展示台 + 一个未开的箱子。用于桌宠 (刻意不画生物, 见 PetTab 注释) */
  pet: illusPet,
  /** 底座上一颗多面体。用于**订阅 / 套餐** (不是方案画布, 那个是 board) */
  plan: illusPlan,
  /** 立着的幻灯片 + 前面两张卡。用于 PowerPoint / .pptx */
  pptx: illusPptx,
  quota: illusQuota,
  /** 一条进来分成三条出去。用于模型路由 */
  routing: illusRouting,
  /** 网格板 + 旁边两根柱。用于表格 / .xlsx / .csv */
  sheet: illusSheet,
  /** 三个方块 + 一个空槽位。用于技能 */
  skill: illusSkill,
  /** 一块板上四个未勾的方框。用于任务 / 待办 */
  task: illusTask,
  /** 三根并排的柱子。用于团队 */
  team: illusTeam,
  /** 两个叠着的浏览器窗, 地址栏是蓝的。用于内嵌浏览器 */
  web: illusWeb,
  /** 桌面上的笔电 + 纸 + 笔。用于文档/工作相关 */
  work: illusWork,
} as const;

export type NeoxIllusName = keyof typeof NeoxIllus;

