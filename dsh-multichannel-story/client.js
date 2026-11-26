// dsh-multichannel-story · 浏览器半边（Desktop 与 Web 共用同一份）
//
// 视觉与交互参照宿主自己的面板：语义 token 的别名层、正文用宿主字体、标题用衬线、
// 克制的动效；结构上按「行动优先」组织——先选这次要什么，再一键开始，
// 流程与设置收在后面，不让人先读三段说明再找按钮。
//
// 三件事：
//   1. 左侧边栏全局面板区（sidebar.panellist）加一个可选入口；
//   2. 主区域是插件自己的工作台：开始（产物预设 + 一键开始）/ 设置；
//   3. 设置 → 插件 → 本插件详情页放同一份入口开关，入口关掉后仍能重新打开。
//
// 侧栏入口显示与否是纯 UI 偏好（localStorage 一个布尔值），不含个人信息。
window.__ModuleLoader__.load({
  id: 'dsh-multichannel-story',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useId, useRef, useState, useSyncExternalStore } = React

    /** 与 package.json 的 name 一致；侧栏入口 id、main 面板 key、bundle 配置 key 都用它。 */
    const PACKAGE_NAME = 'dsh-multichannel-story'
    const PANEL_ID = 'multichannel-story'
    const PREF_KEY = 'dsh-multichannel-story:sidebar-entry'
    const ENTRY_ORDER = 7
    const START_PROMPT = '/multichannel-story '

    /**
     * 文案：每个叶子都是 {zh, en}，由宿主 locale 服务按回退链解析
     * （不支持的界面语言回退英文，而不是中文）。数组保持同样形状。
     */
    const COPY = {
      sidebar: { zh: '多平台内容', en: 'Multichannel' },
      kicker: { zh: 'Multichannel · 一条内容，四种出口', en: 'Multichannel · one piece, four outlets' },
      title: { zh: '多平台内容流水线', en: 'Multichannel content pipeline' },
      lede: {
        zh: '一篇文章进去：精排网页长文、小红书图文、公众号封面一次成型；需要时再加一条带自然男声旁白的抖音竖屏视频。顺序、排版与验收标准都在技能里，你只补内容。',
        en: 'One article in: a long-form page, a Xiaohongshu card set and a WeChat cover pair come out together — plus an optional vertical Douyin video with a natural male voice-over. Order, layout and acceptance rules live in the skill.',
      },
      tabsLabel: { zh: '工作台视图', en: 'Workbench views' },
      tabStart: { zh: '开始', en: 'Start' },
      tabSettings: { zh: '设置', en: 'Settings' },

      pickTitle: { zh: '这次要做什么', en: 'What this run produces' },
      pickHint: { zh: '选一个起点；音色、素材、风格这些细节，技能开跑后会一次问完。', en: 'Pick a starting point; the skill asks for voice, material and style in one go once it starts.' },
      ctaPrefix: { zh: '开始：', en: 'Start: ' },
      ctaBusy: { zh: '正在打开…', en: 'Opening…' },
      ctaHint: { zh: '会把提示词写进草稿（复用空白会话或新开一个）；已有草稿时追加在后面，不会自动发送。', en: 'Writes the prompt into the draft (reusing a blank Session or opening one); it is appended after any existing draft and never sent.' },
      ctaDone: { zh: '已写入草稿。去会话里补上文章或选题，再发送。', en: 'Written to the draft. Add your article or topic in the Session, then send.' },
      promptSummary: { zh: '查看将写入草稿的提示词', en: 'Show the prompt that will be written' },
      promptLabel: { zh: '将写入草稿', en: 'Goes into the draft' },
      customHint: { zh: '还想要封面矩阵、中英双版本，或「先去 AI 味」再排版？直接说需求，技能会按对应工作流走。', en: 'Also want a cover matrix, a bilingual edition, or a de-AI rewrite before typesetting? Just describe it; the skill picks the matching workflow.' },

      tipsTitle: { zh: '开跑前会检查', en: 'Checked before it runs' },
      tips: [
        {
          zh: '环境：node、Python、ffmpeg 与 dsh-guizang-design 插件是否就绪；缺了会停下并说明装什么。',
          en: 'Environment: node, Python, ffmpeg and the dsh-guizang-design plugin; a missing piece stops the run with an install hint.',
        },
        {
          zh: '声音：视频必须有声，默认云健（成熟男声），可换云扬 / 云希 / 云夏。',
          en: 'Voice: the video always has sound — Yunjian by default, with Yunyang / Yunxi / Yunxia as alternatives.',
        },
        {
          zh: '口径：不编造数据与引文；只去空话，不改你的立场。',
          en: 'Ear: no invented data or quotes; only filler is removed, never your position.',
        },
      ],

      flowSummary: { zh: '这条内容会怎么走（4 步）', en: 'How one piece travels (4 steps)' },
      steps: [
        {
          n: '01',
          title: { zh: '定主题与素材', en: 'Theme and material' },
          desc: { zh: '事实、数字、引文都来自你给的材料；外文素材默认译成中文。', en: 'Facts, numbers and quotes come from your material; foreign sources are translated first.' },
        },
        {
          n: '02',
          title: { zh: '写网页长文', en: 'Long-form page' },
          desc: { zh: '模型写标注、脚本确定性渲染；去掉工具页脚，竖图按栏宽收窄。', en: 'The model writes annotations, the script renders; tool footers removed, portraits narrowed.' },
        },
        {
          n: '03',
          title: { zh: '卡片与封面', en: 'Cards and covers' },
          desc: { zh: '复用网页的素材与主题；渲染后逐张自检，校验跑到 0 fail。', en: 'Same assets and theme as the page; every PNG is reviewed and the deck validation must pass.' },
        },
        {
          n: '04',
          title: { zh: '视频与验收', en: 'Video and review' },
          desc: { zh: '旁白逐句对齐分镜，成片核对音轨、画幅、响度与语句落点。', en: 'Narration is aligned shot by shot, then checked for audio, size, loudness and cue points.' },
        },
      ],

      settingsTitle: { zh: '入口与偏好', en: 'Entry and preference' },
      settingsLede: { zh: '侧栏入口只影响界面，技能始终可用。', en: 'The sidebar entry only affects the UI; the skill always works.' },
      toggle: { zh: '在左侧边栏显示入口', en: 'Show entry in the left sidebar' },
      toggleNote: { zh: '关掉后侧栏不再显示「多平台内容」；可随时在 设置 → 插件 → 多平台内容流水线 → 配置 重新打开。', en: 'Hides the “Multichannel” entry; re-enable any time in Settings → Plugins → this plugin → configuration.' },
      storageNote: { zh: '偏好存在本浏览器的 localStorage（一个布尔值），换机器或换浏览器会回到默认显示。', en: 'The preference lives in this browser’s localStorage (one boolean); another machine or browser starts from the default.' },
      configTitle: { zh: '侧边栏入口', en: 'Sidebar entry' },
      configNote: { zh: '这个开关只影响界面入口，不影响 multichannel-story 技能；技能始终可用。', en: 'This only controls the UI entry; the multichannel-story skill stays available either way.' },
      startFailed: { zh: '打开新会话失败：', en: 'Could not open a new Session: ' },
      retry: { zh: '重试', en: 'Retry' },
    }

    /**
     * 产物预设：把「技能第一步要问的三件事」里最常选的那一档做成可点的起点。
     * prompt 会拼在 `/multichannel-story ` 后面写进草稿，用户仍可改。
     */
    const PRESETS = [
      {
        id: 'deck',
        title: { zh: '网页 + 卡片 + 封面', en: 'Page + cards + covers' },
        desc: { zh: '三条主产物，同一套主题与素材；6–9 张 3:4 卡片，21:9 与 1:1 封面各自构图。', en: 'The three main deliverables on one theme: 6–9 cards at 3:4, plus separately composed 21:9 and 1:1 covers.' },
        tag: { zh: '默认', en: 'Default' },
        prompt: {
          zh: '做一条内容：网页长文（杂志风）+ 小红书图文 + 公众号封面（21:9 主封面与 1:1 分享卡）。',
          en: 'Make one piece: a long-form web page (magazine style) + Xiaohongshu cards + WeChat covers (21:9 main cover and 1:1 share card).',
        },
      },
      {
        id: 'video',
        title: { zh: '网页 + 卡片 + 封面 + 视频', en: 'Page + cards + covers + video' },
        desc: { zh: '三样都做，再加一条 1080×1920 竖屏成片：自然男声旁白逐句对齐分镜，导出后核对音轨与响度。要多 ffmpeg 与语音链路，耗时明显更长。', en: 'All three, plus a 1080×1920 vertical cut with a natural male voice-over aligned shot by shot and checked after export. Needs ffmpeg and the voice chain, so it takes noticeably longer.' },
        tag: { zh: '含视频', en: 'With video' },
        prompt: {
          zh: '做一条内容：网页长文（杂志风）+ 小红书图文 + 公众号封面（21:9 主封面与 1:1 分享卡），再加一条抖音竖屏视频，自然男声旁白。',
          en: 'Make one piece: a long-form web page (magazine style) + Xiaohongshu cards + WeChat covers (21:9 main cover and 1:1 share card), plus a vertical Douyin video with a natural male voice-over.',
        },
      },
      {
        id: 'page',
        title: { zh: '只要网页长文', en: 'Only the long-form page' },
        desc: { zh: '目录、图表、图注与许可表齐全，导出 PDF 与长图；最快的一条。', en: 'TOC, figures, captions and a license table, exported as PDF and a long image; the fastest path.' },
        tag: { zh: '最快', en: 'Fastest' },
        prompt: {
          zh: '只要网页长文（杂志风），不要卡片、封面和视频。',
          en: 'Only the long-form web page (magazine style); no cards, covers or video.',
        },
      },
    ]

    /** 写进草稿的完整提示词：显示与实际写入共用这一份，避免两处各拼一遍。 */
    function promptFor(presetId, text) {
      const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0]
      return `${START_PROMPT}${text(preset.prompt)}`
    }

    // ---------------------------------------------------------------- 样式
    // 先把 DSH 语义 token 收成一组别名（带兜底），再只用别名写样式。
    const STYLE = `
.mcs-root {
  --ink: var(--dsw-alias-label-primary, currentColor);
  --ink2: var(--dsw-alias-label-secondary, color-mix(in srgb, var(--ink) 78%, transparent));
  --ink3: var(--dsw-alias-label-tertiary, color-mix(in srgb, var(--ink) 58%, transparent));
  /* 主按钮用 brand-primary（实心墨色）+ 反相字色：两者在明暗两套主题里都成对出现，
     比 button-primary-fill 稳（后者在部分主题里指向 error 色）。悬停用 filter，不再赌 hover token。 */
  --primary: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary, currentColor));
  --on-primary: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-bg-base, transparent));
  --bg: var(--dsw-alias-bg-base, transparent);
  --card: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent));
  --line: var(--dsw-alias-border-l2, color-mix(in srgb, var(--ink) 14%, transparent));
  --line-strong: var(--dsw-alias-border-l4, color-mix(in srgb, var(--ink) 26%, transparent));
  --hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--ink) 6%, transparent));
  --accent: var(--dsw-alias-link, var(--dsw-alias-brand-primary, currentColor));
  --danger: var(--dsw-alias-state-error-primary, currentColor);
  --r-sm: var(--dsw-radius-sm, 8px);
  --r-md: var(--dsw-radius-md, 12px);
  --r-lg: var(--dsw-radius-lg, 16px);
  --serif: "Songti SC", "STSong", "SimSun", "宋体", "Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", Georgia, serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--dsw-font-family, inherit);
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
}
.mcs-root *, .mcs-root *::before, .mcs-root *::after { box-sizing: border-box; }
.mcs-root :where(h1, h2, h3, p, ol, ul) { margin: 0; padding: 0; }
.mcs-root :where(ol, ul) { list-style: none; }
/* :where() 让这条重置的优先级为 0：否则 (0,1,1) 会压过 .mcs-cta / .mcs-preset 这些
   单类选择器，按钮就只剩文字（踩过：主按钮没底色、卡片没内边距）。 */
.mcs-root :where(button) { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
.mcs-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.mcs-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 56px;
  padding: 0 20px;
  border-bottom: .5px solid var(--line);
  background: var(--bg);
}
.mcs-brand { display: flex; align-items: center; gap: 9px; min-width: 0; color: var(--ink2); }
.mcs-brand-name { font-family: var(--serif); font-size: 14px; letter-spacing: .01em; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 页签用下划线指示，不依赖「面」的 token：浅色主题下 layer-1/2/3 几乎同色，
   做成胶囊会分辨不出当前页；下划线在明暗两套主题里都成立。 */
.mcs-tabs { margin-left: auto; display: flex; align-items: center; gap: 20px; }
.mcs-tab {
  position: relative;
  height: 36px;
  padding: 0 2px;
  color: var(--ink2);
  font-size: 13px;
  line-height: 36px;
  white-space: nowrap;
  transition: color .18s var(--ease);
}
.mcs-tab:hover { color: var(--ink); }
.mcs-tab[aria-selected="true"] { color: var(--ink); }
.mcs-tab[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.mcs-main { flex: 1; min-height: 0; overflow-y: auto; padding: 36px 24px 72px; container-type: inline-size; }
.mcs-page { max-width: 660px; margin: 0 auto; }
.mcs-cols { display: flex; flex-direction: column; }
/* 按「容器」宽度判断，而不是视口：同一个面板也挂在 better-sidebar 的窄标签页里，
   视口很宽时那里仍会被排成两栏挤爆。容器查询不可用的宿主自动退回单列。 */
@container (min-width: 1000px) {
  .mcs-page.mcs-page-wide { max-width: 1000px; }
  .mcs-page-wide .mcs-cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    column-gap: 44px;
    align-items: start;
  }
  .mcs-page-wide .mcs-col-side { position: sticky; top: 8px; }
  .mcs-page-wide .mcs-col-side .mcs-section { margin-top: 26px; }
  .mcs-page-wide .mcs-col-side .mcs-details { margin-top: 22px; }
}
.mcs-kicker { font-size: 11px; line-height: 18px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink3); }
.mcs-title { margin: 10px 0 10px; font-family: var(--serif); font-size: 30px; line-height: 42px; font-weight: 300; letter-spacing: -.01em; }
/* 中文一行约 30–34 字最舒服：用 em 而不是 ch（ch 按西文字宽算，中文会排得过长）。 */
.mcs-lede { max-width: 34em; color: var(--ink2); font-size: 14px; line-height: 24px; }
.mcs-caption { margin-top: 6px; color: var(--ink3); font-size: 12px; line-height: 20px; }

.mcs-section { margin-top: 32px; }
.mcs-section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.mcs-section-head h2 { font-family: var(--serif); font-size: 17px; line-height: 26px; font-weight: 400; }

.mcs-head + .mcs-cols .mcs-col-main > .mcs-section:first-child { margin-top: 24px; }
.mcs-presets { display: flex; flex-direction: column; gap: 8px; }
.mcs-presets-wrap { margin-top: 12px; }
/* 预设做成竖排单选行：标题/标签一行、说明一行，比三列窄卡好读，也不会让标签压住标题。 */
.mcs-preset {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  column-gap: 10px;
  row-gap: 3px;
  align-items: start;
  padding: 12px 14px;
  border-radius: var(--r-lg);
  background: var(--card);
  box-shadow: inset 0 0 0 .5px var(--line);
  text-align: left;
  transition: box-shadow .18s var(--ease), background .18s var(--ease);
}
.mcs-preset:hover { box-shadow: inset 0 0 0 .5px var(--line-strong); }
.mcs-preset[aria-checked="true"] {
  background: color-mix(in srgb, var(--accent) 7%, var(--card));
  box-shadow: inset 0 0 0 1px var(--accent);
}
.mcs-preset-dot {
  grid-column: 1;
  grid-row: 1 / span 2;
  width: 14px;
  height: 14px;
  margin-top: 4px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.mcs-preset[aria-checked="true"] .mcs-preset-dot { background: var(--accent); box-shadow: none; }
.mcs-preset-title { grid-column: 2; grid-row: 1; color: var(--ink); font-size: 13.5px; line-height: 21px; font-weight: 500; }
.mcs-preset-tag {
  grid-column: 3;
  grid-row: 1;
  margin-left: 8px;
  padding: 0 7px;
  border-radius: 999px;
  box-shadow: inset 0 0 0 .5px var(--line);
  color: var(--ink3);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}
.mcs-preset[aria-checked="true"] .mcs-preset-tag {
  color: var(--accent);
  box-shadow: inset 0 0 0 .5px color-mix(in srgb, var(--accent) 45%, transparent);
}
.mcs-preset-desc { grid-column: 2 / span 2; grid-row: 2; color: var(--ink2); font-size: 12px; line-height: 19px; }

.mcs-cta-consequence { max-width: 34em; margin-top: 14px; color: var(--ink2); font-size: 13px; line-height: 21px; }
.mcs-cta-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
.mcs-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 20px;
  border-radius: var(--r-md);
  background: var(--primary);
  color: var(--on-primary);
  font-size: 13.5px;
  line-height: 20px;
  font-weight: 500;
  transition: filter .15s var(--ease), transform .3s cubic-bezier(.2, 1.2, .4, 1);
}
.mcs-cta:hover { filter: brightness(.94); }
.mcs-cta:active { transform: translateY(1px); }
.mcs-cta[disabled] { cursor: default; opacity: .72; }
.mcs-status { margin-top: 12px; color: var(--ink2); font-size: 13px; line-height: 21px; }
/* 常驻的空 live region 不占位：内容改在已有节点里，读屏才会播报。 */
.mcs-status:empty { margin-top: 0; }
.mcs-status::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 7px; border-radius: 50%; background: var(--accent); vertical-align: 2px; }

.mcs-prompt-details { margin-top: 14px; }
.mcs-prompt-details summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  cursor: pointer;
  color: var(--ink3);
  font-size: 12px;
  list-style: none;
}
.mcs-prompt-details summary::-webkit-details-marker { display: none; }
.mcs-prompt-details summary::after {
  content: "";
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg) translateY(-2px);
  transition: transform .2s var(--ease);
}
.mcs-prompt-details[open] summary::after { transform: rotate(-135deg) translateY(-2px); }
.mcs-prompt {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 8px;
  padding: 9px 12px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  box-shadow: inset 0 0 0 .5px var(--line);
  font-size: 12px;
  line-height: 19px;
  color: var(--ink2);
  word-break: break-word;
}
.mcs-prompt b { flex: none; font-weight: 500; color: var(--ink3); }
.mcs-prompt code { font-family: var(--mono); font-size: 12px; }

.mcs-list { display: flex; flex-direction: column; gap: 7px; }
.mcs-list li { position: relative; max-width: 36em; padding-left: 15px; color: var(--ink2); font-size: 13px; line-height: 21px; }
.mcs-list li::before { content: ""; position: absolute; left: 2px; top: 8px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); opacity: .65; }

.mcs-details { margin-top: 30px; padding-top: 4px; border-top: .5px solid var(--line); }
.mcs-details summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  cursor: pointer;
  color: var(--ink2);
  font-size: 13px;
  list-style: none;
}
.mcs-details summary::-webkit-details-marker { display: none; }
.mcs-details summary::after {
  content: "";
  margin-left: auto;
  width: 7px;
  height: 7px;
  border-right: 1.5px solid var(--ink3);
  border-bottom: 1.5px solid var(--ink3);
  transform: rotate(45deg) translateY(-2px);
  transition: transform .2s var(--ease);
}
.mcs-details[open] summary::after { transform: rotate(-135deg) translateY(-2px); }
.mcs-steps { display: flex; flex-direction: column; }
.mcs-step { display: grid; grid-template-columns: 34px 1fr; gap: 12px; padding: 11px 0; border-top: .5px solid var(--line); }
.mcs-step-n { font-family: var(--serif); font-size: 17px; line-height: 24px; color: var(--ink3); }
.mcs-step h3 { font-size: 13px; line-height: 21px; font-weight: 500; }
.mcs-step p { margin-top: 1px; color: var(--ink2); font-size: 12px; line-height: 19px; }

.mcs-card { padding: 18px 20px; border-radius: var(--r-lg); background: var(--card); border: .5px solid var(--line); box-shadow: var(--dsw-elevation-soft, none); }
.mcs-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mcs-row-label { font-size: 14px; line-height: 22px; }
.mcs-note { max-width: 36em; margin-top: 10px; color: var(--ink3); font-size: 12px; line-height: 19px; }
.mcs-error { display: flex; align-items: center; gap: 10px; margin-top: 12px; color: var(--danger); font-size: 12px; line-height: 20px; }
.mcs-retry {
  flex: none;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--r-sm);
  box-shadow: inset 0 0 0 .5px var(--line-strong);
  color: var(--ink2);
  font-size: 12px;
  line-height: 30px;
}
.mcs-retry:hover { background: var(--hover); color: var(--ink); }

.mcs-switch {
  position: relative;
  flex: none;
  width: 44px;
  height: 24px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 18%, transparent);
  box-shadow: inset 0 0 0 .5px var(--line-strong);
  transition: background .18s var(--ease), box-shadow .18s var(--ease);
}
/* 视觉尺寸保持 44×24，点击区域用伪元素撑到 44 高，手机上不至于难点。 */
.mcs-switch::before { content: ""; position: absolute; inset: -10px -4px; }
.mcs-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ink);
  transition: transform .22s var(--ease), background .18s var(--ease);
}
.mcs-switch[aria-checked="true"] { background: var(--primary); box-shadow: none; }
.mcs-switch[aria-checked="true"]::after { transform: translateX(20px); background: var(--on-primary); }

.mcs-embed { height: auto; background: transparent; overflow: visible; }
.mcs-embed .mcs-card { margin: 0; }

@media (max-width: 720px) {
  .mcs-topbar { flex-wrap: wrap; min-height: 0; padding: 10px 14px; }
  .mcs-tabs { margin-left: 0; width: 100%; }
  .mcs-tab { flex: 1; height: 44px; line-height: 44px; text-align: center; }
  .mcs-main { padding: 24px 16px 56px; }
  .mcs-title { font-size: 26px; line-height: 36px; }
  .mcs-cta { width: 100%; }
  .mcs-step { grid-template-columns: 28px 1fr; padding: 11px 0; }
}
@media (prefers-reduced-motion: reduce) {
  .mcs-cta, .mcs-tab, .mcs-preset, .mcs-switch, .mcs-switch::after, .mcs-details summary::after, .mcs-prompt-details summary::after { transition: none; }
}
`

    // ---------------------------------------------------------------- 偏好存储

    function getStorage() {
      try {
        return window.localStorage
      } catch {
        return undefined
      }
    }

    /** 读不到（隐私模式/被禁用）时退回默认"显示"，不让入口莫名其妙消失。 */
    function readPreference() {
      try {
        if (getStorage()?.getItem(PREF_KEY) === 'off') return false
      } catch {
        // 忽略，按默认处理
      }
      return true
    }

    function writePreference(enabled) {
      try {
        getStorage()?.setItem(PREF_KEY, enabled ? 'on' : 'off')
      } catch {
        // 忽略：本页面内仍然生效
      }
    }

    /** 极简外部 store：React 用 useSyncExternalStore 订阅。 */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch {
              // 单个订阅者出错不影响其它订阅者
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /**
     * 文案解析：优先用宿主的 locale 服务（按回退链，非中英语言回退英文），
     * 服务不可用或未提供该语言时退回 en → zh，永远不把中文塞给英文界面。
     */
    function createI18n(ctx) {
      const guess = typeof navigator !== 'undefined' && /^zh\b/iu.test(navigator.language ?? '') ? 'zh' : 'en'
      const store = createStore(guess)
      let runtime
      ctx.inject(['locale'], (scope) => {
        runtime = scope?.locale
        const push = (snapshot) => store.set(String(snapshot?.active ?? guess).toLowerCase())
        try {
          push(runtime?.getSnapshot?.())
        } catch {
          // 老版本没有该服务：保持浏览器语言
        }
        try {
          scope?.on?.('locale/change', push)
        } catch {
          // 没有事件也没有关系，至少首帧是对的
        }
      })
      const text = (leaf) => {
        if (leaf === undefined) return ''
        if (typeof leaf === 'string') return leaf
        try {
          if (typeof runtime?.resolveText === 'function') {
            const resolved = runtime.resolveText(leaf)
            // 宿主缺键时会返回空串/undefined：只有真拿到文案才算解析成功，
            // 否则继续走下面的 en → zh 兜底，别让界面出现空白。
            if (typeof resolved === 'string' && resolved !== '') return resolved
          }
        } catch {
          // 服务在但解析失败：继续走本地兜底
        }
        const active = String(store.get())
        return leaf[active] ?? leaf[active.split('-')[0]] ?? leaf.en ?? leaf.zh ?? ''
      }
      return { store, text }
    }

    // ---------------------------------------------------------------- 图标

    const ICONS = {
      scatter: ['M4.5 7h6M4.5 12h6M4.5 17h4', 'M4.5 5.2h12v13.6h-12z', 'M17 9h3M17 13h3M17 17h3'],
      spark: ['M12 4l1.6 5.4L19 11l-5.4 1.6L12 18l-1.6-5.4L5 11l5.4-1.6z'],
      arrow: ['M5 12h13', 'M13 6l6 6-6 6'],
    }

    function Icon({ name, size = 18 }) {
      const paths = ICONS[name] ?? ICONS.scatter
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    // ---------------------------------------------------------------- 基础控件

    function Switch({ checked, onChange, label, labelledBy, describedBy }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': labelledBy === undefined ? label : undefined,
        'aria-labelledby': labelledBy,
        'aria-describedby': describedBy,
        title: label,
        className: 'mcs-switch',
        onClick: () => onChange(!checked),
      })
    }

    /**
     * 两个页签：role=tablist/tab/tabpanel + 方向键/Home/End，
     * 和宿主自己的视图页签保持同一套语义与键盘行为。
     */
    function Tabs({ view, onView, items, label, baseId }) {
      const refs = useRef({})
      const move = (event, nextIndex) => {
        event.preventDefault()
        const next = items[nextIndex]
        onView(next.id)
        refs.current[next.id]?.focus()
      }
      const onKeyDown = (event) => {
        const index = items.findIndex((item) => item.id === view)
        if (index === -1) return
        if (event.key === 'ArrowRight') move(event, (index + 1) % items.length)
        else if (event.key === 'ArrowLeft') move(event, (index - 1 + items.length) % items.length)
        else if (event.key === 'Home') move(event, 0)
        else if (event.key === 'End') move(event, items.length - 1)
      }
      return h('div', { className: 'mcs-tabs', role: 'tablist', 'aria-label': label, onKeyDown },
        items.map((item) => h('button', {
          key: item.id,
          type: 'button',
          role: 'tab',
          id: `${baseId}-${item.id}-tab`,
          'aria-controls': `${baseId}-${item.id}-panel`,
          'aria-selected': view === item.id,
          tabIndex: view === item.id ? 0 : -1,
          className: 'mcs-tab',
          ref: (node) => {
            refs.current[item.id] = node
          },
          onClick: () => onView(item.id),
        }, item.label)))
    }

    /** 产物预设：radiogroup + roving tabindex，方向键换档；读屏名只读标题，说明走 describedby。 */
    function Presets({ value, onChange, presets, text, label, hintId, baseId }) {
      const refs = useRef({})
      const select = (index) => {
        const next = presets[index]
        if (next === undefined) return
        onChange(next.id)
        refs.current[next.id]?.focus()
      }
      const onKeyDown = (event) => {
        const index = presets.findIndex((preset) => preset.id === value)
        if (index === -1) return
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          select((index + 1) % presets.length)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          select((index - 1 + presets.length) % presets.length)
        }
      }
      return h('div', {
        className: 'mcs-presets',
        role: 'radiogroup',
        'aria-label': label,
        'aria-describedby': hintId,
        onKeyDown,
      },
      presets.map((preset) => h('button', {
        key: preset.id,
        type: 'button',
        role: 'radio',
        'aria-checked': value === preset.id,
        'aria-labelledby': `${baseId}-preset-${preset.id}-title`,
        'aria-describedby': `${baseId}-preset-${preset.id}-desc`,
        tabIndex: value === preset.id ? 0 : -1,
        className: 'mcs-preset',
        ref: (node) => {
          refs.current[preset.id] = node
        },
        onClick: () => onChange(preset.id),
      },
      h('span', { className: 'mcs-preset-dot', 'aria-hidden': true }),
      h('span', { className: 'mcs-preset-title', id: `${baseId}-preset-${preset.id}-title` }, text(preset.title)),
      h('span', { className: 'mcs-preset-tag' }, text(preset.tag)),
      h('span', { className: 'mcs-preset-desc', id: `${baseId}-preset-${preset.id}-desc` }, text(preset.desc)))))
    }

    // ---------------------------------------------------------------- 两个视图

    function StartPage({ preset, onPreset, onStart, error, onRetry, busy, status, baseId, i18n }) {
      const t = i18n.text
      const current = PRESETS.find((item) => item.id === preset) ?? PRESETS[0]
      const prompt = promptFor(preset, t)
      const consequenceId = `${baseId}-cta-hint`
      return h('div', { className: 'mcs-page mcs-page-wide' },
        h('header', { className: 'mcs-head' },
          h('p', { className: 'mcs-kicker' }, t(COPY.kicker)),
          h('h1', { className: 'mcs-title' }, t(COPY.title)),
          h('p', { className: 'mcs-lede' }, t(COPY.lede))),

        h('div', { className: 'mcs-cols' },
          h('div', { className: 'mcs-col-main' },
            h('section', { className: 'mcs-section' },
              h('div', { className: 'mcs-section-head' }, h('h2', null, t(COPY.pickTitle))),
              h('p', { className: 'mcs-caption', id: `${baseId}-pick-hint` }, t(COPY.pickHint)),
              h('div', { className: 'mcs-presets-wrap' },
                h(Presets, {
                  value: preset,
                  onChange: onPreset,
                  presets: PRESETS,
                  text: t,
                  label: t(COPY.pickTitle),
                  hintId: `${baseId}-pick-hint`,
                  baseId,
                })),
              // 决定「点下去会发生什么」的一句话放在按钮上方，而不是塞进按钮右边的注释位。
              h('p', { className: 'mcs-cta-consequence', id: consequenceId }, t(COPY.ctaHint)),
              h('div', { className: 'mcs-cta-row' },
                h('button', {
                  type: 'button',
                  className: 'mcs-cta',
                  onClick: onStart,
                  disabled: busy,
                  'aria-describedby': consequenceId,
                },
                h(Icon, { name: 'spark', size: 16 }),
                busy ? t(COPY.ctaBusy) : t(COPY.ctaPrefix) + t(current.title))),
              error === '' ? null : h('p', { className: 'mcs-error', role: 'alert' },
                h('span', null, error),
                onRetry === undefined ? null : h('button', {
                  type: 'button',
                  className: 'mcs-retry',
                  onClick: onRetry,
                  disabled: busy,
                }, t(COPY.retry))),
              // 常驻节点：live region 要先在树里，再把文字填进去，读屏才会播报。
              h('p', { className: 'mcs-status', role: 'status', 'aria-live': 'polite' },
                status === 'done' ? t(COPY.ctaDone) : null),
              // 提示词默认收起：平时不需要读 60 字，但写入的内容必须随时可查。
              h('details', { className: 'mcs-prompt-details' },
                h('summary', null, t(COPY.promptSummary)),
                h('p', { className: 'mcs-prompt' },
                  h('b', null, t(COPY.promptLabel)),
                  h('code', null, prompt))))),

          h('div', { className: 'mcs-col-side' },
            h('section', { className: 'mcs-section' },
              h('div', { className: 'mcs-section-head' }, h('h2', null, t(COPY.tipsTitle))),
              h('ul', { className: 'mcs-list' }, COPY.tips.map((tip, index) => h('li', { key: index }, t(tip)))),
              h('p', { className: 'mcs-note' }, t(COPY.customHint))),

            h('details', { className: 'mcs-details' },
              h('summary', null, t(COPY.flowSummary)),
              h('ol', { className: 'mcs-steps' },
                COPY.steps.map((step) => h('li', { key: step.n, className: 'mcs-step' },
                  h('span', { className: 'mcs-step-n', 'aria-hidden': true }, step.n),
                  h('div', null,
                    h('h3', null, t(step.title)),
                    h('p', null, t(step.desc))))))))))
    }

    function SettingsPage({ store, i18n, onEntryChange, baseId }) {
      const t = i18n.text
      const enabled = useSyncExternalStore(store.subscribe, store.get)
      const noteId = `${baseId}-settings-note`
      return h('div', { className: 'mcs-page' },
        h('h1', { className: 'mcs-title' }, t(COPY.settingsTitle)),
        h('p', { className: 'mcs-lede' }, t(COPY.settingsLede)),
        h('section', { className: 'mcs-section' },
          h('div', { className: 'mcs-card' },
            h('div', { className: 'mcs-row' },
              h('span', { className: 'mcs-row-label', id: `${baseId}-toggle` }, t(COPY.toggle)),
              h(Switch, {
                checked: enabled,
                label: t(COPY.toggle),
                labelledBy: `${baseId}-toggle`,
                describedBy: noteId,
                onChange: (next) => onEntryChange(next),
              })),
            h('p', { className: 'mcs-note', id: noteId }, t(COPY.toggleNote)))),
        h('section', { className: 'mcs-section' },
          h('p', { className: 'mcs-caption' }, t(COPY.storageNote))))
    }

    // ---------------------------------------------------------------- 工作台外壳

    /**
     * @param {object} options
     * @param {'main'|'tab'} [options.host] 面板实例所在的宿主：主区面板与 better-sidebar 标签页行为不同。
     */
    function makePanel({ ctx, store, i18n, host = 'main' }) {
      return function Panel() {
        useSyncExternalStore(i18n.store.subscribe, i18n.store.get)
        const t = i18n.text
        const baseId = useId()
        const [view, setView] = useState('start')
        const [preset, setPreset] = useState(PRESETS[0].id)
        const [error, setError] = useState('')
        const [busy, setBusy] = useState(false)
        const [status, setStatus] = useState('idle')
        const alive = useRef(true)
        useEffect(() => {
          alive.current = true
          return () => {
            alive.current = false
          }
        }, [])

        const fail = (cause) => {
          if (!alive.current) return
          setBusy(false)
          setError(t(COPY.startFailed) + String((cause && cause.message) || cause))
        }

        const start = () => {
          // 连点会开两个会话、把提示词追加两遍：忙的时候直接忽略。
          if (busy) return
          setError('')
          setStatus('idle')
          setBusy(true)
          const prompt = promptFor(preset, t)
          const done = () => {
            if (!alive.current) return
            setBusy(false)
            setStatus('done')
          }
          try {
            const result = ctx.uiWorkspace.startSession(undefined, {
              prompt,
              // 追加而不是覆盖：用户可能已经写了一半草稿。
              whenDraftExists: 'append',
            })
            // 用 then 判 thenable（而不是 catch）：只要有 then 就按 Promise 收敛，
            // 不会把「有 then 无 catch」的返回当成同步成功、漏掉 reject。
            if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
              Promise.resolve(result).then(done, fail)
            } else {
              done()
            }
          } catch (cause) {
            fail(cause)
          }
        }

        const choosePreset = (next) => {
          setPreset(next)
          setStatus('idle')
          setError('')
        }

        const changeEntry = (next) => {
          store.set(next)
          writePreference(next)
          // 只有主区面板才需要「关掉入口后回到会话」：侧栏标签页里这么切会把人从
          // 中间面板硬拽走，而右侧栏那个标签本身还在。
          if (!next && host === 'main') {
            try {
              ctx.layout?.selectPanel('conversation')
            } catch {
              // layout 不可用时留在本页，仍可在设置里重新打开
            }
          }
        }

        const tabs = [
          { id: 'start', label: t(COPY.tabStart) },
          { id: 'settings', label: t(COPY.tabSettings) },
        ]

        return h('div', { className: 'mcs-root' },
          // 不用 <header>/<main>：面板可能和宿主已有的 banner/main 叠加成重复地标。
          // 一个带名字的 region 已经够读屏定位，也不会和宿主抢地标角色。
          h('div', { className: 'mcs-topbar' },
            h('div', { className: 'mcs-brand' },
              h(Icon, { name: 'scatter' }),
              h('span', { className: 'mcs-brand-name' }, t(COPY.sidebar))),
            h(Tabs, { view, onView: setView, items: tabs, label: t(COPY.tabsLabel), baseId })),
          h('div', { className: 'mcs-main', role: 'region', 'aria-label': t(COPY.sidebar) },
            h('div', {
              role: 'tabpanel',
              id: `${baseId}-start-panel`,
              'aria-labelledby': `${baseId}-start-tab`,
              hidden: view !== 'start',
              tabIndex: 0,
            }, view === 'start'
              ? h(StartPage, {
                preset,
                onPreset: choosePreset,
                onStart: start,
                error,
                onRetry: error === '' ? undefined : start,
                busy,
                status,
                baseId,
                i18n,
              })
              : null),
            h('div', {
              role: 'tabpanel',
              id: `${baseId}-settings-panel`,
              'aria-labelledby': `${baseId}-settings-tab`,
              hidden: view !== 'settings',
              tabIndex: 0,
            }, view === 'settings'
              ? h(SettingsPage, { store, i18n, onEntryChange: changeEntry, baseId })
              : null)))
      }
    }

    function makeConfigCard({ store, i18n }) {
      return function ConfigCard() {
        useSyncExternalStore(i18n.store.subscribe, i18n.store.get)
        const t = i18n.text
        const enabled = useSyncExternalStore(store.subscribe, store.get)
        return h('div', { className: 'mcs-root mcs-embed' },
          h('div', { className: 'mcs-card' },
            h('div', { className: 'mcs-row' },
              h('span', { className: 'mcs-row-label' }, t(COPY.configTitle)),
              h(Switch, {
                checked: enabled,
                label: t(COPY.configTitle),
                onChange: (next) => {
                  store.set(next)
                  writePreference(next)
                },
              })),
            h('p', { className: 'mcs-note' }, t(COPY.configNote))))
      }
    }

    // ---------------------------------------------------------------- 插件入口

    function apply(ctx) {
      const i18n = createI18n(ctx)
      const store = createStore(readPreference())
      const Panel = makePanel({ ctx, store, i18n, host: 'main' })
      // 同一套面板在右侧栏标签页里是另一个实例：只差「关入口时要不要切主区」。
      const TabPanel = makePanel({ ctx, store, i18n, host: 'tab' })

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = PACKAGE_NAME
        style.textContent = STYLE
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-multichannel-story: styles')

      // 主工作台面板（两个视图共用）。
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))

      // 侧栏入口：按偏好动态注册/注销。
      ctx.slots.inject('sidebar.panellist', () => {
        let dispose
        const sync = () => {
          if (dispose !== undefined) {
            dispose()
            dispose = undefined
          }
          if (!store.get()) return
          dispose = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: ENTRY_ORDER,
            label: () => i18n.text(COPY.sidebar),
          }, (props) => h(Icon, { name: 'scatter', size: (props && props.size) || 18 }))
        }
        sync()
        const unsubscribe = store.subscribe(sync)
        return () => {
          unsubscribe()
          if (dispose !== undefined) {
            dispose()
            dispose = undefined
          }
        }
      })

      // 插件详情页里的配置卡片：入口关掉后仍能重新打开。
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE_NAME,
        inject: () => ({}),
      }, makeConfigCard({ store, i18n })))

      // 本机若装了 better-sidebar（DSH 右侧栏），顺带注册一个同名标签页；没装就跳过。
      try {
        const registerTab = (service) => {
          if (service === undefined || typeof service.registerTab !== 'function') return
          ctx.effect(() => service.registerTab({
            id: `${PACKAGE_NAME}:panel`,
            title: () => i18n.text(COPY.sidebar),
            description: () => i18n.text(COPY.lede),
            icon: (size) => h(Icon, { name: 'scatter', size }),
            order: 60,
            single: true,
            component: TabPanel,
          }), 'dsh-multichannel-story: better-sidebar tab')
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['betterSidebar'], (scope) => registerTab(scope?.betterSidebar ?? scope?.get?.('betterSidebar')))
        }
      } catch (cause) {
        console.warn('[dsh-multichannel-story] better-sidebar tab skipped:', cause)
      }
    }

    return {
      apply,
      inject: ['slots', 'uiWorkspace'],
      __internals: {
        PACKAGE_NAME,
        PANEL_ID,
        PREF_KEY,
        START_PROMPT,
        COPY,
        PRESETS,
        ICONS,
        promptFor,
        readPreference,
        writePreference,
        createStore,
        createI18n,
        Icon,
        Switch,
        Tabs,
        Presets,
        StartPage,
        SettingsPage,
        makePanel,
        makeConfigCard,
      },
    }
  },
})
