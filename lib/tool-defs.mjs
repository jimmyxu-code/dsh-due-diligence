/**
 * dd_* 工具定义层：把纯逻辑模块包装成 Host 可注册的 ToolDefinition。
 *
 * 设计要点：
 * - 不 import 任何 @deepseek-ai 包：workspace 以 `link:` 安装的插件，其真实路径在
 *   profile 之外，Host 的模块解析拦截层不会映射 @deepseek-ai/* 裸导入（2026-11-07 实测）。
 *   因此这里直接构造 ToolDefinition（字段与 defineTool 产物一致，由 Host 校验）。
 * - 纯模块：`createToolDefinitions(defineTool?)` 不依赖 DSH，普通 `node --test` 可测；
 *   测试可传入 stub defineTool 或省略，直接调用 definition.execute(args, fakeExec)。
 * - 所有工具返回统一 Evidence 信封：{ ok, tool, query, summary, evidence, warnings, error, ... }；
 *   输入非法/执行抛错/数据源失败都不抛给模型，而是返回 ok:false + error。
 * - 输出 schema 用 Host 支持的原始 JSON Schema 子集；关键字段声明类型，长尾结构保持开放，
 *   避免上游数据源字段微调导致 INVALID_TOOL_OUTPUT。
 */

import { makeEvidence } from './evidence.mjs'
import { investigateCompany } from './company.mjs'
import { investigateDomain } from './domain.mjs'
import { investigateName } from './name.mjs'
import { writeReport } from './report.mjs'
import { scanUsername } from './username.mjs'

/** 工具顺序（也是模式里展示的顺序）。 */
export const TOOL_NAMES = Object.freeze(['dd_username', 'dd_name', 'dd_company', 'dd_domain', 'dd_report'])

/** 统一信封里必有的键。 */
const ENVELOPE_REQUIRED = Object.freeze(['ok', 'tool', 'query', 'summary', 'evidence', 'warnings', 'error'])

/** 统一信封的 schema 片段。 */
const ENVELOPE_PROPERTIES = Object.freeze({
  ok: { type: 'boolean', description: '是否成功完成（软失败也为 true；输入/内部错误为 false）。' },
  tool: { type: 'string', description: '工具名。' },
  query: { description: '归一化后的查询参数。' },
  summary: { type: 'string', description: '一句话结论摘要（含命中数与降级说明）。' },
  evidence: { type: 'array', items: { type: 'object' }, description: '证据列表：source/url/fetched_at/confidence/detail。' },
  warnings: { type: 'array', items: { type: 'string' }, description: '软失败、降级、截断等提醒。' },
  error: { description: '致命错误信息；null 表示无致命错误。' },
})

/**
 * 构造一个对象根 schema：统一信封 + 工具特有字段。
 * @param {Record<string, unknown>} properties 工具特有字段。
 * @param {string[]} [required] 工具特有必填字段。
 * @returns {Record<string, unknown>} 输出 schema。
 */
function envelopeSchema(properties, required = []) {
  return {
    type: 'object',
    properties: { ...ENVELOPE_PROPERTIES, ...properties },
    required: [...ENVELOPE_REQUIRED, ...required],
  }
}

/**
 * 统一信封的 render 头：摘要 + 计数 + 提醒。
 * @param {Record<string, any>} value 规范输出。
 * @returns {string[]} 文本行。
 */
function envelopeHead(value) {
  const lines = [value.summary === '' ? `${value.tool} 执行完成` : value.summary]
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    for (const warning of value.warnings.slice(0, 8)) lines.push(`! ${warning}`)
    if (value.warnings.length > 8) lines.push(`! …另有 ${value.warnings.length - 8} 条提醒`)
  }
  return lines
}

/**
 * 把规范输出渲染成模型可见文本块。
 * @param {string[]} lines 文本行。
 * @returns {{ type: 'text', text: string }[]} 内容块。
 */
