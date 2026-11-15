/**
 * dd_name：真名 / 人名维度适配层（纯 ESM、无第三方依赖）。
 *
 * 做三件事：
 * 1) Wikidata wbsearchentities 查同名实体候选（含别名），用于消歧与人名定位；
 * 2) 生成 Google / Bing / Baidu / Brave 搜索链接（只给链接，不抓取）；
 * 3) 生成可直接交给 web_search 的查询组（web_queries），覆盖简介/采访/作品/机构/教育，
 *    让模型能继续做「人物画像」而不是停在真伪判断。
 * 名字疑似公司/组织时返回 company_hint=true，并提示改用 dd_company。
 *
 * 统一信封 {ok, tool, query, summary, evidence, warnings, error, wikidata, search_links,
 * web_queries, company_hint, suggestions}；Wikidata 失败软降级，不抛网络错误。
 */

import { clampText, dedupeEvidence, makeEvidence } from './evidence.mjs'
import { fetchJson } from './http.mjs'
import { looksLikeCompanyName } from './company.mjs'

/** 工具名（DSH tool 层按此注册）。 */
export const NAME_TOOL = 'dd_name'

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
const MAX_NAME_LENGTH = 120
const MAX_WIKIDATA_ITEMS = 10
const MAX_ALIAS_ITEMS = 5
const LANG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i

/** 搜索入口定义（只生成链接，不抓取）。 */
const SEARCH_ENGINES = [
  { engine: 'Google', base: 'https://www.google.com/search?q=' },
  { engine: 'Bing', base: 'https://www.bing.com/search?q=' },
  { engine: 'Baidu', base: 'https://www.baidu.com/s?wd=' },
  { engine: 'Brave', base: 'https://search.brave.com/search?q=' },
]

/** 生成四个搜索引擎链接。 */
function buildSearchLinks(name) {
  const encoded = encodeURIComponent(name)
  return SEARCH_ENGINES.map((item) => ({ engine: item.engine, url: `${item.base}${encoded}` }))
}

/** 归一化语言参数：只接受形如 zh / en / zh-hans 的值，默认 zh。 */
function normalizeLang(value) {
  if (typeof value !== 'string') return 'zh'
  const text = value.trim().toLowerCase()
  return LANG_PATTERN.test(text) ? text : 'zh'
}

/** Wikidata 查询并解析为 {id, label, description, url} 列表；失败软返回。 */
async function searchWikidata(name, lang, deps) {
  const url = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=${encodeURIComponent(lang)}&format=json&limit=${MAX_WIKIDATA_ITEMS}&type=item&origin=*`
  const res = await fetchJson(url, {
    fetchImpl: deps.fetchImpl,
    signal: deps.signal,
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return { ok: false, error: `Wikidata 查询失败：${res.error}`, items: [] }
  const items = []
  const seen = new Set()
  for (const item of Array.isArray(res.data?.search) ? res.data.search : []) {
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (!/^Q\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const label = (typeof item.label === 'string' && item.label.trim()) || item?.display?.label?.value || item?.match?.text || ''
    const cleanLabel = String(label).trim()
    if (cleanLabel === '') continue
    const description = clampText(item?.description ?? item?.display?.description?.value ?? '', 160)
    items.push({ id, label: cleanLabel, description, url: `https://www.wikidata.org/wiki/${encodeURIComponent(id)}` })
  }
  return { ok: true, error: null, items, url }
}

/**
 * 取候选实体的别名（Wikidata wbgetentities），用于消歧与扩展搜索词；失败软返回。
 * @param {Array<{id: string}>} items 候选实体。
 * @param {string} lang 语言。
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} deps 依赖。
 * @returns {Promise<{ ok: boolean, byId: Map<string, string[]>, error: string|null }>} 别名映射。
 */
