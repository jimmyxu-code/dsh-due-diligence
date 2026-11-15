/**
 * Sherlock 判定引擎（Node 原生移植，纯 ESM、无第三方依赖）。
 *
 * 来源与移植说明：
 * - 规则来自 Sherlock v0.16.2（commit c588d7c，MIT）：
 *   sherlock_project/sherlock.py 的判定逻辑 + resources/data.json 的站点规则；
 * - 数据文件：data/sherlock-sites.json（原始 data.json 的逐字节副本，加载时忽略 $schema）；
 *   误报排除：data/false-positive-exclusions.txt（上游 exclusions 分支 45 条快照）；
 * - 许可声明见 data/SHERLOCK-LICENSE.txt。
 *
 * 与 Python 版（sherlock.py）的已知差异（刻意为之，便于宿主软降级）：
 * 1. 站点库/排除名单固定为 v0.16.2 本地快照；Python 默认联网拉取
 *    data.sherlockproject.xyz 与 exclusions 分支。我们保证可复现、离线可用。
 * 2. 任何单站失败（网络/超时/页面过大/规则非法）都只记为 failed/unknown，
 *    不再像 Python 那样让整轮扫描崩溃（例如 Python 遇到未知 request_method 会
 *    raise RuntimeError；message 类型缺 errorMsg 会 TypeError）。
 * 3. regexCheck 用 JS RegExp 解释。已校验当前 data.json 的 95 条正则全部可在
 *    Node 24 编译；未来若含 JS 不支持的语法（如 Python 的 (?i) 内联标志），
 *    本站记为 skipped（unknown/invalid-regex）而不是中断扫描。
 * 4. WAF 指纹按字面量子串匹配（Python 用 re.search；指纹本身是页面原文片段）。
 * 5. exclusions 名单按站点名大小写不敏感匹配（Python 为精确 pop；当前 45 条均可
 *    精确命中，此差异仅为将来上游改名时更稳妥）。
 * 6. Node fetch 禁止 GET/HEAD 携带 body：若站点同时配置 request_payload 又未显式
 *    request_method，Python 会按 errorType 选 GET/HEAD 并带 body（实际不会工作），
 *    我们改为 POST 并补 content-type。当前 data.json 的 3 个 payload 站点均为 POST。
 * 7. 不支持代理（Python 的 --proxy）；P1 不需要，宿主可后续叠加。
 * 8. 超时默认 10s/站（插件契约），Python CLI 默认 60s；并发同为 20。
 * 9. 响应正文由 fetch 的 text() 解码；不再做 Python 的 encoding 猜测。
 *
 * 本模块除 loadSiteManifest / loadExclusions（只读本地文件并缓存）外均为纯函数；
 * 网络只经由 http.mjs 的 requestText，测试通过 fetchImpl 注入 mock。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describeError, isAbortFailure, requestText } from './http.mjs'

/** 移植自的 Sherlock 版本。 */
export const SHERLOCK_VERSION = '0.16.2'
/** 移植自的 Sherlock commit。 */
export const SHERLOCK_COMMIT = 'c588d7c8b476df9f9c84912a05d1430fb8cdcdae'
/** 单站探测默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 10000
/** 默认并发数（与 sherlock.py 的 max_workers=20 一致）。 */
export const DEFAULT_CONCURRENCY = 20
/** sherlock.py 使用的浏览器 UA（部分站点对默认 UA 返回错误页）。 */
export const SHERLOCK_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0'
/** 站点库 / 误报排除名单绝对路径（插件 data/ 目录）。 */
export const DATA_FILE_PATH = fileURLToPath(new URL('../data/sherlock-sites.json', import.meta.url))
export const EXCLUSIONS_FILE_PATH = fileURLToPath(new URL('../data/false-positive-exclusions.txt', import.meta.url))

/** sherlock 支持的三种判定方式。 */
export const ERROR_TYPES = Object.freeze(['message', 'status_code', 'response_url'])
/** sherlock 支持的 HTTP 方法。 */
export const SUPPORTED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT'])