function textBlocks(lines) {
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 归一化证据数组，保证每条都能通过 schema 与后续渲染。
 * @param {unknown} evidence 原始证据。
 * @returns {Array<{ source: string, url: string|null, fetched_at: string, confidence: string, detail: string }>} 证据。
 */
export function sanitizeEvidence(evidence) {
  if (!Array.isArray(evidence)) return []
  const out = []
  for (const item of evidence) {
    if (item === null || typeof item !== 'object') continue
    const source = typeof item.source === 'string' && item.source !== '' ? item.source : 'unknown'
    out.push(
      makeEvidence({
        source,
        url: typeof item.url === 'string' ? item.url : null,
        now: typeof item.fetched_at === 'string' ? Date.parse(item.fetched_at) || Date.now() : Date.now(),
        confidence: item.confidence,
        detail: typeof item.detail === 'string' ? item.detail : '',
      }),
    )
  }
  return out
}

/**
 * 归一化统一信封。
 * @param {string} tool 工具名。
 * @param {Record<string, any>} query 查询参数。
 * @param {unknown} raw 模块返回值。
 * @returns {{ ok: boolean, tool: string, query: any, summary: string, evidence: any[], warnings: string[], error: string|null }} 信封。
 */
export function normalizeEnvelope(tool, query, raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ok: value.ok === true,
    tool,
    query: value.query ?? query,
    summary: typeof value.summary === 'string' ? value.summary : `${tool} 执行完成`,
    evidence: sanitizeEvidence(value.evidence),
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item) => typeof item === 'string') : [],
    error: typeof value.error === 'string' && value.error !== '' ? value.error : null,
  }
}

/**
 * 构造失败信封（输入非法或内部异常）。
 * @param {string} tool 工具名。
 * @param {Record<string, any>} query 查询。
 * @param {string} message 错误。
 * @param {Record<string, unknown>} [defaults] 工具特有字段默认值。
 * @returns {Record<string, any>} 失败信封。
 */
function failureEnvelope(tool, query, message, defaults = {}) {
  return {
    ok: false,
    tool,
    query,
    summary: `${tool} 未完成：${message}`,
    evidence: [],
    warnings: [],
    error: message,
    ...defaults,
  }
}

/**
 * 读取必填字符串参数。
 * @param {unknown} value 值。
 * @param {string} name 参数名。
 * @param {number} [maxChars=200] 上限。
 * @returns {string} 去空白后的字符串。
 * @throws {Error} 缺失或超长时抛错（由调用方转成失败信封）。
 */
function requireString(value, name, maxChars = 200) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`缺少必填参数 ${name}`)
  if (text.length > maxChars) throw new Error(`参数 ${name} 过长（最多 ${maxChars} 字符）`)
  return text
}

/**
 * 读取数字参数并夹在区间内。
 * @param {unknown} value 值。
 * @param {number} fallback 默认值。
 * @param {number} min 下限。
 * @param {number} max 上限。
 * @returns {number} 数字。
 */
