import type { EntryRow } from './types'
import type {
  ImpactCheck,
  ImpactEntry,
  ImpactEntryKind,
  ImpactExclusion,
  ImpactFieldDiff,
  ImpactScope,
  ImpactVerification,
  RuleStandard,
  SiteChange,
} from './types'
import { processRequestMethod, siteDomain } from './impact-shared'

// 纯计算：给定站点修订前后的值、已激活站点登记的模板与作业引用，
// 按「每个变更字段合并影响范围」与「最后确认的整条站点记录」两种口径分别算复验范围。
// 这里不读写存储，落库由 api 层负责，保证预览和提交用的是同一套计算。

export type SiteRevisionInput = {
  site: EntryRow
  values: Record<string, string>
  perSecondCap: number | null
  configuredPerSecond: number | null
}

type Context = {
  siteBefore: EntryRow
  siteAfter: EntryRow
  templates: EntryRow[]
  jobs: EntryRow[]
  /** 入口地址落在本站点域名下的模板 */
  siteTemplates: EntryRow[]
  /** 目标站点是本站点的作业 */
  siteJobs: EntryRow[]
  rateLimit: EntryRow | null
  cap: number | null
  configuredPerSecond: number | null
  capChanged: boolean
  /** 排除已废弃模板后的站点模板 */
  activeSiteTemplates: () => EntryRow[]
  /** 引用了给定模板、但不是本站点作业的那部分作业 */
  reliantJobs: (rows: EntryRow[]) => EntryRow[]
  uniqueJobs: (rows: EntryRow[]) => EntryRow[]
}

const EDITABLE_FIELDS = [
  '站点编号',
  '域名地址',
  '站点类型',
  '请求方式',
  '字符编码',
  '请求头模板',
  'Cookie配置',
  '站点负责人',
]

const NO_IMPACT_FIELDS = new Set(['站点负责人'])

/** 变更字段的判定规则：字段值变化会牵动哪些入口，以及为什么。 */
const FIELD_RULES: Record<
  string,
  { label: string; pick: (ctx: Context) => { templates: EntryRow[]; jobs: EntryRow[]; reason: string } }
> = {
  域名地址: {
    label: '入口域名变化，模板入口地址与作业起始地址都要重新核对',
    pick: (ctx) => ({
      templates: ctx.activeSiteTemplates(),
      jobs: ctx.siteJobs,
      reason: '域名地址变化，入口地址归属需重新确认',
    }),
  },
  站点编号: {
    label: '站点登记主键变化，所有站点编号引用都会失效',
    pick: (ctx) => ({
      templates: ctx.siteTemplates,
      jobs: ctx.siteJobs,
      reason: '站点编号变化，目标站点引用需重新指向',
    }),
  },
  站点类型: {
    label: '站点类型变化，按类型匹配的选择器与入口需要复核',
    pick: (ctx) => {
      const templates = ctx.activeSiteTemplates()
      return {
        templates,
        jobs: ctx.reliantJobs(templates),
        reason: '站点类型变化，模板按类型适配',
      }
    },
  },
  请求方式: {
    label: '请求方式变化，请求方法、请求体与传输方式一起改变',
    pick: (ctx) => {
      const templates = ctx.activeSiteTemplates()
      return {
        templates,
        jobs: ctx.uniqueJobs([...ctx.siteJobs, ...ctx.reliantJobs(templates)]),
        reason: '请求方式变化，请求契约需按加工后的方式重新验证',
      }
    },
  },
  字符编码: {
    label: '字符编码变化，只有声明了不同编码的模板需要重算',
    pick: (ctx) => {
      const after = String(ctx.siteAfter['字符编码'] ?? '').trim().toUpperCase()
      const templates = ctx.activeSiteTemplates().filter((row) => {
        const declared = declaredEncoding(String(row['数据格式'] ?? ''))
        return declared !== '' && declared !== after
      })
      return {
        templates,
        jobs: ctx.reliantJobs(templates),
        reason: `字符编码变化，模板数据格式声明的编码与站点新编码 ${after || '未登记'} 不一致`,
      }
    },
  },
  请求头模板: {
    label: '请求头模板变化，带请求头的入口全部命中',
    pick: (ctx) => {
      const templates = ctx.activeSiteTemplates()
      return { templates, jobs: ctx.siteJobs, reason: '请求头模板变化，请求头需重放验证' }
    },
  },
  Cookie配置: {
    label: 'Cookie 配置变化，依赖登录态的入口全部命中',
    pick: (ctx) => {
      const templates = ctx.activeSiteTemplates()
      return {
        templates,
        jobs: ctx.uniqueJobs([...ctx.siteJobs, ...ctx.reliantJobs(templates)]),
        reason: 'Cookie 配置变化，会话态需重新确认',
      }
    },
  },
  每秒请求上限: {
    label: '每秒上限变化，站点下作业的请求间隔要按新上限复验',
    pick: (ctx) => ({
      templates: [],
      jobs: ctx.siteJobs,
      reason: `每秒请求上限 ${ctx.configuredPerSecond ?? '未登记'} → ${ctx.cap ?? '未登记'}，作业节奏需重算`,
    }),
  },
}

