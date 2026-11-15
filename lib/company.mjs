/**
 * dd_company：公司 / 组织 / 机构的实体尽调适配层（纯 ESM、无第三方依赖）。
 *
 * 数据源（P1 全部免费、无需付费 key）：
 * - GLEIF：fuzzycompletions 找候选 LEI（短查询补 inc./ltd/gmbh 后缀变体，否则只会返回编辑距离最近的
 *   短名称，实测 q=apple 只返回 APALE / APILEC），命中后取 /lei-records/{lei}（官方登记，高置信）；
 * - SEC EDGAR：efts.sec.gov 全文检索拿 CIK，再取 data.sec.gov/submissions（必须带可联系 UA；
 *   www.sec.gov/files/company_tickers.json 实测不可用，不接）；
 * - Wikidata：wbsearchentities 补候选实体，用于消歧（低置信）；
 * - 疑似中国公司：只生成天眼查 / 企查查 / 爱企查 / GSXT 的 Deep Link，绝不抓取。
 *
 * 统一信封 {ok, tool, query, summary, evidence, warnings, error, candidates, sources, gleif, sec,
 * wikidata, deep_links, next_steps}；所有数据源失败都软降级，不把网络错误抛给调用方。
 */

import { clampText, dedupeEvidence, makeEvidence, sortByConfidence } from './evidence.mjs'
import { USER_AGENT, fetchJson, mapLimit } from './http.mjs'

/** 工具名（DSH tool 层按此注册）。 */
export const COMPANY_TOOL = 'dd_company'

const GLEIF_API = 'https://api.gleif.org/api/v1'
const SEC_FTS_API = 'https://efts.sec.gov/LATEST/search-index'
const SEC_SUBMISSIONS_API = 'https://data.sec.gov/submissions'
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
/**
 * SEC 要求 UA 带可联系信息；SEC 限速 ≤10 req/s。
 * 可通过 DSH_DD_SEC_CONTACT 设置邮箱或项目联系页；默认使用公开仓库地址，不包含私人信息。
 */
const SEC_CONTACT = process.env.DSH_DD_SEC_CONTACT?.trim() || 'https://github.com/jimmyxu-code/dsh-due-diligence/issues'
const SEC_USER_AGENT = `${USER_AGENT} (contact: ${SEC_CONTACT})`
const MAX_QUERY_LENGTH = 200
const MAX_CANDIDATES = 12
const MAX_GLEIF_RECORDS = 3
const MAX_SEC_CIKS = 6
/** 英文公司后缀（looksLikeCompanyName + 后缀变体判断）。 */
const EN_COMPANY_SUFFIX =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|plc|llp|lp|group|holdings?|technologies|technology|systems|partners|bank|foundation|university|institute|trust|capital|labs?|ventures?|industries|enterprises|solutions|consulting|associates)\b\.?/i
/** 中文公司/机构后缀关键词。 */
const CN_COMPANY_SUFFIX =
  /(公司|集团|控股|股份|实业|企业|银行|保险|证券|基金|信托|事务所|研究院|研究所|大学|学院|医院|协会|基金会|合作社|工作室|工厂|商行|酒店|地产|置业|投资|资本|咨询|科技|网络|信息|软件|通信|能源|矿业|建设|工程|物流|传媒|教育|旅游|餐饮|制造|工业)/
/** CJK 统一表意文字（判断疑似中国主体）。 */
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/
/** LEI：20 位大写字母数字；CIK：7–10 位数字或带 CIK 前缀。 */
const LEI_PATTERN = /^[A-Z0-9]{20}$/
const CIK_PATTERN = /^(?:CIK[:\s-]*)?0*\d{7,10}$/i

/** 构造候选实体（字段与 DSH output schema 对齐）。 */
function candidateOf(source, id, name, jurisdiction, status, url, confidence) {
  return { source, id, name, jurisdiction, status, url, confidence }
}

/** 构造一条来源证据。 */
function evidenceOf(source, url, now, confidence, detail) {
  return makeEvidence({ source, url, now, confidence, detail })
}