/**
 * WAF 指纹（逐条抄自 sherlock.py 的 WAFHitMsgs，注释保留上游标注的目标与日期）。
 * Python 用 re.search；这里按字面量子串 includes 匹配（指纹即页面原文片段）。
 */
export const WAF_FINGERPRINTS = Object.freeze([
  // 2024-05-13 Cloudflare
  {
    label: 'Cloudflare challenge (2024-05-13)',
    needle:
      '.loading-spinner{visibility:hidden}body.no-js .challenge-running{display:none}body.dark{background-color:#222;color:#d9d9d9}body.dark a{color:#fff}body.dark a:hover{color:#ee730a;text-decoration:underline}body.dark .lds-ring div{border-color:#999 transparent transparent}body.dark .font-red{color:#b20f03}body.dark',
  },
  // 2024-11-11 Cloudflare error page
  { label: 'Cloudflare error page (2024-11-11)', needle: '<span id="challenge-error-text">' },
  // 2024-11-11 Cloudfront (AWS)
  { label: 'AWS Cloudfront WAF (2024-11-11)', needle: 'AwsWafIntegration.forceRefreshToken' },
  // 2024-04-09 PerimeterX / Human Security
  {
    label: 'PerimeterX / Human Security (2024-04-09)',
    needle: '{return l.onPageView}}),Object.defineProperty(r,"perimeterxIdentifiers",{enumerable:',
  },
])

/** @typedef {'claimed'|'available'|'illegal'|'waf'|'unknown'|'failed'|'aborted'} SherlockStatus */
/** @typedef {'high'|'medium'|'low'} Confidence */

/** 站点库与排除名单的内存缓存（同一路径只读一次）。 */
const manifestCache = new Map()
const exclusionsCache = new Map()

/** 读取内置站点库（失败抛错由调用方转软失败）；按路径缓存。
 * @param {{ path?: string }} [options] 可覆盖默认路径（测试用）。
 * @returns {{ sites: Record<string, any>, count: number, path: string }} 站点库。 */
export function loadSiteManifest(options = {}) {
  const path = options.path ?? DATA_FILE_PATH
  const cached = manifestCache.get(path)
  if (cached !== undefined) return cached
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`站点库格式非法（应为 JSON 对象）：${path}`)
  }
  delete raw.$schema
  const count = Object.keys(raw).length
  if (count === 0) throw new Error(`站点库为空：${path}`)
  const result = { sites: raw, count, path }
  manifestCache.set(path, result)
  return result
}

/** 读取内置误报排除名单；读不到时只返回 warning，不抛错（长尾软失败）；按路径缓存。
 * @param {{ path?: string }} [options] 可覆盖默认路径（测试用）。
 * @returns {{ names: string[], path: string, warning: string|null }} 排除名单。 */
export function loadExclusions(options = {}) {
  const path = options.path ?? EXCLUSIONS_FILE_PATH
  const cached = exclusionsCache.get(path)
  if (cached !== undefined) return cached
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const result = {
      names: [],
      path,
      warning: `无法读取误报排除名单（${path}）：${describeError(error)}；本次未做 exclusions 过滤`,
    }
    exclusionsCache.set(path, result)
    return result
  }
  const names = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const result = { names, path, warning: null }
  exclusionsCache.set(path, result)
  return result
}

/** 清空本地数据缓存（测试隔离用）。 */
export function clearSherlockDataCache() {
  manifestCache.clear()
  exclusionsCache.clear()
}

/** 递归把字符串/对象/数组里的 "{}" 替换成 username（对应 Python interpolate_string）。
 * @template T @param {T} input 站点规则片段 @param {string} username 已做 URL 空格转义的用户名
 * @returns {T} 替换后的副本。 */