function numberWithin(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

/**
 * 执行一次模块调用并转成统一信封；任何异常都变成失败信封。
 * @param {string} tool 工具名。
 * @param {Record<string, any>} query 查询。
 * @param {() => Promise<unknown>} run 模块调用。
 * @param {Record<string, unknown>} [defaults] 工具特有字段默认值。
 * @returns {Promise<Record<string, any>>} 信封。
 */
async function runSafely(tool, query, run, defaults = {}, mapExtras = null) {
  try {
    const raw = await run()
    const envelope = normalizeEnvelope(tool, query, raw)
    const extras = mapExtras === null ? {} : pickDefined(mapExtras(raw))
    return { ...envelope, ...defaults, ...extras }
  } catch (error) {
    return failureEnvelope(tool, query, error instanceof Error ? error.message : String(error), defaults)
  }
}

/**
 * 只保留已定义（非 undefined）的键。
 * @param {Record<string, any>|null|undefined} object 对象。
 * @returns {Record<string, any>} 过滤后的对象。
 */
function pickDefined(object) {
  const out = {}
  if (object === null || typeof object !== 'object') return out
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 判断普通对象。
 * @param {unknown} value 值。
 * @returns {boolean} 是否普通对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * dd_username 工具特有字段映射（容忍上游字段微调）。
 * @param {unknown} raw 模块原始返回值。
 * @returns {Record<string, any>} 工具特有字段。
 */
function mapUsernameExtras(raw) {
  const value = isPlainObject(raw) ? raw : {}
  return {
    found: Array.isArray(value.found) ? value.found : [],
    counts: isPlainObject(value.counts) ? value.counts : {},
    verify: isPlainObject(value.verify) ? value.verify : {},
    elapsed_ms: Number.isFinite(value.elapsed_ms) ? value.elapsed_ms : 0,
    sites_total: Number.isFinite(value.sites_total) ? Math.trunc(value.sites_total) : 0,
    truncated: value.truncated === true,
    aborted: value.aborted === true,
    ...(isPlainObject(value.sherlock) ? { sherlock: value.sherlock } : {}),
  }
}

/**
 * dd_name 工具特有字段映射。
 * @param {unknown} raw 模块原始返回值。
 * @returns {Record<string, any>} 工具特有字段。
 */
function mapNameExtras(raw) {
  const value = isPlainObject(raw) ? raw : {}
  return {
    wikidata: Array.isArray(value.wikidata) ? value.wikidata : Array.isArray(value.entities) ? value.entities : [],
    search_links: Array.isArray(value.search_links) ? value.search_links : Array.isArray(value.links) ? value.links : [],
    web_queries: Array.isArray(value.web_queries) ? value.web_queries.filter((item) => typeof item === 'string') : [],
    company_hint: value.company_hint === true,
    suggestions: Array.isArray(value.suggestions)
      ? value.suggestions.filter((item) => typeof item === 'string')
      : Array.isArray(value.next_steps)
        ? value.next_steps.filter((item) => typeof item === 'string')
        : [],
  }
}

/**
 * dd_company 工具特有字段映射（兼容 sources/deeplinks 旧命名）。
 * @param {unknown} raw 模块原始返回值。
 * @returns {Record<string, any>} 工具特有字段。
 */
function mapCompanyExtras(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const sources = isPlainObject(value.sources) ? value.sources : {}
  const deepLinks = Array.isArray(value.deep_links) ? value.deep_links : Array.isArray(value.deeplinks) ? value.deeplinks : []
  return {
    candidates: Array.isArray(value.candidates) ? value.candidates : [],
    gleif: isPlainObject(value.gleif) ? value.gleif : isPlainObject(sources.gleif) ? sources.gleif : {},
    sec: isPlainObject(value.sec) ? value.sec : isPlainObject(sources.sec) ? sources.sec : {},
    wikidata: Array.isArray(value.wikidata) ? value.wikidata : [],
    deep_links: deepLinks,
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.filter((item) => typeof item === 'string') : [],
  }
}

/**
 * dd_domain 工具特有字段映射。
 * @param {unknown} raw 模块原始返回值。
 * @returns {Record<string, any>} 工具特有字段。
 */
function mapDomainExtras(raw) {
  const value = isPlainObject(raw) ? raw : {}
  const sources = isPlainObject(value.sources) ? value.sources : {}
  const certificates = isPlainObject(value.certificates)
    ? value.certificates
    : isPlainObject(value.crt)
      ? value.crt
      : isPlainObject(sources.crt_sh)
        ? sources.crt_sh
        : {}
  const subdomains = Array.isArray(value.subdomains)
    ? value.subdomains.filter((item) => typeof item === 'string')
    : Array.isArray(certificates.subdomains)
      ? certificates.subdomains.filter((item) => typeof item === 'string')
      : []
  return {
    domain: typeof value.domain === 'string' ? value.domain : '',
    rdap: isPlainObject(value.rdap) ? value.rdap : isPlainObject(sources.rdap) ? sources.rdap : {},
    certificates,
    wayback: isPlainObject(value.wayback) ? value.wayback : isPlainObject(sources.wayback) ? sources.wayback : {},
    subdomains,
    next_steps: Array.isArray(value.next_steps) ? value.next_steps.filter((item) => typeof item === 'string') : [],
  }
}

/**
 * 构造 dd_username 工具。
 * @param {Record<string, any>} deps 注入依赖。
 * @returns {Record<string, any>} ToolDefinition。
 */
function usernameTool(deps) {
  return {
    name: 'dd_username',
    description:
      '用户名/handle → 各平台账号探测（内置 sherlock v0.16.2 站点库，481 站，免费公开 URL，不登录、不抓取私域内容）。' +
      '返回命中平台（site、url、http_status、confidence、title、description）。verify=true 时对命中页做二次核验，' +
      '并顺带抓取公开主页的 <title> 与 meta 简介（description）——这是人物画像的原料，人物调查建议开启。' +
      '适合查人的网名；真名请用 dd_name；结果可能同名，需人工核实。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: { type: 'string', description: '要查的用户名/handle，例如 sherlock。' },
        site: { type: 'string', description: '可选：只查某个站点（如 GitHub）。省略则扫描全部站点。' },
        timeoutMs: { type: 'number', description: '单站探测超时（毫秒），默认 10000，范围 1000–30000。' },
        verify: { type: 'boolean', description: '是否对命中 URL 做二次 FETCH 核验（并发 10、超时 6s）。默认 false。' },
        max_results: { type: 'integer', description: '最多返回多少条命中，默认 100，范围 1–500。' },
      },
      required: ['username'],
    },
    output: {
      schema: envelopeSchema(
        {
          found: { type: 'array', items: { type: 'object' }, description: '命中列表：site/url/status/http_status/confidence/verified/title。' },
          counts: { type: 'object', description: '扫描计数：checked/claimed/available/unknown/waf/failed 等。' },
          verify: { type: 'object', description: '二次核验统计（enabled/checked/verified/unreachable）。' },
          elapsed_ms: { type: 'number' },
          sites_total: { type: 'integer' },
          truncated: { type: 'boolean' },
          aborted: { type: 'boolean' },
          sherlock: { type: 'object', description: '引擎版本信息。' },
        },
        ['found', 'counts', 'verify', 'elapsed_ms', 'sites_total'],
      ),
      render: (_args, value) => {
        const lines = envelopeHead(value)
        const found = Array.isArray(value.found) ? value.found : []
        lines.push('', '命中平台（含公开主页标题/简介，若有）：')
        if (found.length === 0) lines.push('- （无命中；可能是该用户名未被占用，或站点反爬/超时导致漏报）')
        for (const item of found.slice(0, 80)) {
          const flags = []
          if (item.verified === true) flags.push('verified')
          else if (item.verified === false) flags.push('unreachable')
          if (typeof item.http_status === 'number') flags.push(`HTTP ${item.http_status}`)
          lines.push(`- ${item.site} | ${item.url} | ${item.confidence ?? 'medium'}${flags.length > 0 ? ` | ${flags.join(' ')}` : ''}`)
          const title = typeof item.title === 'string' && item.title !== '' ? item.title : null
          const description = typeof item.description === 'string' && item.description !== '' ? item.description : null
          if (title !== null) lines.push(`  标题：${title.slice(0, 160)}`)
          if (description !== null) lines.push(`  简介：${description.slice(0, 200)}`)
        }
        if (found.length > 80) lines.push(`- …另有 ${found.length - 80} 条命中（完整列表在工具规范值中）`)
        const verifyEnabled = value.verify?.enabled === true
        if (!verifyEnabled && found.length > 0) {
          lines.push('', '提示：本次 verify=false，只有「账号存在」没有主页简介。人物画像请用 verify=true 重跑（会抓公开标题/简介），再用 web_fetch 打开重点主页。')
        } else {
          lines.push('', '下一步：从高置信、与目标职业/领域相符的主页里挑 2–5 个，用 web_fetch 读公开简介/简介页，补全人物画像；不要只用账号存在性下结论。')
        }
        lines.push('', '提醒：命中只代表该 URL 返回「存在」，不等于账号属于同一个人；请结合多来源核实。')
        return textBlocks(lines)
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `dd_username ${args.username}`,
      kind: 'search',
      rawInput: { username: args.username, site: args.site, verify: args.verify },
    }),
    presentResult: (_args, result) => {
      const count = result?.meta?.found_count
      return { card: 'generic', title: typeof count === 'number' ? `dd_username · ${count} 个命中` : 'dd_username' }
    },
    timeoutMs: 280000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const defaults = { found: [], counts: {}, verify: {}, elapsed_ms: 0, sites_total: 0, truncated: false, aborted: false }
      let query = { username: typeof args?.username === 'string' ? args.username : null }
      try {
        const username = requireString(args?.username, 'username', 100)
        const site = typeof args?.site === 'string' && args.site.trim() !== '' ? args.site.trim() : undefined
        const timeoutMs = numberWithin(args?.timeoutMs, 10000, 1000, 30000)
        const verify = args?.verify === true
        const maxResults = numberWithin(args?.max_results, 100, 1, 500)
        query = { username, site: site ?? null, timeout_ms: timeoutMs, verify, max_results: maxResults }
        return await runSafely(
          'dd_username',
          query,
          () =>
            scanUsername(
              { username, ...(site === undefined ? {} : { site }), timeoutMs, verify, maxResults },
              { ...deps, signal: exec?.signal },
            ),
          defaults,
          mapUsernameExtras,
        )
      } catch (error) {
        return failureEnvelope('dd_username', query, error instanceof Error ? error.message : String(error), defaults)
      }
    },
  }
}

