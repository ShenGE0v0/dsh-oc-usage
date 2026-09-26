/**
 * host 半加载测试 —— 在插件目录里跑：`node test/host-load.mjs`
 *
 * 不只是 apply()：还把 ctx.inject 的回调按真实时序喂上桩服务。台账与路由表都是在
 * 那些回调里接上的，不跑它们就发现不了"回调里引用了已经删掉的变量"这类错 —— 那种错
 * 会让额度面板照常显示、只是 token 一行永远空着，最难看出来。
 *
 * 这个测试必须与开发机无关：配置路径与会话日志根都是模块加载时按 USERPROFILE 算出来的，
 * 所以先把 home 指到一个空临时目录、并在那里写一份**本次测试自己要用的**配置，再动态
 * import 插件。不这么做就会去读开发自己的 ~/.dsh/dsh-oc-usage.config.json —— 谁把某一路
 * 来源关了，测试就跟着红，结论也无法复现。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'oc-usage-test-'))
process.env.USERPROFILE = home
process.env.HOME = home
mkdirSync(join(home, '.dsh'), { recursive: true })
writeFileSync(
  join(home, '.dsh', 'dsh-oc-usage.config.json'),
  `${JSON.stringify(
    {
      version: 2,
      rollingHours: 5,
      routes: null,
      sources: {
        opencode: { kind: 'usage', enabled: true, baseURL: 'https://opencode.ai/zen/go/v1', credentialRefs: ['TEST_KEY'] },
        deepseek: { kind: 'balance', enabled: true, baseURL: 'https://api.deepseek.com', credentialRef: 'DEEPSEEK_API_KEY' },
        openrouter: { kind: 'credits', enabled: true, baseURL: 'https://openrouter.ai/api/v1', credentialRef: 'OPENROUTER_API_KEY' },
        // 自定义来源：generic 解读器 + 自己取值，走的是"没有凭据"那条路（不发 Authorization）
        generic: {
          kind: 'generic',
          label: '通用来源',
          enabled: true,
          baseURL: 'https://example.com/api',
          credentialRefs: [],
          path: '/info',
          valuePath: 'data.balance',
          unit: 'money',
          detailPath: 'data.name',
        },
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const { apply } = await import('../index.js')

const routes = new Map()
const logs = []
const listens = []

const services = {
  settings: {
    get: (ns) => (ns === 'llm-pi-ai' ? { providers: { open: { baseURL: 'https://opencode.ai/zen/go/v1' } } } : undefined),
    describe: () => [],
    watch: () => () => {},
  },
  sessionQuery: {
    listSessions: async () => [
      { header: { id: 'session-a', createdAt: Date.now() - 3600_000 }, live: true, persisted: true },
    ],
    readSession: async () => ({
      inheritedEventCount: 1,
      events: [
        // 继承事件：属于父会话，必须被跳过（算了就会翻倍）
        { type: 'assistant/message', time: Date.now() - 3600_000, data: { turn: 9, step: 9, usage: { inputTokens: 999999, outputTokens: 999999 } } },
        { type: 'request/context', time: Date.now() - 60_000, data: { provider: 'open', model: 'deepseek-v4.1-flash' } },
        { type: 'assistant/message', time: Date.now() - 30_000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } } },
        // 同一步再报一次是"替换"，不是累加
        { type: 'assistant/message', time: Date.now() - 29_000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } } },
      ],
    }),
  },
}

globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/usage')) {
    return Response.json({
      usage: {
        rolling: { status: 'ok', percent: 10, resetsAt: new Date(Date.now() + 3600e3).toISOString() },
        weekly: { status: 'ok', percent: 50, resetsAt: new Date(Date.now() + 86400e3).toISOString() },
        monthly: { status: 'ok', percent: 20, resetsAt: new Date(Date.now() + 86400e3 * 20).toISOString() },
      },
    })
  }
  if (target.includes('/user/balance')) {
    return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] })
  }
  if (target.includes('/credits')) return Response.json({ data: { total_credits: 5, total_usage: 1.25 } })
  if (target.includes('/key')) return Response.json({ data: { usage_monthly: 1.25 } })
  if (target.includes('/info')) return Response.json({ data: { balance: 7.5, name: '示例接口' } })
  return Response.json({})
}

const ctx = {
  logger: {
    info: (...a) => logs.push(['info', ...a]),
    warn: (...a) => logs.push(['warn', ...a]),
    error: (...a) => logs.push(['error', ...a]),
    debug: () => {},
  },
  effect(fn) {
    const disposer = fn()
    return () => (typeof disposer === 'function' ? disposer() : undefined)
  },
  inject(deps, cb) {
    for (const dep of deps) if (services[dep] === undefined) return
    listens.push({ deps, cb })
  },
  webServer: { register(route) { routes.set(route.path, route.handler) } },
  credentials: { resolve: async () => ({ value: 'test-key', source: 'file' }) },
}

const failures = []
const check = (label, condition, extra = '') => {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`)
  if (!condition) failures.push(label)
}

apply(ctx, {})
check('apply() 注册了路由', routes.has('/dsh-oc-usage-api'))

for (const { deps, cb } of listens) {
  try {
    const scoped = { ...ctx }
    for (const dep of deps) scoped[dep] = services[dep]
    cb(scoped)
    check(`inject(${deps.join('+')}) 回调不抛`, true)
  } catch (error) {
    check(`inject(${deps.join('+')}) 回调不抛`, false, String(error?.message ?? error))
  }
}

const handler = routes.get('/dsh-oc-usage-api')
async function call(url, init = {}) {
  let body = ''
  const request = {
    url,
    method: init.method ?? 'GET',
    headers: init.headers ?? {},
    on(event, listener) {
      if (event === 'data' && init.body !== undefined) listener(Buffer.from(init.body))
      if (event === 'end') queueMicrotask(() => listener())
      return request
    },
  }
  await handler(request, { writeHead() {}, end(chunk) { body = chunk } })
  return body === '' ? null : JSON.parse(body)
}

await new Promise((resolve) => setTimeout(resolve, 300))

const usage = await call('/dsh-oc-usage-api/usage?refresh=1')
check('额度取数成功', usage?.ok === true, usage?.message ?? '')
check('四路来源都在（三内置 + 一自定义）', Object.keys(usage?.sources ?? {}).length === 4)
check('余额来源可用', usage?.sources?.deepseek?.balances?.[0]?.total === 12.34)
check('额度来源可用', usage?.sources?.openrouter?.credits?.used === 1.25)
check('自定义 generic 来源按路径取到值', usage?.sources?.generic?.summary?.value === 7.5, `value=${usage?.sources?.generic?.summary?.value}`)
check('自定义来源的单位与说明一起回给前端', usage?.sources?.generic?.summary?.unit === 'money' && usage?.sources?.generic?.summary?.detail === '示例接口')
check('主面板仍只认 opencode 那一路', usage?.worst === usage?.windows?.weekly?.percent)

const rolling = usage?.tokens?.rolling
// 100 + 20 + 900 —— 继承事件与重复上报都不该进账
check('台账只算非继承且去重后的一次用量', rolling?.total === 1020, `total=${rolling?.total}`)
check('路由归属走了设置里的 baseURL', usage?.tokens?.attribution?.routes?.includes('open') === true)
check('各路由清单非空', (usage?.tokens?.routes?.length ?? 0) > 0)

const config = await call('/dsh-oc-usage-api/config')
check('配置可读', config?.ok === true && Object.keys(config.config.sources).length === 4)
check('写配置无自定义头被拒', (await call('/dsh-oc-usage-api/config', { method: 'PUT', headers: {} }))?.error === 'forbidden')
check('空请求体被拒', (await call('/dsh-oc-usage-api/config', { method: 'PUT', headers: { 'x-dsh-oc-usage-config': '1' } }))?.error === 'body')

/** 带写头 PUT 一次配置，返回响应体（校验用）。 */
const putConfig = (body) =>
  call('/dsh-oc-usage-api/config', {
    method: 'PUT',
    headers: { 'x-dsh-oc-usage-config': '1' },
    body: JSON.stringify(body),
  })
