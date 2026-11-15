/**
 * dd_domain：域名 / 基础设施尽调适配层（纯 ESM、无第三方依赖）。
 *
 * 数据源（P1 全部免费、无需付费 key）：
 * - RDAP：https://rdap.org/domain/<domain>（registrar / created / expires / status / nameservers）；
 * - crt.sh：https://crt.sh/?q=%25.<domain>&output=json（证书透明日志；偶发 502，retry 1 次后软降级）；
 * - Wayback：https://archive.org/wayback/available?url=<domain>（历史存档可用性）。
 *
 * 统一信封 {ok, tool, query, summary, evidence, warnings, error, domain, rdap, certificates,
 * wayback, subdomains, next_steps}；任一源失败只写入分源状态与 warnings，不抛网络错误。
 */

import { clampText, dedupeEvidence, dedupeStrings, makeEvidence } from './evidence.mjs'
import { HttpFailure, fetchJson, retry } from './http.mjs'

/** 工具名（DSH tool 层按此注册）。 */
export const DOMAIN_TOOL = 'dd_domain'

const RDAP_BASE = 'https://rdap.org/domain'
const CRT_SH_BASE = 'https://crt.sh/'
const WAYBACK_API = 'https://archive.org/wayback/available'
const MAX_INPUT_LENGTH = 300
const MAX_CERT_ENTRIES = 10
const MAX_SUBDOMAINS = 200
/** 单个主机名标签 + TLD 的宽松校验（IDN 会被 URL 转成 xn-- punycode，故 TLD 允许 xn-- 形式）。 */
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/

/**
 * 归一化域名：接受域名或完整 URL，拒绝非法输入。
 * @param {unknown} input 原始输入（如 "https://WWW.Example.com/path?q=1"）。
 * @returns {string|null} 小写域名；非法返回 null。
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text === '' || text.length > MAX_INPUT_LENGTH) return null
  let hostname = ''
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
    hostname = new URL(candidate).hostname.toLowerCase()
  } catch {
    return null
  }
  hostname = hostname.replace(/\.$/, '')
  if (hostname === '' || !DOMAIN_PATTERN.test(hostname)) return null
  return hostname
}

/** 从 RDAP vcardArray 取 fn（注册商名称），如 ["fn", {}, "text", "NameCheap, Inc."]。 */
function extractVcardFn(entity) {
  const card = entity?.vcardArray
  if (!Array.isArray(card) || !Array.isArray(card[1])) return null
  for (const field of card[1]) {
    if (Array.isArray(field) && field[0] === 'fn' && typeof field[3] === 'string' && field[3].trim() !== '') {
      return field[3].trim()
    }
  }
  return null
}

/** RDAP 查询；失败软返回 {ok:false,error}。 */
async function fetchRdap(domain, deps) {
  const url = `${RDAP_BASE}/${encodeURIComponent(domain)}`
  const res = await fetchJson(url, {
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
    headers: { accept: 'application/rdap+json, application/json' },
  })
  if (!res.ok) {
    const error = res.status === 404 ? '域名未注册或该 TLD 暂无公开 RDAP 服务（HTTP 404）' : `RDAP 查询失败：${res.error}`
    return { ok: false, error }
  }
  const data = res.data ?? {}
  const entities = Array.isArray(data.entities) ? data.entities : []
  const registrarEntity = entities.find((item) => Array.isArray(item?.roles) && item.roles.includes('registrar'))
  const events = Array.isArray(data.events) ? data.events : []
  const eventDate = (action) => {
    const event = events.find((item) => item?.eventAction === action)
    return typeof event?.eventDate === 'string' ? event.eventDate : null
  }
  const status = (Array.isArray(data.status) ? data.status : []).filter((item) => typeof item === 'string')
  const nameservers = dedupeStrings(
    (Array.isArray(data.nameservers) ? data.nameservers : []).map((item) =>
      typeof item?.ldhName === 'string' ? item.ldhName.toLowerCase() : '',
    ),
    50,
  )
  return {
    ok: true,
    url,
    registrar: extractVcardFn(registrarEntity),
    created: eventDate('registration'),
    expires: eventDate('expiration'),
    status,
    nameservers,
  }
}

/** 解析 crt.sh 的 JSON 数组，返回证书条目与去重主机名。 */
function parseCrtSh(data, domain) {
  const list = Array.isArray(data) ? data : []
  const entries = []
  const names = []
  const seenName = new Set()
  const seenEntry = new Set()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const commonName = typeof item.common_name === 'string' ? item.common_name.trim().toLowerCase() : ''
    const cleanName = commonName.replace(/^\*\./, '')
    const inScope = cleanName !== '' && (cleanName === domain || cleanName.endsWith(`.${domain}`))
    const rawNames = typeof item.name_value === 'string' ? item.name_value.split('\n') : []
    for (const raw of [commonName, ...rawNames]) {
      const name = String(raw ?? '').trim().toLowerCase().replace(/^\*\./, '')
      if (name === '') continue
      if (name !== domain && !name.endsWith(`.${domain}`)) continue
      if (seenName.has(name) || names.length >= MAX_SUBDOMAINS) continue
      seenName.add(name)
      names.push(name)
    }
    const key = `${commonName}\u0000${typeof item.not_before === 'string' ? item.not_before : ''}`
    if (inScope && !seenEntry.has(key) && entries.length < MAX_CERT_ENTRIES) {
      seenEntry.add(key)
      entries.push({
        common_name: commonName,
        issuer: clampText(item.issuer_name ?? '', 160),
        not_before: typeof item.not_before === 'string' ? item.not_before : null,
        not_after: typeof item.not_after === 'string' ? item.not_after : null,
      })
    }
  }
  names.sort()
  const subdomains = names.filter((name) => name !== domain)
  return { count: list.length, entries, subdomains }
}