/** 某源查询成功（可能 0 条）的结果骨架。 */
function okSource(candidates, evidence, warnings = [], extras = null) {
  const result = { candidates, evidence, warnings, status: { ok: true, count: candidates.length, error: null } }
  if (extras !== null) result.extras = extras
  return result
}

/** 某源「查询成功但无匹配」的结果骨架。 */
function missSource(warning) {
  return okSource([], [], warning ? [warning] : [])
}

/** 某源失败（软降级）的结果骨架。 */
function failSource(message) {
  return {
    candidates: [],
    evidence: [],
    warnings: [],
    status: { ok: false, count: 0, error: clampText(String(message ?? 'unknown error'), 240) },
  }
}

/** 判断是否「疑似公司 / 组织名称」（后缀启发式，仅提示用，不构成事实判定）。 */
export function looksLikeCompanyName(name) {
  if (typeof name !== 'string') return false
  const text = name.trim()
  return text !== '' && (EN_COMPANY_SUFFIX.test(text) || CN_COMPANY_SUFFIX.test(text))
}

/** 是否疑似 LEI；是否疑似 CIK。 */
function looksLikeLei(text) {
  return typeof text === 'string' && LEI_PATTERN.test(text.trim().toUpperCase())
}
function looksLikeCik(text) {
  return typeof text === 'string' && CIK_PATTERN.test(text.trim())
}

/** 归一化 CIK 为 10 位补零字符串。 */
function normalizeCik(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits === '' ? '' : digits.padStart(10, '0')
}

/** 归一化名称：去空白/标点并大写，用于跨源名称匹配与排序。 */
function normalizeName(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9\u3400-\u9fff]/g, '')
}

/** 公司名称与查询的相关性打分（3=完全相同，2=前缀，1=包含，0=无关）。 */
function scoreGleifName(name, query) {
  const left = normalizeName(name)
  const right = normalizeName(query)
  if (left === '' || right === '') return 0
  if (left === right) return 3
  if (left.startsWith(right)) return 2
  return left.includes(right) ? 1 : 0
}

/**
 * 去掉常见法律后缀后的“核心名称”（全大写无标点），用于 SEC 同名公司排序。
 * 例：Apple Inc. → APPLE；APPLE COMPUTER INC → APPLECOMPUTER。
 * @param {string} value 公司名。
 * @returns {string} 核心名。
 */
function coreNameNormalized(value) {
  let name = normalizeName(value)
  if (name === '') return ''
  const suffixes = [
    'INCORPORATED', 'CORPORATION', 'COMPANY', 'HOLDINGS', 'HOLDING', 'LIMITED', 'GROUP',
    'LLC', 'LLP', 'PLC', 'GMBH', 'INC', 'CORP', 'LTD', 'LP', 'CO', 'AG', 'SA', 'NV', 'BV', 'SE',
  ]
  for (let round = 0; round < 3; round += 1) {
    const before = name
    for (const suffix of suffixes) {
      if (name.endsWith(suffix) && name.length > suffix.length + 1) {
        name = name.slice(0, -suffix.length)
        break
      }
    }
    if (name === before) break
  }
  return name
}

/**
 * SEC 候选与查询的相关性打分（0=核心名完全相同，1=前缀，2=包含，3=无关）。
 * @param {string} name 公司名。
 * @param {string} query 查询词。
 * @returns {number} 分数，越小越相关。
 */
function scoreSecName(name, query) {
  const left = coreNameNormalized(name)
  const right = coreNameNormalized(query)
  if (left === '' || right === '') return 4
  if (left === right) return 0
  if (left.startsWith(right)) return 1
  if (left.includes(right)) return 2
  return 3
}

/** 按 source + id 去重候选实体。 */
function dedupeCandidates(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue
    const key = `${item.source}\u0000${item.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** 生成中国工商检索入口（只给 Deep Link，不抓取）。 */
function buildCnDeepLinks(query) {
  if (!CJK_PATTERN.test(query)) return []
  const encoded = encodeURIComponent(query)
  return [
    { source: '天眼查', url: `https://www.tianyancha.com/search?key=${encoded}`, note: '仅检索入口，不抓取（实测有 WAF）' },
    { source: '企查查', url: `https://www.qcc.com/web/search?key=${encoded}`, note: '仅检索入口，不抓取；P2 可接企查查 MCP' },
    { source: '爱企查', url: `https://aiqicha.baidu.com/s?q=${encoded}`, note: '仅检索入口，不抓取' },
    { source: 'GSXT', url: 'https://www.gsxt.gov.cn/index.html', note: '需手工输入名称并过验证码，不抓取' },
  ]
}

