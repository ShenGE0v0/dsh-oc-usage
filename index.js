/**
 * OpenCode Go 额度面板 —— Host 半。
 *
 * 上游一个官方额度接口，三种滚动窗口：
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <OpenCode Console Key>
 *   -> { usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }
 *
 * 这一半只做三件事：
 *   1. 从 credentials 服务按名解析 Key（每次请求都重新解析 —— 该服务的约定是
 *      消费者不得跨操作缓存，换了 Key 下一个请求就生效，不用重启）；
 *   2. 带上 Key 向上游取数，并把各窗口归一成 { percent, resetsAt, status }；
 *   3. 在 /dsh-oc-usage-api/usage 上把结果交给 Client 半。
 *
 * Key 只存在于这一半，任何响应体里都不回传它（只回传它来自哪个凭据名、哪个来源，
 * 以及它是哪一代 Key —— 那只是前缀分类，不是密钥内容）。
 */
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const inject = ['webServer', 'credentials']

/** 本包独占的路由前缀，Client 半按同一常量取数。 */
const ROUTE = '/dsh-oc-usage-api'
const REQUEST_TIMEOUT_MS = 15_000
/** 上游是自己计费的滚动窗口，30 秒内重复问没有意义；Client 也按这个节奏轮询。 */
const CACHE_TTL_MS = 30_000

/**
 * 候选凭据名。第一个被上游接受的胜出并被记住，稳态下每次刷新仍然只发一个请求；
 * 只有它失效了，才会重新挨个试。
 *
 * 为什么要一串名字，而不是一个：
 *   - 上游 /usage 只认 Console 里那把 `oc_sk_` 开头的 Key。`sk-` 开头的旧版 Key
 *     早已不在 Console 的 KeyTable 里，一律回 401 —— 而与此同时同一个 profile 里的
 *     对话却完全正常，因为对话用的是路由自己那把（llm-pi-ai 的 apiKeyEnv）。
 *     两处不是同一把 Key，是这类面板最常见的一种"看着像坏了、其实只是问错了对象"。
 *   - 凭据引用这一半没有枚举接口（credentials 服务的约定：谁用谁点名，配置界面靠
 *     settings schema 知道存在哪些引用），所以只能把可能的名字列全，挨个试。
 *
 * 顺序按"最可能是路由正在用的那把"排：面板和推理认同一把 Key，显示的额度才和
 * 实际消耗对得上。要换成别的名字，在 config 里声明 credentialRefs 即可（声明的排最前）。
 */
const DEFAULT_CREDENTIAL_REFS = [
  'OPEN_API_KEY', // 一些 profile 里 llm-pi-ai 路由的 apiKeyEnv 指向它
  'OPENCODE_USAGE_API_KEY', // 本面板最初的专用引用（现存的可能仍是失效的旧 Key）
  'OPENCODE_GO_API_KEY', // opencode 网关的环境变量名
  'OPENCODE_API_KEY', // 其它第三方额度工具用的名字
]

/* ── 来源（设置页可增删改）──────────────────────────────────────────────────
 *
 * 每一路来源都是同一件事：拿一个凭据引用，去问一个只读的额度/余额接口。
 * 所以设置里存的是 **引用名和地址**，绝不是密钥本身 —— 面板从头到尾不落任何密钥。
 *
 * kind 决定"怎么读这份响应"，也就是用哪个解读器：
 *   usage    三档滚动窗口  GET {base}{path}      -> usage.rolling|weekly|monthly{status,percent,resetsAt}
 *   balance  账户余额      GET {base}{path}      -> {is_available, balance_infos:[{currency,total_balance,…}]}
 *   credits  OpenRouter    GET {base}{path}      -> {data:{total_credits,total_usage}}
 *                          GET {base}{infoPath}  -> {data:{usage_daily,usage_weekly,usage_monthly,limit,…}}
 *   generic  任意只读接口   GET {base}{path}      -> 用 valuePath/currencyPath/detailPath 自己取
 *
 * 前三种解读器各自带一个默认 path，也可以改（换个厂商、同样的响应形状挂在别的路径下）。
 * generic 没有默认值：path 与 valuePath 必填，unit 决定那个数怎么显示。
 *
 * 默认只开 opencode：其它几路是"不仅想看 OCG"用的，能力装好了但不会自己冒出来占
 * 版面，去设置页勾一下即可。除 opencode 之外的来源一律以「其它来源」那几行的形式
 * 出现在浮层里 —— 三张卡片和 token 台账的额度对照口径只认 opencode 这一路，
 * 因为它才是这份订阅的额度，别的来源没有那份 resetsAt 可以反推窗口。
 */
const SOURCE_KINDS = ['usage', 'balance', 'credits', 'generic']
/** 每种解读器的默认请求路径；generic 必须自己写，所以默认值是空串。 */
const KIND_DEFAULT_PATH = { usage: '/usage', balance: '/user/balance', credits: '/credits', generic: '' }
/** credits 解读器的补充信息接口（OpenRouter 的 /key）；写空串就是不请求它。 */
const KIND_DEFAULT_INFO_PATH = '/key'
/** generic 取到的数怎么显示。不在这张表里的单位一律拒绝，免得前端拿到一个不认识的单位。 */
const GENERIC_UNITS = ['money', 'percent', 'tokens', 'number', 'text']
/** 来源条数上限：浮层是给人扫一眼的，不是仪表盘。 */
const MAX_SOURCES = 12
/** 自定义来源的标识：既进配置文件当键名、也进接口响应，所以先把字符集收窄。 */
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/
/** 取值路径的语法：a.b[0].c。没有通配、过滤器、函数 —— 这是取值器，不是查询语言。 */
const VALUE_PATH_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]*(\.[A-Za-z0-9_$-]+|\[\d+\])*$/

const SOURCE_DEFAULTS = {
  opencode: {
    kind: 'usage',
    label: 'OpenCode Go',
    enabled: true,
    baseURL: 'https://opencode.ai/zen/go/v1',
    credentialRefs: DEFAULT_CREDENTIAL_REFS,
  },
  deepseek: {
    kind: 'balance',
    label: 'DeepSeek',
    enabled: false,
    baseURL: 'https://api.deepseek.com',
    credentialRef: 'DEEPSEEK_API_KEY',
  },
  openrouter: {
    kind: 'credits',
    label: 'OpenRouter',
    enabled: false,
    baseURL: 'https://openrouter.ai/api/v1',
    credentialRef: 'OPENROUTER_API_KEY',
  },
}

/** 面板自己的配置。放 harness home 下，跟 .credentials.yaml 并列，便于手改。 */
const CONFIG_FILE = join(process.env.USERPROFILE ?? '', '.dsh', 'dsh-oc-usage.config.json')
/** 设置页写配置时要带的自定义头：本地端口上防住"网页表单误提交"这一类意外写。 */
const CONFIG_WRITE_HEADER = 'x-dsh-oc-usage-config'

/**
 * 请求路径归一。只收相对路径：绝对 URL 和 `//host` 那种协议相对写法一律拒绝 ——
 * 否则一个 path 就能把带着凭据的请求指到别的主机上去。
 * 空串统一表示"没填"，由调用方换成该类型的默认值 —— 这样设置页里清空一个路径框
 * 得到的语义是"用默认"，而不是"把路径删掉"（后者会让请求打到 baseURL 根上）。
 */
function normalizePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return { path: '' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return { error: '只能是相对路径，不能是完整地址（凭据只发给你填的这个 baseURL）' }
  }
  return { path: raw.startsWith('/') ? raw : `/${raw}` }
}

/** generic 的取值路径：先卡语法，运行时再由 readPath 走一遍。 */
function checkValuePath(value, what) {
  if (typeof value !== 'string' || value.trim() === '') return { error: `要填${what}，例如 data.balance` }
  const trimmed = value.trim()
  if (!VALUE_PATH_PATTERN.test(trimmed)) {
    return { error: `${trimmed} 不是合法的取值路径（形如 data.balance、data.items[0].total）` }
  }
  return { path: trimmed }
}

/**
 * 按 `a.b[0].c` 取值。只走对象属性与数组下标，不 eval、没有通配与过滤器 ——
 * 取值路径来自配置文件，等于用户自己写的表达式，所以这里必须是个封闭的解释器。
 * 取不到一律回 undefined，由调用方如实报"响应里没有这个路径"，绝不编一个 0 出来：
 * 编出来的 0 会被当成"余额就是 0"，比报错更误导。
 */
