import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { loadImpactState, syncSpiderPendingList } from '@/api/impact-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]
const stats = [
  {
    "label": "采集作业总数",
    "value": 0
  },
  {
    "label": "运行中作业",
    "value": 0
  },
  {
    "label": "已完成作业",
    "value": 0
  }
]

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [syncMessage, setSyncMessage] = useState('')
  const [impactToken, setImpactToken] = useState(0)
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const impact = useMemo(() => loadImpactState(), [impactToken])
  const pendingJobs = impact.spiderPending?.jobIds ?? []

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
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
    setImpactToken((value) => value + 1)
  }

  function readImpactList() {
    setErrorMessage('')
    setSyncMessage('')
    const result = syncSpiderPendingList('值班管理员')
    if (!result.ok) {
      setErrorMessage(result.message)
      setImpactToken((value) => value + 1)
      return
    }
    setSyncMessage(result.message)
    setImpactToken((value) => value + 1)
    reload()
  }

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">维护采集作业的输入、执行约束与结果记录，为任务编排提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={readImpactList}>
            读取影响清单并刷新待处理
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
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

      <p className="banner ok">
        待处理清单 {impact.spiderPending ? `${impact.spiderPending.spiderVersion}（${impact.spiderPending.basis === 'fieldUnion' ? '按每个变更字段合并影响范围' : '按最后确认的整条站点记录确定范围'}）` : '尚未读取'}
        ：当前列表 {rows.filter((row) => pendingJobs.includes(String(row['作业编号'] ?? ''))).length} 个作业标记待复验，
        其余 {rows.filter((row) => !pendingJobs.includes(String(row['作业编号'] ?? ''))).length} 个继续按原站点版本执行。
      </p>
      {syncMessage && <p className="banner ok">{syncMessage}</p>}

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
            <th>复验标记</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>
                {pendingJobs.includes(String(row['作业编号'] ?? ''))
                  ? impact.spiderPending?.completedJobIds.includes(String(row['作业编号'] ?? ''))
                    ? <span className="tag template">已复验</span>
                    : <span className="tag job">待复验</span>
                  : <span className="muted">按原版本执行</span>}
              </td>
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
              <td className="empty-state" colSpan={columns.length + 3}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
