import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  changeSummary,
  downloadFile,
  exportImpactAudit,
  exportImpactList,
  loadImpactState,
  lookupScopesBySiteCode,
  markJobVerified,
  syncSpiderPendingList,
} from '@/api/impact-service'
import type { ImpactList } from '@/data/types'

const OPERATOR = '值班管理员'

function nowText(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

type Props = {
  /** 从站点登记页跳转过来时直接展开的清单 */
  focusList?: ImpactList | null
}

export default function ImpactView({ focusList = null }: Props) {
  const [token, setToken] = useState(0)
  const [codeInput, setCodeInput] = useState('')
  const [lookupCode, setLookupCode] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const state = useMemo(() => loadImpactState(), [token])
  const list = state.activeList ?? focusList
  const lookup = useMemo(() => (lookupCode ? lookupScopesBySiteCode(lookupCode) : null), [lookupCode, token])

  useEffect(() => {
    setShowHistory(false)
  }, [list?.listId])

  const refresh = useCallback(() => setToken((value) => value + 1), [])

  function handleSync() {
    setError('')
    const result = syncSpiderPendingList(OPERATOR)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setMessage(result.message)
    refresh()
  }

  function handleVerify(jobCode: string) {
    setError('')
    const result = markJobVerified(jobCode, OPERATOR)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setMessage(result.message)
    refresh()
  }

  function handleLookup() {
    if (!codeInput.trim()) {
      setError('请先输入站点编号')
      return
    }
    setError('')
    setLookupCode(codeInput.trim())
    setMessage('')
  }

  function handleExport() {
    const file = exportImpactList(list)
    downloadFile(file.filename, file.content)
    setMessage(`已导出 ${file.filename}`)
  }

  function handleAudit() {
    const file = exportImpactAudit(list)
    downloadFile(file.filename, file.content)
    setMessage(`已导出 ${file.filename}`)
  }

  return (
    <section className="page" data-module="impact">
      <header className="page-head">
        <div>
          <h2>受影响采集站点配置清单</h2>
          <p className="page-desc">
            站点修订后只留一份完整影响清单；任务编排读取后只把清单里的入口标记为待复验，其余作业继续按原站点版本执行。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={handleExport}>导出清单数据</button>
          <button className="btn" type="button" onClick={handleAudit}>导出复核记录</button>
        </div>
      </header>

      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
          handleLookup()
        }}
      >
        <label className="filter-item">
          <span>按站点编号查复验范围</span>
          <input value={codeInput} placeholder="例如 SITE-0002" onChange={(event) => setCodeInput(event.target.value)} />
        </label>
        <button className="btn primary" type="submit">查复验范围</button>
        <button
          className="btn ghost"
          type="button"
          onClick={() => {
            setCodeInput('')
            setLookupCode('')
            setMessage('')
            setError('')
          }}
        >
          清除查询
        </button>
      </form>

      {message && <p className="banner ok">{message}</p>}
      {error && <p className="banner danger">{error}</p>}

      {lookup && (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h3>站点编号「{lookupCode}」的复验范围</h3>
              <p className="page-desc">当前清单与历史清单都能回看，值班员按站点编号核对。</p>
            </div>
          </header>
          {lookup.current ? (
            <p className="banner ok">当前清单 {lookup.current.listId}（{lookup.current.basisLabel}，{lookup.current.entries.length} 条）</p>
          ) : (
            <p className="banner warn">当前可执行清单不包含这个站点编号</p>
          )}
          {lookup.history.length > 0 ? (
            <ul className="history-list">
              {lookup.history.map((item) => (
                <li key={item.listId}>
                  {item.listId} · v{item.version} · {item.basisLabel} · {item.entries.length} 条 · {item.status} · {nowText(item.createdAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-hint">没有更早的清单记录</p>
          )}
        </section>
      )}

      {!list ? (
        <p className="empty-hint">当前没有可执行的受影响采集站点配置清单。</p>
      ) : (
        <>
          <div className="meta-grid">
            <div><span>清单编号</span><strong>{list.listId}</strong></div>
            <div><span>清单版本</span><strong>v{list.version}</strong></div>
            <div><span>站点登记</span><strong>#{list.siteId} · {list.siteCode}</strong></div>
            <div><span>采集站点</span><strong>{list.siteDomain}</strong></div>
            <div><span>落库路线</span><strong>{list.basisLabel}</strong></div>
            <div><span>任务编排版本</span><strong>{list.spiderVersion}</strong></div>
            <div><span>清单条数</span><strong>{list.entries.length}</strong></div>
            <div><span>未纳入入口</span><strong>{list.excluded.length}</strong></div>
            <div><span>站点版本</span><strong>{list.siteVersionBefore} → {list.siteVersionAfter}</strong></div>
            <div><span>校验和</span><strong>{list.checksum}</strong></div>
            <div><span>生成人</span><strong>{list.createdBy}</strong></div>
            <div><span>生成时间</span><strong>{nowText(list.createdAt)}</strong></div>
          </div>

          <div className="grid-2">
            <div>
              <h4 className="sub-head">规则标准</h4>
              <ul className="kv-list">
                <li><span>版本</span><strong>{list.rule.version}</strong></li>
                <li><span>判定口径</span><strong>{list.rule.criteria}</strong></li>
                <li><span>适用范围</span><strong>{list.rule.scope}</strong></li>
                <li><span>复核依据</span><strong>{list.rule.reviewBasis}</strong></li>
                <li><span>每秒请求上限</span><strong>{list.rule.capChanged ? `${list.rule.configuredPerSecond ?? '未登记'} → ${list.rule.perSecondCap}` : list.rule.perSecondCap ?? '未登记'}</strong></li>
              </ul>
              <p className="hint-line">
                本次变更：{changeSummary(list.changes) || '无'}；请求方式加工：{list.requestMethod.raw} → {list.requestMethod.processed}。
              </p>
            </div>
            <div>
              <h4 className="sub-head">复验核对（{list.verification.ok ? '通过' : '未通过'}）</h4>
              <ul className="check-list">
                {list.verification.checks.map((check) => (
                  <li key={check.key} className={check.ok ? 'ok' : 'bad'}>
                    <span>{check.ok ? '✓' : '✗'} {check.label}</span>
                    <em>{check.detail}</em>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <h4 className="sub-head">字段级差异与影响范围</h4>
          <table className="data-table">
            <thead>
              <tr><th>字段</th><th>修订前</th><th>修订后</th><th>命中模板</th><th>命中作业</th><th>判定原因</th><th>是否触发</th></tr>
            </thead>
            <tbody>
              {list.fieldDiffs.map((diff) => (
                <tr key={diff.field} className={diff.triggers ? '' : 'muted-row'}>
                  <td>{diff.field}{diff.fromRateRule ? '（限速规则）' : ''}</td>
                  <td>{diff.before || '空'}</td>
                  <td>{diff.after || '空'}</td>
                  <td>{diff.templateRefs.join('、') || '—'}</td>
                  <td>{diff.jobRefs.join('、') || '—'}</td>
                  <td>{diff.reason}</td>
                  <td>{diff.triggers ? '触发复验' : '不触发'}</td>
                </tr>
              ))}
              {list.fieldDiffs.length === 0 && (
                <tr><td className="empty-state" colSpan={7}>本次没有字段级差异，仅因每秒上限变化生成清单</td></tr>
              )}
            </tbody>
          </table>

          <h4 className="sub-head">复验范围（{list.entries.length} 条）</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>入口类型</th><th>入口编号</th><th>入口地址</th><th>变更字段</th><th>复验原因</th><th>每秒上限</th><th>状态</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.entries.map((entry) => (
                <tr key={entry.recordId}>
                  <td><span className={`tag ${entry.kind}`}>{entry.kind === 'template' ? '抽取模板' : '采集作业'}</span></td>
                  <td>{entry.refCode}</td>
                  <td>{entry.snapshot['入口地址'] ?? entry.snapshot['起始地址'] ?? '—'}</td>
                  <td>{entry.changedFields.join('、')}</td>
                  <td>{entry.reasons.join('；')}</td>
                  <td>{entry.perSecondCap ?? '—'}</td>
                  <td>{entry.verifyStatus}{entry.verifiedAt ? ` · ${nowText(entry.verifiedAt)}` : ''}</td>
                  <td>
                    {entry.kind === 'job' ? (
                      <button className="link" type="button" onClick={() => handleVerify(entry.refCode)}>
                        标记复验完成
                      </button>
                    ) : (
                      <span className="muted">随作业复验</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="sub-head">未纳入入口（继续按原站点版本执行）</h4>
          <table className="data-table compact">
            <thead><tr><th>类型</th><th>编号</th><th>未纳入原因</th><th>当前状态</th></tr></thead>
            <tbody>
              {list.excluded.map((item) => (
                <tr key={`${item.kind}:${item.refCode}`}>
                  <td>{item.kind === 'template' ? '抽取模板' : '采集作业'}</td>
                  <td>{item.refCode}</td>
                  <td>{item.why}</td>
                  <td>{item.snapshot['status'] ?? '—'}</td>
                </tr>
              ))}
              {list.excluded.length === 0 && (
                <tr><td className="empty-state" colSpan={4}>所有相关入口都进了清单</td></tr>
              )}
            </tbody>
          </table>

          <div className="panel-tools" style={{ marginTop: 10 }}>
            <button className="btn primary" type="button" onClick={handleSync}>任务编排读取清单并刷新待处理</button>
            <button className="btn ghost" type="button" onClick={() => setShowHistory((value) => !value)}>
              {showHistory ? '收起' : '展开'}历史清单（{state.history.length}）
            </button>
          </div>

          {state.spiderPending && (
            <p className="banner ok">
              任务编排待处理清单 {state.spiderPending.spiderVersion}：{state.spiderPending.jobIds.length} 个作业待复验，
              已完成 {state.spiderPending.completedJobIds.length} 个；读取于 {nowText(state.spiderPending.syncedAt)}。
            </p>
          )}

          {showHistory && (
            <table className="data-table compact">
              <thead><tr><th>清单</th><th>版本</th><th>落库路线</th><th>条数</th><th>站点</th><th>生成时间</th><th>状态</th></tr></thead>
              <tbody>
                {state.history.map((item) => (
                  <tr key={item.listId}>
                    <td>{item.listId}</td>
                    <td>v{item.version}</td>
                    <td>{item.basisLabel}</td>
                    <td>{item.entries.length}</td>
                    <td>{item.siteCode}</td>
                    <td>{nowText(item.createdAt)}</td>
                    <td>{item.status}</td>
                  </tr>
                ))}
                {state.history.length === 0 && (
                  <tr><td className="empty-state" colSpan={7}>还没有被替换的清单</td></tr>
                )}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  )
}