/** crt.sh 查询：偶发 502 → retry 1 次；仍失败软降级。 */
async function fetchCrtSh(domain, deps) {
  const url = `${CRT_SH_BASE}?q=%25.${encodeURIComponent(domain)}&output=json`
  try {
    const data = await retry(
      async () => {
        const res = await fetchJson(url, {
          fetchImpl: deps.fetchImpl,
          signal: deps.signal,
          headers: { accept: 'application/json' },
          timeoutMs: 20000,
        })
        if (res.ok) return res.data
        throw new HttpFailure(res.error, { url, status: res.status ?? undefined, code: res.code })
      },
      { retries: 1, delayMs: 600, sleep: deps.sleep, signal: deps.signal },
    )
    const parsed = parseCrtSh(data, domain)
    return { ok: true, url, count: parsed.count, entries: parsed.entries, subdomains: parsed.subdomains }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `crt.sh 查询失败（偶发 502，可稍后重试）：${message}` }
  }
}

/** Wayback 可用性查询；无存档也算查询成功。 */
async function fetchWayback(domain, deps) {
  const url = `${WAYBACK_API}?url=${encodeURIComponent(domain)}`
  const res = await fetchJson(url, {
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
    headers: { accept: 'application/json' },
    timeoutMs: 12000,
  })
  if (!res.ok) return { ok: false, error: `Wayback 查询失败：${res.error}` }
  const closest = res.data?.archived_snapshots?.closest
  const available = closest?.available === true && typeof closest?.url === 'string' && closest.url !== ''
  return {
    ok: true,
    url,
    available,
    snapshot_url: available ? closest.url : null,
    timestamp: typeof closest?.timestamp === 'string' && closest.timestamp !== '' ? closest.timestamp : null,
  }
}

/** 汇总下一步建议。 */
function buildNextSteps(rdap, certificates, wayback) {
  const steps = []
  const expires = typeof rdap.expires === 'string' ? Date.parse(rdap.expires) : Number.NaN
  if (Number.isFinite(expires)) {
    const days = Math.round((expires - Date.now()) / 86400000)
    if (days >= 0 && days <= 90) steps.push(`RDAP 显示域名将在 ${rdap.expires} 到期（约 ${days} 天后），关注抢注与钓鱼风险。`)
  }
  if (!rdap.ok) steps.push('RDAP 不可用：部分 TLD（如 .cn）无公开 RDAP，可改用注册商 WHOIS 页面人工查询。')
  if (wayback.ok && !wayback.available) steps.push('Wayback 无存档：可尝试 web_search 或 urlscan.io 查看历史页面与站点指纹。')
  if (certificates.ok && (certificates.subdomains?.length ?? 0) > 0) {
    steps.push('对高价值子域（admin / api / mail / vpn / dev）继续用 dd_domain 逐级展开，或人工核验登录页与证书。')
  }
  if (!certificates.ok) steps.push('crt.sh 偶发 502，稍后重试；证书透明日志会暴露历史子域（含已下线服务）。')
  steps.push('需要域名背后的运营公司，用 dd_company 查询；需要站点内容，用 web_search / web_fetch（遵守 robots 与 ToS）。')
  return steps.slice(0, 6)
}

/**
 * 域名 / 基础设施尽调入口。
 * @param {{ domain?: string }} input 域名或完整 URL。
 * @param {{ fetchImpl?: typeof fetch, now?: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void> }} [deps]
 *   依赖注入：fetchImpl 供测试 mock；sleep 供测试跳过重试等待。
 * @returns {Promise<object>} 统一 Evidence 信封 + 域名特有字段。
 */
