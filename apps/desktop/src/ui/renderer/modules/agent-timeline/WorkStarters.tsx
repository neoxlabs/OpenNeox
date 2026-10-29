import React from 'react';
import { PPTX_AVAILABLE } from '../surface/pptxAvailability';
import aTranslate from './starters-art/s-translate.webp?inline';
import aPolish from './starters-art/s-polish.webp?inline';
import aSlides from './starters-art/s-slides.webp?inline';
import aVideo from './starters-art/s-video.webp?inline';
import aFigure from './starters-art/s-figure.webp?inline';
import aSheet from './starters-art/s-sheet.webp?inline';
import aHomework from './starters-art/s-homework.webp?inline';
import aReading from './starters-art/s-reading.webp?inline';
import aOutline from './starters-art/s-outline.webp?inline';
import aQuiz from './starters-art/s-quiz.webp?inline';
import aDefense from './starters-art/s-defense.webp?inline';
import aResume from './starters-art/s-resume.webp?inline';
import aWeekly from './starters-art/s-weekly.webp?inline';
import aMinutes from './starters-art/s-minutes.webp?inline';
import aEmail from './starters-art/s-email.webp?inline';
import aReport from './starters-art/s-report.webp?inline';
import aAnalysis from './starters-art/s-analysis.webp?inline';
import aResearch from './starters-art/s-research.webp?inline';
import aTravel from './starters-art/s-travel.webp?inline';
import aImage from './starters-art/s-image.webp?inline';
import aContract from './starters-art/s-contract.webp?inline';
import aRecipe from './starters-art/s-recipe.webp?inline';
import aFitness from './starters-art/s-fitness.webp?inline';
import aStory from './starters-art/s-story.webp?inline';
import cExplain from './starters-art/c-explain.webp?inline';
import cBug from './starters-art/c-bug.webp?inline';
import cFeature from './starters-art/c-feature.webp?inline';
import cTest from './starters-art/c-test.webp?inline';
import cReview from './starters-art/c-review.webp?inline';
import cNewapp from './starters-art/c-newapp.webp?inline';

interface Starter {
  key: string;
  title: [string, string];
  sub: [string, string];
  text: [string, string];
  /** 要先给文件 */
  file?: boolean;
  art: string;
}

type Persona = 'teacher' | 'student' | 'office' | 'life';

export const PERSONAS: Array<{ key: Persona; label: [string, string] }> = [
  { key: 'teacher', label: ['老师', 'Teachers'] },
  { key: 'student', label: ['学生', 'Students'] },
  { key: 'office', label: ['上班族', 'At work'] },
  { key: 'life', label: ['生活', 'Life'] },
];