/**
 * 构造 dd_name 工具。
 * @param {Record<string, any>} deps 注入依赖。
 * @returns {Record<string, any>} ToolDefinition。
 */
function nameTool(deps) {
  const defaults = { wikidata: [], search_links: [], web_queries: [], company_hint: false, suggestions: [] }
  return {
    name: 'dd_name',
    description:
      '人的真名维度：Wikidata 查候选实体（含描述、别名、实体链接），生成 Google/Bing/Baidu/Brave 搜索链接（只给链接、不抓取），' +
      '并给出可直接交给 web_search 的查询组（web_queries：简介/履历、采访、作品、机构、教育）。' +
      '这是人物画像的起点：先 dd_name 消歧，再按 web_queries 用 web_search/web_fetch 收集公开资料，最后 dd_report 汇总。' +
      '名字疑似公司时返回 company_hint 并提示改用 dd_company。适合真名；网名/handle 用 dd_username。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '要查的真名，例如 张三 或 Elon Musk。' },
        lang: { type: 'string', description: 'Wikidata 检索语言，默认 zh；可传 en/ja 等。' },
      },
      required: ['name'],
    },
    output: {
      schema: envelopeSchema(
        {
          wikidata: { type: 'array', items: { type: 'object' }, description: 'Wikidata 候选实体（含 aliases）。' },
          search_links: { type: 'array', items: { type: 'object' }, description: '各搜索引擎链接（只给链接）。' },
          web_queries: { type: 'array', items: { type: 'string' }, description: '可直接传给 web_search 的查询组（人物画像用）。' },
          company_hint: { type: 'boolean', description: '名字疑似公司时 true。' },
          suggestions: { type: 'array', items: { type: 'string' }, description: '下一步建议。' },
        },
        ['wikidata', 'search_links', 'web_queries', 'company_hint', 'suggestions'],
      ),
      render: (_args, value) => {
        const lines = envelopeHead(value)
        const wikidata = Array.isArray(value.wikidata) ? value.wikidata : []
        lines.push('', 'Wikidata 候选实体：')
        if (wikidata.length === 0) lines.push('- （无候选；可换语言或补充更多限定词）')
        for (const entity of wikidata.slice(0, 10)) {
          const aliases = Array.isArray(entity.aliases) && entity.aliases.length > 0 ? `（别名：${entity.aliases.slice(0, 3).join(' / ')}）` : ''
          lines.push(`- ${entity.label ?? entity.id ?? '?'}${entity.description ? `：${entity.description}` : ''}${aliases} | ${entity.url ?? ''}`)
        }
        const links = Array.isArray(value.search_links) ? value.search_links : []
        if (links.length > 0) {
          lines.push('', '搜索链接（只给链接，未抓取）：')
          for (const link of links) lines.push(`- ${link.engine ?? 'search'}: ${link.url}`)
        }
        const webQueries = Array.isArray(value.web_queries) ? value.web_queries : []
        if (webQueries.length > 0) {
          lines.push('', '建议的 web_search 查询（人物画像必做）：')
          for (const query of webQueries) lines.push(`- ${query}`)
          lines.push('', '工作流：用上面的查询做 3–6 轮 web_search；对个人主页/机构页/访谈/论文页用 web_fetch 读原文；' +
            '把「基本信息 / 职业与机构 / 教育 / 作品 / 媒体 / 账号 / 时间线 / 争议」写进画像，再 dd_report。' +
            '只回答「有没有这个人/真伪」而没有画像，视为不合格。')
        }
        if (value.company_hint === true) lines.push('', '注意：这个名字疑似公司/组织，建议改用 dd_company。')
        const suggestions = Array.isArray(value.suggestions) ? value.suggestions : []
        if (suggestions.length > 0) {
          lines.push('', '建议：')
          for (const suggestion of suggestions.slice(0, 6)) lines.push(`- ${suggestion}`)
        }
        lines.push('', '提醒：同名很常见，Wikidata 候选不等于目标本人，请结合其它来源核实。')
        return textBlocks(lines)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `dd_name ${args.name}`, kind: 'search', rawInput: { name: args.name, lang: args.lang } }),
    presentResult: () => ({ card: 'generic', title: 'dd_name' }),
    timeoutMs: 45000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let query = { name: typeof args?.name === 'string' ? args.name : null }
      try {
        const name = requireString(args?.name, 'name', 200)
        const lang = typeof args?.lang === 'string' && args.lang.trim() !== '' ? args.lang.trim().slice(0, 16) : 'zh'
        query = { name, lang }
        return await runSafely('dd_name', query, () => investigateName({ name, lang }, { ...deps, signal: exec?.signal }), defaults, mapNameExtras)
      } catch (error) {
        return failureEnvelope('dd_name', query, error instanceof Error ? error.message : String(error), defaults)
      }
    },
  }
}