export function interpolateString(input, username) {
  if (typeof input === 'string') return /** @type {T} */ (input.split('{}').join(username))
  if (Array.isArray(input)) return /** @type {T} */ (input.map((item) => interpolateString(item, username)))
  if (input !== null && typeof input === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, value] of Object.entries(input)) out[key] = interpolateString(value, username)
    return /** @type {T} */ (out)
  }
  return input
}

/** 归一化 site 参数：字符串 / 数组 / 逗号分隔都接受，去空、保序。
 * @param {unknown} site 原始 site 输入。 @returns {string[]} 站点名列表。 */
export function normalizeSiteInput(site) {
  if (site === undefined || site === null) return []
  const list = Array.isArray(site) ? site : [site]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    for (const part of item.split(',')) {
      const name = part.trim()
      if (name !== '' && !out.includes(name)) out.push(name)
    }
  }
  return out
}

/** 站点规则是否可用（sites.py 要求 urlMain + url 必填）。 */
function isUsableSite(info) {
  return (
    info !== null &&
    typeof info === 'object' &&
    typeof info.url === 'string' &&
    info.url.trim() !== '' &&
    typeof info.urlMain === 'string' &&
    info.urlMain.trim() !== ''
  )
}

/**
 * 站点筛选（对应 SitesInformation + remove_nsfw_sites + --site 逻辑）。
 * - 显式 site：只扫指定站点，不受 exclusions / NSFW 过滤影响（do_not_exclude /
 *   do_not_remove），站点名大小写不敏感；- 未指定 site：先剔 exclusions（45 条），
 *   再剔 NSFW（19 个）；- 缺字段站点归入 invalid，跳过而不中断。
 * @param {Record<string, any>} sites 站点库（不含 $schema）。
 * @param {{
 *   site?: unknown,
 *   exclusions?: string[],
 *   excludeNsfw?: boolean,
 *   ignoreExclusions?: boolean,
 * }} [options] 筛选选项。
 * @returns {{
 *   plan: { name: string, info: any }[],
 *   mode: 'full'|'filtered',
 *   requested: string[],
 *   missing: string[],
 *   excluded: string[],
 *   nsfw_removed: string[],
 *   invalid: string[],
 *   manifest_total: number,
 * }} 筛选结果。
 */
export function filterSites(sites, options = {}) {
  const manifest = sites !== null && typeof sites === 'object' ? sites : {}
  const names = Object.keys(manifest).filter((name) => name !== '$schema')
  const requested = normalizeSiteInput(options.site)
  const exclusions = new Set(
    (Array.isArray(options.exclusions) ? options.exclusions : [])
      .map((name) => String(name).trim().toLowerCase())
      .filter((name) => name !== ''),
  )
  const excludeNsfw = options.excludeNsfw !== false
  const ignoreExclusions = options.ignoreExclusions === true

  const plan = []
  const missing = []
  const excluded = []
  const nsfwRemoved = []
  const invalid = []

  if (requested.length > 0) {
    const canonicalByLower = new Map(names.map((name) => [name.toLowerCase(), name]))
    const seen = new Set()
    for (const wanted of requested) {
      const canonical = canonicalByLower.get(wanted.toLowerCase())
      if (canonical === undefined) {
        missing.push(wanted)
        continue
      }
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const info = manifest[canonical]
      if (!isUsableSite(info)) {
        invalid.push(canonical)
        continue
      }
      plan.push({ name: canonical, info })
    }
    return {
      plan,
      mode: 'filtered',
      requested,
      missing,
      excluded,
      nsfw_removed: nsfwRemoved,
      invalid,
      manifest_total: names.length,
    }
  }

  for (const name of names) {
    const info = manifest[name]
    if (!isUsableSite(info)) {
      invalid.push(name)
      continue
    }
    if (!ignoreExclusions && exclusions.has(name.toLowerCase())) {
      excluded.push(name)
      continue
    }
    if (excludeNsfw && info.isNSFW === true) {
      nsfwRemoved.push(name)
      continue
    }
    plan.push({ name, info })
  }
  return {
    plan,
    mode: 'full',
    requested,
    missing,
    excluded,
    nsfw_removed: nsfwRemoved,
    invalid,
    manifest_total: names.length,
  }
}

