/**
 * 证据（Evidence）工具：所有 dd_* 工具共享的统一结论元数据。
 *
 * 纯函数模块：不 import DSH / 不联网，保证 `node --test` 在普通 Node 下可测。
 *
 * @typedef {'high'|'medium'|'low'} Confidence
 * @typedef {{
 *   source: string,
 *   url: string|null,
 *   fetched_at: string,
 *   confidence: Confidence,
 *   detail: string,
 * }} Evidence
 */

/** 置信度从高到低。 */
export const CONFIDENCE_ORDER = Object.freeze(['high', 'medium', 'low'])

/**
 * 取两个置信度里更保守的一个。
 * @param {Confidence|undefined} a 置信度。
 * @param {Confidence|undefined} b 置信度。
 * @returns {Confidence} 更低的一档。
 */
export function combineConfidence(a, b) {
  const left = CONFIDENCE_ORDER.indexOf(a ?? '')
  const right = CONFIDENCE_ORDER.indexOf(b ?? '')
  if (left === -1 && right === -1) return 'medium'
  if (left === -1) return CONFIDENCE_ORDER[right]
  if (right === -1) return CONFIDENCE_ORDER[left]
  return CONFIDENCE_ORDER[Math.max(left, right)]
}

/**
 * 把时间戳转成 ISO 字符串（UTC）。
 * @param {number} [now] 毫秒时间戳。
 * @returns {string} ISO 时间。
 */
export function isoNow(now = Date.now()) {
  const value = Number.isFinite(now) ? now : Date.now()
  return new Date(value).toISOString()
}

/**
 * 构造一条证据。source 为空时抛错，避免出现无来源结论。
 * @param {{
 *   source: string,
 *   url?: string|null,
 *   now?: number,
 *   confidence?: Confidence,
 *   detail?: string,
 * }} input 证据字段。
 * @returns {Evidence} 证据。
 */
export function makeEvidence(input) {
  const source = typeof input?.source === 'string' ? input.source.trim() : ''
  if (source === '') throw new Error('evidence source is required')
  const url = typeof input?.url === 'string' && input.url.trim() !== '' ? input.url.trim() : null
  const confidence = CONFIDENCE_ORDER.includes(input?.confidence) ? input.confidence : 'medium'
  return {
    source,
    url,
    fetched_at: isoNow(input?.now),
    confidence,
    detail: typeof input?.detail === 'string' ? input.detail.slice(0, 600) : '',
  }
}

/**
 * 去重证据（按 source + url + detail）。
 * @param {Evidence[]} list 证据列表。
 * @returns {Evidence[]} 去重结果。
 */
export function dedupeEvidence(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue
    const key = `${item.source ?? ''}\u0000${item.url ?? ''}\u0000${item.detail ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 按置信度统计。
 * @param {Evidence[]} list 证据列表。
 * @returns {{ high: number, medium: number, low: number, total: number }} 统计。
 */
export function countByConfidence(list) {
  const counts = { high: 0, medium: 0, low: 0, total: 0 }
  for (const item of Array.isArray(list) ? list : []) {
    if (item === null || typeof item !== 'object') continue
    counts.total += 1
    if (item.confidence === 'high') counts.high += 1
    else if (item.confidence === 'low') counts.low += 1
    else counts.medium += 1
  }
  return counts
}

/**
 * 列出证据里出现过的数据源（保持首次出现顺序）。
 * @param {Evidence[]} list 证据列表。
 * @returns {string[]} 数据源名。
 */
export function listSources(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const source = item?.source
    if (typeof source !== 'string' || source === '' || seen.has(source)) continue
    seen.add(source)
    out.push(source)
  }
  return out
}

/**
 * 按置信度排序（high 在前），同级保持原顺序。
 * @param {Evidence[]} list 证据列表。
 * @returns {Evidence[]} 新数组。
 */
export function sortByConfidence(list) {
  const rank = { high: 0, medium: 1, low: 2 }
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => (rank[a?.confidence] ?? 1) - (rank[b?.confidence] ?? 1))
}

/**
 * 去掉字符串数组里的空值、重复项并限制长度。
 * @param {unknown[]} list 候选列表。
 * @param {number} [max=20] 最多保留条数。
 * @returns {string[]} 干净列表。
 */
export function dedupeStrings(list, max = 20) {
  const out = []
  const seen = new Set()
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * 截断长文本并加省略号。
 * @param {unknown} value 任意值。
 * @param {number} [max=600] 最大字符数。
 * @returns {string} 字符串。
 */
export function clampText(value, max = 600) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 从 HTML 里抽 <title>，用于二次核验与证据 detail。
 * @param {string} html HTML 文本。
 * @returns {string} 标题；找不到返回空串。
 */
export function extractHtmlTitle(html) {
  if (typeof html !== 'string') return ''
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  if (match === null) return ''
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 200)
}

/**
 * 从 HTML `<meta>` 里抽公开简介（description / og:description / og:site_name）。
 * 用于把「账号存在」升级成「公开主页上写了什么」，不抓正文、不登录。
 * @param {string} html HTML 文本。
 * @returns {{ title: string, description: string, siteName: string }} 公开元信息。
 */
export function extractHtmlMeta(html) {
  const empty = { title: '', description: '', siteName: '' }
  if (typeof html !== 'string' || html === '') return empty
  const title = extractHtmlTitle(html)
  const collect = (pattern) => {
    const match = html.match(pattern)
    if (match === null) return ''
    const value = (match[1] ?? '').replace(/\s+/g, ' ').trim()
    return value.length > 300 ? `${value.slice(0, 299)}…` : value
  }
  const description =
    collect(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    collect(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i)
  const siteName =
    collect(/<meta[^>]+(?:name|property)=["'](?:og:site_name|application-name)["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    collect(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:site_name|application-name)["'][^>]*>/i)
  return { title, description, siteName }
}