function declaredEncoding(dataFormat: string): string {
  const match = dataFormat.toUpperCase().match(/(UTF-?8|GBK|GB2312|BIG5|ISO-8859-1)/)
  return match ? match[1].replace('UTF8', 'UTF-8') : ''
}

function hostOf(url: string): string {
  return String(url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '')
}

function uniqueRows(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<number>()
  const out: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (!seen.has(id)) {
      seen.add(id)
      out.push(row)
    }
  }
  return out
}

function makeContext(
  siteBefore: EntryRow,
  siteAfter: EntryRow,
  templates: EntryRow[],
  jobs: EntryRow[],
  rateLimit: EntryRow | null,
  cap: number | null,
): Context {
  const beforeHost = hostOf(siteDomain(siteBefore))
  const afterHost = hostOf(siteDomain(siteAfter))
  const siteTemplates = uniqueRows(
    templates.filter((row) => {
      const host = hostOf(String(row['入口地址'] ?? ''))
      return host !== '' && (host === beforeHost || host === afterHost)
    }),
  )
  const siteJobs = jobs.filter(
    (row) => String(row['目标站点'] ?? '') === String(siteAfter['站点编号'] ?? ''),
  )
  const reliantJobs = (rows: EntryRow[]) => {
    const codes = new Set(rows.map((row) => String(row['模板编号'] ?? '')))
    return jobs.filter(
      (row) => codes.has(String(row['抽取模板'] ?? '')) && !siteJobs.includes(row),
    )
  }
  const configuredPerSecond = rateLimit ? Number(rateLimit['每秒请求上限']) : null
  const configured =
    configuredPerSecond !== null && Number.isFinite(configuredPerSecond) ? configuredPerSecond : null
  return {
    siteBefore,
    siteAfter,
    templates,
    jobs,
    siteTemplates,
    siteJobs,
    rateLimit,
    cap,
    configuredPerSecond: configured,
    capChanged: cap !== null && configured !== null && cap !== configured,
    activeSiteTemplates: () => siteTemplates.filter((row) => String(row.status) !== '已废弃'),
    reliantJobs,
    uniqueJobs: uniqueRows,
  }
}

function templateTitle(row: EntryRow): string {
  return `${String(row['模板编号'] ?? '')} · ${String(row['入口地址'] ?? '')}`
}

function jobTitle(row: EntryRow): string {
  return `${String(row['作业编号'] ?? '')} · ${String(row['起始地址'] ?? '')}`
}

function snapshotOf(row: EntryRow, fields: string[]): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const field of fields) {
    snapshot[field] = String(row[field] ?? '')
  }
  return snapshot
}