function readPath(root, path) {
  let current = root
  for (const token of String(path).split('.')) {
    const bracket = token.indexOf('[')
    const name = bracket === -1 ? token : token.slice(0, bracket)
    if (name !== '') {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = current[name]
    }
    if (bracket !== -1) {
      for (const match of token.slice(bracket).matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(current)) return undefined
        current = current[Number(match[1])]
      }
    }
  }
  return current
}

/**
 * 凭据引用名与地址的白名单校验。配置里只允许"引用名"，所以这里也拦一下别把密钥写进来。
 *
 * 三种内置解读器有默认值（SOURCE_DEFAULTS），自定义来源什么都没有，所以每个字段都按
 * "配置里写了就用、没写就用内置默认、都没有就报错"来判。返回对象只含白名单里的键。
 */
function validateSourceEntry(id, entry, errors) {
  const fallback = SOURCE_DEFAULTS[id] ?? {}
  const out = {}
  const kind = SOURCE_KINDS.includes(entry?.kind) ? entry.kind : fallback.kind
  if (kind === undefined) errors.push(`${id}.kind 要是 ${SOURCE_KINDS.join(' / ')} 之一`)
  out.kind = kind ?? 'generic'
  out.label = typeof entry?.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : (fallback.label ?? id)
  out.enabled = entry?.enabled === true
  const base = typeof entry?.baseURL === 'string' && entry.baseURL.trim() !== '' ? entry.baseURL.trim() : fallback.baseURL
  if (typeof base !== 'string' || !/^https?:\/\/[^\s]+$/i.test(base)) {
    errors.push(`${id}.baseURL 必须是 http(s) 地址`)
  } else if (/^https?:\/\/[^/@]*@/i.test(base)) {
    /* 地址里塞密钥是这类面板最常见的自伤：会被写进明文配置文件。 */
    errors.push(`${id}.baseURL 不能内嵌凭据，请改用 credentialRef`)
  } else {
    out.baseURL = base.replace(/\/+$/, '')
  }

  /* 凭据引用：可以一把、可以多把（按顺序试），也可以明确不带（空数组或空串 = 公开接口）。 */
  const refPattern = /^[A-Za-z_][A-Za-z0-9_]*$/
  const refList = Array.isArray(entry?.credentialRefs)
    ? entry.credentialRefs.filter((ref) => typeof ref === 'string' && ref.trim() !== '').map((ref) => ref.trim())
    : null
  const refSingle = typeof entry?.credentialRef === 'string' ? entry.credentialRef.trim() : ''
  let declared = false
  if (refList !== null && refList.length > 0) {
    for (const ref of refList) if (!refPattern.test(ref)) errors.push(`${id}.credentialRefs 里的 ${ref} 不是合法的引用名`)
    out.credentialRefs = refList
    declared = true
  } else if (refSingle !== '') {
    /* 单值优先于"空列表"：设置页在单值/多值两种形状之间切过之后，草稿里会同时留着
     * credentialRefs: [] 和刚填的 credentialRef —— 那时必须听后者，否则填了等于没填。 */
    if (!refPattern.test(refSingle)) errors.push(`${id}.credentialRef 里的 ${refSingle} 不是合法的引用名`)
    else out.credentialRef = refSingle
    declared = true
  } else if (refList !== null || entry?.credentialRef === '') {
    out.credentialRefs = []
    declared = true
  }
  if (!declared) {
    if (Array.isArray(fallback.credentialRefs)) out.credentialRefs = [...fallback.credentialRefs]
    else if (typeof fallback.credentialRef === 'string') out.credentialRef = fallback.credentialRef
    else out.credentialRefs = []
  }

  /* 请求路径：空着就用该类型的默认值。generic 的默认值是空串，于是会在下面报错。 */
  const rawPath = typeof entry?.path === 'string' && entry.path.trim() !== '' ? entry.path : (fallback.path ?? KIND_DEFAULT_PATH[out.kind] ?? '')
  const path = normalizePath(rawPath)
  if (path.error) errors.push(`${id}.path ${path.error}`)
  else out.path = path.path
  if (out.kind === 'generic' && out.path === '') {
    errors.push(`${id} 是 generic 来源，必须填请求路径（例如 /user/info）`)
  }

  if (out.kind === 'credits') {
    const rawInfo = typeof entry?.infoPath === 'string' && entry.infoPath.trim() !== '' ? entry.infoPath : (fallback.infoPath ?? KIND_DEFAULT_INFO_PATH)
    const info = normalizePath(rawInfo)
    if (info.error) errors.push(`${id}.infoPath ${info.error}`)
    else out.infoPath = info.path
  }

  if (out.kind === 'generic') {
    const valuePath = checkValuePath(entry?.valuePath ?? fallback.valuePath, '取值路径')
    if (valuePath.error) errors.push(`${id}.valuePath ${valuePath.error}`)
    else out.valuePath = valuePath.path
    /* 单位只认表里那几个。手写的配置文件里写了个不认识的值就报出来，而不是悄悄按金额
     * 显示 —— 把 token 数按金额显示，比报错难查得多。 */
    if (entry?.unit !== undefined && !GENERIC_UNITS.includes(entry.unit)) {
      errors.push(`${id}.unit 要是 ${GENERIC_UNITS.join(' / ')} 之一`)
    }
    out.unit = GENERIC_UNITS.includes(entry?.unit)
      ? entry.unit
      : GENERIC_UNITS.includes(fallback.unit)
        ? fallback.unit
        : 'money'
    for (const key of ['currencyPath', 'detailPath']) {
      const raw = entry?.[key]
      if (raw === undefined || raw === null || raw === '') continue
      const parsed = checkValuePath(raw, key === 'currencyPath' ? '币种路径' : '说明路径')
      if (parsed.error) errors.push(`${id}.${key} ${parsed.error}`)
      else out[key] = parsed.path
    }
  }
  return out
}

/**
 * 面板配置，三层叠起来：代码默认值 → cordis.patch.yml 的 config → 设置页写下的
 * `~/.dsh/dsh-oc-usage.config.json`。设置页永远只改最后一层，所以手改 patch 或
 * 删掉那个 JSON 都能回到上一层，不会出现"改了不知道哪层在生效"。
 *
 * 来源是一张开放的表：三个内置来源永远在（只能停用，不能删），设置页新增的自定义
 * 来源以同样的形状存进同一张表。所以"读配置文件"和"设置页保存"共用同一个 merge()，
 * 两边永远不会出现校验口径不一致 —— 手改的文件和设置页写出来的文件是同一种东西。
 */
