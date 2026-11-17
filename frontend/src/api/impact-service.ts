import type {
  DraftRevision,
  EntryRow,
  ImpactBasis,
  ImpactCommitResult,
  ImpactList,
  ImpactPreview,
  ImpactScope,
  ImpactState,
  SiteChange,
  SpiderPendingList,
} from '@/data/types'
import { IMPACT_AUX_KEY, cloneRoot, listRows, readAux, writeStore } from '@/data/local-store'
import {
  buildRuleStandard,
  computeImpact,
  diffSite,
  verifyScope,
  type BuildOptions,
} from '@/data/impact-engine'
import { processRequestMethod, siteBusinessKey, siteDomain, siteKey } from '@/data/impact-shared'

// 影响传播的读写入口：站点修订、草稿中断恢复、复验核对、任务编排读取清单都在这里。
// 落库是整份根对象一次写盘：站点字段、影响清单、任务编排待处理清单要么一起生效，
// 要么全部不生效，作业不会读到只算了一半的集合。

const RULE_NOW = () => new Date().toISOString()

/** 演练开关：只为验证「保存失败时上一份清单仍保留」，不做任何真实数据改写。 */
let simulatedWriteFailure = ''

export function setSimulatedWriteFailure(reason: string): void {
  simulatedWriteFailure = reason
}

export function getSimulatedWriteFailure(): string {
  return simulatedWriteFailure
}

function emptyState(): ImpactState {
  return {
    activeList: null,
    history: [],
    sequence: 0,
    lastSavedAt: '',
    lastError: '',
    spiderSyncedAt: '',
    spiderSyncedVersion: '',
    spiderPending: null,
    siteRevisions: {},
    drafts: {},
  }
}

export function loadImpactState(): ImpactState {
  const stored = readAux<ImpactState>(IMPACT_AUX_KEY)
  if (!stored) return emptyState()
  const base = emptyState()
  return {
    ...base,
    ...stored,
    history: stored.history ?? [],
    siteRevisions: stored.siteRevisions ?? {},
    drafts: stored.drafts ?? {},
    lastError: simulatedWriteFailure || stored.lastError || '',
  }
}

function persistImpact(
  next: ImpactState,
  overrides: { site?: EntryRow[]; ratelimit?: EntryRow[] } = {},
): void {
  if (simulatedWriteFailure) {
    throw new Error(simulatedWriteFailure)
  }
  const root = cloneRoot()
  if (overrides.site) {
    root.site = overrides.site
  }
  if (overrides.ratelimit) {
    root.ratelimit = overrides.ratelimit
  }
  root[IMPACT_AUX_KEY] = next
  // 一次序列化、一次写盘：站点记录、影响清单、任务编排待处理清单同生共死。
  writeStore(root)
}

export function siteVersionOf(state: ImpactState, site: EntryRow): number {
  const fromState = state.siteRevisions[siteKey(site)]
  if (typeof fromState === 'number') return fromState
  const fromRow = Number(String(site['版本'] ?? 'v1').replace(/^v/, ''))
  return Number.isFinite(fromRow) && fromRow > 0 ? fromRow : 1
}

function buildOptions(at: string): BuildOptions {
  return {
    templates: listRows('template'),
    jobs: listRows('spider'),
    rateLimits: listRows('ratelimit'),
    at,
  }
}

function capOf(site: EntryRow): number | null {
  const row = listRows('ratelimit').find(
    (item) => String(item['目标站点'] ?? '') === String(site['站点编号'] ?? ''),
  )
  if (!row) return null
  const value = Number(row['每秒请求上限'])
  return Number.isFinite(value) ? value : null
}

function nextListId(state: ImpactState): string {
  const serial = String(state.sequence + 1).padStart(4, '0')
  return `IMP-2026-${serial}`
}

function siteValues(site: EntryRow): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of Object.keys(site)) {
    if (['id', 'status', 'pending', 'abnormal'].includes(field)) continue
    values[field] = String(site[field] ?? '')
  }
  return values
}