/** 一次 GLEIF fuzzycompletions 查询，返回 {lei, name} 提案。 */
async function gleifFuzzy(query, deps) {
  const url = `${GLEIF_API}/fuzzycompletions?field=entity.legalName&q=${encodeURIComponent(query)}&page[size]=10`
  const res = await fetchJson(url, { fetchImpl: deps.fetchImpl, signal: deps.signal })
  if (!res.ok) return { ok: false, proposals: [], error: res.error }
  const proposals = []
  const seen = new Set()
  for (const item of Array.isArray(res.data?.data) ? res.data.data : []) {
    const lei = item?.relationships?.['lei-records']?.data?.id
    if (typeof lei !== 'string' || !looksLikeLei(lei)) continue
    const key = lei.trim().toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push({ lei: key, name: typeof item?.attributes?.value === 'string' ? item.attributes.value.trim() : '' })
  }
  return { ok: true, proposals }
}

/** 取单条 GLEIF LEI 记录并转候选；失败软返回。 */
async function fetchGleifRecord(lei, deps, confidence = 'high') {
  const url = `${GLEIF_API}/lei-records/${encodeURIComponent(lei)}`
  const res = await fetchJson(url, { fetchImpl: deps.fetchImpl, signal: deps.signal })
  if (!res.ok) return { ok: false, error: `LEI ${lei} 记录获取失败：${res.error}` }
  const attributes = res.data?.data?.attributes ?? {}
  const entity = attributes.entity ?? {}
  const name = typeof entity?.legalName?.name === 'string' ? entity.legalName.name.trim() : ''
  if (name === '') return { ok: false, error: `LEI ${lei} 记录缺少 legalName` }
  const status = typeof entity.status === 'string' ? entity.status : (attributes?.registration?.status ?? null)
  return {
    ok: true,
    candidate: candidateOf('GLEIF', lei, name, typeof entity.jurisdiction === 'string' ? entity.jurisdiction : null, status,
      `https://search.gleif.org/#/record/${encodeURIComponent(lei)}`, confidence),
    detail: `LEI ${lei}；名称 ${name}；状态 ${status ?? '未知'}；辖区 ${entity.jurisdiction ?? '未知'}；注册日期 ${attributes?.registration?.initialRegistrationDate ?? '未知'}`,
  }
}

/** GLEIF 数据源编排：LEI 直查 / fuzzycompletions（短查询补后缀变体）→ 取记录。 */
async function searchGleif(query, deps) {
  if (looksLikeLei(query)) {
    const record = await fetchGleifRecord(query.trim().toUpperCase(), deps, 'high')
    if (!record.ok) return failSource(record.error)
    return okSource([record.candidate], [evidenceOf('GLEIF', record.candidate.url, deps.now, 'high', record.detail)])
  }
  const queries = [query]
  if (!CJK_PATTERN.test(query) && !looksLikeCompanyName(query)) queries.push(`${query} inc.`, `${query} ltd`, `${query} gmbh`)
  const attempts = await mapLimit(queries, 4, (value) => gleifFuzzy(value, deps), { signal: deps.signal })
  const okAttempts = attempts.filter((item) => item.ok)
  if (okAttempts.length === 0) return failSource(`GLEIF fuzzycompletions 失败：${attempts[0]?.error ?? 'unknown error'}`)
  const proposals = []
  const seen = new Set()
  for (const attempt of okAttempts) {
    for (const proposal of attempt.proposals) {
      if (seen.has(proposal.lei)) continue
      seen.add(proposal.lei)
      proposals.push(proposal)
    }
  }
  if (proposals.length === 0) return missSource('GLEIF 未命中：可改用公司完整法定名称、英文名或 LEI 重试。')
  proposals.sort((a, b) => scoreGleifName(b.name, query) - scoreGleifName(a.name, query))
  const records = await mapLimit(
    proposals.slice(0, MAX_GLEIF_RECORDS),
    3,
    (proposal) => fetchGleifRecord(proposal.lei, deps, scoreGleifName(proposal.name, query) >= 3 ? 'high' : 'medium'),
    { signal: deps.signal },
  )
  const candidates = []
  const evidence = []
  const warnings = []
  for (const record of records) {
    if (!record.ok) {
      warnings.push(`GLEIF：${record.error}`)
      continue
    }
    candidates.push(record.candidate)
    evidence.push(evidenceOf('GLEIF', record.candidate.url, deps.now, 'high', record.detail))
  }
  if (candidates.length === 0) return failSource(warnings.join('；') || 'GLEIF 记录获取失败')
  return okSource(candidates, evidence, warnings)
}