function createConfigStore(ctx, patch) {
  const defaults = () => {
    const base = {
      version: 2,
      rollingHours: DEFAULT_ROLLING_HOURS,
      /** null = 自动判"哪些路由算 opencode"；给了数组就是白名单。 */
      routes: null,
      sources: Object.fromEntries(
        Object.entries(SOURCE_DEFAULTS).map(([id, entry]) => [id, validateSourceEntry(id, entry, [])]),
      ),
    }
    if (typeof patch?.rollingHours === 'number' && patch.rollingHours > 0 && patch.rollingHours <= 168) {
      base.rollingHours = patch.rollingHours
    }
    if (Array.isArray(patch?.routes)) {
      base.routes = patch.routes.filter((route) => typeof route === 'string' && route !== '')
    }
    /* 老写法（patch 里只写 credentialRef/credentialRefs）继续有效：声明的排最前，
     * 代码里的候选名跟在后面兜底 —— 跟这个面板最初的语义一致。 */
    const declared = []
    if (typeof patch?.credentialRef === 'string' && patch.credentialRef.trim() !== '') {
      declared.push(patch.credentialRef.trim())
    }
    if (Array.isArray(patch?.credentialRefs)) {
      for (const ref of patch.credentialRefs) {
        if (typeof ref === 'string' && ref.trim() !== '') declared.push(ref.trim())
      }
    }
    if (declared.length > 0) {
      const merged = [...new Set([...declared, ...DEFAULT_CREDENTIAL_REFS])]
      base.sources.opencode = validateSourceEntry('opencode', { ...base.sources.opencode, credentialRefs: merged }, [])
    }
    return base
  }
  /**
   * 一份配置文档 → 归一后的值。读文件和设置页保存共用这一份，于是报错信息也只有一套。
   *
   * 自定义来源与内置来源的唯一区别是"内置那份在 sources 里被删掉时回落到默认值"：
   * provided 里没提到的内置来源保持默认（删不掉，只能 enabled:false），没提到的自定义
   * 来源就是被删了 —— 设置页每次保存送的都是完整草稿，所以"缺席即删除"是准确的。
   */
  const merge = (raw, errors) => {
    const next = defaults()
    if (raw?.rollingHours !== undefined) {
      if (typeof raw.rollingHours === 'number' && raw.rollingHours > 0 && raw.rollingHours <= 168) {
        next.rollingHours = raw.rollingHours
      } else {
        errors.push('rollingHours 要是 0 到 168 之间的数字')
      }
    }
    if (raw?.routes !== undefined && raw.routes !== null) {
      if (Array.isArray(raw.routes)) next.routes = raw.routes.filter((route) => typeof route === 'string' && route !== '')
      else errors.push('routes 要么是数组，要么留空表示自动')
    }

    const provided = raw?.sources !== undefined && raw.sources !== null && typeof raw.sources === 'object' ? raw.sources : {}
    const custom = Object.keys(provided).filter((id) => SOURCE_DEFAULTS[id] === undefined)
    for (const id of custom) {
      if (!SOURCE_ID_PATTERN.test(id)) {
        errors.push(`来源标识 ${id} 不合法：小写字母开头，只能用 小写字母/数字/_/-，最长 24 字符`)
      }
    }
    const ids = [...Object.keys(SOURCE_DEFAULTS), ...custom.filter((id) => SOURCE_ID_PATTERN.test(id))]
    if (ids.length > MAX_SOURCES) errors.push(`来源最多 ${MAX_SOURCES} 路（现在 ${ids.length} 路）`)
    for (const id of ids) {
      const entry = provided[id]
      if (entry === undefined) continue
      next.sources[id] = validateSourceEntry(id, entry, errors)
    }
    return next
  }

  let value = defaults()
  let error = null

  const load = () => {
    if (!existsSync(CONFIG_FILE)) {
      value = defaults()
      error = null
      return
    }
    try {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
      const errors = []
      const next = merge(raw, errors)
      if (errors.length > 0) {
        error = errors.join('；')
        ctx.logger?.warn?.(`[oc-usage] ${error}`)
        return
      }
      value = next
      error = null
    } catch (failure) {
      error = `配置文件读不动（保持上一份可用值）: ${String(failure?.message ?? failure)}`
      ctx.logger?.warn?.(`[oc-usage] ${error}`)
    }
  }

  const save = (raw) => {
    const errors = []
    const next = merge(raw, errors)
    if (errors.length > 0) return { ok: false, errors }
    try {
      mkdirSync(dirname(CONFIG_FILE), { recursive: true })
      writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (failure) {
      return { ok: false, errors: [`写不进去 ${CONFIG_FILE}: ${String(failure?.message ?? failure)}`] }
    }
    load()
    return { ok: true, config: value, path: CONFIG_FILE }
  }

  load()
  return {
    get: () => value,
    get error() {
      return error
    },
    save,
    reload: load,
    path: CONFIG_FILE,
  }
}

/** 读一个 JSON 请求体，带大小上限。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done({ ok: false, message: `请求体超过 ${limit} 字节` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        done({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch (failure) {
        done({ ok: false, message: `请求体不是 JSON: ${String(failure?.message ?? failure)}` })
      }
    })
    req.on('error', (failure) => done({ ok: false, message: String(failure?.message ?? failure) }))
  })
}

/* ── token 台账 ──────────────────────────────────────────────────────────────
 *
 * 面板的百分比只说"消耗了多少额度"，说不出"为此花了多少 token"。要把两者放在
 * 一起看（也就才看得出有没有掺水），就得自己记一份账：
 *
 *   来源   DSH 自己的会话日志（走 ctx.sessionQuery，不碰存储格式）。
 *          provider 自报的 usage 就在 assistant/message 的 data.usage 上，
 *          路由名/模型名在 request/context 上 —— 都是现成的，不用另算。
 *   粒度   1 分钟一桶。只存"有活动的桶"，所以桶数跟着请求数走（一月 5 千请求
 *          约 5 千个桶），而不是跟着 31 天走。
 *   增量   每个会话按日志文件的 (mtime,size) 做版本号；没变的直接跳过。
 *          冷启动要全量扫一遍（几百个会话的机器上约 40 秒，
 *          后台跑、不挡接口），之后每次只重读还在动的会话。
 *
 * 两个坑，踩过了：
 *   1. 种子/分叉会话的日志里带着父会话的继承事件，从头累加会把父会话的用量
 *      再算一遍 —— 必须跳过前 inheritedEventCount 条。
 *   2. 同一步重试时，日志会为同一个 (turn,step) 再报一次用量，那是"替换"不是
 *      "累加"；而 llm/retry-started 之后的同位置上报又是真的一次新消耗。这份
 *      语义跟 DSH 自己的 tokenUsage 投影一致，面板的数字才对得上界面上的统计。
 */
const BUCKET_MS = 60_000
/** 只留 31 天：月度窗口是账目的最长一档。 */
const LEDGER_RETENTION_MS = 31 * 24 * 3600 * 1000
/** 台账刷新节奏。上游额度是滚动窗口，分钟级粒度足够。 */
const LEDGER_REFRESH_MS = 120_000
/** 定位不到日志文件的会话，最多隔这么久重读一次。 */
const LEDGER_STALE_MS = 600_000
/** 上游 rolling 窗口长度（小时）。Lite 计划是 5 小时。 */
const DEFAULT_ROLLING_HOURS = 5

function emptyBuckets() {
  return { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 }
}

/** provider 报的一次用量 → 台账桶。cache 与 input 是拆开的，总量相加即可。 */
function bucketsFromUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    uncachedInput: number(usage.inputTokens),
    output: number(usage.outputTokens),
    cacheRead: number(usage.cacheReadTokens),
    cacheWrite: number(usage.cacheWriteTokens),
    reasoning: number(usage.reasoningTokens),
    requests: 1,
  }
}

/**
 * 一个会话里的用量样本。语义照抄 DSH 的 tokenUsage 投影：
 *   - assistant/message 的 data.usage 是主路径，没有就回落到流里最后一个 usage chunk；
 *   - 同一个 (turn,step) 再报一次是替换；
 *   - llm/retry-started 会清掉这个位置，于是重试的一次算新增。
 */
function usageOfEvent(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return null
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    if (stream[index]?.usage !== undefined) return stream[index].usage
  }
  return null
}

function stepKeyOf(data) {
  const turn = data?.turn
  const step = data?.step
  if (typeof turn !== 'number' || typeof step !== 'number') return null
  return `${turn}:${step}`
}

/** 把一个会话的日志折成"桶 → 用量"。整段重算，不做增量合并，换会话也换不掉账。 */
function foldSession(snapshot, since) {
  const contrib = new Map()
  const all = Array.isArray(snapshot?.events) ? snapshot.events : []
  /* 继承事件属于父会话，父会话自己也会被读到 —— 跳过，否则分叉出去就多算一份。 */
  const inherited = typeof snapshot?.inheritedEventCount === 'number' ? snapshot.inheritedEventCount : 0
  const events = inherited > 0 ? all.slice(inherited) : all

  let route = '未知|未知'
  const lastByStep = new Map()

  const add = (key, buckets, sign) => {
    const entry = contrib.get(key) ?? emptyBuckets()
    for (const field of Object.keys(entry)) entry[field] += buckets[field] * sign
    if (entry.requests <= 0) contrib.delete(key)
    else contrib.set(key, entry)
  }

  for (const event of events) {
    if (event.type === 'request/context') {
      const provider = typeof event.data?.provider === 'string' ? event.data.provider : '未知'
      const model = typeof event.data?.model === 'string' ? event.data.model : '未知'
      route = `${provider}|${model}`
      continue
    }
    if (event.type === 'llm/retry-started') {
      const key = stepKeyOf(event.data)
      if (key !== null) lastByStep.delete(key)
      continue
    }
    const usage = usageOfEvent(event)
    if (usage === null) continue
    const buckets = bucketsFromUsage(usage)
    if (buckets === null) continue
    const time = typeof event.time === 'number' ? event.time : null
    if (time === null || time < since) continue

    const bucket = Math.floor(time / BUCKET_MS) * BUCKET_MS
    const key = `${bucket}|${route}`
    const stepKey = stepKeyOf(event.data)
    if (stepKey !== null) {
      const previous = lastByStep.get(stepKey)
      if (previous !== undefined) add(previous.key, previous.buckets, -1)
    }
    add(key, buckets, 1)
    if (stepKey !== null) lastByStep.set(stepKey, { key, buckets })
  }
  return contrib
}