/** 已激活站点登记及其模板、采集作业引用，供修订面板选择范围。 */
export function loadActiveSites(): {
  site: EntryRow
  domain: string
  businessKey: string
  version: string
  templates: string[]
  jobs: string[]
  perSecondCap: number | null
}[] {
  const state = loadImpactState()
  const templates = listRows('template')
  const jobs = listRows('spider')
  return listRows('site')
    .filter((row) => String(row.status) === '已激活')
    .map((row) => {
      const domain = siteDomain(row)
      const host = domain
        .replace(/^[a-z]+:\/\//i, '')
        .split('/')[0]
        .toLowerCase()
      return {
        site: row,
        domain,
        businessKey: siteBusinessKey(row),
        version: `v${siteVersionOf(state, row)}`,
        templates: templates
          .filter((item) => String(item['入口地址'] ?? '').toLowerCase().includes(host) && host !== '')
          .map((item) => String(item['模板编号'] ?? '')),
        jobs: jobs
          .filter((item) => String(item['目标站点'] ?? '') === String(row['站点编号'] ?? ''))
          .map((item) => String(item['作业编号'] ?? '')),
        perSecondCap: capOf(row),
      }
    })
}

export type RevisionInput = {
  siteId: number
  values?: Record<string, string>
  perSecondCap?: number | null
  basis?: ImpactBasis
}

/** 只计算不落库：站点登记页可以反复看两种口径的差异。 */
export function previewRevision(input: RevisionInput): ImpactPreview {
  const state = loadImpactState()
  const site = listRows('site').find((row) => Number(row.id) === Number(input.siteId))
  if (!site) {
    throw new Error(`没有找到编号为 ${input.siteId} 的采集站点`)
  }
  if (String(site.status) !== '已激活') {
    throw new Error(`采集站点「${String(site['站点编号'] ?? '')}」尚未激活，不参与影响传播`)
  }
  const current = siteValues(site)
  const values = { ...current, ...(input.values ?? {}) }
  const at = RULE_NOW()
  const revision = siteVersionOf(state, site)
  const listId = nextListId(state)
  const computed = computeImpact(
    {
      site,
      values,
      perSecondCap: input.perSecondCap ?? capOf(site),
      configuredPerSecond: capOf(site),
    },
    buildOptions(at),
    revision,
    listId,
    'SPIDER-PENDING',
  )
  const templateCodes = listRows('template').map((row) => String(row['模板编号'] ?? ''))
  const verification = verifyScope(computed.fieldUnion, {
    changes: computed.changes,
    fieldDiffs: computed.fieldDiffs,
    rule: computed.rule,
    at,
    site,
    templateCodes,
  })
  const checksum = computed.fieldUnion.checksum
  return {
    site,
    changes: computed.changes,
    fieldDiffs: computed.fieldDiffs,
    conflict: computed.conflict,
    conflictNote: computed.conflictNote,
    fieldUnion: computed.fieldUnion,
    wholeRecord: computed.wholeRecord,
    rule: computed.rule,
    requestMethod: computed.requestMethod,
    siteVersionBefore: computed.siteVersionBefore,
    siteVersionAfter: computed.siteVersionAfter,
    listId,
    spiderVersion: computed.fieldUnion.spiderVersion,
    checksum,
    verification,
  }
}

export type CommitRevisionInput = RevisionInput & {
  basis: ImpactBasis
  operator: string
  sessionId: string
}

/**
 * 站点修订落库：站点字段、复验清单、任务编排待处理清单一次写入。
 * 任何一步失败都抛回调用方，内存与 localStorage 里上一份可执行清单保持原样。
 */
export function commitRevision(input: CommitRevisionInput): ImpactCommitResult {
  const state = loadImpactState()
  const siteRows = listRows('site')
  const siteIndex = siteRows.findIndex((row) => Number(row.id) === Number(input.siteId))
  if (siteIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${input.siteId} 的采集站点`, list: null, preservedVersion: state.activeList?.version ?? null }
  }
  const site = siteRows[siteIndex]
  if (String(site.status) !== '已激活') {
    return {
      ok: false,
      message: `采集站点「${String(site['站点编号'] ?? '')}」尚未激活，不参与影响传播`,
      list: null,
      preservedVersion: state.activeList?.version ?? null,
    }
  }
  const values = { ...siteValues(site), ...(input.values ?? {}) }
  const changes = diffSite(site, values)
  const cap = input.perSecondCap === undefined ? capOf(site) : input.perSecondCap
  const capChanged = cap !== null && cap !== capOf(site)
  if (changes.length === 0 && !capChanged) {
    return { ok: false, message: '没有任何字段或每秒上限发生变化，不需要生成复验清单', list: null, preservedVersion: state.activeList?.version ?? null }
  }

  const at = RULE_NOW()
  const revision = siteVersionOf(state, site)
  const listId = nextListId(state)
  const computed = computeImpact(
    { site, values, perSecondCap: cap, configuredPerSecond: capOf(site) },
    buildOptions(at),
    revision,
    listId,
    'SPIDER-PENDING',
  )
  const scope = input.basis === 'wholeRecord' ? computed.wholeRecord : computed.fieldUnion
  const templateCodes = listRows('template').map((row) => String(row['模板编号'] ?? ''))
  // 复核依据固定为字段并集口径：即使落库选了整条记录，也用字段并集清单核对。
  const verification = verifyScope(computed.fieldUnion, {
    changes: computed.changes,
    fieldDiffs: computed.fieldDiffs,
    rule: computed.rule,
    at,
    site,
    templateCodes,
  })
  if (!verification.ok) {
    const failed = verification.checks.filter((check) => !check.ok).map((check) => check.label).join('、')
    return {
      ok: false,
      message: `复验核对未通过（${failed}），清单未落库，上一份可执行清单继续保留`,
      list: null,
      preservedVersion: state.activeList?.version ?? null,
    }
  }

  const version = revision + 1
  const list: ImpactList = {
    listId,
    version: state.sequence + 1,
    spiderVersion: scope.spiderVersion,
    siteId: Number(site.id),
    siteEntity: '采集站点',
    siteCode: String(values['站点编号'] ?? site['站点编号'] ?? ''),
    siteDomain: siteDomain({ ...site, ...values }),
    siteVersionBefore: `v${revision}`,
    siteVersionAfter: `v${version}`,
    basis: input.basis,
    basisLabel: scope.label,
    rule: computed.rule,
    changes: computed.changes,
    fieldDiffs: computed.fieldDiffs,
    requestMethod: computed.requestMethod,
    entries: scope.entries.map((entry) => ({ ...entry, verifyStatus: '待复验', verifiedAt: '' })),
    excluded: scope.excluded,
    alternatives: [computed.fieldUnion, computed.wholeRecord],
    createdAt: at,
    createdBy: input.operator,
    verification,
    checksum: scope.checksum,
    status: '可执行',
    preservedFrom: '',
  }

  const previous = state.activeList
  const history = previous
    ? [{ ...previous, status: '已替换' as const, preservedFrom: list.listId }, ...state.history].slice(0, 20)
    : state.history

  const pending: SpiderPendingList = {
    listId: list.listId,
    spiderVersion: list.spiderVersion,
    basis: list.basis,
    siteCode: list.siteCode,
    jobIds: list.entries.filter((entry) => entry.kind === 'job').map((entry) => entry.refCode),
    syncedAt: at,
    syncedBy: input.operator,
    completedJobIds: [],
    checksum: list.checksum,
  }

  const nextSite: EntryRow = {
    ...site,
    ...values,
    版本: `v${version}`,
  }

  const nextRateLimits = listRows('ratelimit').map((row) => {
    if (!capChanged || cap === null) return row
    if (String(row['目标站点'] ?? '') !== String(site['站点编号'] ?? '')) return row
    return { ...row, 每秒请求上限: String(cap) }
  })

  const drafts = { ...state.drafts }
  if (input.sessionId) {
    delete drafts[`${siteKey(site)}`]
  }

  const nextState: ImpactState = {
    ...state,
    activeList: list,
    history,
    sequence: state.sequence + 1,
    lastSavedAt: at,
    lastError: '',
    spiderSyncedAt: at,
    spiderSyncedVersion: list.spiderVersion,
    spiderPending: pending,
    siteRevisions: { ...state.siteRevisions, [siteKey(site)]: version },
    drafts,
  }

  const nextSiteRows = [...siteRows]
  nextSiteRows[siteIndex] = nextSite

  try {
    persistImpact(nextState, { site: nextSiteRows, ratelimit: capChanged ? nextRateLimits : undefined })
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存失败'
    return {
      ok: false,
      message: `保存失败：${message}。上一份可执行清单（${previous ? `${previous.listId} / v${previous.version}` : '无'}）继续保留，作业不会读到半份集合`,
      list: null,
      preservedVersion: previous?.version ?? null,
    }
  }

  return {
    ok: true,
    message: `已生成 ${list.listId}：${list.basisLabel}，${list.entries.length} 条待复验入口（模板 ${list.entries.filter((entry) => entry.kind === 'template').length}、作业 ${list.entries.filter((entry) => entry.kind === 'job').length}）；任务编排待处理清单 ${list.spiderVersion} 已同步刷新`,
    list,
    preservedVersion: previous?.version ?? null,
  }
}

/** 中断现场：只写草稿，不动站点记录，也不回退当前可执行清单。 */
export function checkpointRevision(input: {
  siteId: number
  values: Record<string, string>
  perSecondCap: string
  basis: ImpactBasis
  sessionId: string
}): { ok: boolean; message: string; draft: DraftRevision | null } {
  const state = loadImpactState()
  const site = listRows('site').find((row) => Number(row.id) === Number(input.siteId))
  if (!site) {
    return { ok: false, message: `没有找到编号为 ${input.siteId} 的采集站点`, draft: null }
  }
  if (String(site.status) !== '已激活') {
    return { ok: false, message: '只有已激活站点可以暂存修订现场', draft: null }
  }
  let preview: ImpactPreview
  try {
    preview = previewRevision({
      siteId: input.siteId,
      values: input.values,
      perSecondCap: input.perSecondCap.trim() === '' ? null : Number(input.perSecondCap),
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '草稿计算失败', draft: null }
  }
  const draft: DraftRevision = {
    siteId: Number(site.id),
    siteCode: String(site['站点编号'] ?? ''),
    sessionId: input.sessionId,
    values: input.values,
    perSecondCap: input.perSecondCap,
    basis: input.basis,
    updatedAt: RULE_NOW(),
    status: '编辑中',
    fieldUnionPreview: {
      entryCount: preview.fieldUnion.entryCount,
      entryIds: preview.fieldUnion.entryIds,
      capturedAt: RULE_NOW(),
    },
    // 当前业务证据继续保留：站点记录 + 已激活引用
    siteEvidence: { ...siteValues(site), 站点业务对象: siteBusinessKey(site) },
  }
  const nextState: ImpactState = {
    ...state,
    drafts: { ...state.drafts, [siteKey(site)]: draft },
    lastError: '',
  }
  try {
    persistImpact(nextState)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '草稿保存失败', draft: null }
  }
  return {
    ok: true,
    message: `修订现场已暂存（字段并集 ${draft.fieldUnionPreview.entryCount} 条入口）。当前可执行清单 ${state.activeList ? `${state.activeList.listId} / ${state.activeList.basisLabel}` : '暂无'} 保持不变`,
    draft,
  }
}

/** 恢复中断现场：先把字段并集范围记下来，可执行清单不跳回旧版本。 */
export function resumeRevisionDraft(siteId: number): {
  ok: boolean
  message: string
  draft: DraftRevision | null
  activeList: ImpactList | null
} {
  const state = loadImpactState()
  const site = listRows('site').find((row) => Number(row.id) === Number(siteId))
  if (!site) {
    return { ok: false, message: `没有找到编号为 ${siteId} 的采集站点`, draft: null, activeList: state.activeList }
  }
  const draft = state.drafts[siteKey(site)]
  if (!draft) {
    return { ok: false, message: '这个站点没有待恢复的修订现场', draft: null, activeList: state.activeList }
  }
  const preview = previewRevision({
    siteId,
    values: draft.values,
    perSecondCap: draft.perSecondCap.trim() === '' ? null : Number(draft.perSecondCap),
  })
  const restored: DraftRevision = {
    ...draft,
    status: '已中断恢复',
    updatedAt: RULE_NOW(),
    fieldUnionPreview: {
      entryCount: preview.fieldUnion.entryCount,
      entryIds: preview.fieldUnion.entryIds,
      capturedAt: RULE_NOW(),
    },
  }
  const nextState: ImpactState = {
    ...state,
    drafts: { ...state.drafts, [siteKey(site)]: restored },
  }
  try {
    persistImpact(nextState)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '恢复现场保存失败',
      draft,
      activeList: state.activeList,
    }
  }
  return {
    ok: true,
    message: `已恢复修订现场，字段并集口径先记为 ${restored.fieldUnionPreview.entryCount} 条入口；当前可执行清单${state.activeList ? `仍为 ${state.activeList.listId}` : '仍为空'}，没有跳回先前版本`,
    draft: restored,
    activeList: state.activeList,
  }
}

export function discardRevisionDraft(siteId: number): void {
  const state = loadImpactState()
  const site = listRows('site').find((row) => Number(row.id) === Number(siteId))
  if (!site) return
  const drafts = { ...state.drafts }
  delete drafts[siteKey(site)]
  persistImpact({ ...state, drafts })
}

/** 任务编排读取清单：只把清单里的作业标记为待复验，其余作业照常按原站点版本执行。 */
export function syncSpiderPendingList(operator: string): {
  ok: boolean
  message: string
  list: ImpactList | null
  pending: SpiderPendingList | null
} {
  const state = loadImpactState()
  const list = state.activeList
  if (!list) {
    return { ok: false, message: '当前没有可执行的受影响采集站点配置清单', list: null, pending: state.spiderPending }
  }
  const at = RULE_NOW()
  const pending: SpiderPendingList = {
    listId: list.listId,
    spiderVersion: list.spiderVersion,
    basis: list.basis,
    siteCode: list.siteCode,
    jobIds: list.entries.filter((entry) => entry.kind === 'job').map((entry) => entry.refCode),
    syncedAt: at,
    syncedBy: operator,
    completedJobIds: [],
    checksum: list.checksum,
  }
  try {
    persistImpact({
      ...state,
      spiderPending: pending,
      spiderSyncedAt: at,
      spiderSyncedVersion: list.spiderVersion,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '同步失败',
      list,
      pending: state.spiderPending,
    }
  }
  return {
    ok: true,
    message: `任务编排已读取 ${list.listId}：${pending.jobIds.length} 个作业标记待复验，其余作业继续按原站点版本执行`,
    list,
    pending,
  }
}

export function markJobVerified(jobCode: string, operator: string): { ok: boolean; message: string } {
  const state = loadImpactState()
  const list = state.activeList
  const pending = state.spiderPending
  if (!list || !pending) {
    return { ok: false, message: '当前没有任务编排待处理清单' }
  }
  if (!pending.jobIds.includes(jobCode)) {
    return { ok: false, message: `作业 ${jobCode} 不在待复验清单里，继续按原站点版本执行` }
  }
  if (pending.completedJobIds.includes(jobCode)) {
    return { ok: false, message: `作业 ${jobCode} 已经复验完成` }
  }
  const at = RULE_NOW()
  const entries = list.entries.map((entry) =>
    entry.kind === 'job' && entry.refCode === jobCode
      ? { ...entry, verifyStatus: '已复验' as const, verifiedAt: at }
      : entry,
  )
  const nextPending: SpiderPendingList = {
    ...pending,
    completedJobIds: [...pending.completedJobIds, jobCode],
    syncedBy: operator,
  }
  try {
    persistImpact({
      ...state,
      activeList: { ...list, entries },
      spiderPending: nextPending,
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '复验结果保存失败' }
  }
  return { ok: true, message: `作业 ${jobCode} 已标记复验完成` }
}

/** 按站点编号查复验范围：当前清单与历史清单都能回看。 */
export function lookupScopesBySiteCode(siteCode: string): {
  current: ImpactList | null
  history: ImpactList[]
} {
  const code = siteCode.trim()
  const state = loadImpactState()
  const match = (list: ImpactList | null) =>
    !!list && (list.siteCode === code || list.siteCode.includes(code))
  return {
    current: match(state.activeList) ? state.activeList : null,
    history: state.history.filter(match),
  }
}

function scopeRows(list: ImpactList): string[][] {
  const rows = list.entries.map((entry) => [
    list.listId,
    `v${list.version}`,
    list.spiderVersion,
    list.siteCode,
    list.siteDomain,
    entry.kind === 'template' ? '抽取模板' : '采集作业',
    entry.refCode,
    entry.changedFields.join('|'),
    entry.reasons.join('|'),
    entry.perSecondCap === null ? '' : String(entry.perSecondCap),
    entry.verifyStatus,
    JSON.stringify(entry.snapshot),
    list.basisLabel,
    list.checksum,
  ])
  for (const excluded of list.excluded) {
    rows.push([
      list.listId,
      `v${list.version}`,
      list.spiderVersion,
      list.siteCode,
      list.siteDomain,
      excluded.kind === 'template' ? '抽取模板' : '采集作业',
      excluded.refCode,
      '—',
      excluded.why,
      '',
      '未纳入（按原站点版本执行）',
      JSON.stringify(excluded.snapshot),
      list.basisLabel,
      list.checksum,
    ])
  }
  return rows
}

const IMPACT_HEADER = [
  '清单编号',
  '清单版本',
  '任务编排待处理清单版本',
  '站点登记',
  '采集站点',
  '站点编号',
  '入口类型',
  '入口编号',
  '变更字段',
  '变更原因',
  '每秒请求上限',
  '复验状态',
  '当前业务证据快照',
  '落库路线',
  '校验和',
]

/** 生成受影响采集站点配置清单数据（CSV，可直接交给复验）。 */
export function exportImpactList(list: ImpactList | null = loadImpactState().activeList): { filename: string; content: string } {
  if (!list) {
    return { filename: '受影响采集站点配置清单.csv', content: '﻿' + IMPACT_HEADER.join(',') }
  }
  const lines = [IMPACT_HEADER.join(',')]
  for (const row of scopeRows(list)) {
    lines.push(row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  }
  return {
    filename: `受影响采集站点配置清单-${list.siteCode}-${list.listId}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

/** 可验证的数据记录：清单 + 复验核对 + 两种口径对照 + 未重算入口。 */
export function exportImpactAudit(list: ImpactList | null = loadImpactState().activeList): { filename: string; content: string } {
  const state = loadImpactState()
  const payload = {
    生成时间: RULE_NOW(),
    当前清单: list,
    复验核对: list?.verification ?? null,
    未变化入口: list?.excluded ?? [],
    口径对照: list?.alternatives.map((scope) => ({
      落库路线: scope.label,
      清单条数: scope.entryCount,
      模板条数: scope.templateCount,
      作业条数: scope.jobCount,
      校验和: scope.checksum,
    })) ?? [],
    历史清单: state.history.map((item) => ({
      清单编号: item.listId,
      清单版本: item.version,
      落库路线: item.basisLabel,
      条数: item.entries.length,
      生成时间: item.createdAt,
      状态: item.status,
    })),
  }
  return {
    filename: `影响清单复核记录-${list?.listId ?? 'EMPTY'}.json`,
    content: `﻿${JSON.stringify(payload, null, 2)}`,
  }
}

/** 统一导出口，页面只调这一处。 */
export function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function scopeSummary(scope: ImpactScope): string {
  return `${scope.entryCount} 条（模板 ${scope.templateCount} / 作业 ${scope.jobCount}）`
}

export function changeSummary(changes: SiteChange[]): string {
  return changes.map((change) => `${change.field} ${change.before || '空'}→${change.after || '空'}`).join('；')
}

export function currentRequestMethod(siteId: number): { raw: string; processed: string } {
  const site = listRows('site').find((row) => Number(row.id) === Number(siteId))
  return processRequestMethod(String(site?.['请求方式'] ?? ''))
}

export { buildRuleStandard }