async function fetchAliases(items, lang, deps) {
  const ids = (Array.isArray(items) ? items : []).slice(0, MAX_ALIAS_ITEMS).map((item) => item.id).filter((id) => /^Q\d+$/.test(id))
  if (ids.length === 0) return { ok: true, byId: new Map(), error: null }
  const languages = [...new Set([lang, 'en'])].join('|')
  const url =
    `${WIKIDATA_API}?action=wbgetentities&ids=${ids.join('|')}&props=aliases|labels|descriptions` +
    `&languages=${encodeURIComponent(languages)}&format=json&origin=*`
  const res = await fetchJson(url, { fetchImpl: deps.fetchImpl, signal: deps.signal, headers: { accept: 'application/json' } })
  if (!res.ok) return { ok: false, byId: new Map(), error: `Wikidata 别名查询失败：${res.error}` }
  const byId = new Map()
  for (const id of ids) {
    const entity = res.data?.entities?.[id]
    const values = []
    for (const language of [lang, 'en']) {
      for (const alias of Array.isArray(entity?.aliases?.[language]) ? entity.aliases[language] : []) {
        if (typeof alias?.value === 'string' && alias.value.trim() !== '') values.push(alias.value.trim())
      }
    }
    byId.set(id, [...new Set(values)].slice(0, 8))
  }
  return { ok: true, byId, error: null }
}

/**
 * 生成可直接交给 web_search 的查询组（人物画像用），失败时退化为基础查询。
 * @param {string} name 姓名。
 * @param {string} lang 语言。
 * @param {Array<{ description?: string, aliases?: string[] }>} items Wikidata 候选。
 * @returns {string[]} 查询列表。
 */
function buildWebQueries(name, lang, items) {
  const zh = String(lang).toLowerCase().startsWith('zh')
  const queries = [
    zh ? `${name} 简介 履历` : `${name} bio profile`,
    zh ? `${name} 采访 访谈 演讲` : `${name} interview talk`,
    zh ? `${name} 论文 作品 项目` : `${name} publications projects`,
    zh ? `${name} 公司 机构 任职` : `${name} company organization`,
    zh ? `${name} 教育 毕业 大学` : `${name} education university`,
  ]
  const first = Array.isArray(items) ? items[0] : undefined
  if (typeof first?.description === 'string' && first.description !== '') queries.push(`${name} ${first.description}`)
  const alias = (Array.isArray(items) ? items : [])
    .flatMap((item) => (Array.isArray(item?.aliases) ? item.aliases : []))
    .find((value) => typeof value === 'string' && value !== '' && value !== name)
  if (alias !== undefined) queries.push(`${alias} 简介 履历`, `${alias} 采访 报道`)
  const seen = new Set()
  const out = []
  for (const query of queries) {
    const text = query.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= 8) break
  }
  return out
}

/** 汇总建议列表。 */
function buildSuggestions(name, companyHint, wikidata, wikidataOk) {
  const suggestions = []
  if (companyHint) {
    suggestions.push(`「${name}」疑似公司/组织名称：建议改用 dd_company 查工商/LEI/SEC，或 dd_domain 查官网。`)
  }
  if (wikidataOk && wikidata.length > 1) {
    suggestions.push(`Wikidata 命中 ${wikidata.length} 个同名实体，请结合职业、国籍、出生日期、活跃领域排除重名。`)
  }
  if (wikidataOk && wikidata.length === 0) {
    suggestions.push('Wikidata 无人名实体命中：属常见情况（普通人通常没有条目），可改用搜索链接人工核验。')
  }
  if (!wikidataOk) suggestions.push('Wikidata 不可用：本次仅生成搜索链接，可稍后重试。')
  suggestions.push('用 dd_username 查该名字可能对应的网名 / handle（公开账号足迹）。')
  suggestions.push('搜索链接只提供入口，本工具不抓取网页内容；结果请引用来源 URL 并区分事实与推断。')
  suggestions.push('公开搜索存在重名与不实信息，涉及个人隐私时请确认合法用途与授权范围。')
  return suggestions.slice(0, 6)
}

/**
 * 真名 / 人名维度入口。
 * @param {{ name?: string, lang?: string }} input 姓名与语言（默认 zh）。
 * @param {{ fetchImpl?: typeof fetch, now?: number, signal?: AbortSignal }} [deps] 依赖注入（测试注入 mock fetch）。
 * @returns {Promise<object>} 统一 Evidence 信封 + wikidata / search_links / company_hint / suggestions。
 */