/**
 * 哪些路由的流量才算在这份额度上。
 *
 * 一个会话日志里混着好几条路由的请求（同一台机器上同时跑几条是常态），而只有打到
 * opencode.ai 的那几条才计这份额度。把别的路由也算进来，token 会被撑大，看起来反而像
 * "上游很慷慨"，恰好掩盖真正要查的东西。判定顺序：
 *   1. 设置里 llm-pi-ai 各路由的 baseURL —— 含 opencode.ai 的算数（权威）；
 *   2. 设置里已经没有的历史路由，按名字兜底：open / opencode* 算数；
 *   3. 显式配了 routes 就完全听配置的。
 * 无论怎么判，被剔除的路由连同 token 一起回给界面，不闷着。
 */
function createRouteFilter(ctx, configured, providerConfig) {
  if (Array.isArray(configured) && configured.length > 0) {
    const set = new Set(configured.filter((value) => typeof value === 'string' && value !== ''))
    return { source: 'config', routes: [...set], isOurs: (provider) => set.has(provider) }
  }

  const providers = providerConfig ?? {}
  const ours = []
  const known = new Set()
  for (const [id, profile] of Object.entries(providers)) {
    known.add(id)
    const base = profile?.baseURL
    if (typeof base === 'string' && base.includes('opencode.ai')) ours.push(id)
  }
  const declared = new Set(ours)
  const looksOurs = (provider) => provider === 'open' || /opencode/i.test(provider)

  return {
    source: known.size > 0 ? 'settings' : 'heuristic',
    routes: ours,
    knownRoutes: [...known],
    /* 配置里有的路由，baseURL 说了算；配置里没有的老路由（名字还留在日志里）
     * 才退回名字判断。 */
    isOurs: (provider) => (known.has(provider) ? declared.has(provider) : looksOurs(provider)),
  }
}

/**
 * token 台账：把每个会话折出的桶按时间窗口加总。
 *
 * 窗口起点尽量用上游自己给的 resetsAt 推，而不是"现在往前 N 小时"：
 *   weekly  —— resetsAt 就是周界，往前 7 天即整周，精确；
 *   monthly —— 账单月以订阅日为锚，往前一个日历月，精确；
 *   rolling —— 上游那个 5 小时窗口是"最后一次记账 + 5h"到期，起点不早于
 *              resetsAt − 5h，所以按它取是"只多不少"的保守口径（宁可不冤枉上游）。
 * resetsAt 缺失时退回"现在往前 N 小时/7 天/31 天"。
 */
function createLedger(ctx) {
  /** sessionId → { revision, foldedAt, contrib } */
  const sessions = new Map()
  let sweptAt = 0
  let sweeping = false
  let progress = { read: 0, total: 0 }

  /** 日志文件索引：会话目录名的就是 session id。只当缓存版本号用，定位不到就走 TTL。 */
  async function logIndex() {
    const index = new Map()
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const root = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
      const walk = (dir, depth) => {
        if (depth > 3) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full, depth + 1)
          } else if (entry.name === 'session.jsonl.zstd') {
            const stat = fs.statSync(full)
            index.set(path.basename(dir), `${stat.mtimeMs}:${stat.size}`)
          }
        }
      }
      if (fs.existsSync(root)) walk(root, 0)
    } catch (error) {
      ctx.logger?.warn?.(`[oc-usage] 会话日志索引失败，退回按时间重读: ${String(error)}`)
    }
    return index
  }

  /** 丢掉超出保留期的桶，让缓存里的老会话不会一直挂着过期数据。 */
  function prune(contrib, since) {
    for (const key of [...contrib.keys()]) {
      const at = Number(key.slice(0, key.indexOf('|')))
      if (!Number.isFinite(at) || at < since) contrib.delete(key)
    }
  }

  async function sweep() {
    if (sweeping) return
    sweeping = true
    try {
      const started = Date.now()
      const since = started - LEDGER_RETENTION_MS
      const listed = await ctx.sessionQuery.listSessions()
      /* 会话创建早于窗口起点一大截的，整段都不可能落在任何窗口里，直接不看。 */
      const targets = listed.filter((record) => (record.header?.createdAt ?? 0) >= since - 7 * 24 * 3600 * 1000)
      const alive = new Set()
      for (const record of targets) if (typeof record.header?.id === 'string') alive.add(record.header.id)
      for (const id of [...sessions.keys()]) if (!alive.has(id)) sessions.delete(id)

      const index = await logIndex()
      progress = { read: 0, total: targets.length }
      let reread = 0
      for (const record of targets) {
        const id = record.header?.id
        if (typeof id !== 'string') continue
        const revision = index.get(id) ?? null
        const cached = sessions.get(id)
        const unchanged = cached !== undefined && revision !== null && cached.revision === revision
        const fresh = cached !== undefined && revision === null && started - cached.foldedAt < LEDGER_STALE_MS
        if (unchanged || fresh) {
          prune(cached.contrib, since)
          progress.read += 1
          continue
        }
        try {
          const snapshot = await ctx.sessionQuery.readSession(id)
          sessions.set(id, { revision, foldedAt: Date.now(), contrib: foldSession(snapshot, since) })
          reread += 1
        } catch (error) {
          ctx.logger?.warn?.(`[oc-usage] 读取会话 ${id} 失败，本次跳过: ${String(error)}`)
        }
        progress.read += 1
      }
      sweptAt = Date.now()
      ctx.logger?.info?.(
        `[oc-usage] token 台账已刷新：${targets.length} 个会话（重读 ${reread}），耗时 ${sweptAt - started}ms`,
      )
    } finally {
      sweeping = false
    }
  }

  /** 到点就在后台补账；永不阻塞取数的那条路径。 */
  function ensureFresh() {
    if (sweeping || Date.now() - sweptAt < LEDGER_REFRESH_MS) return
    void sweep().catch((error) => ctx.logger?.warn?.(`[oc-usage] 台账刷新失败: ${String(error)}`))
  }

  function sumWindow(from, to, isOurs) {
    const totals = emptyBuckets()
    const byRoute = new Map()
    const excluded = new Map()
    for (const entry of sessions.values()) {
      for (const [key, buckets] of entry.contrib) {
        const at = Number(key.slice(0, key.indexOf('|')))
        if (!Number.isFinite(at) || at + BUCKET_MS <= from || at >= to) continue
        const rest = key.slice(key.indexOf('|') + 1)
        const provider = rest.slice(0, rest.indexOf('|'))
        const counted = isOurs(provider)
        const target = counted ? byRoute : excluded
        const seen = target.get(rest) ?? emptyBuckets()
        for (const field of Object.keys(seen)) seen[field] += buckets[field]
        target.set(rest, seen)
        if (!counted) continue
        for (const field of Object.keys(totals)) totals[field] += buckets[field]
      }
    }
    const total = totals.uncachedInput + totals.output + totals.cacheRead + totals.cacheWrite
    return {
      ...totals,
      total,
      /* 计费口径的 prompt 侧 = 未命中输入 + 缓存读 + 缓存写；缓存读占绝大头时，
       * 这个比例本身就说明"额度被什么吃掉的"。 */
      prompt: totals.uncachedInput + totals.cacheRead + totals.cacheWrite,
      cacheShare: total > 0 ? totals.cacheRead / total : null,
      byRoute: Object.fromEntries(byRoute),
      excluded: Object.fromEntries(excluded),
    }
  }

  return {
    ensureFresh,
    snapshot() {
      return { sweptAt, sweeping, progress, sessionCount: sessions.size }
    },
    /** 按窗口名加总。quota 是上游那份 windows ── resetsAt 决定窗口起点。 */
    windows(quota, now, rollingHours, routeFilter) {
      const at = (name) => {
        const iso = quota?.windows?.[name]?.resetsAt
        if (typeof iso !== 'string') return null
        const parsed = Date.parse(iso)
        return Number.isFinite(parsed) ? parsed : null
      }
      const monthStart = (end) => {
        const date = new Date(end)
        date.setMonth(date.getMonth() - 1)
        return date.getTime()
      }
      const spans = {
        rolling: { from: (at('rolling') ?? now) - rollingHours * 3600_000, to: now },
        weekly: { from: (at('weekly') ?? now) - 7 * 24 * 3600_000, to: now },
        monthly: { from: at('monthly') !== null ? monthStart(at('monthly')) : now - 31 * 24 * 3600_000, to: now },
      }
      const out = {}
      const excludedRoutes = new Set()
      for (const [name, span] of Object.entries(spans)) {
        const totals = sumWindow(span.from, span.to, routeFilter.isOurs)
        for (const key of Object.keys(totals.excluded)) excludedRoutes.add(key.slice(0, key.indexOf('|')))
        const percent = quota?.windows?.[name]?.percent
        out[name] = {
          ...totals,
          from: new Date(span.from).toISOString(),
          to: new Date(span.to).toISOString(),
          quotaPercent: typeof percent === 'number' ? percent : null,
          tokensPerPercent: typeof percent === 'number' && percent > 0 ? Math.round(totals.total / percent) : null,
        }
      }
      out.attribution = {
        source: routeFilter.source,
        routes: routeFilter.routes,
        knownRoutes: routeFilter.knownRoutes,
        excludedRoutes: [...excludedRoutes],
      }
      /* 全部路由一份账 —— 不只算进 opencode 额度的那几条。月度窗口最长，按它列，
       * 这样"我别的路由烧了多少"在面板上直接看得见，而不是只能看到一句"未计入"。 */
      const lists = new Map()
      for (const entry of sessions.values()) {
        for (const [key, buckets] of entry.contrib) {
          const at = Number(key.slice(0, key.indexOf('|')))
          if (!Number.isFinite(at) || at + BUCKET_MS <= spans.monthly.from || at >= spans.monthly.to) continue
          const rest = key.slice(key.indexOf('|') + 1)
          const seen = lists.get(rest) ?? emptyBuckets()
          for (const field of Object.keys(seen)) seen[field] += buckets[field]
          lists.set(rest, seen)
        }
      }
      out.routes = [...lists.entries()]
        .map(([route, buckets]) => {
          const provider = route.slice(0, route.indexOf('|'))
          return {
            provider,
            model: route.slice(route.indexOf('|') + 1),
            counted: routeFilter.isOurs(provider),
            uncachedInput: buckets.uncachedInput,
            output: buckets.output,
            cacheRead: buckets.cacheRead,
            cacheWrite: buckets.cacheWrite,
            requests: buckets.requests,
            total: buckets.uncachedInput + buckets.output + buckets.cacheRead + buckets.cacheWrite,
          }
        })
        .sort((left, right) => right.total - left.total)
      out.routeWindow = { from: new Date(spans.monthly.from).toISOString(), to: new Date(spans.monthly.to).toISOString() }
      return out
    },
  }
}

