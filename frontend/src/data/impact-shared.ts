import type { EntryRow } from './types'

/** 站点登记主键：按站点登记这一条记录确定范围时用的稳定标识。 */
export function siteKey(row: EntryRow): string {
  return `site:${Number(row.id)}`
}

/** 业务对象由站点登记、采集站点实体与站点编号共同描述。 */
export function siteBusinessKey(row: EntryRow): string {
  return `${siteKey(row)}|采集站点|${String(row['站点编号'] ?? '')}`
}

/** 采集站点显示名：优先域名地址，没有就用站点编号。 */
export function siteDomain(row: EntryRow): string {
  const domain = String(row['域名地址'] ?? '').trim()
  return domain || String(row['站点编号'] ?? '')
}

/**
 * 请求方式加工：把登记值规范成「方法 + 传输」和「请求体形态」两段，
 * 落到影响清单数据里，供任务编排直接消费。
 */
export function processRequestMethod(raw: string): { raw: string; processed: string } {
  const value = String(raw ?? '').trim()
  const upper = value.toUpperCase()
  if (!upper) {
    return { raw: value, processed: '未登记' }
  }
  const hasForm = upper.includes('FORM') || upper.includes('表单')
  const hasJson = upper.includes('JSON')
  const base = upper.includes('POST')
    ? 'POST'
    : upper.includes('PUT')
      ? 'PUT'
      : upper.includes('HEAD')
        ? 'HEAD'
        : 'GET'
  const wired = upper.includes('HEADLESS') || upper.includes('无头')
  const method = base === 'GET' ? `GET/${wired ? '无头浏览器' : '静态请求'}` : `${base}/${hasJson ? 'JSON 请求体' : hasForm ? '表单请求体' : '裸请求体'}`
  return { raw: value, processed: method }
}

/** 每站点已登记、正在生效的每秒请求上限。 */
export const RATE_LIMIT_FIELD = '每秒请求上限'

/** 站点字段里会牵动采集作业的字段，采集站点侧另有入口/运行时字段。 */
export const JOB_SENSITIVE_FIELDS = ['请求方式', '字符编码', '请求头模板', 'Cookie配置']

/** 全量变更字段并集，用于整条记录口径的计算起点。 */
export function allSiteFields(row: EntryRow): string[] {
  return Object.keys(row).filter(
    (field) => !['id', 'status', 'pending', 'abnormal', '版本'].includes(field),
  )
}
