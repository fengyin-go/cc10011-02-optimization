/**
 * 影响传播逻辑的可执行核对：在 Node 里用内存版 localStorage 跑一遍站点修订全流程。
 * 运行：npx esbuild tests/impact-check.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/impact-check.mjs && node /tmp/impact-check.mjs
 */

type Store = Map<string, string>

function installWindow(): void {
  const store: Store = new Map()
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key) : null),
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    },
  }
  ;(globalThis as unknown as { __store: Store }).__store = store
}

function text(value: unknown): string {
  return JSON.stringify(value)
}

async function main() {
  installWindow()
  const service = await import('@/api/impact-service')
  const engine = await import('@/data/impact-engine')
  const store = await import('@/data/local-store')

  let failures = 0
  function check(name: string, ok: boolean, detail = '') {
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  // 1. 站点 SITE-0002：同时改字符编码与请求方式，两种口径的清单行数应不同。
  const preview = service.previewRevision({
    siteId: 2,
    values: { 请求方式: 'GET/静态请求', 字符编码: 'UTF-8' },
    perSecondCap: 1,
  })
  check('字段级差异只含变更字段', text(preview.changes.map((c) => c.field)) === text(['请求方式', '字符编码']), text(preview.changes.map((c) => c.field)))
  check(
    '整条记录口径会比字段并集多纳入入口',
    preview.wholeRecord.entryCount > preview.fieldUnion.entryCount,
    `字段并集 ${preview.fieldUnion.entryCount} / 整条记录 ${preview.wholeRecord.entryCount}`,
  )
  check('冲突提示包含行数对比', preview.conflict && preview.conflictNote.includes('清单行数'), preview.conflictNote)
  check(
    '字符编码只命中编码不一致的模板',
    text(preview.fieldDiffs.find((d) => d.field === '字符编码')!.templateRefs) === text(['TEMP-0003']),
    text(preview.fieldDiffs.map((d) => [d.field, d.templateRefs])),
  )
  check('请求方式加工结果可回看', preview.requestMethod.processed === 'GET/静态请求', text(preview.requestMethod))

  // 2. 字段并集落库后：清单、站点字段、任务编排待处理清单一起生效。
  const commit = service.commitRevision({
    siteId: 2,
    values: { 请求方式: 'GET/静态请求', 字符编码: 'UTF-8' },
    perSecondCap: 1,
    basis: 'fieldUnion',
    operator: '值班管理员',
    sessionId: 'S-1',
  })
  check('字段并集落库成功', commit.ok, commit.message)
  const stateA = service.loadImpactState()
  check('清单版本写入且替代上一份', stateA.activeList?.basis === 'fieldUnion' && stateA.activeList.version === 1)
  check('任务编排待处理清单与清单同步', stateA.spiderPending?.spiderVersion === stateA.activeList?.spiderVersion)
  check('站点字段已更新', String(store.listRows('site').find((r) => Number(r.id) === 2)!['字符编码']) === 'UTF-8')
  check('校验和稳定可复算', engine.computeImpact(
    {
      site: { ...store.listRows('site').find((r) => Number(r.id) === 2)!, 字符编码: 'GBK' },
      values: { 请求方式: 'POST/JSON', 字符编码: 'GBK' },
      perSecondCap: 1,
      configuredPerSecond: 1,
    },
    { templates: store.listRows('template'), jobs: store.listRows('spider'), rateLimits: store.listRows('ratelimit'), at: 'T' },
    0,
    'X',
    'Y',
  ).fieldUnion.entries.length > 0, '复算不依赖写入')
  check('已废弃模板明确不重算', (stateA.activeList?.excluded.length ?? 0) > 0, `${stateA.activeList?.excluded.length} 条`)
  check(
    '本站未变化入口记入未纳入清单且给出来源',
    stateA.activeList!.excluded.every((entry) => entry.why.length > 0) &&
      stateA.activeList!.excluded.some((entry) => entry.refCode === 'TEMP-0007' && entry.why.includes('已废弃')),
    text(stateA.activeList!.excluded.map((entry) => [entry.refCode, entry.why])),
  )
  check(
    '与本站无关的入口既不在清单也不占未纳入行',
    ['TEMP-0001', 'TEMP-0002', 'SPID-0001', 'SPID-0002', 'SPID-0006'].every(
      (code) =>
        !stateA.activeList!.entries.some((entry) => entry.refCode === code) &&
        !stateA.activeList!.excluded.some((entry) => entry.refCode === code),
    ),
    text(stateA.activeList!.excluded.map((entry) => entry.refCode)),
  )

  // 3. 保存失败：上一份清单仍可执行，任务编排读到的还是旧版本。
  const beforeFailure = service.loadImpactState().activeList
  service.setSimulatedWriteFailure('演练：本地存储写入失败')
  const failed = service.commitRevision({
    siteId: 2,
    values: { 请求方式: 'POST/JSON', 字符编码: 'GBK', 请求头模板: '桌面端 UA' },
    perSecondCap: 2,
    basis: 'wholeRecord',
    operator: '值班管理员',
    sessionId: 'S-2',
  })
  check('保存失败时返回失败并保留上一份版本', !failed.ok && failed.preservedVersion === beforeFailure?.version, failed.message)
  const afterFailure = service.loadImpactState()
  check('上一份清单仍在原位', afterFailure.activeList?.listId === beforeFailure?.listId)
  check('任务编排版本没有跳到半份集合', afterFailure.spiderPending?.spiderVersion === beforeFailure?.spiderVersion)
  check('站点字段未被半写', String(store.listRows('site').find((r) => Number(r.id) === 2)!['字符编码']) === 'UTF-8')
  check('失败原因记录可见', afterFailure.lastError.includes('写入失败'), afterFailure.lastError)
  service.setSimulatedWriteFailure('')

  // 3b. 正常再修订一次，上一份清单转入历史，可回看。
  const second = service.commitRevision({
    siteId: 2,
    values: { 请求方式: 'POST/JSON', 字符编码: 'GBK', 请求头模板: '桌面端 UA' },
    perSecondCap: 2,
    basis: 'wholeRecord',
    operator: '值班管理员',
    sessionId: 'S-2',
  })
  check('第二次修订按整条记录落库', second.ok && second.list?.basis === 'wholeRecord', second.message)
  check('上一份清单转入历史且标记已替换', service.loadImpactState().history[0]?.listId === beforeFailure?.listId)
  check('站点版本按成功修订递增', service.loadImpactState().siteRevisions['site:2'] === 3, String(service.loadImpactState().siteRevisions['site:2']))

  // 4. 中断恢复：草稿只记字段并集快照，可执行清单不跳回先前版本。
  const checkpoint = service.checkpointRevision({
    siteId: 3,
    values: { 请求方式: 'POST/JSON', 字符编码: 'GBK', 域名地址: 'https://blog2.example.com' },
    perSecondCap: '3',
    basis: 'fieldUnion',
    sessionId: 'S-3',
  })
  check('中断现场暂存成功', checkpoint.ok, checkpoint.message)
  const resumed = service.resumeRevisionDraft(3)
  check('恢复后先记录字段并集范围', resumed.ok && (resumed.draft?.fieldUnionPreview.entryCount ?? 0) > 0, resumed.message)
  check('恢复后当前清单不跳回先前版本', resumed.activeList?.listId === second.list?.listId)
  check('当前业务证据保留', !!resumed.draft?.siteEvidence['站点业务对象'])

  // 5. 复验流程：任务编排只标记清单内入口，其余继续原版本。
  const sync = service.syncSpiderPendingList('值班管理员')
  check('任务编排读取清单', sync.ok && (sync.pending?.jobIds.length ?? 0) > 0, sync.message)
  const jobCode = sync.pending!.jobIds[0]
  const verify = service.markJobVerified(jobCode, '值班管理员')
  check('标记复验完成', verify.ok, verify.message)
  const afterVerify = service.loadImpactState()
  check('复验状态写回清单', afterVerify.activeList?.entries.some((e) => e.refCode === jobCode && e.verifyStatus === '已复验'))
  const notListed = store.listRows('spider').find((r) => !sync.pending!.jobIds.includes(String(r['作业编号'])))
  if (notListed) {
    const rejected = service.markJobVerified(String(notListed['作业编号']), '值班管理员')
    check('清单外作业不能被标记复验', !rejected.ok, rejected.message)
  }

  // 6. 按站点编号查复验范围。
  const lookup = service.lookupScopesBySiteCode('SITE-0002')
  check('按站点编号能查到当前清单', lookup.current?.listId === second.list?.listId)
  check('按站点编号能查到历史清单', lookup.history.length >= 1, `${lookup.history.length} 条历史`)

  // 7. 导出数据：清单数据与复核记录都能生成。
  const exportFile = service.exportImpactList()
  check('清单数据含快照与版本列', exportFile.content.includes('任务编排待处理清单版本') && exportFile.content.includes('当前业务证据快照'))
  const auditFile = service.exportImpactAudit()
  check('复核记录包含口径对照', auditFile.content.includes('口径对照') && auditFile.content.includes('未变化入口'))

  // 7b. 只调每秒上限：不产生站点字段差异，但仍要按规则标准生成清单。
  const capOnly = service.commitRevision({
    siteId: 2,
    values: {},
    perSecondCap: 5,
    basis: 'fieldUnion',
    operator: '值班管理员',
    sessionId: 'S-4',
  })
  check('仅每秒上限变化也能生成清单', capOnly.ok, capOnly.message)
  check('仅上限变化的清单记录规则版本与上限', capOnly.list?.rule.perSecondCap === 5 && capOnly.list?.rule.capChanged === true)
  check('仅上限变化时字段差异来自限速规则', capOnly.list?.fieldDiffs.every((diff) => diff.fromRateRule) === true)
  check('限速配置同步新上限', String(store.listRows('ratelimit').find((r) => String(r['目标站点']) === 'SITE-0002')!['每秒请求上限']) === '5')

  // 8. 未激活站点不参与传播。
  let blocked = false
  try {
    service.previewRevision({ siteId: 4 })
  } catch (error) {
    blocked = error instanceof Error && error.message.includes('尚未激活')
  }
  check('未激活站点不参与影响传播', blocked)

  // 9. 重置站点登记会清空引用旧快照的影响清单。
  const localService = await import('@/api/local-service')
  localService.resetModule('site')
  const afterReset = service.loadImpactState()
  check('重置站点登记后清单清空', afterReset.activeList === null && afterReset.spiderPending === null)
  check('站点登记回到示例数据', String(store.listRows('site').find((r) => Number(r.id) === 2)!['字符编码']) === 'GBK')

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