/** 三档窗口的对外名字。上游极可能只给 rolling/weekly/monthly，
 *  其余别名是照着同类实现的容错写的，上游换字段名时不至于直接空白。 */
const WINDOW_ALIASES = {
  rolling: ['rolling', 'window_5h', '5h', 'session', 'hourly', 'short'],
  weekly: ['weekly', 'window_weekly', 'week', 'wk'],
  monthly: ['monthly', 'window_monthly', 'month', 'mo'],
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function clampPercent(value) {
  if (value === null) return null
  return Math.min(100, Math.max(0, value))
}

/**
 * Key 的"世代"标签。只看前缀、不碰密钥内容，但正好能分辨最常见的坏法：
 * Console 新签发的 Key 是 `oc_sk_`，旧的 legacy Key 是 `sk-`，而上游 /usage
 * 只认前者。给用户看的是"这把是哪一代"，不是"这把是什么"。
 */
function keyKind(value) {
  if (typeof value !== 'string' || value === '') return 'none'
  if (value.startsWith('oc_sk_')) return 'console'
  if (value.startsWith('sk-')) return 'legacy'
  return 'unknown'
}

const KEY_KIND_LABEL = {
  none: '未配置凭据',
  console: 'Console 新 Key（oc_sk_ 开头）',
  legacy: '旧版 Key（sk- 开头）',
  unknown: '未知格式',
}

/** 上游 percent 就是 0-100 的百分数（接口示例里 percent: 4 对应面板 4%）。
 *  只有拿不到 percent、只能用 used/limit 换算时才自己做除法。 */
function readPercent(raw) {
  const direct = asNumber(raw.percent ?? raw.percentUsed ?? raw.percent_used)
  if (direct !== null) return clampPercent(direct)

  const used = asNumber(raw.used ?? raw.used_amount)
  const limit = asNumber(raw.limit ?? raw.limit_amount)
  if (used !== null && limit !== null && limit > 0) return clampPercent((used / limit) * 100)

  const remaining = asNumber(raw.remaining ?? raw.remainingPercentage ?? raw.remaining_percentage)
  if (remaining !== null) return clampPercent(100 - remaining)

  return null
}

/** 归一成 ISO 串，好让 Client 半直接算倒计时。 */
function readResetAt(raw) {
  const iso = raw.resetsAt ?? raw.resetAt ?? raw.reset_at
  if (typeof iso === 'string' && iso !== '') {
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  const epoch = asNumber(raw.resetAtEpoch ?? raw.reset_at_epoch)
  if (epoch !== null && epoch > 0) {
    return new Date(epoch < 1e12 ? epoch * 1000 : epoch).toISOString()
  }
  const afterSeconds = asNumber(raw.resetAfterSeconds ?? raw.reset_after_seconds)
  if (afterSeconds !== null && afterSeconds > 0) {
    return new Date(Date.now() + afterSeconds * 1000).toISOString()
  }
  return null
}

function pickWindow(container, aliases) {
  for (const alias of aliases) {
    const raw = asRecord(container[alias])
    if (raw) return raw
  }
  return null
}

/** 把上游响应压成 Client 半要的形状；一个窗口都认不出来就是 null。 */
function normalizeUsage(data) {
  const root = asRecord(data)
  if (!root) return null

  const container =
    asRecord(root.usage) ?? asRecord(root.quota) ?? asRecord(root.data) ?? root

  const windows = {}
  let seen = 0
  for (const [name, aliases] of Object.entries(WINDOW_ALIASES)) {
    const raw = pickWindow(container, aliases)
    if (!raw) {
      windows[name] = null
      continue
    }
    seen += 1
    windows[name] = {
      percent: readPercent(raw),
      resetsAt: readResetAt(raw),
      status: typeof raw.status === 'string' ? raw.status : null,
    }
  }
  if (seen === 0) return null

  const percentages = Object.values(windows)
    .map((entry) => entry?.percent)
    .filter((value) => typeof value === 'number')
  const worst = percentages.length > 0 ? Math.max(...percentages) : null

  return { windows, worst, limitReached: worst !== null && worst >= 100 }
}

/** 按名解析凭据。凭据服务本身已经叠了进程环境，这里再兜一层 env 只是防它缺席。 */
async function resolveApiKey(ctx, refName) {
  try {
    const resolved = await ctx.credentials.resolve(refName)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (value !== '') return { key: value, source: resolved?.source ?? 'credentials' }
  } catch (error) {
    ctx.logger?.warn?.(`[oc-usage] 解析凭据 ${refName} 失败: ${String(error)}`)
  }

  const fromEnv = process.env[refName]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { key: fromEnv.trim(), source: 'environment' }
  }
  return null
}

/** 上游错误体里那句话：`{ error: { type, message } }`。type 能把"Key 不认"
 *  （AuthError）和"Key 认了但没订阅"（EntitlementError）分开，message 可以直接给用户看。 */
function readUpstreamError(body) {
  const record = asRecord(body)
  if (!record) return { type: null, message: null }
  const detail = asRecord(record.error) ?? record
  return {
    type: typeof detail.type === 'string' ? detail.type : null,
    message: typeof detail.message === 'string' ? detail.message : null,
  }
}

/**
 * 把响应体解成 JSON，顺带认一下它是怎么压的。
 *
 * 为什么不能直接用 response.json()：宿主这一侧的 fetch 会收到"体是 br 压缩、
 * 却没有 content-encoding 头"的响应（同一个请求用 curl 和裸 Node 打都是明文
 * JSON），没有那个头就没有任何一层会替你解压，response.json() 只会炸在一串
 * 二进制上。不赌哪条链路会这样，按"先当明文、不行就把四种压缩各猜一遍"处理；
 * 每次都以"能不能 JSON.parse"为准，猜错不会误判成成功。
 */
function decodeJsonBody(bytes) {
  const candidates = [
    ['identity', (value) => value],
    ['br', brotliDecompressSync],
    ['gzip', gunzipSync],
    ['deflate', inflateSync],
    ['deflate-raw', inflateRawSync],
  ]
  const tried = []
  for (const [encoding, decompress] of candidates) {
    let raw
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(decompress(bytes))
    } catch {
      tried.push(encoding)
      continue
    }
    try {
      return { data: JSON.parse(raw), encoding, raw }
    } catch {
      tried.push(encoding)
    }
  }
  return { data: null, encoding: null, raw: '', tried }
}

/** baseURL 已经去掉尾斜杠、path 一定以 / 开头（校验时归一过），直接拼就是完整地址。
 *  path 为空串表示"就用 baseURL 本身"。 */