export const STARTERS: Record<Persona, Starter[]> = {
  teacher: [
    {
      key: 'translate', art: aTranslate, file: true,
      title: ['翻译文档', 'Translate a document'],
      sub: ['PDF / Word 整篇翻译，排版不变', 'Whole PDF / Word file, layout kept'],
      text: ['把这份文档翻译成【中文】，保留原来的排版和图表，专业术语按本学科的习惯译法，译完存成 Word。', 'Translate this document into 【English】, keep the layout and figures, use the field’s standard terminology, and save it as a Word file.'],
    },
    {
      key: 'polish', art: aPolish, file: true,
      title: ['润色论文', 'Polish a paper'],
      sub: ['改语病、理顺逻辑，改动处标出来', 'Fix grammar and flow, changes marked'],
      text: ['帮我润色这篇论文：改语病和不通顺的地方，理顺逻辑，不改原意，改过的地方标出来。重点看【摘要和引言】。', 'Polish this paper: fix grammar and awkward sentences, tighten the logic, keep the meaning, and mark every change. Focus on 【the abstract and introduction】.'],
    },
    {
      key: 'slides', art: aSlides,
      title: ['做课件 PPT', 'Make slides'],
      sub: ['给个主题，出整套课件和讲稿', 'Give a topic, get a full deck with notes'],
      text: ['帮我做一份课件 PPT：主题是【在这里写主题或教材章节】，给【本科生】讲，大约【15】页，每页配讲稿。', 'Make a slide deck on 【your topic or textbook chapter】 for 【undergraduates】, about 【15】 slides, with speaker notes on each.'],
    },
    {
      key: 'video', art: aVideo,
      title: ['做讲解视频', 'Make an explainer video'],
      sub: ['把一个知识点做成动画短片', 'Turn one idea into a short animation'],
      text: ['把【在这里写知识点】做成一段 1 分钟左右的讲解动画，配上字幕，导出 MP4。', 'Turn 【your concept】 into a one-minute explainer animation with captions, exported as MP4.'],
    },
    {
      key: 'figure', art: aFigure,
      title: ['画示意图', 'Draw a diagram'],
      sub: ['流程图、结构图、课件配图', 'Flowcharts, diagrams, slide figures'],
      text: ['帮我画一张【在这里写要画的内容】的示意图，风格简洁，适合放进课件。', 'Draw a clean diagram of 【what to show】 that fits on a slide.'],
    },
    {
      key: 'data', art: aSheet, file: true,
      title: ['整理成绩表', 'Tidy a grade sheet'],
      sub: ['算均分、及格率，顺手出图表', 'Averages and pass rates, with a chart'],
      text: ['帮我整理这份表格：【在这里写要怎么整理，比如按班级算平均分和及格率】，再做一张图表，存成 Excel。', 'Tidy this spreadsheet: 【how to organize it, e.g. average and pass rate per class】, add a chart, and save as Excel.'],
    },
  ],
  student: [
    {
      key: 'homework', art: aHomework, file: true,
      title: ['讲一道题', 'Explain a problem'],
      sub: ['拍照或截图，一步步讲懂', 'Photo or screenshot, step by step'],
      text: ['这道题我不会，帮我一步步讲明白，讲完再出【两道】类似的题让我练，答案放最后。', 'I’m stuck on this problem. Walk me through it step by step, then give me 【two】 similar ones to practice, answers at the end.'],
    },
    {
      key: 'reading', art: aReading, file: true,
      title: ['读懂一篇文献', 'Understand a paper'],
      sub: ['讲清核心观点，列出能引用的地方', 'Key ideas, plus what you can cite'],
      text: ['帮我读懂这篇文献：用大白话讲它解决了什么问题、怎么做的、结论是什么，再列出我写【课程论文】时能引用的几处。', 'Help me understand this paper in plain words: the problem, the method, the findings, and a few passages I could cite in my 【term paper】.'],
    },
    {
      key: 'outline', art: aOutline,
      title: ['写报告提纲', 'Outline a report'],
      sub: ['给题目，出结构和每节要点', 'Give a title, get sections and points'],
      text: ['我要写一篇【在这里写题目】的【课程报告】，大约【3000】字，帮我列提纲：分几节、每节写什么、去哪找资料。', 'I’m writing a 【term report】 on 【your topic】, about 【3000】 words. Outline it: sections, what goes in each, and where to find sources.'],
    },
    {
      key: 'quiz', art: aQuiz, file: true,
      title: ['考前出题', 'Quiz me'],
      sub: ['按笔记或课件出测验，带答案', 'Questions from your notes, with answers'],
      text: ['根据这份【笔记 / 课件】给我出【10】道测验题，选择题和简答题都要，答案和解析放在最后。', 'Make 【10】 quiz questions from these 【notes / slides】, mixing multiple choice and short answer, with answers and explanations at the end.'],
    },
    {
      key: 'defense', art: aDefense,
      title: ['做答辩 PPT', 'Defense slides'],
      sub: ['按论文出答辩稿和讲稿', 'Slides and script from your thesis'],
      text: ['帮我做毕业答辩 PPT：论文题目是【在这里写题目】，讲【10】分钟，每页配讲稿，最后一页列老师可能问的问题。', 'Make thesis defense slides for 【your thesis title】, a 【10】-minute talk, speaker notes on each slide, and a last slide of likely questions.'],
    },
    {
      key: 'resume', art: aResume,
      title: ['改简历', 'Fix my résumé'],
      sub: ['对着岗位改，存成 Word', 'Tailored to the job, saved as Word'],
      text: ['帮我改简历，投的是【在这里写岗位】：突出相关经历，用数字说话，控制在一页，改完存成 Word。', 'Rewrite my résumé for 【the job】: highlight relevant experience, use numbers, keep it to one page, and save it as Word.'],
    },
  ],
  office: [
    {
      key: 'weekly', art: aWeekly,
      title: ['写周报', 'Weekly report'],
      sub: ['列几件事，出一份像样的周报', 'List what you did, get a clean report'],
      text: ['帮我写这周的周报。这周做了：【在这里随便列几条】。按「完成 / 进展 / 风险 / 下周计划」分好，语气正式。', 'Write my weekly report. This week I: 【list a few things】. Organize it as done / in progress / risks / next week, in a professional tone.'],
    },
    {
      key: 'minutes', art: aMinutes, file: true,
      title: ['整理会议纪要', 'Meeting notes'],
      sub: ['记录或转写稿 → 决定和待办', 'Transcript → decisions and to-dos'],
      text: ['把这份会议记录整理成纪要：讨论了什么、定了什么、待办事项写清楚谁负责、什么时候完成。', 'Turn these meeting notes into minutes: what was discussed, what was decided, and to-dos with owners and deadlines.'],
    },
    {
      key: 'email', art: aEmail,
      title: ['写一封邮件', 'Draft an email'],
      sub: ['说清楚要办的事，语气得体', 'Clear ask, the right tone'],
      text: ['帮我写一封邮件给【收件人，比如客户 / 领导】，要说的是【在这里写要办的事】，语气【客气但直接】。', 'Draft an email to 【who】 about 【what you need】, in a 【polite but direct】 tone.'],
    },
    {
      key: 'report', art: aReport,
      title: ['做汇报 PPT', 'Presentation deck'],
      sub: ['给要点，出整套汇报', 'Give the points, get the deck'],
      text: ['帮我做一份汇报 PPT，主题是【在这里写主题】，给【领导 / 客户】看，大约【10】页，要有数据图表。', 'Make a 【10】-slide deck on 【your topic】 for 【your boss / a client】, with charts.'],
    },
    {
      key: 'analysis', art: aAnalysis, file: true,
      title: ['分析表格数据', 'Analyze a spreadsheet'],
      sub: ['找趋势和异常，出结论和图表', 'Trends, outliers, charts, conclusions'],
      text: ['帮我分析这份数据：【在这里写想知道什么，比如哪个月销量掉了、为什么】，出几张图表和三条结论。', 'Analyze this data: 【what you want to know, e.g. which month sales dropped and why】. Give me a few charts and three conclusions.'],
    },
    {
      key: 'research', art: aResearch,
      title: ['做一份调研', 'Research a topic'],
      sub: ['上网查资料，出带来源的报告', 'Searches the web, cites sources'],
      text: ['帮我调研【在这里写主题，比如某个行业 / 竞品】：现状、主要玩家、趋势，每条结论附来源，存成 Word。', 'Research 【a topic, e.g. an industry or competitors】: current state, key players, trends, with sources for every claim, saved as Word.'],
    },
  ],
  life: [
    {
      key: 'travel', art: aTravel,
      title: ['做旅行攻略', 'Plan a trip'],
      sub: ['路线、住哪、吃什么、花多少', 'Route, stays, food, budget'],
      text: ['帮我做一份【城市】【3】天的旅行攻略：每天去哪、怎么走、住哪片、吃什么，预算大概【每人 3000】。', 'Plan a 【3】-day trip to 【city】: daily route, getting around, where to stay, what to eat, budget around 【$500 each】.'],
    },
    {
      key: 'image', art: aImage,
      title: ['做一张图', 'Make an image'],
      sub: ['头像、海报、贺卡、壁纸', 'Avatars, posters, cards, wallpapers'],
      text: ['帮我做一张【海报 / 头像 / 生日贺卡】，内容是【在这里写】，风格【温暖可爱】。', 'Make a 【poster / avatar / birthday card】 about 【what】, in a 【warm, cute】 style.'],
    },
    {
      key: 'contract', art: aContract, file: true,
      title: ['看懂合同账单', 'Read a contract'],
      sub: ['挑出要注意的条款和费用', 'Flags the clauses and fees that matter'],
      text: ['帮我看看这份【租房合同 / 账单】：用大白话讲讲，哪些条款对我不利、有哪些隐藏费用、签之前该问什么。', 'Read this 【lease / bill】 for me in plain words: which terms work against me, any hidden fees, and what to ask before signing.'],
    },
    {
      key: 'recipe', art: aRecipe,
      title: ['一周菜单', 'Weekly meal plan'],
      sub: ['按口味配好，附买菜清单', 'With a shopping list'],
      text: ['帮我排一周的晚饭菜单，【2】个人吃，口味【清淡、少油】，每道菜写做法，最后列一份买菜清单。', 'Plan a week of dinners for 【2】, 【light, low-oil】, with a short recipe for each and a shopping list.'],
    },
    {
      key: 'fitness', art: aFitness,
      title: ['健身计划', 'Workout plan'],
      sub: ['按目标和时间排好每一天', 'Daily plan for your goal'],
      text: ['帮我排一个【4】周的健身计划，目标是【减脂】，每周能练【3】次、每次【40】分钟，在【家里】练。', 'Make a 【4】-week plan to 【lose fat】, 【3】 sessions a week, 【40】 minutes each, 【at home】.'],
    },
    {
      key: 'story', art: aStory,
      title: ['讲个睡前故事', 'Bedtime story'],
      sub: ['按孩子的名字和喜好现编', 'Made up for your kid'],
      text: ['给我【5】岁的孩子【名字】编一个睡前故事，主角是【小兔子】，讲【勇敢】，5 分钟能讲完，再配一张插图。', 'Make up a bedtime story for my 【5】-year-old 【name】, starring 【a little rabbit】, about 【being brave】, five minutes long, with one illustration.'],
    },
  ],
};