const rejects = (body) => putConfig(body).then((res) => res?.error === 'invalid')

check(
  '内嵌凭据的 baseURL 被拒',
  await rejects({ sources: { deepseek: { enabled: true, baseURL: 'https://user:key@api.deepseek.com' } } }),
)
check(
  '绝对地址的 path 被拒（免得凭据被指到别的主机）',
  await rejects({
    sources: { probe: { kind: 'generic', enabled: true, baseURL: 'https://example.com', path: 'https://evil.example.com/x', valuePath: 'a.b' } },
  }),
)
check(
  '非法来源标识被拒',
  await rejects({ sources: { 'Bad Id': { kind: 'generic', enabled: true, baseURL: 'https://example.com', path: '/x', valuePath: 'a.b' } } }),
)
check(
  'generic 缺取值路径被拒',
  await rejects({ sources: { probe: { kind: 'generic', enabled: true, baseURL: 'https://example.com', path: '/x' } } }),
)
check(
  '不认识的单位被拒',
  await rejects({
    sources: { probe: { kind: 'generic', enabled: true, baseURL: 'https://example.com', path: '/x', valuePath: 'a.b', unit: 'yuan' } },
  }),
)
check('被拒的写入没有污染配置', Object.keys((await call('/dsh-oc-usage-api/config'))?.config?.sources ?? {}).length === 4)

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项: ${failures.join(' / ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