function joinURL(baseURL, path) {
  return typeof path === 'string' && path !== '' ? `${baseURL}${path}` : baseURL
}

/**
 * 一次带 Key 的只读 GET：要明文、自己解压、读成 JSON，失败时把原因分好类。
 * 所有来源共用它，各自的"怎么解读"在外面。
 */
async function fetchJson(url, key) {
  /* key 为空 = 这一路没配凭据（公开接口）。那就别发一个空的 Authorization —— 
   * `Bearer ` 比不发更容易被上游判成"认证失败"，反而看不出真实原因。 */
  const headers = {
    accept: 'application/json',
    /* 明确只要明文：这条链路上有东西会把压缩体交出来却不带
     * content-encoding，能从上游就要到不压的，就不必自己解。 */
    'accept-encoding': 'identity',
  }
  if (typeof key === 'string' && key !== '') headers.authorization = `Bearer ${key}`

  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      ok: false,
      error: timedOut ? 'timeout' : 'network',
      message: timedOut ? '请求上游超时' : `无法连接 ${url}: ${String(error?.message ?? error)}`,
    }
  }

  /* 体只读一次，成败两条路都走同一个解码器：错误体同样可能是压缩过的。 */
  let bytes
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    return {
      ok: false,
      error: 'network',
      status: response.status,
      message: `读取上游响应失败: ${String(error?.message ?? error)}`,
    }
  }

  const decoded = decodeJsonBody(bytes)
  const upstream = readUpstreamError(decoded.data)

  if (!response.ok) {
    return {
      ok: false,
      error: response.status === 401 || response.status === 403 ? 'unauthorized' : 'http',
      status: response.status,
      detail: upstream.message,
      upstream,
      message: `上游返回 HTTP ${response.status}${upstream.message ? `：${upstream.message}` : ''}`,
    }
  }

  if (decoded.data === null) {
    const type = response.headers.get('content-type') ?? '缺 content-type'
    const encoding = response.headers.get('content-encoding') ?? '缺 content-encoding'
    return {
      ok: false,
      error: 'parse',
      status: response.status,
      /* 十六进制而不是文本片段：这种响应体是二进制，转成文本只剩一串
       * U+FFFD，连"它其实是压缩过的"都看不出来。 */
      detail: {
        bytes: bytes.length,
        hex: Buffer.from(bytes.subarray(0, 32)).toString('hex'),
        contentType: type,
        contentEncoding: encoding,
        tried: decoded.tried,
      },
      message: `上游返回的不是 JSON（HTTP ${response.status}，${type}，${encoding}，${bytes.length} 字节）`,
    }
  }

  return { ok: true, data: decoded.data, transport: decoded.encoding }
}

/** 用一把 Key 问一次额度接口；与凭据无关的失败也在这里被命名，好让调用方决定要不要换下一把。 */
async function requestUsage(key, url) {
  const result = await fetchJson(url, key)
  if (!result.ok) {
    if (result.error !== 'unauthorized') return result
    /* 401 与 403 在这一路要分开：前者是 Key 不认，后者是 Key 认了但没订 Go。 */
    const upstream = result.upstream ?? { type: null, message: null }
    const entitled = result.status === 403 || upstream.type === 'EntitlementError'
    return {
      ok: false,
      error: entitled ? 'entitlement' : 'unauthorized',
      status: result.status,
      detail: upstream.message,
      message: entitled
        ? `这把 Key 上游认得，但账号没有 OpenCode Go 订阅${upstream.message ? `（上游：${upstream.message}）` : '（HTTP 403）'}`
        : `API Key 无效或已过期（HTTP ${result.status}${upstream.message ? `：${upstream.message}` : ''}）`,
    }
  }

  const normalized = normalizeUsage(result.data)
  if (!normalized) {
    return { ok: false, error: 'unrecognized', message: '上游响应里没有可识别的额度窗口' }
  }
  return { ok: true, transport: result.transport, ...normalized }
}

/** 把余额/额度里的数字兜成可显示的值：拿不到就是 null，不编 0。 */
function readAmount(value) {
  return asNumber(value)
}

/** DeepSeek：账户余额，`{is_available, balance_infos:[{currency,total_balance,…}]}`。 */
async function fetchDeepSeek(source, key) {
  const result = await fetchJson(joinURL(source.baseURL, source.path), key)
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status ?? null, message: result.message }
  }
  const infos = Array.isArray(result.data?.balance_infos) ? result.data.balance_infos : []
  const balances = infos
    .map((info) => ({
      currency: typeof info?.currency === 'string' ? info.currency : '?',
      total: readAmount(info?.total_balance),
      granted: readAmount(info?.granted_balance),
      toppedUp: readAmount(info?.topped_up_balance),
    }))
    .filter((entry) => entry.total !== null)
  if (balances.length === 0) {
    return { ok: false, error: 'unrecognized', message: '余额响应里没有 balance_infos' }
  }
  return { ok: true, transport: result.transport, available: result.data?.is_available === true, balances }
}

/** OpenRouter：额度 + 这把 Key 的日月用量。两个只读接口拼一份视图。 */
async function fetchOpenRouter(source, key) {
  const credits = await fetchJson(joinURL(source.baseURL, source.path), key)
  if (!credits.ok) {
    return { ok: false, error: credits.error, status: credits.status ?? null, message: credits.message }
  }
  const total = readAmount(credits.data?.data?.total_credits)
  const used = readAmount(credits.data?.data?.total_usage)
  /* infoPath 是补充信息：拿不到不影响"额度"这一项，所以它失败只在旁边记一条；
   * 配成空串就是不请求这个接口（换个只提供 /credits 的厂商时用得上）。 */
  const keyInfo = source.infoPath ? await fetchJson(joinURL(source.baseURL, source.infoPath), key) : { ok: false, message: null }
  const info = keyInfo.ok ? asRecord(keyInfo.data?.data) : null
  return {
    ok: true,
    transport: credits.transport,
    credits: { total, used, remaining: total !== null && used !== null ? total - used : null },
    key:
      info === null
        ? null
        : {
            label: typeof info.label === 'string' ? info.label : null,
            limit: readAmount(info.limit),
            limitRemaining: readAmount(info.limit_remaining),
            usageDaily: readAmount(info.usage_daily),
            usageWeekly: readAmount(info.usage_weekly),
            usageMonthly: readAmount(info.usage_monthly),
            isFreeTier: info.is_free_tier === true,
            freeDailyRequests: asRecord(info.free_model_daily_requests),
          },
    keyError: keyInfo.ok ? null : keyInfo.message,
  }
}

/**
 * generic：一个只读 GET，然后照配置里的路径去响应里取数。
 *
 * 取不到主数值就算失败（"响应里没有 X"），绝不拿 0 兜 —— 编出来的 0 会被读成
 * "余额就是 0"。unit=text 时不要求是数字，原样当字符串展示（有些接口回的是
 * "unlimited" 这种）。
 */
async function fetchGeneric(source, key) {
  const result = await fetchJson(joinURL(source.baseURL, source.path), key)
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status ?? null, message: result.message }
  }
  const read = (path) => (typeof path === 'string' && path !== '' ? readPath(result.data, path) : undefined)
  const rawValue = read(source.valuePath)
  if (rawValue === undefined || rawValue === null) {
    return { ok: false, error: 'unrecognized', message: `响应里没有 ${source.valuePath} 这个路径` }
  }
  const detailRaw = read(source.detailPath)
  const detail = detailRaw === undefined || detailRaw === null ? null : String(detailRaw)
  if (source.unit === 'text') {
    return { ok: true, transport: result.transport, value: String(rawValue), currency: null, detail }
  }
  const value = asNumber(rawValue)
  if (value === null) {
    return {
      ok: false,
      error: 'unrecognized',
      message: `${source.valuePath} 拿到的不是数字（${JSON.stringify(rawValue).slice(0, 60)}）`,
    }
  }
  const currencyRaw = read(source.currencyPath)
  return {
    ok: true,
    transport: result.transport,
    value,
    currency: typeof currencyRaw === 'string' ? currencyRaw : null,
    detail,
  }
}

/** 每种 kind 各自的取数。签名统一，方便在 apply 里按配置分发。 */
const SOURCE_FETCHERS = {
  usage: (source, key) => requestUsage(key, joinURL(source.baseURL, source.path)),
  balance: (source, key) => fetchDeepSeek(source, key),
  credits: (source, key) => fetchOpenRouter(source, key),
  generic: (source, key) => fetchGeneric(source, key),
}

