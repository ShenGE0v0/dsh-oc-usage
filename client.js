/**
 * OpenCode 额度面板 —— Client 半。
 *
 * 两个注册点，都跟 git-panel 一样的挂法：
 *   sidebar.panellist —— 侧栏的一枚仪表图标，点开把 main 切到本面板；
 *   main (key=oc-usage) —— 面板本体：5 小时 / 每周 / 每月三档用量。
 *
 * 样式全部走主题 token（--dsw-alias-*），所以明暗主题、品牌色都自动跟随宿主，
 * 不写死任何一种颜色。数据来自本包 Host 半的 /dsh-oc-usage-api/usage。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-oc-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'ocUsage'
    /** 标题栏徽标在 header utilities 里的注册键。 */
    const CHIP_ID = 'oc-usage'
    /** 与 __ModuleLoader__ 的 id 一致：样式标签靠它标记，便于识别与清理。 */
    const PLUGIN_ID = '@local/dsh-oc-usage'
    const API = '/dsh-oc-usage-api/usage'
    const CONFIG_API = '/dsh-oc-usage-api/config'
    /** 写配置必须带的头：与 host 半的 CONFIG_WRITE_HEADER 一致，防跨站误写。 */
    const CONFIG_WRITE_HEADER = 'x-dsh-oc-usage-config'
    /** 上游是按滚动窗口计费的，一分钟一问足够，也不至于给上游添麻烦。 */
    const POLL_MS = 60_000
    /** 倒计时刷新节奏：只影响“重置于 …”那行文字。 */
    const TICK_MS = 15_000

    const zh = {
      panel: 'OpenCode 额度',
      rolling: '5 小时用量',
      weekly: '每周用量',
      monthly: '每月用量',
      rollingShort: '5h',
      weeklyShort: '1w',
      monthlyShort: '1m',
      clickToRefresh: '点击刷新',
      dismissHint: '点别处收起',
      loading: '读取中…',
      updated: '更新于',
      resetPrefix: '重置于',
      resetUnknown: '重置时间未知',
      windowUnknown: '该窗口暂不可用',
      loadFailed: '读取额度失败',
      perPercent: '1% ≈',
      counting: '统计中',
      ledger: 'token 记账',
      cacheShare: '缓存读占',
      requests: '次请求',
      ledgerIdle: '取自本地 DSH 会话日志，窗口起点按上游重置时间反推',
      excluded: '未计入',
      settingsNav: '额度面板',
      settingsTitle: '额度面板来源',
      settingsIntro: '面板上显示哪几路额度，以及它们各自用哪个凭据引用去取数。这里只存引用名，密钥本身始终在 设置 → 凭据 里。',
      enabled: '启用',
      credentialRef: '凭据引用',
      credentialRefs: '凭据引用（按顺序试）',
      baseURL: '接口地址',
      rollingHours: 'rolling 窗口长度（小时）',
      routes: '计入额度的路由（留空=自动判断）',
      routesAuto: '自动：设置里 baseURL 含 opencode.ai 的路由算数；查不到的老路由按名字兜底',
      save: '保存',
      saved: '已保存，并已重新取数',
      saving: '保存中…',
      configPath: '配置文件',
      reload: '重新读取',
      live: '当前状态',
      sourceDisabled: '未启用',
      otherSources: '其它来源',
      allRoutes: '各路由 token（月度窗口）',
      counted: '计入额度',
      notCounted: '不计入',
      balance: '余额',
      credits: '额度',
      used: '已用',
      remaining: '剩余',
      monthUsage: '本月',
      noData: '无数据',
      statusOk: '正常',
      kind: '类型',
      kind_usage: '用量（三档滚动窗口）',
      kind_balance: '余额',
      kind_credits: '额度（OpenRouter 形状）',
      kind_generic: '通用（自定义取值）',
      path: '请求路径',
      infoPath: '补充信息路径',
      infoPathHint: '/key，留空=用默认',
      needPath: 'generic 来源要填请求路径，例如 /user/info',
      needValuePath: 'generic 来源要填取值路径，例如 data.balance',
      valuePath: '取值路径',
      currencyPath: '币种路径',
      detailPath: '说明路径',
      optional: '可选',
      unit: '数值单位',
      unit_money: '金额',
      unit_percent: '百分比',
      unit_tokens: 'token 数',
      unit_number: '数字',
      unit_text: '文本',
      addSource: '新增来源',
      add: '添加',
      remove: '删除',
      sourceId: '标识',
      sourceName: '名称',
      sourceIdHint: '小写字母开头，只能用 小写字母/数字/_/-，最长 24 字符；它就是配置里的键名',
      idRule: '标识要用小写字母开头，只能含 小写字母/数字/_/-，最长 24 字符',
      idTaken: '这个标识已经有了',
      sourcesFull: '来源数量已经到上限（12 路）',
      kindLocked: '上面三张卡片固定读 opencode 这一路，类型改不了；请求路径可以改。',
      credsEmpty: '留空 = 不带凭据（公开接口）；多把引用用空格分开，会按顺序试',
      customHint: '新增的来源会作为「其它来源」的一行出现在额度卡片下面。只有 opencode 决定上面那三张卡片和 token 台账的窗口口径。',
      builtinNoDelete: '内置来源只能停用，不能删',
    }

    const en = {
      panel: 'OpenCode Usage',
      rolling: '5-hour usage',
      weekly: 'Weekly usage',
      monthly: 'Monthly usage',
      rollingShort: '5h',
      weeklyShort: '1w',
      monthlyShort: '1m',
      clickToRefresh: 'Click to refresh',
      dismissHint: 'Click outside to dismiss',
      loading: 'Loading…',
      updated: 'Updated',
      resetPrefix: 'Resets in',
      resetUnknown: 'Reset time unknown',
      windowUnknown: 'Window unavailable',
      loadFailed: 'Could not load usage',
      perPercent: '1% ≈',
      counting: 'counting',
      ledger: 'token ledger',
      cacheShare: 'cache reads',
      requests: 'requests',
      ledgerIdle: 'from local DSH session logs; window starts derived from upstream resets',
      excluded: 'excluded',
      settingsNav: 'Usage panel',
      settingsTitle: 'Usage panel sources',
      settingsIntro: 'Which sources the panel shows, and which credential reference each one reads. Only reference names live here; secrets stay in Settings → Credentials.',
      enabled: 'Enabled',
      credentialRef: 'Credential reference',
      credentialRefs: 'Credential references (tried in order)',
      baseURL: 'Endpoint',
      rollingHours: 'Rolling window length (hours)',
      routes: 'Routes counted against quota (blank = auto)',
      routesAuto: 'Auto: routes whose configured baseURL contains opencode.ai, plus unlisted legacy routes by name',
      save: 'Save',
      saved: 'Saved and re-fetched',
      saving: 'Saving…',
      configPath: 'Config file',
      reload: 'Reload',
      live: 'Current state',
      sourceDisabled: 'disabled',
      otherSources: 'Other sources',
      allRoutes: 'Tokens per route (monthly window)',
      counted: 'counted',
      notCounted: 'not counted',
      balance: 'Balance',
      credits: 'Credits',
      used: 'used',
      remaining: 'remaining',
      monthUsage: 'this month',
      noData: 'no data',
      statusOk: 'ok',
      kind: 'Kind',
      kind_usage: 'Usage (three rolling windows)',
      kind_balance: 'Balance',
      kind_credits: 'Credits (OpenRouter shape)',
      kind_generic: 'Generic (custom paths)',
      path: 'Request path',
      infoPath: 'Info path',
      infoPathHint: '/key, blank = default',
      needPath: 'A generic source needs a request path, e.g. /user/info',
      needValuePath: 'A generic source needs a value path, e.g. data.balance',
      valuePath: 'Value path',
      currencyPath: 'Currency path',
      detailPath: 'Detail path',
      optional: 'optional',
      unit: 'Value unit',
      unit_money: 'Money',
      unit_percent: 'Percent',
      unit_tokens: 'Tokens',
      unit_number: 'Number',
      unit_text: 'Text',
      addSource: 'Add a source',
      add: 'Add',
      remove: 'Remove',
      sourceId: 'Id',
      sourceName: 'Name',
      sourceIdHint: 'Lowercase letter first, then lowercase letters/digits/_/-; up to 24 chars. This is the config key.',
      idRule: 'Use a lowercase letter first, then lowercase letters/digits/_/-; up to 24 chars',
      idTaken: 'That id is already taken',
      sourcesFull: 'Source limit reached (12)',
      kindLocked: 'The three cards above always read the opencode source; its kind is fixed. The request path is still editable.',
      credsEmpty: 'Blank = no credential (public endpoint); space-separate several refs to try in order',
      customHint: 'Added sources show up as rows under "Other sources". Only opencode drives the three cards and the token-ledger window.',
      builtinNoDelete: 'Built-in sources can only be disabled, not removed',
    }

    let translate = (key) => key

    /**
     * 上一次真实指针位置，由 apply 里挂在 document 上的监听器维护。
     * 事件从目标冒泡到 document，所以徽标自己的处理函数先跑、读到的是"上一个事件"的
     * 坐标 —— 布局把徽标挪到静止指针底下时，浏览器补发的 mousemove 坐标与上一次完全
     * 相同，据此就能把合成的移动和真实移动区分开。
     */
    let lastPointer = { x: null, y: null }

    const WINDOWS = ['rolling', 'weekly', 'monthly']

    const CSS = `
/* 下面这组卡片规则由标题栏浮层里的三张用量卡片使用。 */
.ocu-card{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;min-width:0}
.ocu-card-head{display:flex;align-items:baseline;gap:8px}
.ocu-card-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ocu-card-pct{margin-left:auto;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;transition:color .3s ease}
.ocu-track{margin:10px 0 8px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ocu-fill{height:100%;border-radius:999px;transition:width .6s cubic-bezier(.4,0,.2,1),background .3s ease}
.ocu-card-foot{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
/* token 台账那一行：跟上面的重置倒计时用一条细线隔开，读法是"这个窗口里烧了多少
   token"，所以主数字给到 label-primary，换算率（1% ≈ 多少）退到次要色。 */
.ocu-tok{margin-top:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1)}
.ocu-tok-main{display:flex;align-items:baseline;gap:5px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocu-tok-strong{color:var(--dsw-alias-label-primary);font-weight:600}
.ocu-tok-dim{color:var(--dsw-alias-label-secondary)}
.ocu-tok-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocu-tok-pending{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.ocu-hpop-ledger{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.55;font-variant-numeric:tabular-nums}
/* 其它来源与各路由两小块：都挤在浮层里，用行而不是卡片，读的是"一行一件事"。 */
.ocu-block{margin-top:10px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}
.ocu-block-title{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-bottom:6px}
.ocu-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.7;font-variant-numeric:tabular-nums}
.ocu-row-name{color:var(--dsw-alias-label-secondary);flex:0 0 auto;min-width:82px}
.ocu-row-val{color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap}
.ocu-row-dim{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ocu-row-tag{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;flex:0 0 auto}
.ocu-row-tag-in{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ocu-row-err{color:var(--dsw-alias-state-error-primary)}
/* ── 设置页 ────────────────────────────────────────────────────────────────
   设置面板自己不带卡片样式，所以这里自建一套；颜色仍然全走主题 token，明暗都跟随。 */
.ocu-set{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}
.ocu-set-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.ocu-set-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px}
.ocu-set-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.ocu-set-name{font-weight:600}
.ocu-set-state{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ocu-set-grid{display:grid;grid-template-columns:112px 1fr;gap:8px 12px;align-items:center}
.ocu-set-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.ocu-set-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit}
.ocu-set-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.ocu-set-row{display:flex;align-items:center;gap:8px}
.ocu-set-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}
.ocu-set-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ocu-set-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:6px 14px;font-size:12.5px;cursor:pointer;font-family:inherit}
.ocu-set-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ocu-set-btn:disabled{opacity:.55;cursor:default}
.ocu-set-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-weight:600}
.ocu-set-note{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.6}
.ocu-set-err{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre-wrap}
.ocu-set-ok{color:var(--dsw-alias-brand-primary);font-size:12px}
.ocu-set-path{color:var(--dsw-alias-label-secondary);font-size:11.5px;word-break:break-all;font-family:var(--dsw-font-mono,monospace)}
/* 新增来源那张卡刻意排成"一张卡片"的样子：标题位就是名称（看起来像标题的输入框），
   下面一行「标识: …」，再下面才是字段网格 —— 跟已有来源的卡片逐行同构。
   那边 标识 是只读说明（id 是配置里的键名），这边是必填输入框。 */
.ocu-set-title{flex:0 1 320px;background:transparent;border:1px solid transparent;border-radius:6px;padding:2px 6px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-family:inherit}
.ocu-set-title:hover{border-color:var(--dsw-alias-border-l1)}
.ocu-set-title:focus{outline:none;border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.ocu-set-idline{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.ocu-set-idline .ocu-set-input{max-width:220px;padding:3px 7px;font-size:12px}
/* ── 对话标题栏里的紧凑徽标 ───────────────────────────────────────────────
   栏高很紧，所以内边距和字号都压到最小；三格数值用等宽数字，刷新时不跳动。 */
.ocu-hwrap{position:relative;display:flex;align-items:center}
.ocu-hchip{display:inline-flex;align-items:center;gap:9px;background:transparent;border:1px solid transparent;border-radius:7px;padding:3px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
.ocu-hchip:hover,.ocu-hchip-open{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ocu-hchip-err{color:var(--dsw-alias-state-error-primary)}
.ocu-hcell{display:inline-flex;align-items:baseline;gap:3px}
.ocu-hkey{color:var(--dsw-alias-label-secondary);font-size:11px}
.ocu-hval{font-size:12px;font-weight:600}
/* 位置由组件按徽标的视口矩形用行内 fixed 声明给出（见 UsageChip.measure）。
 *
 * 入场/退场用过渡而不是关键帧：浮层随时可能被再点一次、也可能悬停进出打断，过渡会
 * 从当前值改道，关键帧只会从头重放。收起态是 scale(.96) 而不是 0 —— 没有东西是从
 * "无"里长出来的；位移朝上 4px，退场就是往触发它的那枚徽标缩回去。
 * transform-origin 放在右上角，因为徽标就在浮层的正上方偏右，缩放要从那里长。
 * visibility 用 0s 过渡 + 150ms 延迟，是为了让淡出真的跑完再隐藏。 */
.ocu-hpop{--ocu-ease-out:cubic-bezier(0.23,1,0.32,1);width:min(520px,78vw);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.32);padding:12px;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-4px) scale(.96);transform-origin:top right;transition:opacity 150ms var(--ocu-ease-out),transform 150ms var(--ocu-ease-out),visibility 0s linear 150ms}
.ocu-hpop[data-open='true']{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);transition:opacity 150ms var(--ocu-ease-out),transform 150ms var(--ocu-ease-out),visibility 0s}
.ocu-hpop-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}
.ocu-hpop .ocu-card{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.ocu-hpop-err{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px;white-space:pre-wrap;word-break:break-word}
.ocu-hpop-foot{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
/* 减弱动效：不去掉淡入淡出（它还承担"这是新出现的一层"这个信息），只去掉位移与缩放。 */
@media (prefers-reduced-motion:reduce){.ocu-fill,.ocu-card-pct{transition:none}.ocu-hpop{transform:none;transition:opacity 120ms ease,visibility 0s linear 120ms}.ocu-hpop[data-open='true']{transform:none;transition:opacity 120ms ease,visibility 0s}}
`

    /* 标题栏自带一套图标按钮样式，会盖掉本包样式表里的 display/尺寸声明
     * （实测沿用宿主后图标被挤到文字上方、三格数值黏成一片）。布局相关的属性
     * 一律写成行内样式，行内声明压得过任何非 !important 的规则；颜色、边框、
     * 悬停态仍留在 CSS 里，这样主题 token 和 hover 反馈都还在。 */
    const CHIP_LAYOUT = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 9,
      width: 'auto',
      height: 'auto',
      minWidth: 0,
      boxSizing: 'border-box',
      padding: '3px 8px',
      borderRadius: 7,
      fontSize: 12,
      lineHeight: 1.45,
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
    }

    const CHIP_CELL_LAYOUT = {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 3.5,
      whiteSpace: 'nowrap',
    }

    const CHIP_WRAP_LAYOUT = { position: 'relative', display: 'flex', alignItems: 'center' }

    /* 悬停意图：指针在徽标上停够这么久才展开（扫过标题栏不会闪浮层）；
     * 离开后留这么久再收，好让指针能从徽标移到浮层上。 */
    const HOVER_OPEN_MS = 110
    const HOVER_CLOSE_MS = 160

    /** 用量越高越接近告警色；正常区间用品牌色，这样跟宿主自带的进度观感一致。 */
    function severityColor(percent) {
      if (typeof percent !== 'number') return 'var(--dsw-alias-label-secondary)'
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= 70) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function formatPercent(percent) {
      if (typeof percent !== 'number') return '—'
      return Number.isInteger(percent) ? String(percent) : percent.toFixed(1)
    }

    /** 跟额度面板一样的读法：天/小时、小时/分钟、分钟。 */
    function formatCountdown(iso, now) {
      if (!iso) return null
      const target = Date.parse(iso)
      if (!Number.isFinite(target)) return null
      const remaining = target - now
      if (remaining <= 0) return null
      const totalMinutes = Math.floor(remaining / 60_000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return `${days} 天 ${hours} 小时`
      if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
      if (minutes > 0) return `${minutes} 分钟`
      return '不到 1 分钟'
    }

    function formatClock(iso) {
      if (!iso) return ''
      const at = new Date(iso)
      return Number.isFinite(at.getTime()) ? at.toLocaleTimeString() : ''
    }

    /** token 数量按量级缩写：一屏里三张卡片都要放得下，位数比精度重要。 */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
      return String(Math.round(value))
    }

    /** 金额：小额保留 4 位（余额 0.007 美元这种不能显示成 0.01）。 */
    function formatMoney(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      const shown = Math.abs(value) < 1 ? value.toFixed(4) : value.toFixed(2)
      return currency === undefined || currency === null ? shown : `${shown} ${currency}`
    }

    const clone = (value) => JSON.parse(JSON.stringify(value))

    /**
     * 一路来源那一行的主数值。host 已经把响应压成 { unit, value, currency, detail }，
     * 所以这里只按单位格式化、不再认识任何具体厂商 —— 加一路来源不用改这个文件。
     * 返回 null 表示"这一路没有主数字"，调用方就把 detail 提上来当主行。
     */
    function summaryValue(summary) {
      const value = summary?.value
      if (value === null || value === undefined) return null
      switch (summary?.unit) {
        case 'money':
          return formatMoney(typeof value === 'number' ? value : Number(value), summary?.currency ?? null)
        case 'percent':
          return `${typeof value === 'number' ? formatPercent(value) : String(value)}%`
        case 'tokens':
          return formatTokens(Number(value))
        default:
          return String(value)
      }
    }

    /**
     * 一个窗口的 token 那一块。主行是"这个窗口里烧了多少 + 换算成 1% 是多少"，
     * 副行是缓存读的量 —— 掺水（如果真有）最可能藏在这里：缓存读占比高到 9 成
     * 以上时，它按什么价计费，直接决定额度掉得快不快。
     */
    function TokenLine({ tokens, pending }) {
      const total = formatTokens(tokens?.total)
      if (total === null) {
        return pending
          ? h('div', { className: 'ocu-tok' }, h('div', { className: 'ocu-tok-pending' }, translate('counting')))
          : null
      }
      const perPercent = formatTokens(tokens?.tokensPerPercent)
      const cacheRead = formatTokens(tokens?.cacheRead)
      const requests = typeof tokens?.requests === 'number' ? tokens.requests : null
      const detail = [
        `${total} tokens`,
        `${translate('requests')} ${requests ?? '—'}`,
        `未命中输入 ${formatTokens(tokens?.uncachedInput) ?? '—'}`,
        `输出 ${formatTokens(tokens?.output) ?? '—'}`,
        `缓存读 ${cacheRead ?? '—'}`,
        `缓存写 ${formatTokens(tokens?.cacheWrite) ?? '—'}`,
      ].join(' · ')

      return h(
        'div',
        { className: 'ocu-tok' },
        h(
          'div',
          { className: 'ocu-tok-main', title: detail },
          h('span', { className: 'ocu-tok-strong' }, total),
          h('span', { className: 'ocu-tok-dim' }, 'tok'),
          perPercent === null
            ? null
            : h('span', { className: 'ocu-tok-dim' }, `· ${translate('perPercent')} ${perPercent}`),
        ),
        h(
          'div',
          { className: 'ocu-tok-sub' },
          `${translate('cacheShare')} ${cacheRead ?? '—'} · ${requests ?? '—'} ${translate('requests')}`,
        ),
      )
    }

    function UsageCard({ name, entry, now, loading, tokens, pending }) {
      const percent = typeof entry?.percent === 'number' ? entry.percent : null
      const countdown = formatCountdown(entry?.resetsAt, now)
      const color = severityColor(percent)

      let foot
      if (loading) foot = translate('loading')
      else if (countdown) foot = `${translate('resetPrefix')} ${countdown}`
      else if (entry?.status && entry.status !== 'ok') foot = translate('windowUnknown')
      else foot = translate('resetUnknown')

      return h(
        'div',
        { className: 'ocu-card' },
        h(
          'div',
          { className: 'ocu-card-head' },
          h('span', { className: 'ocu-card-title' }, translate(name)),
          h('span', { className: 'ocu-card-pct', style: { color } }, `${formatPercent(percent)}%`),
        ),
        h(
          'div',
          { className: 'ocu-track' },
          h('div', { className: 'ocu-fill', style: { width: `${percent ?? 0}%`, background: color } }),
        ),
        h('div', { className: 'ocu-card-foot' }, foot),
        h(TokenLine, { tokens, pending }),
      )
    }

    /** 侧栏图标 + 标题行图标：一枚仪表。 */
    function UsageIcon(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flexShrink: 0 },
        },
        h('path', { d: 'M3.6 18.2a9.4 9.4 0 1 1 16.8 0' }),
        h('path', { d: 'M12 14.4 16.3 9.6' }),
        h('circle', { cx: 12, cy: 15.2, r: 1.5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /**
     * 面板和标题栏徽标共用的一份取数：60s 轮询、15s 刷新倒计时、点击时强制刷新。
     * 两个挂载点各持一份状态，互不影响。
     */
    function useUsage() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const load = useCallback(async (force) => {
        setBusy(true)
        try {
          const response = await fetch(force ? `${API}?refresh=1` : API, {
            headers: { accept: 'application/json' },
          })
          const payload = await response.json()
          if (!mounted.current) return
          if (payload?.ok) {
            setState(payload)
            setError('')
          } else {
            setError(payload?.message || translate('loadFailed'))
          }
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message ?? failure))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [])

      useEffect(() => {
        void load(false)
        const poll = setInterval(() => {
          void load(false)
        }, POLL_MS)
        const tick = setInterval(() => {
          setNow(Date.now())
        }, TICK_MS)
        return () => {
          clearInterval(poll)
          clearInterval(tick)
        }
      }, [load])

      return { state, error, busy, now, load }
    }

    /** 每格百分比的取值，取不到就是 null（显示为 —）。 */
    function percentOf(state, name) {
      const percent = state?.windows?.[name]?.percent
      return typeof percent === 'number' ? percent : null
    }

    /**
     * 对话标题栏里的紧凑徽标：常显 5h / 1w / 1m 三格百分比。
     *   悬停 —— 预览完整卡片（带进度条与重置倒计时），但只认真实指针移动；
     *   点击 —— 钉住/收起浮层，并在展开时强制刷新一次（触屏和键盘就只有这一条路）；
     *   收起 —— 点浮层以外的任何地方、或按 Esc。
     */
    function UsageChip() {
      const { state, error, busy, now, load } = useUsage()
      const [hovered, setHovered] = useState(false)
      const [pinned, setPinned] = useState(false)
      /* 浮层用 fixed 定位：标题栏自带布局，把 absolute 浮层交给它当包含块时右侧会
       * 溢出窗口（实测三张卡片被窗口右缘切掉）。改成量出徽标的视口矩形、自己算
       * top/right，就既不受祖先 overflow 裁切，也不受包含块是谁影响。 */
      const [anchor, setAnchor] = useState(null)
      const wrapRef = useRef(null)
      const popoverRef = useRef(null)
      const closeTimer = useRef(null)
      const openTimer = useRef(null)
      /* 主动收起后不再被"指针还停在原地"重新唤起，直到指针真的离开一次。 */
      const suppressHover = useRef(false)

      const open = hovered || pinned

      const measure = () => {
        const node = wrapRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function') return
        const rect = node.getBoundingClientRect()
        setAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) })
      }

      const cancelClose = () => {
        if (closeTimer.current) {
          clearTimeout(closeTimer.current)
          closeTimer.current = null
        }
      }
      const cancelOpen = () => {
        if (openTimer.current) {
          clearTimeout(openTimer.current)
          openTimer.current = null
        }
      }

      /**
       * 悬停展开只认真实的指针移动：用 onMouseMove + 坐标比对，而不是 onMouseEnter。
       * 开合侧栏会改变标题栏宽度，徽标就在静止的指针底下挪了位置，浏览器会据此补发
       * 一次进入/移动事件 —— 于是"点侧栏"看起来把额度浮层也带出来了。补发的事件坐标
       * 与上一次完全相同，据此过滤掉；再加一点 hover 意图延迟，指针只是扫过标题栏
       * 时也不会闪一下浮层。
       */
      const scheduleOpen = () => {
        cancelClose()
        if (open || suppressHover.current || openTimer.current) return
        openTimer.current = setTimeout(() => {
          openTimer.current = null
          measure()
          setHovered(true)
        }, HOVER_OPEN_MS)
      }
      const onMouseMove = (event) => {
        cancelClose()
        /* 与上一次指针位置完全相同 = 指针其实没动，这是布局位移/悬停修正补发的
         * 事件，不算悬停。 */
        if (event.clientX === lastPointer.x && event.clientY === lastPointer.y) return
        scheduleOpen()
      }
      const closeSoon = () => {
        cancelOpen()
        cancelClose()
        closeTimer.current = setTimeout(() => {
          setHovered(false)
        }, HOVER_CLOSE_MS)
      }
      const onLeave = () => {
        /* 指针离开过，就允许下次悬停重新展开。 */
        suppressHover.current = false
        closeSoon()
      }
      const togglePin = () => {
        cancelOpen()
        cancelClose()
        const next = !pinned
        measure()
        setPinned(next)
        setHovered(next)
        /* 收起之后指针多半还停在徽标上，别让它立刻又被悬停逻辑打开。 */
        suppressHover.current = !next
        if (next) void load(true)
      }
      /* 卸载时取消挂起的开、关计时器。 */
      useEffect(
        () => () => {
          cancelOpen()
          cancelClose()
        },
        [],
      )
      /* 徽标位置变了就重新量：窗口尺寸变化时 fixed 浮层要跟着走。 */
      useEffect(() => {
        if (!open) return undefined
        const onResize = () => measure()
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open])
      /* 点浮层（或徽标）以外的任何地方都收起；Esc 也收起。
       * 捕获阶段监听，别的组件 stopPropagation 也拦不住这次收起。 */
      useEffect(() => {
        if (!open) return undefined
        const dismiss = () => {
          setPinned(false)
          setHovered(false)
        }
        const onPointerDown = (event) => {
          /* 两道判定：浮层是徽标的子节点，所以 node.contains 通常就够；再按浮层自身的
           * 视口矩形兜一次，免得任何 retarget / 影子边界让点击被误判成"点在外面"。 */
          const wrap = wrapRef.current
          if (wrap && typeof wrap.contains === 'function' && wrap.contains(event.target)) return
          const pop = popoverRef.current
          if (pop && typeof pop.getBoundingClientRect === 'function') {
            const rect = pop.getBoundingClientRect()
            const { clientX: x, clientY: y } = event
            if (
              typeof x === 'number' &&
              typeof y === 'number' &&
              x >= rect.left &&
              x <= rect.right &&
              y >= rect.top &&
              y <= rect.bottom
            ) {
              return
            }
          }
          dismiss()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') dismiss()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('touchstart', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('touchstart', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const stamp = state ? `${translate('updated')} ${formatClock(state.fetchedAt)}` : translate('panel')

      /* token 台账是后台扫会话日志攒出来的：冷启动那一次要几十秒，期间三张卡片
       * 先显示"统计中"，扫完自动变成数字。只有"一个字都还没有"才算统计中 ——
       * 之后的增量刷新每两分钟一次，不该让已显示的数字来回闪。 */
      const coverage = state?.tokens?.coverage ?? null
      const hasAnyTokens = WINDOWS.some((name) => (state?.tokens?.[name]?.total ?? 0) > 0)
      const tokensPending = state?.tokens ? coverage?.sweeping === true && !hasAnyTokens : false
      const cacheShare = state?.tokens?.monthly?.cacheShare
      const excludedRoutes = state?.tokens?.attribution?.excludedRoutes ?? []
      /* 计数口径要写出来，否则"token 比预期少"会被当成漏算：只算打到 opencode.ai
       * 的路由，别的路由另列一行。 */
      /* 其它来源：启用了的都列出来 —— 取到数的显示数值，没取到的把失败原因写在那一行上。
       * 自定义来源最容易"悄悄坏了没人发现"，所以失败也必须占一行；未启用的不占版面
       * （要看状态去设置页）。 */
      const otherSources = Object.entries(state?.sources ?? {})
        .filter(([id, source]) => id !== 'opencode' && source?.skipped !== true)
        .map(([id, source]) => {
          const summary = source?.summary ?? null
          const failed = source?.ok !== true
          const value = failed ? null : summaryValue(summary)
          const reason = failed ? (source?.message ?? source?.error ?? translate('loadFailed')) : ''
          return {
            id,
            label: source?.label ?? id,
            /* 没有主数字时（免费层余额、unit=text）把 detail 提到主行，别让那一格空着。 */
            text: failed ? '—' : (value ?? summary?.detail ?? translate('noData')),
            detail: failed ? reason : value === null ? '' : (summary?.detail ?? ''),
            failed,
          }
        })
      const otherBlock =
        otherSources.length === 0
          ? null
          : h(
              'div',
              { className: 'ocu-block' },
              h('div', { className: 'ocu-block-title' }, translate('otherSources')),
              otherSources.map((entry) =>
                h(
                  'div',
                  { className: 'ocu-row', key: entry.id },
                  h('span', { className: 'ocu-row-name' }, entry.label),
                  h('span', { className: 'ocu-row-val' }, entry.text),
                  h(
                    'span',
                    {
                      className: `ocu-row-dim${entry.failed ? ' ocu-row-err' : ''}`,
                      title: entry.detail === '' ? undefined : entry.detail,
                    },
                    entry.detail,
                  ),
                ),
              ),
            )
      /* 各路由一份账：不只 OCG。月度窗口最长，按它列前几名。 */
      const routeRows = state?.tokens?.routes ?? []
      const routesBlock =
        routeRows.length === 0
          ? null
          : h(
              'div',
              { className: 'ocu-block' },
              h('div', { className: 'ocu-block-title' }, translate('allRoutes')),
              routeRows.slice(0, 6).map((entry) =>
                h(
                  'div',
                  { className: 'ocu-row', key: `${entry.provider}/${entry.model}` },
                  h('span', { className: 'ocu-row-name' }, entry.provider),
                  h('span', { className: 'ocu-row-val' }, `${formatTokens(entry.total) ?? '—'} tok`),
                  h('span', { className: 'ocu-row-dim' }, entry.model),
                  h(
                    'span',
                    { className: `ocu-row-tag${entry.counted ? ' ocu-row-tag-in' : ''}` },
                    translate(entry.counted ? 'counted' : 'notCounted'),
                  ),
                ),
              ),
            )

      const ledgerNote = state?.tokens
        ? h(
            'div',
            { className: 'ocu-hpop-ledger' },
            h(
              'div',
              null,
              tokensPending
                ? `${translate('ledger')}：${translate('counting')} ${coverage.read}/${coverage.total}`
                : `${translate('ledger')}：${coverage?.sessionCount ?? 0} 个会话` +
                    (typeof cacheShare === 'number'
                      ? ` · ${translate('cacheShare')} ${(cacheShare * 100).toFixed(1)}%`
                      : ''),
            ),
            h('div', null, translate('ledgerIdle')),
            excludedRoutes.length > 0
              ? h('div', null, `${translate('excluded')}：${excludedRoutes.join('、')}`)
              : null,
          )
        : null

      return h(
        'div',
        {
          className: 'ocu-hwrap',
          ref: wrapRef,
          style: CHIP_WRAP_LAYOUT,
          onMouseMove: onMouseMove,
          onMouseLeave: onLeave,
        },
        h(
          'button',
          {
            type: 'button',
            className:
              `ocu-hchip${open ? ' ocu-hchip-open' : ''}${error && !state ? ' ocu-hchip-err' : ''}`,
            style: CHIP_LAYOUT,
            'aria-label': translate('panel'),
            'aria-expanded': open,
            title: stamp,
            onClick: togglePin,
          },
          h(UsageIcon, { size: 13 }),
          WINDOWS.map((name) => {
            const percent = percentOf(state, name)
            return h(
              'span',
              { className: 'ocu-hcell', style: CHIP_CELL_LAYOUT, key: name },
              h('span', { className: 'ocu-hkey', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, translate(`${name}Short`)),
              h(
                'span',
                { className: 'ocu-hval', style: { fontSize: 12, fontWeight: 600, color: severityColor(percent) } },
                `${formatPercent(percent)}%`,
              ),
            )
          }),
        ),
        /* 常驻 DOM、用 data-open 切状态：条件渲染是瞬时挂载/卸载，过渡没有起点可插值，
           也就只会有"突然出现"。它是 position:fixed，隐藏时既不占布局、也不收指针事件。 */
        h(
          'div',
          {
            className: 'ocu-hpop',
            ref: popoverRef,
            'data-open': open ? 'true' : 'false',
            'aria-hidden': open ? undefined : 'true',
            style: {
              position: 'fixed',
              top: anchor?.top ?? 0,
              right: anchor?.right ?? 8,
              left: 'auto',
              zIndex: 90,
            },
          },
          error ? h('div', { className: 'ocu-hpop-err' }, error) : null,
          h(
            'div',
            { className: 'ocu-hpop-grid' },
            WINDOWS.map((name) =>
              h(UsageCard, {
                key: name,
                name,
                entry: state?.windows?.[name] ?? null,
                tokens: state?.tokens?.[name] ?? null,
                pending: tokensPending,
                now,
                loading: !state && !error,
              }),
            ),
          ),
          ledgerNote,
          otherBlock,
          routesBlock,
          h(
            'div',
            { className: 'ocu-hpop-foot' },
            busy
              ? `${stamp} · ${translate('loading')}`
              : `${stamp} · ${translate('clickToRefresh')} · ${translate('dismissHint')}`,
          ),
        ),
      )
    }

    /** kind 的取值顺序就是设置页下拉框的顺序；三种内置解读器之外就是 generic。 */
    const KINDS = ['usage', 'balance', 'credits', 'generic']
    const UNITS = ['money', 'percent', 'tokens', 'number', 'text']
    /** 内置来源：只能停用，不能删 —— 删了主面板就没数据了。 */
    const BUILTIN_IDS = ['opencode', 'deepseek', 'openrouter']
    /** 请求路径的占位提示，跟 host 半的 KIND_DEFAULT_PATH 一一对应（只用于提示，真正
     *  的默认值在 host 那边；这里留空就等于"用默认"）。 */
    const PATH_HINT = { usage: '/usage', balance: '/user/balance', credits: '/credits', generic: '' }
    /** 新增来源表单的初始草稿。id 只在表单里用，不会进配置。 */
    const blankSource = () => ({
      id: '',
      kind: 'generic',
      label: '',
      enabled: true,
      baseURL: '',
      credentialRef: '',
      path: '',
      valuePath: '',
      unit: 'money',
      currencyPath: '',
      detailPath: '',
    })

    /**
     * 一路来源的字段块，已有来源的卡片与"新增来源"表单共用。
     *
     * 只画 kind 真正用得上的字段：credits 才有补充信息路径，generic 才有取值路径/单位。
     * 换类型时别的字段留在草稿里不显示 —— 保存时 host 半按 kind 白名单丢弃，不会因为
     * 切过一次类型就往配置里留下一堆没用的键。
     */
    function SourceFields({ source, patch, locked }) {
      const kind = source.kind ?? 'generic'
      /* 空数组按"单值"渲染：host 半对没配凭据的来源就是存一个空数组，那不该让标签
       * 变成"（按顺序试）"——那个说法只对真的有多把的 opencode 成立。 */
      const many = Array.isArray(source.credentialRefs) && source.credentialRefs.length > 0
      const rows = []
      const pair = (key, label, node) => {
        rows.push(h('span', { className: 'ocu-set-label', key: `${key}-label` }, label))
        rows.push(h(React.Fragment, { key }, node))
      }
      const text = (value, onChange, placeholder) =>
        h('input', { className: 'ocu-set-input', spellCheck: false, value: value ?? '', placeholder, onChange })

      pair(
        'kind',
        translate('kind'),
        h(
          'select',
          {
            className: 'ocu-set-input',
            value: kind,
            disabled: locked === true,
            onChange: (event) => patch({ kind: event.target.value }),
          },
          KINDS.map((value) => h('option', { key: value, value }, translate(`kind_${value}`))),
        ),
      )
      pair('baseURL', translate('baseURL'), text(source.baseURL, (event) => patch({ baseURL: event.target.value }), 'https://…'))
      pair(
        'creds',
        translate(many ? 'credentialRefs' : 'credentialRef'),
        text(
          many ? (source.credentialRefs ?? []).join(' ') : (source.credentialRef ?? ''),
          (event) => {
            const pieces = event.target.value.split(/[\s,]+/).filter((piece) => piece !== '')
            if (many) patch({ credentialRefs: pieces })
            else patch({ credentialRef: event.target.value.trim() })
          },
          translate('credsEmpty'),
        ),
      )
      pair('path', translate('path'), text(source.path, (event) => patch({ path: event.target.value }), PATH_HINT[kind] || '/…'))
      if (kind === 'credits') {
        pair(
          'infoPath',
          translate('infoPath'),
          text(source.infoPath, (event) => patch({ infoPath: event.target.value }), translate('infoPathHint')),
        )
      }
      if (kind === 'generic') {
        pair('valuePath', translate('valuePath'), text(source.valuePath, (event) => patch({ valuePath: event.target.value }), 'data.balance'))
        pair(
          'unit',
          translate('unit'),
          h(
            'select',
            {
              className: 'ocu-set-input',
              value: source.unit ?? 'money',
              onChange: (event) => patch({ unit: event.target.value }),
            },
            UNITS.map((value) => h('option', { key: value, value }, translate(`unit_${value}`))),
          ),
        )
        pair(
          'currencyPath',
          translate('currencyPath'),
          text(source.currencyPath, (event) => patch({ currencyPath: event.target.value }), `data.currency（${translate('optional')}）`),
        )
        pair(
          'detailPath',
          translate('detailPath'),
          text(source.detailPath, (event) => patch({ detailPath: event.target.value }), `data.name（${translate('optional')}）`),
        )
      }
      return h('div', { className: 'ocu-set-grid' }, rows)
    }

    /**
     * 设置页：面板看哪几路来源、各自用哪个凭据引用取数。
     *
     * 配置存在 host 半自己管的 JSON 里，而不是 settings namespace：那份文档里只有
     * 引用名和地址，密钥始终留在 设置 → 凭据。保存走 PUT，host 半校验通过才落盘，
     * 所以这里不用在客户端猜哪个值合法 —— 报错原样显示 host 那几句。
     */
    function OcUsageSettings() {
      const [draft, setDraft] = useState(null)
      const [errors, setErrors] = useState([])
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [path, setPath] = useState('')
      const [live, setLive] = useState(null)
      /* 新增来源的表单草稿，以及它自己的报错（标识非法/重复这种，当场就能说清）。 */
      const [fresh, setFresh] = useState(blankSource)
      const [addError, setAddError] = useState('')

      const refreshLive = useCallback(async () => {
        try {
          const response = await fetch(`${API}?refresh=1`, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          setLive(payload?.sources ?? null)
        } catch {
          setLive(null)
        }
      }, [])

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(CONFIG_API, { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (payload?.ok) {
            setDraft(clone(payload.config))
            setPath(payload.path ?? '')
            setErrors(payload.error ? [payload.error] : [])
            void refreshLive()
          } else {
            setErrors([...(payload?.errors ?? []), payload?.message].filter(Boolean))
          }
        } catch (failure) {
          setErrors([String(failure?.message ?? failure)])
        } finally {
          setBusy(false)
        }
      }, [refreshLive])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(async () => {
        setBusy(true)
        setErrors([])
        setNotice('')
        try {
          const response = await fetch(CONFIG_API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', [CONFIG_WRITE_HEADER]: '1' },
            body: JSON.stringify(draft),
          })
          const payload = await response.json()
          if (payload?.ok) {
            setDraft(clone(payload.config))
            setPath(payload.path ?? '')
            setNotice(translate('saved'))
            void refreshLive()
          } else {
            setErrors([...(payload?.errors ?? []), payload?.message].filter(Boolean))
          }
        } catch (failure) {
          setErrors([String(failure?.message ?? failure)])
        } finally {
          setBusy(false)
        }
      }, [draft, refreshLive])

      if (draft === null) {
        return h(
          'div',
          { className: 'ocu-set' },
          errors.length > 0 ? h('div', { className: 'ocu-set-err' }, errors.join('\n')) : null,
          h('div', { className: 'ocu-set-intro' }, busy ? translate('saving') : translate('loading')),
        )
      }

      const patchSource = (id, patch) => {
        setDraft((current) => ({
          ...current,
          sources: { ...current.sources, [id]: { ...current.sources[id], ...patch } },
        }))
      }

      const removeSource = (id) => {
        setDraft((current) => {
          const sources = { ...current.sources }
          delete sources[id]
          return { ...current, sources }
        })
        /* 删掉这一路之后，它上一轮的那行状态留在 live 里也没意义了。 */
        setLive((current) => {
          if (current === null || current[id] === undefined) return current
          const next = { ...current }
          delete next[id]
          return next
        })
      }

      const patchFresh = (patch) => {
        setAddError('')
        setFresh((current) => ({ ...current, ...patch }))
      }

      /**
       * 把新增表单里那一条加进草稿。只做"现在就能判死"的检查（标识格式/重复、generic
       * 必填项），其余交给 host 半 —— 保存时它会用同一套校验再拦一次，这里只是别让
       * 用户点了添加、等到保存才知道标识写错了。
       *
       * 空串一律不写进草稿：host 半对 path/infoPath 的语义是"空 = 用该类型的默认值"，
       * 所以少写一个键和写一个空串等价，而少写更不容易在切类型后留下垃圾值。
       */
      const addSource = () => {
        const id = fresh.id.trim()
        if (!/^[a-z][a-z0-9_-]{0,23}$/.test(id)) {
          setAddError(translate('idRule'))
          return
        }
        if (draft.sources?.[id] !== undefined) {
          setAddError(translate('idTaken'))
          return
        }
        if (Object.keys(draft.sources ?? {}).length >= 12) {
          setAddError(translate('sourcesFull'))
          return
        }
        if (fresh.kind === 'generic' && fresh.path.trim() === '') {
          setAddError(translate('needPath'))
          return
        }
        if (fresh.kind === 'generic' && fresh.valuePath.trim() === '') {
          setAddError(translate('needValuePath'))
          return
        }
        const entry = {}
        for (const [key, value] of Object.entries(fresh)) {
          if (key === 'id' || key === 'credentialRef') continue
          if (typeof value === 'string') {
            if (value.trim() !== '') entry[key] = value.trim()
            continue
          }
          if (Array.isArray(value)) {
            if (value.length > 0) entry[key] = [...value]
            continue
          }
          entry[key] = value
        }
        /* enabled 是布尔且默认 true，不能被上面的"空值丢掉"规则波及。 */
        entry.enabled = fresh.enabled === true
        entry.label = fresh.label.trim() !== '' ? fresh.label.trim() : id
        /* 凭据引用：一把就存成 credentialRef（跟内置那两路同形，卡片上也就显示"凭据引用"），
         * 多把才存成数组 —— "（按顺序试）"这个说法只对真有多把成立。空着就是不带凭据。 */
        const refs = fresh.credentialRef.split(/[\s,]+/).filter((piece) => piece !== '')
        if (refs.length > 1) entry.credentialRefs = refs
        else entry.credentialRef = refs[0] ?? ''
        setDraft((current) => ({ ...current, sources: { ...(current.sources ?? {}), [id]: entry } }))
        setFresh(blankSource())
        setAddError('')
      }

      const card = (id) => {
        const source = draft.sources?.[id] ?? {}
        const state = live?.[id]
        const builtin = BUILTIN_IDS.includes(id)
        let stateText = ''
        if (state !== undefined && state !== null) {
          if (state.skipped === true) stateText = translate('sourceDisabled')
          else if (state.ok === true) stateText = translate('statusOk')
          else stateText = state.message ?? state.error ?? ''
        }
        return h(
          'div',
          { className: 'ocu-set-card', key: id },
          h(
            'div',
            { className: 'ocu-set-head' },
            h('input', {
              type: 'checkbox',
              className: 'ocu-set-check',
              checked: source.enabled === true,
              'aria-label': `${translate('enabled')} ${source.label ?? id}`,
              onChange: (event) => patchSource(id, { enabled: event.target.checked }),
            }),
            h('span', { className: 'ocu-set-name' }, source.label ?? id),
            h('span', { className: 'ocu-set-state' }, stateText),
            /* 内置那三路不给删：删了主面板就没数据了，只能停用。 */
            builtin
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ocu-set-btn',
                    disabled: busy,
                    onClick: () => removeSource(id),
                  },
                  translate('remove'),
                ),
          ),
          h('div', { className: 'ocu-set-idline' }, h('span', { className: 'ocu-set-label' }, `${translate('sourceId')}: ${id}`)),
          h(SourceFields, { source, patch: (patch) => patchSource(id, patch), locked: id === 'opencode' }),
          id === 'opencode' ? h('div', { className: 'ocu-set-note', style: { marginTop: 8 } }, translate('kindLocked')) : null,
        )
      }

      const addCard = h(
        'div',
        { className: 'ocu-set-card' },
        h(
          'div',
          { className: 'ocu-set-head' },
          h('input', {
            type: 'checkbox',
            className: 'ocu-set-check',
            checked: fresh.enabled === true,
            'aria-label': translate('enabled'),
            onChange: (event) => patchFresh({ enabled: event.target.checked }),
          }),
          /* 标题位就是"名称"：已有来源的卡片那里是只读的名字，这边是同一个位置的输入框。 */
          h('input', {
            className: 'ocu-set-title',
            spellCheck: false,
            value: fresh.label,
            placeholder: translate('sourceName'),
            'aria-label': translate('sourceName'),
            onChange: (event) => patchFresh({ label: event.target.value }),
          }),
        ),
        /* 与已有来源的卡片同构：标题下面是「标识: …」一行，再下面是字段网格。
         * 那边 id 是配置里的键名、只读，这边是必填输入框。 */
        h(
          'div',
          { className: 'ocu-set-idline' },
          h('span', { className: 'ocu-set-label' }, `${translate('sourceId')}:`),
          h('input', {
            className: 'ocu-set-input',
            spellCheck: false,
            value: fresh.id,
            placeholder: 'glm',
            onChange: (event) => patchFresh({ id: event.target.value }),
          }),
        ),
        h(SourceFields, { source: fresh, patch: patchFresh }),
        addError ? h('div', { className: 'ocu-set-err', style: { marginTop: 10 } }, addError) : null,
        h(
          'div',
          { className: 'ocu-set-actions', style: { marginTop: 10 } },
          h('button', { type: 'button', className: 'ocu-set-btn', disabled: busy, onClick: addSource }, translate('add')),
          h('span', { className: 'ocu-set-note' }, translate('sourceIdHint')),
        ),
      )

      return h(
        'div',
        { className: 'ocu-set' },
        h(
          'div',
          { className: 'ocu-set-intro' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, translate('settingsTitle')),
          h('div', null, translate('settingsIntro')),
        ),
        errors.length > 0 ? h('div', { className: 'ocu-set-err' }, errors.join('\n')) : null,
        notice ? h('div', { className: 'ocu-set-ok' }, notice) : null,
        Object.keys(draft.sources ?? {}).map(card),
        addCard,
        h(
          'div',
          { className: 'ocu-set-card' },
          h(
            'div',
            { className: 'ocu-set-grid' },
            h('span', { className: 'ocu-set-label' }, translate('rollingHours')),
            h('input', {
              className: 'ocu-set-input',
              type: 'number',
              min: 1,
              max: 168,
              value: draft.rollingHours ?? 5,
              onChange: (event) => setDraft((current) => ({ ...current, rollingHours: Number(event.target.value) })),
            }),
            h('span', { className: 'ocu-set-label' }, translate('routes')),
            h('input', {
              className: 'ocu-set-input',
              spellCheck: false,
              placeholder: translate('routesAuto'),
              value: (draft.routes ?? []).join(' '),
              onChange: (event) =>
                setDraft((current) => ({
                  ...current,
                  routes: event.target.value.split(/[\s,]+/).filter((piece) => piece !== ''),
                })),
            }),
          ),
        ),
        h(
          'div',
          { className: 'ocu-set-actions' },
          h(
            'button',
            { type: 'button', className: 'ocu-set-btn ocu-set-btn-primary', disabled: busy, onClick: () => void save() },
            busy ? translate('saving') : translate('save'),
          ),
          h('button', { type: 'button', className: 'ocu-set-btn', disabled: busy, onClick: () => void load() }, translate('reload')),
        ),
        path
          ? h(
              'div',
              { className: 'ocu-set-note' },
              `${translate('configPath')}: `,
              h('span', { className: 'ocu-set-path' }, path),
            )
          : null,
        h('div', { className: 'ocu-set-note' }, translate('customHint')),
        h('div', { className: 'ocu-set-note' }, translate('builtinNoDelete')),
        h('div', { className: 'ocu-set-note' }, translate('routesAuto')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /* 样式表挂在插件生命周期上，而不是某个组件的渲染树里：徽标所在的标题栏
         * 与浮层是两个挂载点，样式只有挂到插件上才都拿得到
         * —— 之前写在组件里，浮层会变成一段没样式的裸文本。 */
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.dataset.pluginCss = `${PLUGIN_ID}/oc-usage.css`
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'oc-usage: stylesheet')

        /* 全局记下最后一个真实的指针位置（冒泡阶段跑，晚于徽标自己的处理函数）。
         * 徽标靠它判断收到的 mousemove 是真实移动还是布局修正补发的。 */
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const onMove = (event) => {
            lastPointer = { x: event.clientX, y: event.clientY }
          }
          document.addEventListener('mousemove', onMove, { passive: true })
          return () => document.removeEventListener('mousemove', onMove)
        }, 'oc-usage: pointer tracker')

        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'oc-usage: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'oc-usage: en dictionary')
        try {
          const bound = ctx.locale.bind(NS)
          translate = (key) => {
            const value = bound(key)
            return value === key ? (zh[key] ?? key) : value
          }
        } catch {
          /* 留用上面的字典回退 */
        }

        /* 只挂这一处：对话标题栏右侧的工具位（会话级 slot，靠 slots.inject 等它
         * 被声明出来）。侧栏图标与整页面板已按要求撤掉。 */
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: CHIP_ID,
              order: 5,
              label: () => translate('panel'),
              locale: NS,
            },
            UsageChip,
          ),
        )

        /* 设置入口：额度面板自己的一页，管"看哪几路来源、各自用哪个引用取数"。
         * 与浮层同源，所以设置里改完下一次轮询就生效，不用重启。 */
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'oc-usage',
              order: 45,
              label: () => translate('settingsNav'),
              locale: NS,
            },
            OcUsageSettings,
          ),
        )
      },
    }
  },
})