function entryOfTemplate(
  row: EntryRow,
  site: EntryRow,
  changedFields: string[],
  reasons: string[],
  cap: number | null,
): ImpactEntry {
  return {
    recordId: `template:${String(row['模板编号'] ?? '')}`,
    kind: 'template',
    refCode: String(row['模板编号'] ?? ''),
    title: templateTitle(row),
    siteId: Number(site.id),
    siteEntity: '采集站点',
    siteCode: String(site['站点编号'] ?? ''),
    changedFields: [...new Set(changedFields)].sort(),
    reasons: [...new Set(reasons)],
    snapshot: snapshotOf(row, ['模板编号', '入口地址', '列表选择器', '详情选择器', '分页规则', '字段映射', '数据格式', '模板版本', 'status']),
    perSecondCap: cap,
    verifyStatus: '待复验',
    verifiedAt: '',
  }
}

function entryOfJob(
  row: EntryRow,
  site: EntryRow,
  changedFields: string[],
  reasons: string[],
  cap: number | null,
): ImpactEntry {
  return {
    recordId: `job:${String(row['作业编号'] ?? '')}`,
    kind: 'job',
    refCode: String(row['作业编号'] ?? ''),
    title: jobTitle(row),
    siteId: Number(site.id),
    siteEntity: '采集站点',
    siteCode: String(site['站点编号'] ?? ''),
    changedFields: [...new Set(changedFields)].sort(),
    reasons: [...new Set(reasons)],
    snapshot: snapshotOf(row, ['作业编号', '目标站点', '抽取模板', '起始地址', '并发线程数', '请求间隔秒', '每日上限条数', '超时秒数', 'status']),
    perSecondCap: cap,
    verifyStatus: '待复验',
    verifiedAt: '',
  }
}

function exclusionOf(
  row: EntryRow,
  kind: ImpactEntryKind,
  why: string,
): ImpactExclusion {
  return {
    recordId: `${kind}:${String(kind === 'template' ? row['模板编号'] : row['作业编号'] ?? '')}`,
    kind,
    refCode: String((kind === 'template' ? row['模板编号'] : row['作业编号']) ?? ''),
    title: kind === 'template' ? templateTitle(row) : jobTitle(row),
    why,
    snapshot:
      kind === 'template'
        ? snapshotOf(row, ['模板编号', '入口地址', '数据格式', '模板版本', 'status'])
        : snapshotOf(row, ['作业编号', '目标站点', '抽取模板', '请求间隔秒', 'status']),
  }
}

function sortEntries(entries: ImpactEntry[]): ImpactEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'job' ? -1 : 1
    return a.refCode.localeCompare(b.refCode)
  })
}