/**
 * 所有候选都没成时，把"试了哪些、各自怎么死的"收成一句能照着做的话。
 * 最常见的两种：全是 401（Key 那一代已经不被上游受理）和 403（Key 有效但没订阅）。
 */
function summarizeFailures(attempts) {
  const tried = attempts.map((entry) => entry.ref).join('、')
  const rejected = attempts.filter((entry) => entry.error === 'unauthorized')
  const entitled = attempts.filter((entry) => entry.error === 'entitlement')

  if (rejected.length > 0) {
    const kinds = [...new Set(rejected.map((entry) => KEY_KIND_LABEL[entry.keyKind] ?? entry.keyKind))].join('、')
    return {
      ok: false,
      error: 'unauthorized',
      status: 401,
      attempts,
      message:
        `上游拒绝了所有候选凭据（HTTP 401；格式：${kinds}）。已试：${tried}。\n` +
        `请在 设置 → 凭据 里把 ${DEFAULT_CREDENTIAL_REFS[0]} 换成 OpenCode Console 里当前有效的 Key` +
        '（oc_sk_ 开头）——旧版 sk- 开头的 Key 上游已经不再受理。',
    }
  }

  if (entitled.length > 0) {
    const detail = entitled.find((entry) => entry.detail)?.detail
    return {
      ok: false,
      error: 'entitlement',
      status: 403,
      attempts,
      message: `候选凭据里没有一把能读额度：Key 上游认得，但账号没有 OpenCode Go 订阅${
        detail ? `（上游：${detail}）` : ''
      }。已试：${tried}。`,
    }
  }

  return {
    ok: false,
    error: 'unconfigured',
    attempts,
    message: `没有找到任何候选凭据（已试：${tried}）。请在 设置 → 凭据 里填入 OpenCode API Key，名称为 ${DEFAULT_CREDENTIAL_REFS[0]}。`,
  }
}

/** 上一次成功的那把排最前，其余候选跟在后面（它失效时才有机会被问到）。 */
function candidateOrder(refs, winner) {
  if (!winner) return [...refs]
  return [winner, ...refs.filter((ref) => ref !== winner)]
}

/**
 * 挨个候选凭据问一遍：第一个被接受的胜出；401/403 说明"这把不行"，换下一把；
 * 其它失败（网络、超时、解析、上游 5xx）与凭据无关，换一把也不会好，立刻上报 ——
 * 挨个重试只会把报错时间拖长。
 *
 * refs 为空数组是合法的：那表示这一路不配凭据（公开接口），只问一次、不发
 * Authorization。这也是自定义来源常见的形态，所以给内置来源和自定义来源用的是同一条路。
 */
async function fetchWithCandidates(ctx, sourceId, refs, winner, fetcher) {
  const attempts = []

  for (const ref of refs.length > 0 ? candidateOrder(refs, winner) : [null]) {
    const found = ref === null ? { key: '', source: 'none' } : await resolveApiKey(ctx, ref)
    if (found === null) {
      attempts.push({ ref, error: 'unconfigured' })
      continue
    }

    const kind = keyKind(found.key)
    const result = await fetcher(found.key)

    if (result.ok) {
      /* transport 不是 identity 时说明这条链路上又把压缩体交出来了（这次被
       * decodeJsonBody 接住）。记一行，将来再出问题时不用从头查。 */
      if (result.transport !== 'identity') {
        ctx.logger?.info?.(`[oc-usage] 上游响应体是 ${result.transport} 压缩的，已自行解压`)
      }
      return { ok: true, credentialRef: ref, keySource: found.source, keyKind: kind, ...result }
    }

    attempts.push({
      ref,
      source: found.source,
      keyKind: kind,
      error: result.error,
      status: result.status ?? null,
      detail: result.detail ?? null,
    })

    if (result.error !== 'unauthorized' && result.error !== 'entitlement') {
      return { ok: false, ...result, attempts }
    }
  }

  return sourceId === 'opencode' ? summarizeFailures(attempts) : summarizeSourceFailures(attempts)
}

/**
 * 不是 opencode 的来源全都不行时那句话。不带 OCG 专属的补救指引 —— 自定义来源的
 * 凭据名是用户自己起的，指不到某个具体页面去换个 Key，只能把试过什么讲清楚。
 */
function summarizeSourceFailures(attempts) {
  const tried = attempts.map((entry) => entry.ref ?? '(未配置凭据)').join('、')
  const rejected = attempts.filter((entry) => entry.error === 'unauthorized' || entry.error === 'entitlement')
  if (rejected.length > 0) {
    const detail = rejected.find((entry) => entry.detail)?.detail
    const status = rejected[0].status ?? 401
    /* 一个凭据都没配、上游却回 401：这是"这是个需要认证的接口"，不是"你这把 Key 不行"。
     * 两句话差得远，别让用户去凭据里找一把根本不存在的 Key。 */
    const keyless = rejected.every((entry) => entry.ref === null)
    return {
      ok: false,
      error: 'unauthorized',
      status,
      attempts,
      message: keyless
        ? `这一路没配凭据，但上游要求认证（HTTP ${status}）${detail ? `。上游：${detail}` : ''}`
        : `上游拒绝了这一路的所有候选凭据（已试：${tried}）${detail ? `。上游：${detail}` : ''}`,
    }
  }
  return {
    ok: false,
    error: 'unconfigured',
    status: null,
    attempts,
    message: `这一路没有可用的凭据（已试：${tried}），或者接口没配对`,
  }
}

/* 每路来源给前端准备的那一行摘要：前端不认识 kind，只认识这几个字段。
 * value 为 null = 这一路没有"一个主数字"可显示，此时前端把 detail 当主行文本。 */
const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']
const WINDOW_SHORT = { rolling: '5h', weekly: '1w', monthly: '1m' }

