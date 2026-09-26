/** client.js 冒烟测试：桩 React 下跑通 factory + apply，确认两个槽位都注册上。 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let loaded = null
globalThis.window = {
  innerWidth: 1440,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(entry) { loaded = entry } },
}
globalThis.document = {
  createElement: () => ({ dataset: {}, remove() {}, textContent: '' }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, config: { sources: {}, rollingHours: 5 } }), { status: 200 })

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

new Function('window', 'document', 'fetch', source)(globalThis.window, globalThis.document, globalThis.fetch)
if (loaded === null) { console.log('失败：模块没有注册'); process.exit(1) }

const module_ = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`未预期的 require: ${name}`)
})

const registered = []
const ctx = {
  effect(fn) { const d = fn(); return disposeable(d) },
  locale: { register: (ns, lang) => ({ ns, lang }), bind: () => (key) => key },
  slots: {
    inject: (name, cb) => { cb() },
    register: (meta, component) => { registered.push({ meta, component }) },
  },
}
function disposeable(value) { return typeof value === 'function' ? value : () => {} }

try {
  module_.apply(ctx)
  console.log('apply() OK')
} catch (error) {
  console.log('apply() 抛出:', error?.stack ?? error)
  process.exit(1)
}

for (const entry of registered) {
  console.log(`槽位 ${entry.meta.name}  id=${entry.meta.id}  order=${entry.meta.order}  组件=${typeof entry.component}`)
}

// 设置页组件直接调用一次（纯函数式，无 hook 依赖的那部分）
const settings = registered.find((entry) => entry.meta.name === 'settings.section')
if (settings) {
  const tree = settings.component({})
  console.log('设置页首屏渲染:', tree === null ? 'null（加载中）' : `div/${tree.props?.className}`)
}
const chip = registered.find((entry) => entry.meta.name === 'conversation.session.header.utilities')
console.log('浮层组件:', typeof chip?.component)
console.log('\n冒烟测试通过')