/**
 * 构造 dd_company 工具。
 * @param {Record<string, any>} deps 注入依赖。
 * @returns {Record<string, any>} ToolDefinition。
 */
function companyTool(deps) {
  const defaults = { candidates: [], gleif: {}, sec: {}, wikidata: [], deep_links: [], next_steps: [] }
  return {
    name: 'dd_company',
    description:
      '公司/组织尽调：输入公司名、股票代码、CIK 或 LEI。查询 GLEIF（全球 LEI）、SEC EDGAR（美国上市公司，带 CIK）、Wikidata 实体；' +
      '中国公司只给天眼查/企查查/爱企查/GSXT 官方 Deep Link，绝不抓取。返回候选（source/id/name/jurisdiction/status/url/confidence）+ 证据 + 下一步。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '公司名 / ticker / CIK / LEI，例如 Apple、AAPL、0000320193。' },
      },
      required: ['query'],
    },
    output: {
      schema: envelopeSchema(
        {
          candidates: { type: 'array', items: { type: 'object' }, description: '候选实体：source/id/name/jurisdiction/status/url/confidence。' },
          gleif: { type: 'object', description: 'GLEIF 查询状态与匹配数。' },
          sec: { type: 'object', description: 'SEC 查询状态：cik/name/tickers/filings_url。' },
          wikidata: { type: 'array', items: { type: 'object' }, description: 'Wikidata 候选。' },
          deep_links: { type: 'array', items: { type: 'object' }, description: '中国官方/商业站点 Deep Link（只给链接）。' },
          next_steps: { type: 'array', items: { type: 'string' }, description: '下一步建议。' },
        },
        ['candidates', 'gleif', 'sec', 'wikidata', 'deep_links', 'next_steps'],
      ),
      render: (_args, value) => {
        const lines = envelopeHead(value)
        const candidates = Array.isArray(value.candidates) ? value.candidates : []
        lines.push('', '候选实体：')
        if (candidates.length === 0) lines.push('- （无候选；可换公司全称、英文名或补充 ticker/CIK/LEI）')
        for (const candidate of candidates.slice(0, 20)) {
          lines.push(
            `- [${candidate.source ?? '?'}] ${candidate.name ?? '?'}${candidate.id ? `（${candidate.id}）` : ''}` +
              `${candidate.jurisdiction ? ` | ${candidate.jurisdiction}` : ''}${candidate.status ? ` | ${candidate.status}` : ''}` +
              ` | ${candidate.confidence ?? 'medium'} | ${candidate.url ?? ''}`,
          )
        }
        const sec = value.sec ?? {}
        if (sec.cik) lines.push('', `SEC：CIK ${sec.cik}${sec.name ? `（${sec.name}）` : ''}${sec.filings_url ? ` | ${sec.filings_url}` : ''}`)
        const links = Array.isArray(value.deep_links) ? value.deep_links : []
        if (links.length > 0) {
          lines.push('', '中国公司 Deep Link（只给链接，未抓取）：')
          for (const link of links) lines.push(`- ${link.label ?? link.url}: ${link.url}`)
        }
        const nextSteps = Array.isArray(value.next_steps) ? value.next_steps : []
        if (nextSteps.length > 0) {
          lines.push('', '下一步：')
          for (const step of nextSteps.slice(0, 8)) lines.push(`- ${step}`)
        }
        lines.push('', '提醒：同名公司很多，确认 jurisdiction/注册号后再下结论；中国工商信息需人工在官方渠道核验。')
        return textBlocks(lines)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `dd_company ${args.query}`, kind: 'search', rawInput: { query: args.query } }),
    presentResult: () => ({ card: 'generic', title: 'dd_company' }),
    timeoutMs: 90000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let query = { query: typeof args?.query === 'string' ? args.query : null }
      try {
        const value = requireString(args?.query, 'query', 200)
        query = { query: value }
        return await runSafely('dd_company', query, () => investigateCompany({ query: value }, { ...deps, signal: exec?.signal }), defaults, mapCompanyExtras)
      } catch (error) {
        return failureEnvelope('dd_company', query, error instanceof Error ? error.message : String(error), defaults)
      }
    },
  }
}