/** WAF 指纹识别（对应 sherlock.py 的 WAFHitMsgs 检查）。
 * @param {unknown} text 响应正文 @returns {{ hit: boolean, label: string|null }} 命中情况。 */
export function detectWaf(text) {
  if (typeof text !== 'string' || text === '') return { hit: false, label: null }
  for (const fingerprint of WAF_FINGERPRINTS) {
    if (text.includes(fingerprint.needle)) return { hit: true, label: fingerprint.label }
  }
  return { hit: false, label: null }
}

/** 归一化 errorType（sherlock 允许字符串或数组）；含未知类型返回 null。
 * @param {unknown} value 原始 errorType。 @returns {string[]|null} 归一化结果。 */
export function normalizeErrorTypes(value) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) return null
  for (const type of list) {
    if (typeof type !== 'string' || !ERROR_TYPES.includes(type)) return null
  }
  return list
}

/** 归一化 errorCode（sherlock 允许整数或整数数组）。
 * @param {unknown} value 原始 errorCode。 @returns {number[]} 状态码列表。 */
export function normalizeErrorCodes(value) {
  if (Number.isInteger(value)) return [value]
  if (!Array.isArray(value)) return []
  return value.filter((code) => Number.isInteger(code))
}

/**
 * 判定一条成功响应（对应 sherlock.py 中 WAF → errorType 分支）。
 * 顺序与 Python 一致：WAF 指纹 → message → status_code → response_url，后两者只在
 * 前序判定不是 AVAILABLE 时覆盖。差异：未知 errorType / message 缺 errorMsg 只记
 * unknown 并给 detail，不抛错。
 * @param {any} siteInfo 站点规则 @param {{ status: number, text?: string }} response 响应
 * @returns {{ status: SherlockStatus, http_status: number|null, detail: string,
 *   decided_by: string|null, confidence: Confidence|null }} 判定结果。
 */
export function judgeResponse(siteInfo, response) {
  const httpStatus = Number.isFinite(response?.status) ? response.status : null
  const text = typeof response?.text === 'string' ? response.text : ''
  const base = { http_status: httpStatus, decided_by: null, confidence: null }

  const waf = detectWaf(text)
  if (waf.hit) {
    return { ...base, status: 'waf', detail: `WAF 指纹命中：${waf.label}` }
  }

  const errorTypes = normalizeErrorTypes(siteInfo?.errorType)
  if (errorTypes === null) {
    return { ...base, status: 'unknown', detail: `未知 errorType：${JSON.stringify(siteInfo?.errorType)}` }
  }

  let status = /** @type {SherlockStatus} */ ('unknown')
  let detail = '未产生判定'
  let decidedBy = null

  if (errorTypes.includes('message')) {
    const errors = siteInfo?.errorMsg
    const list = Array.isArray(errors) ? errors : errors === undefined || errors === null ? null : [errors]
    if (list === null || list.length === 0 || list.every((item) => typeof item !== 'string' || item === '')) {
      return { ...base, status: 'unknown', detail: 'message 判定缺少有效的 errorMsg 规则' }
    }
    const matched = list.find((item) => typeof item === 'string' && item !== '' && text.includes(item))
    if (matched === undefined) {
      status = 'claimed'
      detail = `errorMsg 未命中（检查 ${list.length} 条特征）`
    } else {
      status = 'available'
      detail = `errorMsg 命中：${matched.slice(0, 120)}`
    }
    decidedBy = 'message'
  }

  if (errorTypes.includes('status_code') && status !== 'available') {
    status = 'claimed'
    decidedBy = 'status_code'
    const codes = normalizeErrorCodes(siteInfo?.errorCode)
    if (codes.length > 0 && httpStatus !== null && codes.includes(httpStatus)) {
      status = 'available'
      detail = `HTTP ${httpStatus} 命中 errorCode [${codes.join(',')}]`
    } else if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
      status = 'available'
      detail = httpStatus === null ? '未取得有效 HTTP 状态码' : `HTTP ${httpStatus} 非 2xx`
    } else {
      detail = codes.length > 0 ? `HTTP ${httpStatus} 为 2xx 且不在 errorCode [${codes.join(',')}]` : `HTTP ${httpStatus} 为 2xx`
    }
  }

  if (errorTypes.includes('response_url') && status !== 'available') {
    decidedBy = 'response_url'
    if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
      status = 'claimed'
      detail = `禁重定向下 HTTP ${httpStatus} 为 2xx`
    } else {
      status = 'available'
      detail = `禁重定向下 HTTP ${httpStatus ?? '?'} 非 2xx`
    }
  }

  // 判定置信度：response_url（禁重定向且 2xx）是相对最硬的信号；message/status_code
  // 都可能受 soft-404 影响，统一先记 medium，由 username.mjs 的二次核验再升降级。
  const confidence = status === 'claimed' ? (decidedBy === 'response_url' ? 'high' : 'medium') : null
  return { ...base, status, detail, decided_by: decidedBy, confidence }
}

