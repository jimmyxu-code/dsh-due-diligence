/**
 * dd_username：用户名 → 各平台账号（Node 原生 sherlock 引擎，不依赖 Python）。
 *
 * 流程（对应 sherlock 的一次 CLI 扫描）：
 *   站点库(481) → site/exclusions/NSFW 筛选 → 并发 20 探测（默认 10s 超时）
 *   → 命中结果（claimed）→ 可选二次核验（并发 10、6s 超时、禁自动重定向；
 *   仅放行指向同一账号路径的规范化 3xx 重定向，避免 www↔apex / 尾斜杠造成误判）
 *   → 统一 Evidence 信封。
 *
 * 合规提示：本工具只做「对公开 URL 的 HTTP 存在性探测」，不登录、不抓取私域内容；
 * 输出仅供人工核实，不构成 consumer report，不得用于自动化的雇佣/信贷决策。
 *
 * 所有网络请求经 http.mjs，测试用 deps.fetchImpl 注入 mock；本模块不直接联网。
 * 长尾错误（网络/超时/单站规则异常）软失败：记入 counts/warnings，绝不整体抛错。
 */

import { clampText, dedupeStrings, extractHtmlMeta, extractHtmlTitle, makeEvidence } from './evidence.mjs'
import { describeError, isAbortFailure, mapLimit, requestText } from './http.mjs'
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  SHERLOCK_COMMIT,
  SHERLOCK_USER_AGENT,
  SHERLOCK_VERSION,
  filterSites,
  loadExclusions,
  loadSiteManifest,
  normalizeSiteInput,
  probeSite,
  toEvidenceSource,
} from './sherlock-engine.mjs'