/**
 * 构造 dd_domain 工具。
 * @param {Record<string, any>} deps 注入依赖。
 * @returns {Record<string, any>} ToolDefinition。
 */
function domainTool(deps) {
  const defaults = { domain: '', rdap: {}, certificates: {}, wayback: {}, subdomains: [], next_steps: [] }
  return {
    name: 'dd_domain',
    description:
      '域名/网站基础设施尽调：crt.sh 证书日志（子域、证书），Wayback Machine 存档可用性，RDAP 域名注册信息（注册商/创建/到期/状态/NS）。' +
      '失败源软降级。输出证书/存档/注册信息 + Evidence。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: { type: 'string', description: '域名，例如 example.com（可带 https:// 前缀，会自动归一化）。' },
      },
      required: ['domain'],
    },
    output: {
      schema: envelopeSchema(
        {
          domain: { type: 'string', description: '归一化后的域名。' },
          rdap: { type: 'object', description: 'RDAP 注册信息（registrar/created/expires/status/nameservers）。' },
          certificates: { type: 'object', description: 'crt.sh 证书统计与条目。' },
          wayback: { type: 'object', description: 'Wayback 存档可用性。' },
          subdomains: { type: 'array', items: { type: 'string' }, description: '证书里出现的子域（去重）。' },
          next_steps: { type: 'array', items: { type: 'string' }, description: '下一步建议。' },
        },
        ['domain', 'rdap', 'certificates', 'wayback', 'subdomains', 'next_steps'],
      ),
      render: (_args, value) => {
        const lines = envelopeHead(value)
        const rdap = value.rdap ?? {}
        lines.push('', `域名：${value.domain ?? ''}`)
        lines.push(`RDAP：${rdap.ok === true ? '可用' : `不可用（${rdap.error ?? '未知'}）`}`)
        if (rdap.registrar) lines.push(`- 注册商：${rdap.registrar}`)
        if (rdap.created) lines.push(`- 创建：${rdap.created}`)
        if (rdap.expires) lines.push(`- 到期：${rdap.expires}`)
        if (Array.isArray(rdap.status) && rdap.status.length > 0) lines.push(`- 状态：${rdap.status.join(', ')}`)
        if (Array.isArray(rdap.nameservers) && rdap.nameservers.length > 0) lines.push(`- NS：${rdap.nameservers.join(', ')}`)
        const certificates = value.certificates ?? {}
        lines.push('', `crt.sh：${certificates.ok === true ? `可用，${certificates.count ?? 0} 条证书记录` : `不可用（${certificates.error ?? '未知'}）`}`)
        const subdomains = Array.isArray(value.subdomains) ? value.subdomains : []
        if (subdomains.length > 0) lines.push(`- 子域（前 30）：${subdomains.slice(0, 30).join(', ')}${subdomains.length > 30 ? ' …' : ''}`)
        const wayback = value.wayback ?? {}
        lines.push('', `Wayback：${wayback.available === true ? `有存档 ${wayback.snapshot_url ?? ''}` : '无可用存档/不可用'}`)
        const nextSteps = Array.isArray(value.next_steps) ? value.next_steps : []
        if (nextSteps.length > 0) {
          lines.push('', '下一步：')
          for (const step of nextSteps.slice(0, 8)) lines.push(`- ${step}`)
        }
        return textBlocks(lines)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `dd_domain ${args.domain}`, kind: 'search', rawInput: { domain: args.domain } }),
    presentResult: () => ({ card: 'generic', title: 'dd_domain' }),
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      let query = { domain: typeof args?.domain === 'string' ? args.domain : null }
      try {
        const domain = requireString(args?.domain, 'domain', 300)
        query = { domain }
        return await runSafely('dd_domain', query, () => investigateDomain({ domain }, { ...deps, signal: exec?.signal }), defaults, mapDomainExtras)
      } catch (error) {
        return failureEnvelope('dd_domain', query, error instanceof Error ? error.message : String(error), defaults)
      }
    },
  }
}