/** 检查用户名是否满足站点 regexCheck。
 * @param {any} siteInfo 站点规则 @param {string} username 原始用户名
 * @returns {'none'|'ok'|'mismatch'|'invalid'} 检查结果。 */
export function siteRegexState(siteInfo, username) {
  const pattern = siteInfo?.regexCheck
  if (typeof pattern !== 'string' || pattern === '') return 'none'
  let regex
  try {
    regex = new RegExp(pattern)
  } catch {
    return 'invalid'
  }
  return regex.test(username) ? 'ok' : 'mismatch'
}

/**
 * 构造单站探测请求（纯函数，不联网）。
 * @param {string} siteName 站点名 @param {any} siteInfo 站点规则
 * @param {string} username 原始用户名（内部按 sherlock 规则把空格转 %20）
 * @returns {{ ok: true, url: string, probe_url: string, method: string,
 *   headers: Record<string, string>, body: string|undefined,
 *   redirect: 'follow'|'manual', error_types: string[] } | { ok: false, error: string }}
 */
export function buildProbeRequest(siteName, siteInfo, username) {
  if (!isUsableSite(siteInfo)) {
    return { ok: false, error: `站点 ${siteName} 缺少 url/urlMain 字段` }
  }
  const errorTypes = normalizeErrorTypes(siteInfo.errorType)
  if (errorTypes === null) {
    return { ok: false, error: `站点 ${siteName} 的 errorType 非法：${JSON.stringify(siteInfo.errorType)}` }
  }
  const encoded = String(username).split(' ').join('%20')
  const url = /** @type {string} */ (interpolateString(siteInfo.url, encoded))
  const probeUrl =
    typeof siteInfo.urlProbe === 'string' && siteInfo.urlProbe !== ''
      ? /** @type {string} */ (interpolateString(siteInfo.urlProbe, encoded))
      : url

  const configuredMethod =
    typeof siteInfo.request_method === 'string' ? siteInfo.request_method.toUpperCase() : null
  if (configuredMethod !== null && !SUPPORTED_METHODS.includes(configuredMethod)) {
    return { ok: false, error: `站点 ${siteName} 使用了不支持的 request_method：${siteInfo.request_method}` }
  }
  let method =
    configuredMethod ??
    (errorTypes.includes('status_code') ? 'HEAD' : 'GET')

  // 与 Python 的差异见文件头第 6 条：Node fetch 禁止 GET/HEAD 带 body。
  let body
  const payload = siteInfo.request_payload
  if (payload !== undefined && payload !== null) {
    body = JSON.stringify(interpolateString(payload, encoded))
    if (method === 'GET' || method === 'HEAD') method = 'POST'
  }

  /** @type {Record<string, string>} */
  const headers = { 'user-agent': SHERLOCK_USER_AGENT }
  if (siteInfo.headers !== null && typeof siteInfo.headers === 'object' && !Array.isArray(siteInfo.headers)) {
    for (const [key, value] of Object.entries(siteInfo.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  if (body !== undefined) {
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    if (!hasContentType) headers['content-type'] = 'application/json'
  }

  return {
    ok: true,
    url,
    probe_url: probeUrl,
    method,
    headers,
    body,
    redirect: errorTypes.includes('response_url') ? 'manual' : 'follow',
    error_types: errorTypes,
  }
}

/**
 * 探测单个站点（单站等价流程：regexCheck → 构造请求 → 判定）；网络失败/超时/取消/
 * 规则非法全部软失败，返回结构化结果而不抛错。
 * @param {string} siteName 站点名 @param {any} siteInfo 站点规则
 * @param {{ username: string, fetchImpl?: typeof fetch, timeoutMs?: number,
 *   signal?: AbortSignal, maxBytes?: number }} options 探测选项
 * @returns {Promise<{ site: string, url: string|null, probe_url: string|null,
 *   method: string|null, status: SherlockStatus, http_status: number|null, detail: string,
 *   error: string|null, code: string|null, confidence: Confidence|null, elapsed_ms: number }>}
 */
export async function probeSite(siteName, siteInfo, options) {
  const startedAt = Date.now()
  const username = typeof options?.username === 'string' ? options.username : ''
  const base = {
    site: siteName,
    url: null,
    probe_url: null,
    method: null,
    http_status: null,
    error: null,
    code: null,
    confidence: null,
    elapsed_ms: 0,
  }
  const finish = (extra) => ({ ...base, ...extra, elapsed_ms: Math.max(0, Date.now() - startedAt) })

  if (username.trim() === '') return finish({ status: 'unknown', detail: '用户名为空', code: 'config' })

  const regexState = siteRegexState(siteInfo, username)
  if (regexState === 'invalid') {
    return finish({ status: 'unknown', detail: '站点 regexCheck 无法编译，已跳过', code: 'invalid-regex' })
  }
  if (regexState === 'mismatch') {
    return finish({
      status: 'illegal',
      detail: '用户名不符合该站 regexCheck（sherlock 记为 ILLEGAL，不发请求）',
      code: 'illegal',
    })
  }

  const request = buildProbeRequest(siteName, siteInfo, username)
  if (request.ok !== true) {
    return finish({ status: 'unknown', detail: request.error, error: request.error, code: 'config' })
  }

  try {
    const response = await requestText(request.probe_url, {
      fetchImpl: options?.fetchImpl,
      timeoutMs: Number.isFinite(options?.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      signal: options?.signal,
      headers: request.headers,
      method: request.method,
      body: request.body,
      redirect: request.redirect,
      maxBytes: Number.isFinite(options?.maxBytes) ? options.maxBytes : undefined,
    })
    const verdict = judgeResponse(siteInfo, response)
    return finish({
      url: request.url,
      probe_url: request.probe_url,
      method: request.method,
      status: verdict.status,
      http_status: verdict.http_status,
      detail: verdict.detail,
      confidence: verdict.confidence,
      code: verdict.status === 'unknown' ? 'config' : null,
    })
  } catch (error) {
    if (isAbortFailure(error)) {
      return finish({ status: 'aborted', detail: '请求被取消', error: null, code: 'aborted' })
    }
    const message = describeError(error)
    return finish({
      status: 'failed',
      detail: `请求失败：${message}`,
      error: message,
      code: typeof error?.code === 'string' ? error.code : 'network',
    })
  }
}

/** 站点名 → Evidence.source，形如 `sherlock:github`、`sherlock:apple-developer`。
 * @param {string} siteName 站点名 @returns {string} 证据来源标识。 */
export function toEvidenceSource(siteName) {
  const slug = String(siteName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `sherlock:${slug === '' ? 'unknown' : slug}`
}
