/** 渲染冒烟：用 SSR 渲染关键页面，确认组件不依赖只能在浏览器里存在的副作用。 */
import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import App from '@/App'
import { commitRevision } from '@/api/impact-service'
import ImpactView from '@/views/impact'
import RevisionWorkbench from '@/views/site/RevisionWorkbench'

const store = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => (store.has(key) ? store.get(key) : null),
    setItem: (key: string, value: string) => store.set(key, value),
  },
}

const committed = commitRevision({
  siteId: 2,
  values: { 请求方式: 'GET/静态请求', 字符编码: 'UTF-8' },
  perSecondCap: 1,
  basis: 'fieldUnion',
  operator: '值班管理员',
  sessionId: 'SMOKE',
})
console.log(`${committed.ok ? 'PASS' : 'FAIL'} 落库预置 — ${committed.message}`)

const pages: Array<[string, React.ReactElement]> = [
  ['App/site', <MemoryRouter initialEntries={['/site']}><App /></MemoryRouter>],
  ['App/impact', <MemoryRouter initialEntries={['/impact']}><App /></MemoryRouter>],
  ['App/spider', <MemoryRouter initialEntries={['/spider']}><App /></MemoryRouter>],
  ['ImpactView', <ImpactView />],
  ['RevisionWorkbench', <RevisionWorkbench onChanged={() => undefined} onInspectList={() => undefined} />],
]

let failures = 0
for (const [name, element] of pages) {
  try {
    const html = renderToString(element)
    const hasScope = name === 'App/impact' || name === 'ImpactView' ? html.includes('复验范围') : true
    const ok = html.length > 500 && hasScope
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${html.length} bytes${hasScope ? '' : '，缺少复验范围区块'}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(failures === 0 ? '\nRENDER SMOKE PASSED' : `\n${failures} RENDER(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