/** 解析 EDGAR 检索命中 display_names，如 "APPLE COMPUTER INC  (AAPL)  (CIK 0000320193)"。 */
function parseSecDisplayName(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { cik: null, ticker: '', name: '' }
  const cikMatch = raw.match(/\(CIK\s+(\d+)\)/i)
  const tickerMatch = raw.match(/\(([A-Z0-9.,\- ]{1,40})\)\s+\(CIK/i)
  let name = raw.replace(/\s*\(CIK\s+\d+\)\s*$/i, '').trim()
  name = name.replace(/\s*\([A-Z0-9.,\- ]{1,40}\)\s*$/, '').trim()
  return {
    cik: cikMatch === null ? null : normalizeCik(cikMatch[1]),
    ticker: tickerMatch === null ? '' : tickerMatch[1].trim(),
    name: name === '' ? raw : name,
  }
}

/** 取 SEC submissions（法定名称 / ticker / 交易所）；失败时用 FTS display_name 兜底。 */
async function fetchSecSubmission(cik, deps, fallback = {}) {
  const headers = { accept: 'application/json', 'user-agent': SEC_USER_AGENT }
  const res = await fetchJson(`${SEC_SUBMISSIONS_API}/CIK${cik}.json`, { fetchImpl: deps.fetchImpl, signal: deps.signal, headers })
  const fallbackName = typeof fallback.name === 'string' ? fallback.name.trim() : ''
  const secUrl = `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(cik)}`
  if (!res.ok) {
    if (fallbackName === '') return { ok: false, error: `CIK ${cik} submissions 获取失败：${res.error}` }
    const tickers = fallback.ticker === '' ? [] : fallback.ticker.split(/[, ]+/).filter((item) => item !== '')
    return {
      ok: true,
      tickers,
      candidate: candidateOf('SEC EDGAR', cik, fallbackName, 'US', 'SEC 申报主体（submissions 详情获取失败）', secUrl, 'medium'),
      detail: `SEC 全文检索命中 CIK ${cik}；submissions 获取失败（${res.error}），名称取自检索结果显示名。`,
    }
  }
  const data = res.data ?? {}
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const tickers = (Array.isArray(data.tickers) ? data.tickers : []).filter((item) => typeof item === 'string')
  const exchanges = (Array.isArray(data.exchanges) ? data.exchanges : []).filter((item) => typeof item === 'string')
  const status = tickers.length > 0 ? `SEC 申报主体（${tickers.slice(0, 3).join(', ')}）` : 'SEC 申报主体'
  const finalName = name === '' ? (fallbackName === '' ? `CIK ${cik}` : fallbackName) : name
  return {
    ok: true,
    tickers: tickers.slice(0, 5),
    candidate: candidateOf('SEC EDGAR', cik, finalName, 'US', status, secUrl, 'high'),
    detail: `SEC CIK ${cik}；名称 ${name === '' ? '未知' : name}${tickers.length > 0 ? `；ticker ${tickers.slice(0, 3).join(', ')}` : ''}${exchanges.length > 0 ? `；交易所 ${exchanges.slice(0, 2).join(', ')}` : ''}；法人类型 ${data.entityType ?? '未知'}`,
  }
}

/** SEC 数据源编排：CIK 直查 / 全文检索（带 SEC UA，最多回填 6 个 CIK）。 */
async function searchSec(query, deps) {
  const headers = { accept: 'application/json', 'user-agent': SEC_USER_AGENT }
  const emptyExtras = { cik: null, name: null, tickers: [], filings_url: null }
  if (looksLikeCik(query)) {
    const cik = normalizeCik(query)
    const entry = await fetchSecSubmission(cik, deps)
    if (!entry.ok) return failSource(entry.error)
    return okSource([entry.candidate], [evidenceOf('SEC EDGAR', entry.candidate.url, deps.now, 'high', entry.detail)], [], {
      cik, name: entry.candidate.name, tickers: entry.tickers.slice(0, 3), filings_url: entry.candidate.url,
    })
  }
  const phrase = `"${query.replace(/"/g, ' ').trim()}"`
  const res = await fetchJson(`${SEC_FTS_API}?q=${encodeURIComponent(phrase)}`, { fetchImpl: deps.fetchImpl, signal: deps.signal, headers })
  if (!res.ok) return failSource(`SEC EDGAR 全文检索失败：${res.error}`)
  const hits = Array.isArray(res.data?.hits?.hits) ? res.data.hits.hits : []
  const fallbacks = new Map()
  for (const hit of hits) {
    const source = hit?._source ?? {}
    const displayNames = Array.isArray(source.display_names) ? source.display_names : []
    const ciks = Array.isArray(source.ciks) ? source.ciks : []
    for (let index = 0; index < ciks.length; index += 1) {
      const cik = normalizeCik(ciks[index])
      if (cik === '' || fallbacks.has(cik)) continue
      fallbacks.set(cik, parseSecDisplayName(displayNames[index] ?? displayNames[0]))
    }
  }
  if (fallbacks.size === 0) return okSource([], [], ['SEC EDGAR 未命中：非美国上市公司通常查不到，可补充 ticker 或 CIK 重试。'], emptyExtras)
  /** 按「核心名」与查询的相关性重排（EDGAR 原始命中常把同前缀的其它公司排前面），短名优先。 */
  const ranked = [...fallbacks.entries()]
    .map(([cik, info]) => ({ cik, info, score: scoreSecName(info?.name, query) * 1000 + normalizeName(info?.name).length }))
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_SEC_CIKS)
  const entries = await mapLimit(ranked, 3, (item) => fetchSecSubmission(item.cik, deps, item.info), { signal: deps.signal })
  /** 用 submissions 里的官方名称再排一次：核心名完全匹配 > 前缀 > 包含；同分时有 ticker（上市公司）优先、名称更短优先。 */
  const scoredEntries = entries
    .map((entry, index) => ({
      entry,
      fallbackName: typeof ranked[index]?.info?.name === 'string' ? ranked[index].info.name : '',
    }))
    .filter((item) => item.entry.ok === true)
    .map((item) => ({
      ...item,
      score: Math.min(scoreSecName(item.entry.candidate.name, query), scoreSecName(item.fallbackName, query)),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      const leftListed = left.entry.tickers.length > 0 ? 0 : 1
      const rightListed = right.entry.tickers.length > 0 ? 0 : 1
      if (leftListed !== rightListed) return leftListed - rightListed
      return normalizeName(left.entry.candidate.name).length - normalizeName(right.entry.candidate.name).length
    })
  const candidates = []
  const evidence = []
  const warnings = []
  let extras = emptyExtras
  for (const item of scoredEntries) {
    if (item.entry.ok !== true) continue
    candidates.push(item.entry.candidate)
    evidence.push(evidenceOf('SEC EDGAR', item.entry.candidate.url, deps.now, 'high', item.entry.detail))
  }
  for (const entry of entries) {
    if (entry.ok !== true) warnings.push(`SEC EDGAR：${entry.error}`)
  }
  if (candidates.length === 0) return failSource(warnings.join('；') || 'SEC EDGAR 候选详情获取失败')
  const best = scoredEntries[0]
  if (best !== undefined) {
    extras = {
      cik: best.entry.candidate.id,
      name: best.entry.candidate.name,
      tickers: best.entry.tickers.slice(0, 3),
      filings_url: best.entry.candidate.url,
    }
  }
  return okSource(candidates, evidence, warnings, extras)
}

/** Wikidata 数据源编排：wbsearchentities 补实体候选（低置信，仅用于消歧）。 */
async function searchWikidata(query, deps) {
  const language = CJK_PATTERN.test(query) ? 'zh' : 'en'
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&format=json&limit=8&type=item&origin=*`
  const res = await fetchJson(url, { fetchImpl: deps.fetchImpl, signal: deps.signal, headers: { accept: 'application/json' } })
  if (!res.ok) return failSource(`Wikidata 查询失败：${res.error}`)
  const candidates = []
  const seen = new Set()
  for (const item of Array.isArray(res.data?.search) ? res.data.search : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!/^Q\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = (typeof item.label === 'string' && item.label.trim()) || item?.display?.label?.value || item?.match?.text || ''
    const name = String(label).trim()
    if (name === '') continue
    const description = clampText(item?.description ?? item?.display?.description?.value ?? 'Wikidata 实体', 120)
    const url2 = `https://www.wikidata.org/wiki/${encodeURIComponent(id)}`
    candidates.push(candidateOf('Wikidata', id, name, null, description, url2, normalizeName(name) === normalizeName(query) ? 'medium' : 'low'))
  }
  if (candidates.length === 0) return missSource('Wikidata 未命中。')
  const detail = `wbsearchentities 命中 ${candidates.length} 个实体：${candidates.slice(0, 4).map((item) => `${item.id} ${item.name}`).join('；')}`
  return okSource(candidates, [evidenceOf('Wikidata', url, deps.now, 'low', detail)])
}