const CODE_STARTERS: Starter[] = [
  {
    key: 'explain', art: cExplain,
    title: ['了解这个项目', 'Explain this project'],
    sub: ['结构、入口、怎么跑起来', 'Layout, entry points, how to run it'],
    text: ['带我了解这个项目：目录结构、主要模块各干什么、入口在哪、怎么在本地跑起来。', 'Walk me through this project: folder layout, what each main module does, the entry points, and how to run it locally.'],
  },
  {
    key: 'bug', art: cBug,
    title: ['修一个 bug', 'Fix a bug'],
    sub: ['说现象，它去查根因再改', 'Describe it; it finds the root cause'],
    text: ['有个 bug：【在这里写现象，比如点保存没反应 / 报什么错】。先找到根因，再修，修完跑一下相关测试。', 'There’s a bug: 【what happens, e.g. clicking save does nothing / the error message】. Find the root cause, fix it, then run the related tests.'],
  },
  {
    key: 'feature', art: cFeature,
    title: ['加一个功能', 'Add a feature'],
    sub: ['先出方案，你点头再写', 'Plans first, codes after you agree'],
    text: ['我想加一个功能：【在这里写要什么】。先看看现有代码，给我一个改动方案（改哪些文件、怎么做），我确认后再写。', 'I want to add: 【what you need】. Read the existing code, propose a plan (which files, what changes), and wait for my OK before coding.'],
  },
  {
    key: 'test', art: cTest,
    title: ['补测试', 'Write tests'],
    sub: ['给关键逻辑补上并跑通', 'Cover the key logic and run them'],
    text: ['给【在这里写模块或文件】补单元测试，覆盖正常和边界情况，用项目现有的测试框架，写完跑通。', 'Add unit tests for 【module or file】, covering normal and edge cases, using the project’s existing test setup, and make them pass.'],
  },
  {
    key: 'review', art: cReview,
    title: ['审一下改动', 'Review my changes'],
    sub: ['看没提交的代码，挑问题', 'Checks uncommitted code for problems'],
    text: ['帮我审一下还没提交的改动：有没有 bug、边界没处理、写法能更简单的地方，按严重程度列出来。', 'Review my uncommitted changes: bugs, unhandled edge cases, anything that could be simpler, ranked by severity.'],
  },
  {
    key: 'newapp', art: cNewapp,
    title: ['从零做个小应用', 'Build a small app'],
    sub: ['说想要什么，做出能跑的', 'Describe it, get something that runs'],
    text: ['帮我从零做一个【在这里写，比如记账网页 / 番茄钟小工具】，技术栈你来选简单的，做完告诉我怎么运行。', 'Build me a 【e.g. budgeting web page / pomodoro timer】 from scratch. Pick a simple stack and tell me how to run it.'],
  },
];