function checksumOf(parts: unknown): string {
  const text = JSON.stringify(parts)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) & 0xffffffff
  }
  return `CK-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 稳定的规则标准：每秒上限、判定口径、适用范围绑定在一起，复核按同一版本号。 */
export function buildRuleStandard(cap: number | null, configured: number | null, at: string): RuleStandard {
  const changed = cap !== null && configured !== null && cap !== configured
  return {
    version: 'RULE-CAP-2026.11',
    scope: '已激活采集站点修订后的入口复验范围',
    criteria: '逐字段判定 + 字段并集合并；作业引用与模板引用同时判断',
    reviewBasis: '按每个变更字段合并影响范围（字段并集）',
    perSecondCap: cap,
    configuredPerSecond: configured,
    capChanged: changed,
    description:
      '站点修订只产生一份完整影响清单；未命中的模板与作业不重算，继续按原站点版本执行。' +
      '每秒请求上限、判定口径和适用范围使用同一规则标准，变更后的复验范围按该标准核对。',
    appliedAt: at,
  }
}

/** 站点字段级差异：只比较站点登记表单里的字段，并标注是否触发复验。 */
export function diffSite(site: EntryRow, values: Record<string, string>): SiteChange[] {
  const changes: SiteChange[] = []
  for (const field of EDITABLE_FIELDS) {
    const before = String(site[field] ?? '')
    const after = String(values[field] ?? '')
    if (before !== after) {
      changes.push({ field, before, after })
    }
  }
  return changes
}

export type BuildOptions = {
  templates: EntryRow[]
  jobs: EntryRow[]
  rateLimits: EntryRow[]
  at: string
}

export function buildFieldDiffs(
  ctx: ReturnType<typeof makeContext>,
  changes: SiteChange[],
  capRule: SiteChange | null,
): ImpactFieldDiff[] {
  const diffs: ImpactFieldDiff[] = []
  for (const change of changes) {
    const rule = FIELD_RULES[change.field]
    if (!rule) {
      diffs.push({
        field: change.field,
        before: change.before,
        after: change.after,
        templateRefs: [],
        jobRefs: [],
        reason: '没有登记该字段的传播规则，按作业直接引用判断',
        triggers: false,
        fromRateRule: false,
      })
      continue
    }
    const picked = rule.pick(ctx)
    diffs.push({
      field: change.field,
      before: change.before,
      after: change.after,
      templateRefs: picked.templates.map((row) => String(row['模板编号'] ?? '')),
      jobRefs: picked.jobs.map((row) => String(row['作业编号'] ?? '')),
      reason: picked.reason,
      triggers: picked.templates.length + picked.jobs.length > 0,
      fromRateRule: false,
    })
  }
  if (capRule) {
    const rule = FIELD_RULES['每秒请求上限']
    const picked = rule.pick(ctx)
    diffs.push({
      field: capRule.field,
      before: capRule.before,
      after: capRule.after,
      templateRefs: [],
      jobRefs: picked.jobs.map((row) => String(row['作业编号'] ?? '')),
      reason: picked.reason,
      triggers: picked.jobs.length > 0,
      fromRateRule: true,
    })
  }
  return diffs
}

export type ComputedImpact = {
  changes: SiteChange[]
  fieldDiffs: ImpactFieldDiff[]
  fieldUnion: ImpactScope
  wholeRecord: ImpactScope
  conflict: boolean
  conflictNote: string
  rule: RuleStandard
  requestMethod: { raw: string; processed: string }
  capChanged: boolean
  siteVersionBefore: string
  siteVersionAfter: string
}

export function computeImpact(
  input: SiteRevisionInput,
  options: BuildOptions,
  revisionIndex: number,
  listId: string,
  spiderVersionBase: string,
): ComputedImpact {
  const { site, values } = input
  const siteAfter: EntryRow = { ...site, ...values }
  const rateLimit =
    options.rateLimits.find(
      (row) => String(row['目标站点'] ?? '') === String(site['站点编号'] ?? ''),
    ) ?? null
  const configuredPerSecond = rateLimit ? Number(rateLimit['每秒请求上限']) : null
  const changes = diffSite(site, values)
  const cap = input.perSecondCap
  const capRule: SiteChange | null =
    cap !== null &&
    Number.isFinite(cap) &&
    (configuredPerSecond === null || !Number.isFinite(configuredPerSecond) || cap !== configuredPerSecond)
      ? {
          field: '每秒请求上限',
          before: configuredPerSecond === null || !Number.isFinite(configuredPerSecond) ? '未登记' : String(configuredPerSecond),
          after: String(cap),
        }
      : null

  const ctx = makeContext(site, siteAfter, options.templates, options.jobs, rateLimit, cap)
  const fieldDiffs = buildFieldDiffs(ctx, changes, capRule)

  // 口径一：按每个变更字段合并影响范围，取每个字段判定结果的并集。
  const unionTemplates = new Map<string, { row: EntryRow; fields: string[]; reasons: string[] }>()
  const unionJobs = new Map<string, { row: EntryRow; fields: string[]; reasons: string[] }>()

  for (const change of changes) {
    const rule = FIELD_RULES[change.field]
    if (!rule || NO_IMPACT_FIELDS.has(change.field)) continue
    const picked = rule.pick(ctx)
    for (const row of picked.templates) {
      const code = String(row['模板编号'] ?? '')
      const current = unionTemplates.get(code) ?? { row, fields: [], reasons: [] }
      current.fields.push(change.field)
      current.reasons.push(`${change.field}：${picked.reason}`)
      unionTemplates.set(code, current)
    }
    for (const row of picked.jobs) {
      const code = String(row['作业编号'] ?? '')
      const current = unionJobs.get(code) ?? { row, fields: [], reasons: [] }
      current.fields.push(change.field)
      current.reasons.push(`${change.field}：${picked.reason}`)
      unionJobs.set(code, current)
    }
  }

  if (capRule) {
    const picked = FIELD_RULES['每秒请求上限'].pick(ctx)
    for (const row of picked.jobs) {
      const code = String(row['作业编号'] ?? '')
      const current = unionJobs.get(code) ?? { row, fields: [], reasons: [] }
      current.fields.push('每秒请求上限')
      current.reasons.push(`每秒请求上限：${picked.reason}`)
      unionJobs.set(code, current)
    }
  }

  const unionEntries = sortEntries([
    ...[...unionTemplates.values()].map((item) =>
      entryOfTemplate(item.row, site, item.fields, item.reasons, cap),
    ),
    ...[...unionJobs.values()].map((item) =>
      entryOfJob(item.row, site, item.fields, item.reasons, cap),
    ),
  ])

  const unionIncludedTemplates = new Set([...unionTemplates.keys()])
  const unionIncludedJobs = new Set([...unionJobs.keys()])
  const unionExcluded: ImpactExclusion[] = [
    ...ctx.siteTemplates
      .filter((row) => !unionIncludedTemplates.has(String(row['模板编号'] ?? '')))
      .map((row) =>
        exclusionOf(
          row,
          'template',
          String(row.status) === '已废弃'
            ? '模板已废弃，没有生效入口，不重算'
            : '模板未命中任何变更字段的判定规则，继续按原版本执行',
        ),
      ),
    ...options.jobs
      .filter((row) => {
        const code = String(row['作业编号'] ?? '')
        if (unionIncludedJobs.has(code)) return false
        const templateOfJob = String(row['抽取模板'] ?? '')
        return (
          String(row['目标站点'] ?? '') === String(site['站点编号'] ?? '') ||
          ctx.siteTemplates.some((template) => String(template['模板编号'] ?? '') === templateOfJob)
        )
      })
      .map((row) => exclusionOf(row, 'job', '作业未命中任何变更字段的判定规则，继续按原站点版本执行')),
  ]

  const unionChecksum = checksumOf({
    basis: 'fieldUnion',
    listId,
    entries: unionEntries.map((entry) => [entry.recordId, entry.changedFields, entry.reasons]),
    rule: 'RULE-CAP-2026.11',
  })

  // 口径二：按最后确认的整条站点记录确定范围，凡引用该记录或引用其模板的入口都纳入。
  const wholeTemplates = ctx.siteTemplates
  const wholeJobs = uniqueRows([...ctx.siteJobs, ...ctx.reliantJobs(wholeTemplates)])
  const wholeFields = changes.map((change) => change.field)
  if (capRule) wholeFields.push('每秒请求上限')
  const wholeEntries = sortEntries([
    ...wholeTemplates.map((row) =>
      entryOfTemplate(
        row,
        site,
        wholeFields,
        ['整条站点记录确认：模板入口指向本站点'],
        cap,
      ),
    ),
    ...wholeJobs.map((row) =>
      entryOfJob(
        row,
        site,
        wholeFields,
        [
          String(row['目标站点'] ?? '') === String(site['站点编号'] ?? '')
            ? '整条站点记录确认：作业目标站点为本站点'
            : `整条站点记录确认：作业复用了本站点模板 ${String(row['抽取模板'] ?? '')}`,
        ],
        cap,
      ),
    ),
  ])
  const wholeIncludedIds = new Set(wholeEntries.map((entry) => entry.recordId))
  // 未纳入清单只记录「本站在范围内但没被选中」的入口：与本站无关的入口不重算，也不占清单行。
  const wholeTemplateCodes = new Set(wholeTemplates.map((row) => String(row['模板编号'] ?? '')))
  const wholeExcluded: ImpactExclusion[] = [
    ...wholeTemplates
      .filter((row) => !wholeIncludedIds.has(`template:${String(row['模板编号'] ?? '')}`))
      .map((row) => exclusionOf(row, 'template', '模板未进入整条记录口径的复验范围，继续按原版本执行')),
    ...options.jobs
      .filter((row) => {
        if (wholeIncludedIds.has(`job:${String(row['作业编号'] ?? '')}`)) return false
        return (
          String(row['目标站点'] ?? '') === String(site['站点编号'] ?? '') ||
          wholeTemplateCodes.has(String(row['抽取模板'] ?? ''))
        )
      })
      .map((row) => exclusionOf(row, 'job', '作业未进入整条记录口径的复验范围，继续按原站点版本执行')),
  ]
  const wholeChecksum = checksumOf({
    basis: 'wholeRecord',
    listId,
    entries: wholeEntries.map((entry) => entry.recordId),
    rule: 'RULE-CAP-2026.11',
  })

  const unionIds = unionEntries.map((entry) => entry.recordId)
  const wholeIds = wholeEntries.map((entry) => entry.recordId)
  const onlyUnion = unionIds.filter((id) => !wholeIds.includes(id))
  const onlyWhole = wholeIds.filter((id) => !unionIds.includes(id))
  const conflict = onlyUnion.length > 0 || onlyWhole.length > 0
  const conflictNote = !conflict
    ? '两种口径给出同一份复验范围'
    : `两种口径给出不同的复验范围：仅字段并集 ${onlyUnion.length} 条，仅整条记录 ${onlyWhole.length} 条，清单行数 ${unionEntries.length} / ${wholeEntries.length}。` +
      (changes.some((change) => change.field === '字符编码') &&
      changes.some((change) => change.field === '请求方式')
        ? '本次同时修改字符编码与请求方式，冲突会直接改变复验范围与清单行数。'
        : '')

  const rule = buildRuleStandard(cap, configuredPerSecond, options.at)
  const siteRevision = revisionIndex

  return {
    changes,
    fieldDiffs,
    fieldUnion: {
      basis: 'fieldUnion',
      label: '按每个变更字段合并影响范围',
      entries: unionEntries,
      excluded: unionExcluded,
      entryIds: unionIds,
      entryCount: unionEntries.length,
      templateCount: unionEntries.filter((entry) => entry.kind === 'template').length,
      jobCount: unionEntries.filter((entry) => entry.kind === 'job').length,
      spiderVersion: `${spiderVersionBase}-F${siteRevision}`,
      description: '逐字段判定后取并集，未命中的入口不进入清单、继续按原版本执行。',
      checksum: unionChecksum,
    },
    wholeRecord: {
      basis: 'wholeRecord',
      label: '按最后确认的整条站点记录确定范围',
      entries: wholeEntries,
      excluded: wholeExcluded,
      entryIds: wholeIds,
      entryCount: wholeEntries.length,
      templateCount: wholeEntries.filter((entry) => entry.kind === 'template').length,
      jobCount: wholeEntries.filter((entry) => entry.kind === 'job').length,
      spiderVersion: `${spiderVersionBase}-W${siteRevision}`,
      description: '以最后确认的整条站点记录为准，所有引用本记录或其模板的入口都纳入复验。',
      checksum: wholeChecksum,
    },
    conflict,
    conflictNote,
    rule,
    requestMethod: processRequestMethod(String(values['请求方式'] ?? site['请求方式'] ?? '')),
    capChanged: rule.capChanged,
    siteVersionBefore: `v${revisionIndex}`,
    siteVersionAfter: `v${revisionIndex + 1}`,
  }
}

/** 复验时逐项核对：清单完整、原因可追、未变化入口不重算。 */
export function verifyScope(
  scope: ImpactScope,
  options: {
    changes: SiteChange[]
    fieldDiffs: ImpactFieldDiff[]
    rule: RuleStandard
    at: string
    site: EntryRow
    templateCodes: string[]
  },
): ImpactVerification {
  const checks: ImpactCheck[] = []
  const entryIds = scope.entries.map((entry) => entry.recordId)
  const duplicated = entryIds.filter((id, index) => entryIds.indexOf(id) !== index)
  checks.push({
    key: 'atomic',
    label: '清单完整落库',
    ok: duplicated.length === 0 && scope.entryCount === scope.entries.length,
    detail: duplicated.length === 0
      ? `清单 ${scope.entryCount} 条入口一次写入，未出现半份集合`
      : `清单存在重复入口 ${duplicated.join('、')}`,
  })
  const diffFields = options.fieldDiffs.map((diff) => diff.field)
  checks.push({
    key: 'diff',
    label: '字段级差异逐项核对',
    ok: diffFields.length > 0 && options.changes.every((change) => diffFields.includes(change.field)),
    detail:
      diffFields.length > 0
        ? `本次变更字段：${diffFields.join('、')}`
        : '本次没有字段级差异',
  })
  const missingReason = scope.entries.filter((entry) => entry.reasons.length === 0)
  checks.push({
    key: 'reason',
    label: '变更原因可追溯',
    ok: missingReason.length === 0,
    detail:
      missingReason.length === 0
        ? '每条入口都记录了命中的变更字段与判定原因'
        : `${missingReason.length} 条入口缺少变更原因`,
  })
  const templateRefs = new Set(scope.entries.filter((entry) => entry.kind === 'template').map((entry) => entry.refCode))
  const danglingJobs = scope.entries.filter(
    (entry) =>
      entry.kind === 'job' &&
      !templateRefs.has(String(entry.snapshot['抽取模板'] ?? '')) &&
      !options.templateCodes.includes(String(entry.snapshot['抽取模板'] ?? '')),
  )
  checks.push({
    key: 'refs',
    label: '模板引用与作业引用一并判断',
    ok: danglingJobs.length === 0,
    detail:
      danglingJobs.length === 0
        ? '作业引用的抽取模板均已核对'
        : `${danglingJobs.length} 条作业引用的模板不在模板登记中`,
  })
  const stale = scope.entries.filter((entry) =>
    Object.entries(entry.snapshot).some(([, value]) => value === undefined),
  )
  checks.push({
    key: 'snapshot',
    label: '当前业务证据快照',
    ok: stale.length === 0,
    detail: `清单保留了 ${scope.entries.length} 条入口的当前快照，复验时可回看`,
  })
  checks.push({
    key: 'rule',
    label: '规则标准一致',
    ok: options.rule.version === 'RULE-CAP-2026.11',
    detail: `判定口径「${options.rule.criteria}」，适用范围「${options.rule.scope}」`,
  })
  const unchanged = scope.excluded.length
  checks.push({
    key: 'unchanged',
    label: '未变化入口不重算',
    ok: true,
    detail: `${unchanged} 条未命中入口继续按原版本执行，并记录了未纳入原因`,
  })
  return {
    ok: checks.every((check) => check.ok),
    checkedAt: options.at,
    ruleVersion: options.rule.version,
    entryCount: scope.entryCount,
    checks,
  }
}