/** 汇总下一步建议。 */
function buildNextSteps(candidates, deepLinks) {
  const steps = []
  if (deepLinks.length > 0) steps.push('中国工商信息：打开天眼查 / 企查查 / 爱企查 / GSXT 的 Deep Link 人工核验；本工具不抓取这些站点（ToS + 反爬 + 判例风险）。')
  if (candidates.some((item) => item.source === 'SEC EDGAR')) steps.push('美国上市公司：用 SEC EDGAR 链接查看 10-K/10-Q、股权结构与高管名单。')
  else steps.push('如需美国上市公司数据，可补充 ticker 或 CIK（如 0000320193）后重试。')
  if (candidates.length === 0) steps.push('改用公司完整法定名称、英文名、LEI（20 位）或 CIK 重试；可先用 web_search 确认官网注册全称。')
  steps.push('实体对齐优先使用 LEI / CIK / 统一社会信用代码等主键，避免同名公司混淆。')
  steps.push('需要官网基础设施或高管姓名时，继续用 dd_domain / dd_name。')
  return steps.slice(0, 6)
}

/**
 * 公司 / 组织尽调入口。
 * @param {{ query?: string }} input 查询词：公司名 / 英文名 / ticker / CIK / LEI。
 * @param {{ fetchImpl?: typeof fetch, now?: number, signal?: AbortSignal }} [deps] 依赖注入（测试注入 mock fetch）。
 * @returns {Promise<object>} 统一 Evidence 信封 + 公司特有字段。
 */