/* Work 首屏 (UI 3.0 设计稿): 一排四颗按成品来的芯片, 不分人群 */
const WORK_HOME: Starter[] = [
  {
    key: 'ppt', art: aSlides,
    title: ['做一份 PPT', 'Make a deck'],
    sub: ['', ''],
    text: ['帮我做一份 PPT，主题是【在这里写主题】，给【领导 / 客户】看，大约【10】页，要有数据图表。', 'Make a 【10】-slide deck on 【your topic】 for 【your boss / a client】, with charts.'],
  },
  {
    key: 'sheet', art: aSheet, file: true,
    title: ['整理成表格', 'Make a spreadsheet'],
    sub: ['', ''],
    text: ['把这份资料整理成 Excel 表格：【在这里写要哪些列】，算好合计，加一张图表。', 'Turn this into an Excel sheet: 【which columns】, with totals and one chart.'],
  },
  {
    key: 'report', art: aResearch,
    title: ['写一篇报告', 'Write a report'],
    sub: ['', ''],
    text: ['帮我写一篇报告，主题是【在这里写】，给【谁】看，结构清楚、有数据支撑，存成 Word。', 'Write a report on 【topic】 for 【who】, clearly structured and backed by data, saved as Word.'],
  },
  {
    key: 'video', art: aVideo,
    title: ['做个短视频', 'Make a short video'],
    sub: ['', ''],
    text: ['帮我做一个【30】秒的短视频，内容是【在这里写】，配字幕和背景音乐，导出 MP4。', 'Make a 【30】-second video about 【what】, with captions and music, exported as MP4.'],
  },
];