function buildSummary(kind, source, result) {
  if (kind === 'usage') {
    const windows = result.windows ?? {}
    const detail = WINDOW_ORDER.map((name) => {
      const percent = windows[name]?.percent
      return `${WINDOW_SHORT[name]} ${typeof percent === 'number' ? `${percent}%` : '—'}`
    }).join(' · ')
    return { unit: 'percent', value: typeof result.worst === 'number' ? result.worst : null, detail }
  }

  if (kind === 'balance') {
    const list = Array.isArray(result.balances) ? result.balances : []
    const first = list[0] ?? null
    const rest = list
      .slice(1)
      .map((entry) => `${entry.total ?? '—'} ${entry.currency}`)
      .join(' / ')
    return {
      unit: 'money',
      value: first?.total ?? null,
      currency: first?.currency ?? null,
      detail: rest === '' ? null : rest,
    }
  }

  if (kind === 'credits') {
    const credits = result.credits ?? {}
    const parts = []
    if (typeof credits.used === 'number') parts.push(`已用 ${credits.used}`)
    if (typeof result.key?.usageMonthly === 'number') parts.push(`本月 ${result.key.usageMonthly}`)
    if (typeof result.key?.limitRemaining === 'number') parts.push(`剩余 ${result.key.limitRemaining}`)
    /* 免费层是"没买额度却有用量"，remaining 会是个负数，显示成负余额像是坏了 ——
     * 这时不给主数字，让前端把 detail（已用…）当主行文本。 */
    const showMoney = typeof credits.remaining === 'number' && typeof credits.total === 'number' && credits.total > 0
    return {
      unit: 'money',
      value: showMoney ? credits.remaining : null,
      currency: null,
      detail: parts.join(' · ') || null,
    }
  }

  return {
    unit: source.unit ?? 'money',
    value: result.value ?? null,
    currency: result.currency ?? null,
    detail: result.detail ?? null,
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx, config) {
  const store = createConfigStore(ctx, config)
  const settingFor = (id) => store.get().sources[id]

  /** 上一次成功的结果；只缓存成功，失败每次都重新问，好让"填好 Key 再刷新"立刻生效。 */
  let cached = null
  /**
   * 每一路各自记住上次成功的那把凭据名，稳态下就只问它。用 Map 而不是一个变量：
   * 来源现在是开放的，谁记得住谁的那把，彼此不干扰。
   */
  const winners = new Map()
  /**
   * token 台账。挂在 sessionQuery 上而不是写进 inject：那个服务缺席时（别的装配
   * 没挂会话查询）额度面板照常工作，只是没有 token 那一行 —— 而不是整个插件不加载。
   */
  let ledger = null

  /**
   * 取一路来源。所有来源走同一条路：按配置里的候选凭据挨个试，第一个被接受的胜出。
   *
   * 只有 opencode 那一路多一层记忆（`winners`）—— 它是每分钟都在问、也是唯一决定
   * 三张卡片与台账窗口的那一路，Key 一换就要立刻生效；其它来源一律只以「其它来源」
   * 那一行的形式出现在浮层里。
   */
  async function fetchSource(id) {
    const source = settingFor(id)
    const label = source?.label ?? id
    const kind = source?.kind ?? 'generic'
    if (source?.enabled !== true) {
      return { label, kind, ok: false, skipped: true, message: '未启用（设置 → 额度面板）' }
    }
    const fetcher = SOURCE_FETCHERS[kind]
    if (fetcher === undefined) {
      return { label, kind, ok: false, error: 'unrecognized', message: `未知的来源类型 ${kind}` }
    }
    const refs = Array.isArray(source.credentialRefs)
      ? source.credentialRefs
      : typeof source.credentialRef === 'string'
        ? [source.credentialRef]
        : []
    const result = await fetchWithCandidates(ctx, id, refs, winners.get(id) ?? null, (key) => fetcher(source, key))
    if (result.ok !== true) return { label, kind, ...result }
    if (typeof result.credentialRef === 'string') winners.set(id, result.credentialRef)
    return {
      label,
      kind,
      ...result,
      fetchedAt: new Date().toISOString(),
      endpoint: joinURL(source.baseURL, source.path),
      summary: buildSummary(kind, source, result),
    }
  }

  const handler = async (req, res) => {
    /* 只有本包的路由前缀会进到这里；前缀下认 /usage 与 /config 两个端点。 */
    const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
    const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')

    if (action === 'config') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        send(res, 200, {
          ok: true,
          config: store.get(),
          path: store.path,
          error: store.error,
          defaults: SOURCE_DEFAULTS,
          routesHint: routeProviderConfig().via,
        })
        return
      }
      if (req.method !== 'PUT' && req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method', message: '只接受 GET/PUT' })
        return
      }
      /* 本地端口上防一手"某个网页顺手 POST 过来改配置"：写必须带自定义头，
       * 跨站表单带不了它。配置里只有引用名、没有密钥，这一层是防误写不是防泄密。 */
      if (req.headers?.[CONFIG_WRITE_HEADER] !== '1') {
        send(res, 403, { ok: false, error: 'forbidden', message: `写配置需要 ${CONFIG_WRITE_HEADER}: 1 头` })
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        send(res, 400, { ok: false, error: 'body', message: body.message })
        return
      }
      const result = store.save(body.value)
      if (!result.ok) {
        send(res, 400, { ok: false, error: 'invalid', errors: result.errors, message: result.errors.join('；') })
        return
      }
      /* 配置一改，缓存的额度与台账窗口都按新配置重算。 */
      cached = null
      send(res, 200, { ok: true, config: result.config, path: result.path })
      return
    }

    if (action !== 'usage') {
      send(res, 404, { ok: false, error: 'not-found', message: `未知端点: ${action || '/'}` })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { ok: false, error: 'method', message: '只接受 GET' })
      return
    }

    /* token 台账独立于额度：额度这把 Key 挂了，本地记的 token 照样该看得见。 */
    ledger?.ensureFresh()

    const force = url.searchParams.get('refresh') === '1'
    const now = Date.now()
    if (!force && cached && now - cached.at < CACHE_TTL_MS) {
      send(res, 200, { ...cached.payload, cached: true, tokens: tokenView(cached.payload, now) })
      return
    }

    try {
      const ids = Object.keys(store.get().sources)
      const results = await Promise.all(ids.map((id) => fetchSource(id)))
      const sources = {}
      ids.forEach((id, index) => {
        sources[id] = results[index]
      })
      const opencode = sources.opencode ?? { ok: false, error: 'unconfigured', message: '配置里没有 opencode 这一路' }
      const payload = { ...opencode, sources }
      /* 成功就落缓存 —— 强制刷新也一样：换了新数据却留着旧的时间戳，会让紧接着的
       * 一次轮询又把旧值端出来。缓存整份（含其它来源），免得每分钟把每一路都问一遍。 */
      if (opencode.ok) {
        cached = { at: Date.now(), payload }
      }
      /* 失败一律 200：这是给界面看的业务结果，不是 HTTP 层错误。 */
      send(res, 200, { ...payload, tokens: tokenView(payload, Date.now()) })
    } catch (error) {
      send(res, 200, {
        ok: false,
        error: 'internal',
        message: String(error?.stack ?? error),
        tokens: tokenView(null, Date.now()),
      })
    }
  }

  /**
   * 台账视图：窗口起点由额度那份 resetsAt 推；额度拿不到时退回"现在往前 N 小时"。
   *
   * 自带 try/catch：token 台账是附加信息，它出任何差错都不能把"看额度"这件事带下去
   * （缓存命中那条分支在 handler 的 try 外面，漏出去的错误会被 web server 直接变成
   * 一个没有响应的 400）。失败就如实写进 error 字段，界面上只是少一行。
   */
  function tokenView(quota, now) {
    if (ledger === null) return null
    try {
      /* 配置与路由归属每次现算：设置页改了窗口长度/白名单/baseURL，下一次取数就跟着变。 */
      const settings = store.get()
      const resolved = routeProviderConfig()
      const filter = createRouteFilter(ctx, settings.routes, resolved.providers)
      const view = { ...ledger.windows(quota, now, settings.rollingHours, filter), coverage: ledger.snapshot() }
      view.attribution.settings = resolved.via
      return view
    } catch (error) {
      ctx.logger?.warn?.(`[oc-usage] token 台账视图失败: ${String(error?.stack ?? error)}`)
      return { error: String(error?.message ?? error) }
    }
  }

  /**
   * 读 llm-pi-ai 的路由表。宿主自带的核心版本可能和插件预期的那个不一样，服务面不一定相同，
   * 所以两条路都试：先 `get(ns)`，不行再退回 `describe()` 里找这个 namespace。
   * 都拿不到就交给路由名判断，并在 attribution.settings 里如实写出来。
   */
  function routeProviderConfig() {
    const service = settingsCtx?.settings
    if (service === undefined || service === null) return { providers: null, via: 'unavailable' }
    try {
      if (typeof service.get === 'function') {
        const value = service.get('llm-pi-ai')
        if (value !== undefined) return { providers: value?.providers ?? null, via: 'get' }
      }
      if (typeof service.describe === 'function') {
        const rows = service.describe()
        const row = Array.isArray(rows)
          ? rows.find((entry) => entry?.namespace === 'llm-pi-ai' || entry?.ns === 'llm-pi-ai')
          : undefined
        const value = row?.value ?? row?.resolved ?? row?.base
        if (value !== undefined) return { providers: value?.providers ?? null, via: 'describe' }
      }
      return { providers: null, via: 'empty' }
    } catch (error) {
      settingsCtx?.logger?.warn?.(`[oc-usage] 读 llm-pi-ai 路由表失败，退回按路由名判断: ${String(error)}`)
      return { providers: null, via: `error:${String(error?.message ?? error)}` }
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'oc-usage: usage api route',
  )

  ctx.inject(['sessionQuery'], (qctx) => {
    ledger = createLedger(qctx)
    qctx.effect(() => () => {
      ledger = null
    }, 'oc-usage: token ledger')
    /* 冷启动那一次全量扫描（几百个会话约 40 秒）在后台跑，接口永远不等它。 */
    ledger.ensureFresh()
  })

  /* 路由表单独挂：面板跟额度无关地先能显示，这里只是把"哪条路由算 opencode"判准。
   * 每次取数时现读而不是缓存：llm-pi-ai 注册自己的 namespace 是在它自己的
   * inject 回调里，谁先谁后不确定，启动时读一次可能读到"还没注册"。 */
  let settingsCtx = null
  ctx.inject(['settings'], (sctx) => {
    settingsCtx = sctx
    sctx.effect(() => () => {
      settingsCtx = null
    }, 'oc-usage: route table')
  })

  const settings = store.get()
  const enabled = Object.entries(settings.sources)
    .filter(([, source]) => source.enabled === true)
    .map(([id, source]) => `${id}(${source.kind})`)
  ctx.logger?.info?.(
    `[oc-usage] 额度接口挂在 ${ROUTE}/usage（共 ${Object.keys(settings.sources).length} 路来源，` +
      `已启用: ${enabled.join('、') || '无'}；opencode 候选凭据: ` +
      `${(settings.sources.opencode?.credentialRefs ?? []).join(' > ') || '(未配置)'}；` +
      `rolling 窗口按 ${settings.rollingHours}h 折算；配置: ${store.path}）`,
  )
}