export async function investigateCompany(input, deps = {}) {
  const query = typeof input?.query === 'string' ? input.query.trim().replace(/\s+/g, ' ') : ''
  const base = {
    ok: false, tool: COMPANY_TOOL, query, summary: '', evidence: [], warnings: [], error: null, candidates: [],
    sources: {}, gleif: { ok: false, error: null, count: 0 },
    sec: { ok: false, error: null, cik: null, name: null, tickers: [], filings_url: null },
    wikidata: [], deep_links: [], next_steps: [],
  }
  if (query === '') {
    return { ...base, summary: '缺少公司查询词。', error: 'company query is required', next_steps: ['请提供公司名称、英文名、ticker、CIK 或 LEI 后重试。'] }
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return { ...base, summary: '公司查询词过长。', error: `query too long (max ${MAX_QUERY_LENGTH} chars)`, next_steps: ['请缩短查询词，改用公司全称或注册编号。'] }
  }
  if (deps?.signal?.aborted === true) return { ...base, summary: '请求已被取消。', error: 'request aborted by caller' }

  /** 单源异常兜底：任何意外 throw 都转软失败，不影响其它源。 */
  const safe = async (action) => {
    try {
      return await action()
    } catch (error) {
      return failSource(error instanceof Error ? `查询异常：${error.message}` : `查询异常：${String(error)}`)
    }
  }
  const [gleif, sec, wikidata] = await Promise.all([
    safe(() => searchGleif(query, deps)), safe(() => searchSec(query, deps)), safe(() => searchWikidata(query, deps)),
  ])

  const warnings = [...gleif.warnings, ...sec.warnings, ...wikidata.warnings]
  for (const [name, result] of [['GLEIF', gleif], ['SEC EDGAR', sec], ['Wikidata', wikidata]]) {
    if (result.status.ok !== true) warnings.push(`${name} 不可用：${result.status.error ?? '未知错误'}`)
  }
  const evidence = dedupeEvidence([...gleif.evidence, ...sec.evidence, ...wikidata.evidence])
  const sources = { gleif: gleif.status, sec: sec.status, wikidata: wikidata.status }
  const cnLinks = buildCnDeepLinks(query)
  if (cnLinks.length > 0) {
    sources.deeplink = { ok: true, count: cnLinks.length, error: null, note: '仅 Deep Link，不抓取中国站点' }
    warnings.push('疑似中国主体：已生成天眼查 / 企查查 / 爱企查 / GSXT 检索入口，本工具不抓取这些站点。')
    evidence.push(evidenceOf('中国工商检索入口（Deep Link）', cnLinks[0].url, deps.now, 'low',
      `仅生成 ${cnLinks.map((item) => item.source).join(' / ')} 检索入口；未抓取任何中国工商站点数据。`))
  } else {
    sources.deeplink = { ok: true, count: 0, error: null, note: '非中国主体，未生成 Deep Link' }
  }
  const deepLinks = cnLinks.map((item) => ({ label: item.source, url: item.url }))

  const candidates = sortByConfidence(dedupeCandidates([...gleif.candidates, ...sec.candidates, ...wikidata.candidates])).slice(0, MAX_CANDIDATES)
  const secSummary = { ok: sec.status.ok, error: sec.status.error ?? null, ...(sec.extras ?? { cik: null, name: null, tickers: [], filings_url: null }) }
  const gleifSummary = { ok: gleif.status.ok, error: gleif.status.error ?? null, count: gleif.status.count }
  const wikidataItems = wikidata.candidates.map((item) => ({ id: item.id, label: item.name, description: item.status ?? '', url: item.url }))
  /** Deep Link 不算「数据源可用」，全部网络源失败时信封仍标记 ok=false。 */
  const networkOk = gleif.status.ok || sec.status.ok || wikidata.status.ok

  if (!networkOk) {
    const details = Object.entries(sources)
      .filter(([, status]) => status.ok !== true && status.error)
      .map(([name, status]) => `${name}: ${status.error}`)
      .join('；')
    return {
      ...base, evidence, warnings, candidates, sources, gleif: gleifSummary, sec: secSummary, wikidata: wikidataItems, deep_links: deepLinks,
      summary: '公司/组织查询失败：所有公开数据源均不可用。',
      error: clampText(`所有数据源查询失败（${details || '未知原因'}）`, 400),
      next_steps: ['稍后重试；或用 web_search 先确认公司全称，再补充 LEI / CIK 重试。'],
    }
  }

  let summary = ''
  if (candidates.length > 0) {
    summary = `找到 ${candidates.length} 个实体候选：${candidates.slice(0, 4).map((item) => `${item.source} → ${item.name}（${item.id}）`).join('；')}。`
  } else if (cnLinks.length > 0) summary = '公开数据源未匹配到实体候选；已生成 4 个中国工商检索入口（仅跳转，不抓取）。'
  else summary = '公开数据源（GLEIF / SEC EDGAR / Wikidata）均未匹配到实体候选。'
  if (cnLinks.length > 0 && candidates.length > 0) summary += ' 疑似中国主体，已附 4 个工商检索入口（仅跳转）。'

  return {
    ok: true, tool: COMPANY_TOOL, query, summary, evidence, warnings, error: null, candidates, sources,
    gleif: gleifSummary, sec: secSummary, wikidata: wikidataItems, deep_links: deepLinks,
    next_steps: buildNextSteps(candidates, cnLinks),
  }
}
