import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  changeSummary,
  checkpointRevision,
  commitRevision,
  discardRevisionDraft,
  downloadFile,
  exportImpactAudit,
  exportImpactList,
  getSimulatedWriteFailure,
  loadActiveSites,
  loadImpactState,
  previewRevision,
  resumeRevisionDraft,
  scopeSummary,
  setSimulatedWriteFailure,
} from '@/api/impact-service'
import type { ImpactBasis, ImpactList, ImpactPreview } from '@/data/types'

const EDIT_FIELDS = [
  '站点编号',
  '域名地址',
  '站点类型',
  '请求方式',
  '字符编码',
  '请求头模板',
  'Cookie配置',
  '站点负责人',
]

const OPERATOR = '值班管理员'

function nowText(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function fieldsOfSite(row: Record<string, string | number | boolean>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of EDIT_FIELDS) values[field] = String(row[field] ?? '')
  return values
}

function parseCap(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

type Props = {
  onChanged: () => void
  onInspectList: (list: ImpactList) => void
}

export default function RevisionWorkbench({ onChanged, onInspectList }: Props) {
  const [refreshToken, setRefreshToken] = useState(0)
  const [siteId, setSiteId] = useState<number | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [capInput, setCapInput] = useState('')
  const [basis, setBasis] = useState<ImpactBasis>('fieldUnion')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [failDrill, setFailDrill] = useState(false)
  const [sessionId] = useState(() => `SESSION-${Date.now().toString(36).toUpperCase()}`)
  const [showExcluded, setShowExcluded] = useState(false)
  const [snapshotEntryId, setSnapshotEntryId] = useState('')

  const state = useMemo(() => loadImpactState(), [refreshToken])
  const sites = useMemo(() => loadActiveSites(), [refreshToken])

  useEffect(() => {
    if (sites.length === 0) {
      setSiteId(null)
      return
    }
    if (siteId === null || !sites.some((item) => Number(item.site.id) === siteId)) {
      setSiteId(Number(sites[0].site.id))
    }
  }, [sites, siteId])

  const selected = sites.find((item) => Number(item.site.id) === siteId) ?? null
  const draft = selected ? state.drafts[`site:${Number(selected.site.id)}`] ?? null : null

  useEffect(() => {
    if (!selected) return
    setForm(fieldsOfSite(selected.site))
    setCapInput(selected.perSecondCap === null ? '' : String(selected.perSecondCap))
    setSnapshotEntryId('')
    // 只在切换站点时重置表单：暂存/落库后保留用户当前输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId])

  const computed = useMemo<{ preview: ImpactPreview | null; error: string }>(() => {
    if (!selected) return { preview: null, error: '' }
    try {
      return {
        preview: previewRevision({ siteId: Number(selected.site.id), values: form, perSecondCap: parseCap(capInput) }),
        error: '',
      }
    } catch (cause) {
      return { preview: null, error: cause instanceof Error ? cause.message : '影响范围计算失败' }
    }
  }, [selected, form, capInput, refreshToken])

  const preview = computed.preview
  const chosenScope = preview ? (basis === 'wholeRecord' ? preview.wholeRecord : preview.fieldUnion) : null

  const toggleFailDrill = useCallback((next: boolean) => {
    setFailDrill(next)
    setSimulatedWriteFailure(next ? '演练：本地存储写入失败' : '')
    setMessage(next ? '已开启保存失败演练，下一次生成会影响清单时只报错、不改动上一份清单' : '已关闭保存失败演练')
    setError('')
  }, [])

  function handleSelectSite(value: string) {
    setSiteId(value === '' ? null : Number(value))
    setMessage('')
    setError('')
  }

  function handleField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
    setMessage('')
    setError('')
  }

  function handleCommit() {
    if (!selected) return
    setError('')
    const result = commitRevision({
      siteId: Number(selected.site.id),
      values: form,
      perSecondCap: parseCap(capInput),
      basis,
      operator: OPERATOR,
      sessionId,
    })
    if (!result.ok) {
      setError(result.message)
      setRefreshToken((token) => token + 1)
      return
    }
    setMessage(result.message)
    // 落库后站点记录已更新：表单回到新值，避免把旧值当成新的差异
    if (result.list) {
      setForm((prev) => ({ ...fieldsOfSite(selected.site), ...prev }))
      setSnapshotEntryId(result.list.entries[0]?.recordId ?? '')
    }
    setRefreshToken((token) => token + 1)
    onChanged()
  }

  function handleCheckpoint() {
    if (!selected) return
    setError('')
    const result = checkpointRevision({
      siteId: Number(selected.site.id),
      values: form,
      perSecondCap: capInput,
      basis,
      sessionId,
    })
    if (!result.ok) {
      setError(result.message)
      return
    }
    setMessage(result.message)
    setRefreshToken((token) => token + 1)
  }

  function handleResume() {
    if (!selected) return
    setError('')
    const result = resumeRevisionDraft(Number(selected.site.id))
    if (!result.ok) {
      setError(result.message)
      setRefreshToken((token) => token + 1)
      return
    }
    if (result.draft) {
      setForm((prev) => ({ ...fieldsOfSite(selected.site), ...result.draft!.values }))
      setCapInput(result.draft.perSecondCap)
      setBasis(result.draft.basis)
    }
    setMessage(result.message)
    setRefreshToken((token) => token + 1)
  }

  function handleDiscardDraft() {
    if (!selected) return
    discardRevisionDraft(Number(selected.site.id))
    setRefreshToken((token) => token + 1)
    setMessage('已放弃修订现场，站点记录与当前清单都没有变化')
  }

  function handleExportList() {
    if (!state.activeList) {
      setError('当前没有可执行的受影响采集站点配置清单')
      return
    }
    const file = exportImpactList(state.activeList)
    downloadFile(file.filename, file.content)
    setMessage(`已导出 ${file.filename}`)
  }

  function handleExportAudit() {
    const file = exportImpactAudit(state.activeList)
    downloadFile(file.filename, file.content)
    setMessage(`已导出复核记录 ${file.filename}`)
  }

  return (
    <section className="panel" data-testid="revision-workbench">
      <header className="panel-head">
        <div>
          <h3>站点修订与变更传播</h3>
          <p className="page-desc">
            只对已激活站点发起修订：按字段判定影响范围，模板引用与作业引用一起判断，落库生成一份完整影响清单。
          </p>
        </div>
        <div className="panel-tools">
          <label className="switch">
            <input type="checkbox" checked={failDrill} onChange={(event) => toggleFailDrill(event.target.checked)} />
            保存失败演练
          </label>
          <button className="btn" type="button" onClick={handleExportList}>导出受影响清单</button>
          <button className="btn" type="button" onClick={handleExportAudit}>导出复核记录</button>
        </div>
      </header>

      <div className="filter-bar">
        <label className="filter-item">
          <span>已激活站点登记</span>
          <select value={siteId ?? ''} onChange={(event) => handleSelectSite(event.target.value)}>
            {sites.map((item) => (
              <option key={String(item.site.id)} value={String(item.site.id)}>
                {String(item.site['站点编号'])} · {item.domain} · {item.version}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <span className="chip">站点登记 #{String(selected.site.id)}</span>
            <span className="chip">采集站点 · {String(selected.site['站点编号'])}</span>
            <span className="chip">业务对象 {selected.businessKey}</span>
            <span className="chip">当前版本 {selected.version}</span>
            <span className="chip">模板 {selected.templates.length} / 作业 {selected.jobs.length}</span>
          </>
        )}
      </div>

      {!selected && <p className="empty-hint">还没有已激活的采集站点，先到下方登记表激活一个站点。</p>}

      {selected && (
        <>
          <div className="grid-2">
            <div>
              <h4 className="sub-head">修订字段</h4>
              <div className="field-grid">
                {EDIT_FIELDS.map((field) => (
                  <label key={field} className="filter-item">
                    <span>{field}</span>
                    <input value={form[field] ?? ''} onChange={(event) => handleField(field, event.target.value)} />
                  </label>
                ))}
                <label className="filter-item">
                  <span>每秒请求上限（限速规则）</span>
                  <input value={capInput} placeholder="未登记" onChange={(event) => setCapInput(event.target.value)} />
                </label>
              </div>
              <div className="row-actions" style={{ marginTop: 8 }}>
                <button className="btn ghost" type="button" onClick={() => setForm(fieldsOfSite(selected.site))}>还原字段</button>
                <button className="btn" type="button" onClick={handleCheckpoint}>暂存修订现场（模拟中断）</button>
                {draft && (
                  <>
                    <button className="btn" type="button" onClick={handleResume}>恢复中断现场</button>
                    <button className="btn ghost" type="button" onClick={handleDiscardDraft}>放弃现场</button>
                  </>
                )}
              </div>
              {draft && (
                <div className="banner info">
                  修订现场：{draft.status}，先记下字段并集 {draft.fieldUnionPreview.entryCount} 条入口（
                  {draft.fieldUnionPreview.entryIds.join('、') || '无'}），更新于 {nowText(draft.updatedAt)}，当前可执行清单
                  {state.activeList ? `仍为 ${state.activeList.listId}` : '仍为空'}。
                </div>
              )}
            </div>

            <div>
              <h4 className="sub-head">字段级差异</h4>
              <table className="data-table compact">
                <thead>
                  <tr><th>字段</th><th>修订前</th><th>修订后</th><th>命中模板</th><th>命中作业</th><th>判定原因</th></tr>
                </thead>
                <tbody>
                  {(preview?.fieldDiffs ?? []).map((diff) => (
                    <tr key={diff.field} className={diff.triggers ? '' : 'muted-row'}>
                      <td>{diff.field}{diff.fromRateRule ? '（限速规则）' : ''}</td>
                      <td>{diff.before || '空'}</td>
                      <td>{diff.after || '空'}</td>
                      <td>{diff.templateRefs.join('、') || '—'}</td>
                      <td>{diff.jobRefs.join('、') || '—'}</td>
                      <td>{diff.reason}</td>
                    </tr>
                  ))}
                  {(preview?.fieldDiffs ?? []).length === 0 && (
                    <tr><td className="empty-state" colSpan={6}>还没有字段变化</td></tr>
                  )}
                </tbody>
              </table>
              {preview && (
                <p className="hint-line">
                  请求方式加工结果：{preview.requestMethod.raw || '未登记'} → <strong>{preview.requestMethod.processed}</strong>
                  ；规则标准 {preview.rule.version}（每秒上限 {preview.rule.perSecondCap ?? '未登记'}，
                  {preview.rule.capChanged ? '相对限速配置为新上限' : '与限速配置一致'}）
                </p>
              )}
            </div>
          </div>

          {computed.error && <p className="banner danger">{computed.error}</p>}

          {preview && (
            <>
              <h4 className="sub-head">两种落库路线</h4>
              <div className="basis-grid">
                {[preview.fieldUnion, preview.wholeRecord].map((scope) => (
                  <button
                    key={scope.basis}
                    type="button"
                    className={`basis-card${basis === scope.basis ? ' selected' : ''}`}
                    onClick={() => setBasis(scope.basis)}
                  >
                    <span className="basis-title">{scope.label}</span>
                    <strong className="basis-count">{scopeSummary(scope)}</strong>
                    <span className="basis-meta">任务编排待处理清单 {scope.spiderVersion}</span>
                    <span className="basis-meta">校验和 {scope.checksum}</span>
                    <span className="basis-desc">{scope.description}</span>
                  </button>
                ))}
              </div>

              {preview.conflict ? (
                <p className="banner warn">
                  {preview.conflictNote} 选定落库路线后，清单数据按选定口径写入，任务编排版本随之确定；复核依据仍为
                  「按每个变更字段合并影响范围」。
                </p>
              ) : (
                <p className="banner ok">两种口径给出同一份复验范围，可任选落库路线。</p>
              )}

              <div className="grid-2">
                <div>
                  <h4 className="sub-head">复验核对</h4>
                  <ul className="check-list">
                    {preview.verification.checks.map((check) => (
                      <li key={check.key} className={check.ok ? 'ok' : 'bad'}>
                        <span>{check.ok ? '✓' : '✗'} {check.label}</span>
                        <em>{check.detail}</em>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="sub-head">待落库清单预览（{chosenScope?.label}）</h4>
                  <p className="hint-line">
                    清单编号 {preview.listId} · 站点 {preview.siteVersionBefore} → {preview.siteVersionAfter} · 校验和{' '}
                    {preview.checksum}
                  </p>
                  <ul className="entry-preview">
                    {(chosenScope?.entries ?? []).map((entry) => (
                      <li key={entry.recordId}>
                        <span className={`tag ${entry.kind}`}>{entry.kind === 'template' ? '模板' : '作业'}</span>
                        {entry.refCode}
                        <span className="muted">（{entry.changedFields.join('、')}）</span>
                      </li>
                    ))}
                    {(chosenScope?.entries ?? []).length === 0 && <li className="muted">该口径下没有需要复验的入口</li>}
                  </ul>
                  <button className="btn primary" type="button" onClick={handleCommit}>
                    生成完整影响清单并落库
                  </button>
                </div>
              </div>
            </>
          )}

          {message && <p className="banner ok">{message}</p>}
          {error && <p className="banner danger">{error}</p>}
        </>
      )}

      <div className="panel-head" style={{ marginTop: 12 }}>
        <div>
          <h3>当前可执行清单</h3>
          <p className="page-desc">
            复验过程中保存失败时，清单保持上一份可执行版本；任务编排读取的也是这一份。
          </p>
        </div>
        <div className="panel-tools">
          <span className={`tag ${state.activeList ? 'job' : 'template'}`}>
            {state.activeList ? `清单 ${state.activeList.listId} · v${state.activeList.version}` : '暂无清单'}
          </span>
          {state.spiderPending && (
            <span className="chip">任务编排已读取 {state.spiderPending.spiderVersion} · {nowText(state.spiderPending.syncedAt)}</span>
          )}
        </div>
      </div>

      {state.lastError && <p className="banner warn">最近一次保存失败：{state.lastError}（上一份清单未被覆盖）</p>}
      {getSimulatedWriteFailure() && <p className="banner warn">保存失败演练已开启</p>}

      {state.activeList ? (
        <>
          <div className="meta-grid">
            <div><span>清单编号</span><strong>{state.activeList.listId}</strong></div>
            <div><span>站点登记</span><strong>#{state.activeList.siteId}</strong></div>
            <div><span>站点编号</span><strong>{state.activeList.siteCode}</strong></div>
            <div><span>落库路线</span><strong>{state.activeList.basisLabel}</strong></div>
            <div><span>任务编排版本</span><strong>{state.activeList.spiderVersion}</strong></div>
            <div><span>清单条数</span><strong>{state.activeList.entries.length}</strong></div>
            <div><span>站点版本</span><strong>{state.activeList.siteVersionBefore} → {state.activeList.siteVersionAfter}</strong></div>
            <div><span>生成时间</span><strong>{nowText(state.activeList.createdAt)}</strong></div>
          </div>
          <p className="hint-line">
            本次变更：{changeSummary(state.activeList.changes) || '无'}；请求方式加工：
            {state.activeList.requestMethod.raw} → {state.activeList.requestMethod.processed}；复核依据{' '}
            {state.activeList.verification.ruleVersion}，核对结果 {state.activeList.verification.ok ? '通过' : '未通过'}。
          </p>

          <table className="data-table">
            <thead>
              <tr>
                <th>入口类型</th><th>入口编号</th><th>变更字段</th><th>复验原因</th>
                <th>每秒上限</th><th>复验状态</th><th>快照</th>
              </tr>
            </thead>
            <tbody>
              {state.activeList.entries.map((entry) => (
                <tr key={entry.recordId}>
                  <td><span className={`tag ${entry.kind}`}>{entry.kind === 'template' ? '抽取模板' : '采集作业'}</span></td>
                  <td>{entry.refCode}</td>
                  <td>{entry.changedFields.join('、')}</td>
                  <td>{entry.reasons.join('；')}</td>
                  <td>{entry.perSecondCap ?? '—'}</td>
                  <td>{entry.verifyStatus}{entry.verifiedAt ? ` · ${nowText(entry.verifiedAt)}` : ''}</td>
                  <td>
                    <button className="link" type="button" onClick={() => setSnapshotEntryId(snapshotEntryId === entry.recordId ? '' : entry.recordId)}>
                      {snapshotEntryId === entry.recordId ? '收起' : '回看'}
                    </button>
                  </td>
                </tr>
              ))}
              {state.activeList.entries.length === 0 && (
                <tr><td className="empty-state" colSpan={7}>本次修订没有需要复验的模板或作业</td></tr>
              )}
            </tbody>
          </table>

          {snapshotEntryId && (() => {
            const entry = state.activeList.entries.find((item) => item.recordId === snapshotEntryId)
            if (!entry) return null
            return (
              <div className="snapshot">
                <strong>{entry.refCode} 当前业务证据快照</strong>
                <dl>
                  {Object.entries(entry.snapshot).map(([key, value]) => (
                    <div key={key}><dt>{key}</dt><dd>{value || '—'}</dd></div>
                  ))}
                </dl>
              </div>
            )
          })()}

          <div className="panel-tools" style={{ marginTop: 8 }}>
            <button className="btn ghost" type="button" onClick={() => setShowExcluded((value) => !value)}>
              {showExcluded ? '收起' : '展开'}未纳入入口（{state.activeList.excluded.length}）
            </button>
            <button className="btn" type="button" onClick={() => onInspectList(state.activeList as ImpactList)}>
              查看复验范围与核对
            </button>
          </div>
          {showExcluded && (
            <table className="data-table compact">
              <thead><tr><th>类型</th><th>编号</th><th>未纳入原因</th><th>按原版本继续执行</th></tr></thead>
              <tbody>
                {state.activeList.excluded.map((item) => (
                  <tr key={`${item.kind}:${item.refCode}`}>
                    <td>{item.kind === 'template' ? '抽取模板' : '采集作业'}</td>
                    <td>{item.refCode}</td>
                    <td>{item.why}</td>
                    <td>{item.snapshot['status'] ?? '—'}</td>
                  </tr>
                ))}
                {state.activeList.excluded.length === 0 && (
                  <tr><td className="empty-state" colSpan={4}>所有相关入口都在清单内</td></tr>
                )}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p className="empty-hint">尚未生成受影响采集站点配置清单，任务编排全部按原站点版本执行。</p>
      )}
    </section>
  )
}