export async function investigateName(input, deps = {}) {
  const name = typeof input?.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : ''
  const lang = normalizeLang(input?.lang)
  const companyHint = looksLikeCompanyName(name)
  const base = {
    ok: false, tool: NAME_TOOL, query: name, lang, summary: '', evidence: [], warnings: [], error: null,
    wikidata: [], search_links: [], web_queries: [], company_hint: companyHint, suggestions: [],
  }
  if (name === '') {
    return { ...base, summary: '缺少姓名。', error: 'name is required', suggestions: ['请提供需要调查的真名后重试。'] }
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ...base, summary: '姓名过长。', error: `name too long (max ${MAX_NAME_LENGTH} chars)`, suggestions: ['请缩短为完整姓名后重试。'] }
  }
  if (deps?.signal?.aborted === true) return { ...base, summary: '请求已被取消。', error: 'request aborted by caller' }

  let result
  try {
    result = await searchWikidata(name, lang, deps)
  } catch (error) {
    result = { ok: false, error: `Wikidata 查询异常：${error instanceof Error ? error.message : String(error)}`, items: [] }
  }
  const searchLinks = buildSearchLinks(name)
  const warnings = []
  const evidence = []
  if (result.ok && result.items.length > 0) {
    try {
      const aliasResult = await fetchAliases(result.items, lang, deps)
      if (aliasResult.ok) {
        for (const item of result.items) item.aliases = aliasResult.byId.get(item.id) ?? []
      } else {
        warnings.push(aliasResult.error)
        for (const item of result.items) item.aliases = []
      }
    } catch (error) {
      warnings.push(`Wikidata 别名查询异常：${error instanceof Error ? error.message : String(error)}`)
      for (const item of result.items) item.aliases = []
    }
  }
  if (result.ok) {
    if (result.items.length === 0) warnings.push('Wikidata 未命中（普通人通常没有条目，属正常）。')
    else {
      evidence.push(
        makeEvidence({
          source: 'Wikidata',
          url: result.url,
          now: deps.now,
          confidence: 'low',
          detail: `wbsearchentities(language=${lang}) 命中 ${result.items.length} 个实体：${result.items
            .slice(0, 5)
            .map((item) => `${item.id} ${item.label}${Array.isArray(item.aliases) && item.aliases.length > 0 ? `（别名：${item.aliases.slice(0, 3).join(' / ')}）` : ''}`)
            .join('；')}`,
        }),
      )
    }
  } else {
    warnings.push(result.error)
  }

  const webQueries = buildWebQueries(name, lang, result.ok ? result.items : [])
  let summary = ''
  if (result.ok && result.items.length > 0) {
    summary = `Wikidata 命中 ${result.items.length} 个实体候选：${result.items
      .slice(0, 3)
      .map((item) => `${item.id} ${item.label}`)
      .join('；')}；已生成 4 个搜索链接 + ${webQueries.length} 组 web_search 查询。`
  } else if (result.ok) {
    summary = `Wikidata 未命中「${name}」；已生成 4 个搜索链接 + ${webQueries.length} 组 web_search 查询。`
  } else {
    summary = `Wikidata 不可用；已生成 4 个搜索链接 + ${webQueries.length} 组 web_search 查询。`
  }
  summary += ' 建议：先用 web_search 检索公开资料、web_fetch 打开关键页面，形成人物画像后再下结论。'
  if (companyHint) summary += ' 该名称疑似公司/组织，建议改用 dd_company。'

  return {
    ok: true,
    tool: NAME_TOOL,
    query: name,
    lang,
    summary,
    evidence: dedupeEvidence(evidence),
    warnings,
    error: null,
    wikidata: result.ok ? result.items : [],
    search_links: searchLinks,
    web_queries: webQueries,
    company_hint: companyHint,
    suggestions: buildSuggestions(name, companyHint, result.ok ? result.items : [], result.ok),
  }
}