/**
 * 构造 dd_report 工具：把调查材料写成 Markdown 背调报告。
 * @param {Record<string, any>} deps 注入依赖。
 * @returns {Record<string, any>} ToolDefinition。
 */
function reportTool(deps) {
  const defaults = { path: '', filename: '', dir: '', bytes: 0, markdown: '' }
  return {
    name: 'dd_report',
    description:
      '生成 Markdown 背调报告并写入报告目录（默认 ~/Desktop/背调报告/，可用环境变量 DSH_DD_REPORT_DIR 覆盖）。' +
      '报告包含：对象、结论摘要、（可选）人物画像章节、证据表（claim/source/url/fetched_at/confidence/detail）、疑点、下一步、合规声明。' +
      '人物调查请把画像分区（basics/occupation/education/works/media/accounts/timeline/risks）放进 profile 参数，报告会按章节渲染。返回文件路径与摘要。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: '报告对象，例如 Apple Inc. / sherlock / example.com。' },
        target_type: { type: 'string', description: '对象类型：company / person / domain / username / other。' },
        summary: { type: 'string', description: '结论摘要（2–5 句，含置信度与关键限定）。' },
        findings: {
          type: 'array',
          description: '证据条目数组；每条含 claim/source/url/fetched_at/confidence/detail。',
          items: { type: 'object' },
        },
        open_questions: { type: 'array', items: { type: 'string' }, description: '疑点/待核实问题列表。' },
        profile: {
          type: 'object',
          description:
            '可选：人物画像分区对象，键为 basics/occupation/education/works/media/accounts/timeline/risks/other，值为字符串数组；报告会渲染成「人物画像」章节。',
        },
      },
      required: ['target', 'target_type', 'summary'],
    },
    output: {
      schema: envelopeSchema(
        {
          path: { type: 'string', description: '报告文件绝对路径。' },
          filename: { type: 'string', description: '报告文件名。' },
          dir: { type: 'string', description: '报告目录。' },
          bytes: { type: 'integer', description: '文件字节数。' },
          markdown: { type: 'string', description: '报告 Markdown 全文（便于模型直接引用关键结论）。' },
        },
        ['path', 'filename', 'dir', 'bytes', 'markdown'],
      ),
      render: (args, value) => {
        const lines = envelopeHead(value)
        lines.push('', `报告已写入：${value.path}`)
        lines.push(`大小：${value.bytes} 字节；目录：${value.dir}`)
        if (args?.profile !== null && typeof args?.profile === 'object' && !Array.isArray(args?.profile)) {
          lines.push('报告已包含「人物画像」章节。')
        }
        lines.push('', '提示：把报告路径告诉用户，并附上 2–5 条关键结论与来源 URL。')
        return textBlocks(lines)
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `dd_report ${args.target}`, kind: 'other', rawInput: { target: args.target, target_type: args.target_type } }),
    presentResult: () => ({ card: 'generic', title: 'dd_report' }),
    timeoutMs: 30000,
    async execute(args, exec) {
      let query = { target: typeof args?.target === 'string' ? args.target : null, target_type: typeof args?.target_type === 'string' ? args.target_type : null }
      try {
        const target = requireString(args?.target, 'target', 200)
        const targetType = requireString(args?.target_type, 'target_type', 40)
        const summary = requireString(args?.summary, 'summary', 8000)
        const findings = Array.isArray(args?.findings) ? args.findings.filter((item) => item !== null && typeof item === 'object') : []
        const openQuestions = Array.isArray(args?.open_questions) ? args.open_questions.filter((item) => typeof item === 'string') : []
        const profile = args?.profile !== null && typeof args?.profile === 'object' && !Array.isArray(args.profile) ? args.profile : undefined
        query = { target, target_type: targetType, has_profile: profile !== undefined }
        if (exec?.signal?.aborted === true) throw new Error('已被取消')
        const written = await writeReport(
          { target, target_type: targetType, summary, findings, open_questions: openQuestions, ...(profile === undefined ? {} : { profile }) },
          { reportDir: deps.reportDir },
        )
        const evidence = findings
          .map((finding) => {
            try {
              return makeEvidence({
                source: typeof finding.source === 'string' && finding.source !== '' ? finding.source : 'dd_report:manual',
                url: typeof finding.url === 'string' ? finding.url : null,
                now: typeof finding.fetched_at === 'string' ? Date.parse(finding.fetched_at) || Date.now() : Date.now(),
                confidence: finding.confidence,
                detail: `${finding.claim ?? ''}${finding.detail ? `；${finding.detail}` : ''}`,
              })
            } catch {
              return null
            }
          })
          .filter((item) => item !== null)
        const envelope = normalizeEnvelope('dd_report', query, {
          ok: true,
          tool: 'dd_report',
          query,
          summary: `报告已生成：${written.filename}（${written.bytes} 字节，含 ${findings.length} 条证据）`,
          evidence,
          warnings: [],
          error: null,
        })
        return {
          ...envelope,
          path: written.path,
          filename: written.filename,
          dir: written.dir,
          bytes: written.bytes,
          markdown: written.markdown,
        }
      } catch (error) {
        return failureEnvelope('dd_report', query, error instanceof Error ? error.message : String(error), defaults)
      }
    },
  }
}

/**
 * 创建全部 dd_* 工具定义。
 * @param {{
 *   defineTool?: (definition: Record<string, unknown>) => Record<string, unknown>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   reportDir?: string,
 * }} [options] 选项：测试可注入 mock fetch/时钟/报告目录；宿主传入真实值或省略。
 * @returns {Array<Record<string, any>>} 5 个 ToolDefinition（顺序固定）。
 */
export function createToolDefinitions(options = {}) {
  const deps = {
    fetchImpl: options.fetchImpl,
    now: options.now,
    reportDir: options.reportDir,
  }
  const definitions = [usernameTool(deps), nameTool(deps), companyTool(deps), domainTool(deps), reportTool(deps)]
  return definitions.map((definition) => (typeof options.defineTool === 'function' ? options.defineTool(definition) : definition))
}
