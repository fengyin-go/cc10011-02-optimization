import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { loadImpactState } from '@/api/impact-service'
import type { EntryRow, ImpactList } from '@/data/types'
import RevisionWorkbench from './RevisionWorkbench'

const meta = moduleMeta('site')
const columns = [
  "站点编号",
  "域名地址",
  "站点类型",
  "请求方式",
  "字符编码",
  "请求头模板",
  "Cookie配置",
  "站点负责人"
]
const actions = [
  "提交校验",
  "激活站点",
  "暂停站点"
]
const statuses = [
  "草稿",
  "待校验",
  "已激活",
  "已暂停"
]
const stats = [
  {
    "label": "采集站点总数",
    "value": 0
  },
  {
    "label": "已激活站点",
    "value": 0
  },
  {
    "label": "待校验站点",
    "value": 0
  }
]

type SiteViewProps = {
  onInspectList?: (list: ImpactList) => void
}

export default function SiteView({ onInspectList }: SiteViewProps = {}) {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [impactRevision, setImpactRevision] = useState(0)
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const impact = useMemo(() => loadImpactState(), [impactRevision, rows])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '站点登记列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function handleImpactChanged() {
    setImpactRevision((value) => value + 1)
    reload()
  }

  function handleInspect(list: ImpactList) {
    if (onInspectList) {
      onInspectList(list)
      return
    }
    try {
      window.localStorage.setItem('scraper-strategy-studio:impact-focus', list.listId)
    } catch {
      // 忽略：只是页面间提示，不影响清单数据
    }
  }

  return (
    <>
    <section className="page" data-module="site">
      <header className="page-head">
        <div>
          <h2>站点登记管理</h2>
          <p className="page-desc">维护采集站点的输入、执行约束与结果记录，为站点登记提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集站点登记入口尚未接入审批流')}>
            登记采集站点
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出站点登记清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无站点登记数据，可先登记采集站点</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条站点登记记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>

    <RevisionWorkbench onChanged={handleImpactChanged} onInspectList={handleInspect} />

    <section className="page" data-module="site-impact-summary">
      <header className="page-head">
        <div>
          <h3>最近一次变更传播结果</h3>
          <p className="page-desc">站点登记用户能核对字段并集口径留下的当前快照，按站点编号即可查复验范围。</p>
        </div>
      </header>
      {impact.activeList ? (
        <div className="meta-grid">
          <div><span>清单编号</span><strong>{impact.activeList.listId}</strong></div>
          <div><span>站点编号</span><strong>{impact.activeList.siteCode}</strong></div>
          <div><span>落库路线</span><strong>{impact.activeList.basisLabel}</strong></div>
          <div><span>待复验入口</span><strong>{impact.activeList.entries.length}</strong></div>
          <div><span>未纳入入口</span><strong>{impact.activeList.excluded.length}</strong></div>
          <div><span>复核依据</span><strong>{impact.activeList.rule.reviewBasis}</strong></div>
        </div>
      ) : (
        <p className="empty-hint">还没有生成过影响清单</p>
      )}
    </section>
    </>
  )
}
