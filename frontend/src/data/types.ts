/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 站点修订影响传播的持久化结构与规则口径。 */

/** 落库路线：按每个变更字段合并影响范围 / 按最后确认的整条站点记录确定范围。 */
export type ImpactBasis = 'fieldUnion' | 'wholeRecord'

export type ImpactEntryKind = 'template' | 'job'

export type SiteChange = {
  field: string
  before: string
  after: string
}

/** 单条受影响入口；模板与作业共用一套结构，便于任务编排直接消费。 */
export type ImpactEntry = {
  recordId: string
  kind: ImpactEntryKind
  refCode: string
  title: string
  /** 站点登记主键 */
  siteId: number
  /** 采集站点业务实体名 */
  siteEntity: string
  siteCode: string
  /** 合并后的变更字段（字段并集） */
  changedFields: string[]
  reasons: string[]
  /** 当前业务证据快照，复验时回看 */
  snapshot: Record<string, string>
  perSecondCap: number | null
  verifyStatus: '待复验' | '已复验'
  verifiedAt: string
}

/** 未进入清单、继续按原版本执行的入口。 */
export type ImpactExclusion = {
  recordId: string
  kind: ImpactEntryKind
  refCode: string
  title: string
  why: string
  snapshot: Record<string, string>
}

export type ImpactScope = {
  basis: ImpactBasis
  label: string
  entries: ImpactEntry[]
  excluded: ImpactExclusion[]
  entryIds: string[]
  entryCount: number
  templateCount: number
  jobCount: number
  /** 该路线落库后任务编排的待处理清单版本 */
  spiderVersion: string
  description: string
  checksum: string
}

/** 单个变更字段触发的复验范围，供核对时逐字段查看。 */
export type ImpactFieldDiff = {
  field: string
  before: string
  after: string
  templateRefs: string[]
  jobRefs: string[]
  reason: string
  triggers: boolean
  /** 该字段来自每秒上限规则而不是站点登记字段 */
  fromRateRule: boolean
}

export type RuleStandard = {
  version: string
  /** 适用范围 */
  scope: string
  /** 判定口径 */
  criteria: string
  /** 复核依据，固定为字段并集口径 */
  reviewBasis: string
  /** 本次修订使用的每秒请求上限 */
  perSecondCap: number | null
  /** 站点当前限速配置里的上限 */
  configuredPerSecond: number | null
  capChanged: boolean
  /** 规则标准说明 */
  description: string
  appliedAt: string
}

export type ImpactCheck = {
  key: string
  label: string
  ok: boolean
  detail: string
}

export type ImpactVerification = {
  ok: boolean
  checkedAt: string
  ruleVersion: string
  entryCount: number
  checks: ImpactCheck[]
}

export type ImpactList = {
  listId: string
  /** 站点修订版本号 */
  version: number
  /** 任务编排待处理清单版本，随落库路线确定 */
  spiderVersion: string
  siteId: number
  siteEntity: string
  siteCode: string
  siteDomain: string
  /** 站点修订前版本 -> 修订后版本 */
  siteVersionBefore: string
  siteVersionAfter: string
  basis: ImpactBasis
  basisLabel: string
  rule: RuleStandard
  changes: SiteChange[]
  fieldDiffs: ImpactFieldDiff[]
  /** 请求方式加工后的数据 */
  requestMethod: { raw: string; processed: string }
  entries: ImpactEntry[]
  excluded: ImpactExclusion[]
  alternatives: ImpactScope[]
  createdAt: string
  createdBy: string
  verification: ImpactVerification
  checksum: string
  status: '可执行' | '已替换'
  preservedFrom: string
}

export type DraftRevision = {
  siteId: number
  siteCode: string
  sessionId: string
  values: Record<string, string>
  perSecondCap: string
  basis: ImpactBasis
  updatedAt: string
  status: '编辑中' | '已中断恢复'
  /** 中断时先记录下来的字段并集快照 */
  fieldUnionPreview: {
    entryCount: number
    entryIds: string[]
    capturedAt: string
  }
  /** 当前业务证据继续保留 */
  siteEvidence: Record<string, string>
}

export type SpiderPendingList = {
  listId: string
  spiderVersion: string
  basis: ImpactBasis
  siteCode: string
  jobIds: string[]
  syncedAt: string
  syncedBy: string
  completedJobIds: string[]
  /** 同步时清单的校验和，用于发现清单已被替换 */
  checksum: string
}

export type ImpactState = {
  activeList: ImpactList | null
  history: ImpactList[]
  sequence: number
  lastSavedAt: string
  lastError: string
  /** 任务编排最后一次读取清单的时间 */
  spiderSyncedAt: string
  spiderSyncedVersion: string
  /** 任务编排按这份清单标记的待复验入口 */
  spiderPending: SpiderPendingList | null
  /** 每个站点已成功落库的修订次数，用于 vN 展示 */
  siteRevisions: Record<string, number>
  /** 修订中断后保留的编辑现场，按站点编号存 */
  drafts: Record<string, DraftRevision>
}

export type ImpactPreview = {
  site: EntryRow
  changes: SiteChange[]
  fieldDiffs: ImpactFieldDiff[]
  conflict: boolean
  conflictNote: string
  fieldUnion: ImpactScope
  wholeRecord: ImpactScope
  rule: RuleStandard
  requestMethod: { raw: string; processed: string }
  siteVersionBefore: string
  siteVersionAfter: string
  listId: string
  spiderVersion: string
  checksum: string
  verification: ImpactVerification
}

export type SpiderSyncResult = {
  ok: boolean
  message: string
  list: ImpactList | null
  syncedAt: string
  syncedVersion: string
  pendingJobCount: number
}

export type ImpactCommitResult = {
  ok: boolean
  message: string
  list: ImpactList | null
  preservedVersion: number | null
}