/* 没有 PPT 引擎的构建: 「做一份 PPT」换成「分析表格数据」, 首屏仍是四颗 */
const WORK_HOME_AVAILABLE: Starter[] = PPTX_AVAILABLE
  ? WORK_HOME
  : [...STARTERS.office.filter((s) => s.key === 'analysis'), ...WORK_HOME.filter((s) => s.key !== 'ppt')];

export const WorkStarters: React.FC<{ isZh: boolean; mode?: 'work' | 'code' }> = ({ isZh, mode = 'work' }) => {
  const isCode = mode === 'code';
  /* 按人群分的那几套 (STARTERS / PERSONAS) 留着给以后的「更多」用, 首屏只放稿里那四颗 */
  const list = isCode ? CODE_STARTERS : WORK_HOME_AVAILABLE;
  const pick = (s: Starter) => {
    const text = isZh ? s.text[0] : s.text[1];
    try {
      window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, focus: true, selectBlank: true, pickFile: s.file === true } }));
    } catch { /* 输入框不在也无妨 */ }
  };
  return (
    <div className="atl-empty-stage__below work-starters" role="list" aria-label={isZh ? '从一件事开始' : 'Start with one task'}>
      <div className="work-starters__head">
        <p className="work-starters__label">{isZh ? '不知道怎么说？点一个，改改【】里的字就能发' : 'Not sure what to say? Pick one, edit the 【】 parts, and send'}</p>
      </div>
      <div className="work-starters__grid" key={isCode ? 'code' : 'work'}>
        {list.map((s) => (
          <button key={s.key} type="button" role="listitem" className="work-starters__card" onClick={() => pick(s)}>
            <img className="work-starters__art" src={s.art} width={40} height={40} decoding="sync" alt="" aria-hidden draggable={false} />
            <span className="work-starters__text">
              <span className="work-starters__title">{isZh ? s.title[0] : s.title[1]}</span>
              <span className="work-starters__sub">{isZh ? s.sub[0] : s.sub[1]}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