/** 工具名（与宿主 tool 定义保持一致）。 */
export const TOOL_NAME = 'dd_username'
/** 二次核验单请求超时（毫秒）。 */
export const VERIFY_TIMEOUT_MS = 6000
/** 二次核验并发。 */
export const VERIFY_CONCURRENCY = 10
/** 单次扫描默认并发（与 sherlock 的 max_workers=20 一致）。 */
export const SCAN_CONCURRENCY = DEFAULT_CONCURRENCY
/** 默认返回命中上限。 */
export const DEFAULT_MAX_RESULTS = 100
/** 用户名最大长度（防止异常输入撑爆 URL）。 */
export const MAX_USERNAME_LENGTH = 100
/** 二次核验响应体上限（512KB，够读 title，避免大页面浪费内存）。 */
const VERIFY_MAX_BYTES = 512 * 1024
/** 二次核验最多容忍的「规范化重定向」跳数（www↔apex、补尾斜杠等）。 */
const VERIFY_MAX_REDIRECTS = 2
/** 视为重定向的状态码。 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
/** 会破坏 URL 结构或注入控制字符的用户名直接拒绝（与 sherlock 的宽松拼接不同）。 */
const FORBIDDEN_USERNAME = /[/\\?#\u0000-\u001f\u007f]/

/** @typedef {'high'|'medium'|'low'} Confidence */

/**
 * 构造空信封（同时用于输入错误/数据缺失/正常扫描的骨架）。
 * @param {{
 *   query: Record<string, unknown>,
 *   summary: string,
 *   warnings?: string[],
 *   error?: string|null,
 *   elapsed_ms?: number,
 *   aborted?: boolean,
 *   ok?: boolean,
 * }} input 字段。
 * @returns {Record<string, any>} Evidence 信封。
 */
function createEnvelope(input) {
  return {
    ok: input.ok === true,
    tool: TOOL_NAME,
    query: input.query,
    summary: input.summary,
    evidence: [],
    warnings: dedupeStrings(input.warnings ?? [], 30),
    error: input.error ?? null,
    found: [],
    counts: {
      manifest_total: 0,
      sites_total: 0,
      checked: 0,
      claimed: 0,
      available: 0,
      unknown: 0,
      waf: 0,
      failed: 0,
      illegal: 0,
      skipped_invalid_regex: 0,
      excluded: 0,
      nsfw_removed: 0,
      aborted: 0,
    },
    verify: {
      enabled: false,
      checked: 0,
      verified: 0,
      unreachable: 0,
      skipped: 0,
      timeout_ms: VERIFY_TIMEOUT_MS,
      concurrency: VERIFY_CONCURRENCY,
    },
    elapsed_ms: Math.max(0, Math.round(input.elapsed_ms ?? 0)),
    sites_total: 0,
    truncated: false,
    aborted: input.aborted === true,
  }
}

/**
 * 校验并归一化输入（错误时返回 {ok:false,error,warnings}，不抛错）。
 * @param {Record<string, any>} input 原始入参（兼容 camelCase 与 snake_case）。
 * @returns {{ ok: true, value: {
 *   username: string, site: unknown, timeoutMs: number, verify: boolean, maxResults: number,
 * } } | { ok: false, error: string, warnings: string[] }} 归一化结果。
 */
function normalizeInput(input) {
  const warnings = []
  const rawUsername = input?.username
  if (typeof rawUsername !== 'string' || rawUsername.trim() === '') {
    return { ok: false, error: 'username 必填，且必须是非空字符串', warnings }
  }
  const username = rawUsername.trim()
  if (username.length > MAX_USERNAME_LENGTH) {
    return { ok: false, error: `username 过长（最多 ${MAX_USERNAME_LENGTH} 字符）`, warnings }
  }
  if (FORBIDDEN_USERNAME.test(username)) {
    return { ok: false, error: 'username 含 / \\ ? # 或控制字符，无法安全拼进站点 URL', warnings }
  }

  const rawTimeout = input?.timeoutMs ?? input?.timeout_ms
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (Number.isFinite(rawTimeout)) {
    timeoutMs = Math.min(60000, Math.max(1000, Math.round(Number(rawTimeout))))
    if (timeoutMs !== rawTimeout) warnings.push(`timeoutMs 已收敛到 ${timeoutMs}ms（允许 1000–60000）`)
  } else if (rawTimeout !== undefined && rawTimeout !== null) {
    warnings.push('timeoutMs 非法，已使用默认 10000ms')
  }

  const rawMax = input?.maxResults ?? input?.max_results
  let maxResults = DEFAULT_MAX_RESULTS
  if (Number.isFinite(rawMax)) {
    maxResults = Math.min(500, Math.max(1, Math.round(Number(rawMax))))
    if (maxResults !== rawMax) warnings.push(`maxResults 已收敛到 ${maxResults}（允许 1–500）`)
  } else if (rawMax !== undefined && rawMax !== null) {
    warnings.push('maxResults 非法，已使用默认 100')
  }

  return {
    ok: true,
    warnings,
    value: { username, site: input?.site, timeoutMs, verify: input?.verify === true, maxResults },
  }
}

/**
 * 置信度排序（高在前），同级按站点名稳定排序。
 * @param {{confidence: Confidence, site: string}} a 结果 A。
 * @param {{confidence: Confidence, site: string}} b 结果 B。
 * @returns {number} 排序值。
 */
function compareFound(a, b) {
  const rank = { high: 0, medium: 1, low: 2 }
  const delta = (rank[a.confidence] ?? 3) - (rank[b.confidence] ?? 3)
  if (delta !== 0) return delta
  if (a.site === b.site) return 0
  return a.site < b.site ? -1 : 1
}

/** 是否重定向状态码。 */
function isRedirectStatus(status) {
  return REDIRECT_STATUS.has(status)
}

/**
 * 判断重定向落点是否仍是「同一账号页」：只放行两类重定向——
 * 1) 同站点的路径规范化（www↔apex、补/去尾斜杠，路径不变）；
 * 2) 落点路径仍包含原 URL 末段用户名（大小写不敏感 / 兼容 URL 编码）。
 * 其它重定向（例如不存在时跳到首页/登录页）一律判不可达，避免把首页 200 当成账号存在。
 * @param {URL} original 原始命中 URL。
 * @param {URL} next 重定向落点。
 * @returns {boolean} 是否为同一账号页的规范化跳转。
 */
function isSameProfileLocation(original, next) {
  const normalizeHost = (host) => host.toLowerCase().replace(/^www\./, '')
  const normalizePath = (path) => path.replace(/\/+$/, '')
  if (normalizeHost(original.hostname) === normalizeHost(next.hostname) && normalizePath(original.pathname) === normalizePath(next.pathname)) {
    return true
  }
  const segments = original.pathname.split('/').filter((segment) => segment !== '')
  const last = segments.length > 0 ? segments[segments.length - 1] : ''
  let username = ''
  try {
    username = decodeURIComponent(last).toLowerCase()
  } catch {
    username = last.toLowerCase()
  }
  if (username === '') return false
  let target = ''
  try {
    target = decodeURIComponent(next.pathname).toLowerCase()
  } catch {
    target = next.pathname.toLowerCase()
  }
  return target.includes(username)
}

/**
 * 二次核验单个命中 URL：GET + 禁自动重定向。
 * - 2xx → verified，并尽量抓 <title> 与公开简介 meta（description / og:description）；
 * - 3xx → 只跟随「同一账号路径的规范化重定向」（最多 VERIFY_MAX_REDIRECTS 跳），
 *   其它跳转（首页/登录页）判 unreachable——防止把重定向后的首页 200 当成账号存在；
 * - 非 2xx / 网络错误 / 超时 → unreachable（取消时 verified=null）。
 * @param {{ site: string, url: string }} item 命中项。
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} options 选项。
 * @returns {Promise<{ verified: boolean|null, title: string|null, description: string|null, site_name: string|null, reason: string }>} 核验结果（含公开主页的标题/简介）。
 */
async function verifyHit(item, options) {
  let original
  try {
    original = new URL(item.url)
  } catch {
    return { verified: false, title: null, description: null, site_name: null, reason: '命中 URL 非法' }
  }
  let current = item.url
  let lastRedirect = 0
  try {
    for (let hop = 0; hop <= VERIFY_MAX_REDIRECTS; hop += 1) {
      const response = await requestText(current, {
        fetchImpl: options.fetchImpl,
        timeoutMs: VERIFY_TIMEOUT_MS,
        signal: options.signal,
        redirect: 'manual',
        headers: { 'user-agent': SHERLOCK_USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
        maxBytes: VERIFY_MAX_BYTES,
      })
      if (response.status >= 200 && response.status < 300) {
        const meta = extractHtmlMeta(response.text)
        const title = meta.title === '' ? extractHtmlTitle(response.text) : meta.title
        const hopText = hop === 0 ? '' : `经 ${hop} 次规范化重定向（${lastRedirect}）后 `
        return {
          verified: true,
          title: title === '' ? null : title,
          description: meta.description === '' ? null : meta.description,
          site_name: meta.siteName === '' ? null : meta.siteName,
          reason: `${hopText}HTTP ${response.status}`,
        }
      }
      if (isRedirectStatus(response.status)) {
        const location = response.headers?.get?.('location')
        if (typeof location !== 'string' || location === '') {
          return { verified: false, title: null, description: null, site_name: null, reason: `HTTP ${response.status} 无 Location` }
        }
        let next
        try {
          next = new URL(location, current)
        } catch {
          return { verified: false, title: null, description: null, site_name: null, reason: `HTTP ${response.status} Location 非法` }
        }
        if (!isSameProfileLocation(original, next)) {
          return {
            verified: false,
            title: null,
            description: null,
            site_name: null,
            reason: `HTTP ${response.status} 重定向到非账号路径（${next.href.slice(0, 160)}）`,
          }
        }
        lastRedirect = response.status
        current = next.href
        continue
      }
      return { verified: false, title: null, description: null, site_name: null, reason: `HTTP ${response.status}（禁重定向，非 2xx）` }
    }
    return { verified: false, title: null, description: null, site_name: null, reason: `规范化重定向超过 ${VERIFY_MAX_REDIRECTS} 跳` }
  } catch (error) {
    if (isAbortFailure(error)) return { verified: null, title: null, description: null, site_name: null, reason: '二次核验被取消' }
    return { verified: false, title: null, description: null, site_name: null, reason: describeError(error) }
  }
}

/**
 * 扫描一个用户名在各平台的账号。
 *
 * 返回统一 Evidence 信封：
 * - found[]：命中平台（status 固定 'claimed'）；
 * - counts：checked/claimed/available/unknown/waf/failed/illegal/skipped_invalid_regex 等；
 * - verify：二次核验统计；
 * - evidence[]：每个命中一条 makeEvidence()，source 形如 'sherlock:github'；
 * - aborted：exec.signal 取消时为 true（返回已拿到的部分结果）。
 *
 * @param {{
 *   username: string,
 *   site?: string|string[],
 *   timeoutMs?: number,
 *   verify?: boolean,
 *   maxResults?: number,
 *   max_results?: number,
 *   timeout_ms?: number,
 * }} input 输入（snake_case 字段为兼容别名）。
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   now?: number|(() => number),
 *   signal?: AbortSignal,
 *   manifestPath?: string,
 *   exclusionsPath?: string,
 * }} [deps] 依赖注入（测试用；manifestPath/exclusionsPath 可覆盖内置数据）。
 * @returns {Promise<Record<string, any>>} Evidence 信封；任何网络/数据异常都不抛错。
 */
export async function scanUsername(input = {}, deps = {}) {
  const startedAt = Date.now()
  const clock = () => {
    if (typeof deps?.now === 'function') return Number(deps.now())
    if (Number.isFinite(deps?.now)) return Number(deps.now)
    return Date.now()
  }
  const elapsed = () => Math.max(0, Date.now() - startedAt)

  const normalized = normalizeInput(input)
  if (normalized.ok !== true) {
    return createEnvelope({
      query: { username: typeof input?.username === 'string' ? input.username : null, site: null },
      summary: `未执行扫描：${normalized.error}`,
      warnings: normalized.warnings,
      error: normalized.error,
      elapsed_ms: elapsed(),
    })
  }
  const { username, site, timeoutMs, verify, maxResults } = normalized.value
  const requestedSites = normalizeSiteInput(site)
  const query = {
    username,
    site: requestedSites.length > 0 ? requestedSites : null,
    timeout_ms: timeoutMs,
    verify,
    max_results: maxResults,
  }

  /** @type {string[]} */
  const warnings = [...normalized.warnings]

  // 1) 站点库 / 排除名单（本地快照；缺失时软降级）。
  let manifest
  try {
    manifest = loadSiteManifest({ path: deps.manifestPath })
  } catch (error) {
    const message = `站点库加载失败：${describeError(error)}`
    return createEnvelope({ query, summary: `未执行扫描：${message}`, warnings, error: message, elapsed_ms: elapsed() })
  }
  const exclusions = loadExclusions({ path: deps.exclusionsPath })
  if (exclusions.warning !== null) warnings.push(exclusions.warning)

  // 2) 站点筛选（显式 site 放行 exclusions/NSFW，与 sherlock 一致）。
  const filtered = filterSites(manifest.sites, { site, exclusions: exclusions.names })
  if (filtered.missing.length > 0) {
    warnings.push(`未找到站点：${filtered.missing.slice(0, 20).join(', ')}${filtered.missing.length > 20 ? ' 等' : ''}`)
  }
  if (filtered.invalid.length > 0) {
    warnings.push(`${filtered.invalid.length} 个站点规则缺 url/urlMain，已跳过`)
  }
  if (filtered.plan.length === 0) {
    const message =
      filtered.requested.length > 0
        ? `未找到可用站点：${filtered.requested.slice(0, 20).join(', ')}`
        : '站点库筛选后为空'
    return createEnvelope({ query, summary: `未执行扫描：${message}`, warnings, error: message, elapsed_ms: elapsed() })
  }
  const sitesTotal = filtered.plan.length
  // 显式指定 site 会放行 exclusions/NSFW（与 sherlock 一致），但要提示这类站点误报风险高。
  if (filtered.mode === 'filtered') {
    const exclusionLower = new Set(exclusions.names.map((name) => name.toLowerCase()))
    const risky = filtered.plan.filter(({ name }) => exclusionLower.has(name.toLowerCase())).map(({ name }) => name)
    if (risky.length > 0) {
      warnings.push(`显式指定了误报排除名单中的站点：${risky.slice(0, 10).join(', ')}（上游因误报默认排除，请结合 verify 与人工核实）`)
    }
    const nsfw = filtered.plan.filter(({ info }) => info.isNSFW === true).map(({ name }) => name)
    if (nsfw.length > 0) warnings.push(`显式指定了 NSFW 站点：${nsfw.slice(0, 10).join(', ')}（默认扫描会排除）`)
  }

  // 3) 并发探测（每站软失败；取消时 mapLimit 停止发起新请求）。
  const probes = await mapLimit(
    filtered.plan,
    SCAN_CONCURRENCY,
    async (entry) => {
      try {
        return await probeSite(entry.name, entry.info, {
          username,
          fetchImpl: deps.fetchImpl,
          timeoutMs,
          signal: deps.signal,
        })
      } catch (error) {
        return {
          site: entry.name,
          url: null,
          probe_url: null,
          method: null,
          status: 'failed',
          http_status: null,
          detail: `探测流程异常：${describeError(error)}`,
          error: describeError(error),
          code: 'internal',
          confidence: null,
          elapsed_ms: 0,
        }
      }
    },
    { signal: deps.signal },
  )

  // 4) 汇总计数（checked = 取得响应的站点；failed/illegal/aborted 单列）。
  const counts = {
    manifest_total: manifest.count,
    sites_total: sitesTotal,
    checked: 0,
    claimed: 0,
    available: 0,
    unknown: 0,
    waf: 0,
    failed: 0,
    illegal: 0,
    skipped_invalid_regex: 0,
    excluded: filtered.excluded.length,
    nsfw_removed: filtered.nsfw_removed.length,
    aborted: 0,
  }
  /** @type {Map<string, Record<string, any>>} */
  const probeBySite = new Map()
  for (const probe of probes) {
    if (probe === undefined || probe === null || typeof probe.site !== 'string') continue
    probeBySite.set(probe.site, probe)
    switch (probe.status) {
      case 'claimed':
        counts.claimed += 1
        counts.checked += 1
        break
      case 'available':
        counts.available += 1
        counts.checked += 1
        break
      case 'waf':
        counts.waf += 1
        counts.checked += 1
        break
      case 'unknown':
        if (probe.code === 'invalid-regex') counts.skipped_invalid_regex += 1
        else counts.unknown += 1
        counts.checked += 1
        break
      case 'illegal':
        counts.illegal += 1
        break
      case 'aborted':
        counts.aborted += 1
        break
      default:
        counts.failed += 1
        break
    }
  }
  const aborted = deps.signal?.aborted === true || counts.aborted > 0
  if (aborted) warnings.push('扫描被取消（exec.signal），返回的是部分结果')
  if (counts.failed > 0) warnings.push(`${counts.failed} 个站点请求失败（超时/网络错误，已软降级）`)
  if (counts.waf > 0) warnings.push(`${counts.waf} 个站点命中 WAF 指纹，无法判定`)
  if (counts.unknown > 0) warnings.push(`${counts.unknown} 个站点规则异常或无法判定（详见 counts）`)

  // 5) 命中列表：先按置信度排序，再按 maxResults 截断（只核验实际返回的命中）。
  const hits = [...probeBySite.values()]
    .filter((probe) => probe.status === 'claimed')
    .map((probe) => ({
      site: probe.site,
      url: probe.url,
      status: 'claimed',
      http_status: probe.http_status,
      confidence: probe.confidence ?? 'medium',
      verified: /** @type {boolean|null} */ (null),
      title: /** @type {string|null} */ (null),
      description: /** @type {string|null} */ (null),
      site_name: /** @type {string|null} */ (null),
      enriched: false,
    }))
    .sort(compareFound)
  let truncated = false
  let kept = hits
  if (hits.length > maxResults) {
    kept = hits.slice(0, maxResults)
    truncated = true
    warnings.push(`命中 ${hits.length} 个平台，按 maxResults=${maxResults} 截断为前 ${maxResults} 个（按置信度排序）`)
  }

  // 6) 可选二次核验（GET + 禁重定向；2xx=verified，否则 unreachable）。
  const verifyInfo = new Map()
  const verifyCounts = { enabled: verify, checked: 0, verified: 0, unreachable: 0, skipped: 0, with_bio: 0 }
  if (verify && kept.length > 0) {
    const verifications = await mapLimit(
      kept,
      VERIFY_CONCURRENCY,
      (item) => verifyHit(item, { fetchImpl: deps.fetchImpl, signal: deps.signal }),
      { signal: deps.signal },
    )
    verifications.forEach((result, index) => {
      const item = kept[index]
      if (item === undefined) return
      const outcome = result ?? { verified: false, title: null, reason: '未知核验结果' }
      verifyInfo.set(item.site, outcome)
      if (outcome.verified === null) verifyCounts.skipped += 1
      else {
        verifyCounts.checked += 1
        item.verified = outcome.verified
        if (outcome.verified) {
          verifyCounts.verified += 1
          item.title = outcome.title ?? null
          item.description = outcome.description ?? null
          item.site_name = outcome.site_name ?? null
          item.enriched = true
          if (item.description !== null) verifyCounts.with_bio += 1
          item.confidence = 'high'
        } else {
          verifyCounts.unreachable += 1
          item.confidence = 'low'
        }
      }
    })
    for (const item of kept) {
      if (!verifyInfo.has(item.site)) verifyCounts.skipped += 1
    }
    if (verifyCounts.unreachable > 0) {
      warnings.push(
        `${verifyCounts.unreachable} 个命中二次核验不可达（可能是账号已删/改版/反爬/区域限制），置信度降为 low`,
      )
    }
    if (verifyCounts.skipped > 0) warnings.push(`${verifyCounts.skipped} 个命中未完成二次核验（取消）`)
  }

  // 7) Evidence：每个命中一条，detail 记录探测方式、HTTP 状态与核验结论。
  const evidence = kept.map((item) => {
    const probe = probeBySite.get(item.site)
    const parts = []
    if (probe !== undefined) {
      parts.push(`${probe.method ?? 'GET'} ${probe.probe_url ?? item.url} → HTTP ${item.http_status ?? '?'}`)
      if (typeof probe.detail === 'string' && probe.detail !== '') parts.push(probe.detail)
    } else {
      parts.push(`HTTP ${item.http_status ?? '?'}`)
    }
    const verification = verifyInfo.get(item.site)
    if (verification !== undefined) {
      if (verification.verified === true) {
        parts.push(`二次核验 GET ${item.url} ${verification.reason} 可达${item.title !== null ? `，标题「${item.title}」` : ''}`)
        if (item.description !== null) parts.push(`公开简介「${clampText(item.description, 200)}」`)
      } else if (verification.verified === false) {
        parts.push(`二次核验不可达：${verification.reason}`)
      } else {
        parts.push('二次核验未完成（取消）')
      }
    } else if (!verify) {
      parts.push('未做二次核验（verify=false）')
    }
    return makeEvidence({
      source: toEvidenceSource(item.site),
      url: item.url,
      now: clock(),
      confidence: item.confidence,
      detail: clampText(parts.join('；'), 600),
    })
  })

  // 8) 摘要。
  const finalAborted = aborted || deps.signal?.aborted === true
  if (finalAborted && !aborted) warnings.push('扫描在二次核验阶段被取消，部分结果未核验')
  const summaryParts = [
    `sherlock v${SHERLOCK_VERSION} 扫描 ${sitesTotal} 站`,
    `命中 ${counts.claimed} 个平台`,
    `checked ${counts.checked}（available ${counts.available} / waf ${counts.waf} / unknown ${counts.unknown}）`,
  ]
  if (counts.failed > 0 || counts.illegal > 0 || counts.skipped_invalid_regex > 0) {
    summaryParts.push(`failed ${counts.failed} / regex跳过 ${counts.illegal + counts.skipped_invalid_regex}`)
  }
  if (counts.excluded > 0 || counts.nsfw_removed > 0) {
    summaryParts.push(`exclusions 排除 ${counts.excluded}、NSFW 排除 ${counts.nsfw_removed}`)
  }
  if (verify) {
    summaryParts.push(
      `二次核验 ${verifyCounts.checked}：verified ${verifyCounts.verified} / unreachable ${verifyCounts.unreachable}；` +
        `${verifyCounts.with_bio} 个主页带公开简介`,
    )
    if (verifyCounts.with_bio > 0) summaryParts.push('公开简介已写入 found[].description，可用于人物画像')
  } else if (counts.claimed > 0) {
    summaryParts.push('未做二次核验：verify=true 可顺带抓取公开主页标题/简介，人物画像建议开启')
  }
  if (truncated) summaryParts.push(`结果按 maxResults=${maxResults} 截断`)
  if (finalAborted) summaryParts.push('已取消（部分结果）')
  summaryParts.push(`耗时 ${(elapsed() / 1000).toFixed(1)}s`)

  const envelope = createEnvelope({
    ok: true,
    query,
    summary: clampText(summaryParts.join('；'), 600),
    warnings,
    elapsed_ms: elapsed(),
    aborted: finalAborted,
  })
  envelope.counts = counts
  envelope.sites_total = sitesTotal
  envelope.found = kept
  envelope.evidence = evidence
  envelope.truncated = truncated
  envelope.verify = {
    enabled: verify,
    checked: verifyCounts.checked,
    verified: verifyCounts.verified,
    unreachable: verifyCounts.unreachable,
    skipped: verifyCounts.skipped,
    with_bio: verifyCounts.with_bio,
    timeout_ms: VERIFY_TIMEOUT_MS,
    concurrency: VERIFY_CONCURRENCY,
  }
  envelope.sherlock = { version: SHERLOCK_VERSION, commit: SHERLOCK_COMMIT }
  return envelope
}