export async function investigateDomain(input, deps = {}) {
  const raw = typeof input?.domain === 'string' ? input.domain.trim() : ''
  const domain = normalizeDomain(raw)
  const base = {
    ok: false, tool: DOMAIN_TOOL, query: raw, domain: domain ?? '', summary: '', evidence: [], warnings: [], error: null,
    rdap: { ok: false, error: null, registrar: null, created: null, expires: null, status: [], nameservers: [] },
    certificates: { ok: false, error: null, count: 0, entries: [] },
    wayback: { ok: false, error: null, available: false, snapshot_url: null, timestamp: null },
    subdomains: [],
    next_steps: [],
  }
  if (raw === '') {
    return { ...base, summary: '缺少域名。', error: 'domain is required', next_steps: ['请提供域名（如 example.com）或完整 URL 后重试。'] }
  }
  if (domain === null) {
    return { ...base, summary: '域名格式非法。', error: `invalid domain: ${clampText(raw, 120)}`, next_steps: ['请提供合法域名，如 example.com、sub.example.com 或 https://example.com/path。'] }
  }
  if (deps?.signal?.aborted === true) return { ...base, summary: '请求已被取消。', error: 'request aborted by caller' }

  const [rdap, certificates, wayback] = await Promise.all([
    fetchRdap(domain, deps).catch((error) => ({ ok: false, error: `RDAP 查询异常：${error instanceof Error ? error.message : String(error)}` })),
    fetchCrtSh(domain, deps),
    fetchWayback(domain, deps).catch((error) => ({ ok: false, error: `Wayback 查询异常：${error instanceof Error ? error.message : String(error)}` })),
  ])

  const warnings = []
  const evidence = []
  if (rdap.ok) {
    const statusText = rdap.status.length > 0 ? rdap.status.join(', ') : '无'
    const nsText = rdap.nameservers.length > 0 ? rdap.nameservers.slice(0, 4).join(', ') : '无'
    evidence.push(evidenceOfRdap(rdap, deps.now, `域名 ${domain}；注册商 ${rdap.registrar ?? '未知'}；注册 ${rdap.created ?? '未知'}；到期 ${rdap.expires ?? '未知'}；状态 ${statusText}；NS ${nsText}`))
  } else {
    warnings.push(rdap.error)
  }
  if (certificates.ok) {
    evidence.push(
      makeEvidence({
        source: 'crt.sh 证书透明日志',
        url: certificates.url,
        now: deps.now,
        confidence: 'medium',
        detail: `crt.sh 返回 ${certificates.count} 条证书记录，去重后涉及 ${certificates.subdomains.length} 个子域 / 主机名（已去掉通配前缀）`,
      }),
    )
  } else {
    warnings.push(certificates.error)
  }
  if (wayback.ok) {
    evidence.push(
      makeEvidence({
        source: 'Wayback Machine',
        url: wayback.url,
        now: deps.now,
        confidence: wayback.available ? 'high' : 'medium',
        detail: wayback.available ? `Wayback 有存档：${wayback.timestamp ?? '时间未知'} → ${wayback.snapshot_url}` : 'Wayback 无可用存档（域名可能较新或未被抓取）',
      }),
    )
    if (!wayback.available) warnings.push('Wayback 无存档：历史页面可能未被抓取。')
  } else {
    warnings.push(wayback.error)
  }

  if (!rdap.ok && !certificates.ok && !wayback.ok) {
    return {
      ...base, domain, evidence: dedupeEvidence(evidence), warnings,
      summary: `域名 ${domain} 的公开数据源均不可用。`,
      error: clampText(`所有数据源查询失败（${warnings.join('；')}）`, 400),
      next_steps: ['稍后重试；或先用 web_search / web_fetch 直接查该域名。'],
    }
  }

  const subdomains = certificates.ok ? certificates.subdomains : []
  const summaryParts = []
  if (rdap.ok) {
    summaryParts.push(`RDAP 注册商 ${rdap.registrar ?? '未知'}（注册 ${rdap.created ?? '未知'}，到期 ${rdap.expires ?? '未知'}）`)
  }
  if (certificates.ok) summaryParts.push(`crt.sh 发现 ${certificates.count} 条证书记录 / ${subdomains.length} 个子域`)
  if (wayback.ok) summaryParts.push(wayback.available ? `Wayback 有存档（${wayback.timestamp ?? '时间未知'}）` : 'Wayback 无存档')
  const summary = `${domain}：${summaryParts.join('；')}。`

  return {
    ok: true,
    tool: DOMAIN_TOOL,
    query: domain,
    domain,
    summary,
    evidence: dedupeEvidence(evidence),
    warnings,
    error: null,
    rdap: {
      ok: rdap.ok, error: rdap.ok ? null : rdap.error, registrar: rdap.ok ? rdap.registrar : null,
      created: rdap.ok ? rdap.created : null, expires: rdap.ok ? rdap.expires : null,
      status: rdap.ok ? rdap.status : [], nameservers: rdap.ok ? rdap.nameservers : [],
    },
    certificates: { ok: certificates.ok, error: certificates.ok ? null : certificates.error, count: certificates.ok ? certificates.count : 0, entries: certificates.ok ? certificates.entries : [] },
    wayback: {
      ok: wayback.ok, error: wayback.ok ? null : wayback.error, available: wayback.ok ? wayback.available : false,
      snapshot_url: wayback.ok ? wayback.snapshot_url : null, timestamp: wayback.ok ? wayback.timestamp : null,
    },
    subdomains,
    next_steps: buildNextSteps(rdap, certificates, wayback),
  }
}

/** 构造 RDAP 证据（单独抽出以便统一 confidence）。 */
function evidenceOfRdap(rdap, now, detail) {
  return makeEvidence({ source: 'RDAP（rdap.org）', url: rdap.url, now, confidence: 'high', detail })
}
