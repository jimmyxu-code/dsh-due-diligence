/**
 * dd_name 单元测试：全部通过注入 mock fetch 完成，禁止真实网络。
 * 覆盖：Wikidata 人名候选、4 个搜索链接（只给链接）、company_hint、Wikidata 失败软降级、
 * 空输入/非法输入、lang 归一化。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { investigateName } from '../lib/name.mjs'

const NOW = Date.parse('2026-11-07T03:00:00.000Z')
const FETCHED_AT = new Date(NOW).toISOString()

/** 构造 JSON Response。 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/** 记录调用的 mock fetch；handler 返回 undefined 时回 500。 */
function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const textUrl = String(url)
    calls.push({ url: textUrl, init })
    return handler(textUrl, init) ?? jsonResponse({ error: 'unmocked' }, 500)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** Wikidata wbsearchentities 对「张三」的真实返回形状（2026-11-07 实测裁剪）。 */
const WIKIDATA_ZHANGSAN = {
  searchinfo: { search: '张三' },
  search: [
    {
      id: 'Q302057',
      label: 'John Doe',
      description: 'placeholder name for an anonymous or unknown person',
      url: '//www.wikidata.org/wiki/Q302057',
      match: { type: 'alias', language: 'zh', text: '张三' },
    },
    { id: 'Q1318274', label: 'placeholder name', description: 'name substituted for an unknown name' },
  ],
  success: 1,
}

test('张三：Wikidata 候选 + 4 个搜索链接（只给链接，不抓取）', async () => {
  const fetchImpl = mockFetch((url) => (url.includes('wikidata.org') ? jsonResponse(WIKIDATA_ZHANGSAN) : jsonResponse({ error: 'unmocked' }, 404)))
  const res = await investigateName({ name: '张三' }, { fetchImpl, now: NOW })

  // 统一信封
  assert.equal(res.tool, 'dd_name')
  assert.equal(res.query, '张三')
  assert.equal(res.lang, 'zh')
  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.match(res.summary, /Wikidata 命中 2 个实体候选/)

  // Wikidata 候选（id/label/description/url 与 DSH schema 对齐）
  assert.equal(res.wikidata.length, 2)
  assert.deepEqual(res.wikidata[0], {
    id: 'Q302057',
    label: 'John Doe',
    description: 'placeholder name for an anonymous or unknown person',
    url: 'https://www.wikidata.org/wiki/Q302057',
    aliases: [],
  })

  // 仅生成搜索链接，且顺序固定
  assert.equal(res.company_hint, false)
  assert.deepEqual(res.search_links.map((link) => link.engine), ['Google', 'Bing', 'Baidu', 'Brave'])
  const encoded = encodeURIComponent('张三')
  for (const link of res.search_links) assert.ok(link.url.includes(encoded), `搜索链接未编码姓名：${link.url}`)
  assert.ok(Array.isArray(res.web_queries))
  assert.ok(res.web_queries.length >= 3, '应生成可直接用于 web_search 的人物查询组')
  assert.ok(res.web_queries.some((query) => query.includes('张三')), '查询组应包含姓名')

  // 只请求了 Wikidata，没有任何搜索/抓取请求
  assert.ok(fetchImpl.calls.length >= 1)
  assert.match(fetchImpl.calls[0].url, /action=wbsearchentities/)
  assert.match(fetchImpl.calls[0].url, /language=zh/)
  // 第二轮 wbgetentities 取别名；mock 未提供 entities 时软降级为空别名。
  if (fetchImpl.calls.length > 1) assert.match(fetchImpl.calls[1].url, /action=wbgetentities/)

  // 证据与建议
  assert.equal(res.evidence.length, 1)
  assert.equal(res.evidence[0].source, 'Wikidata')
  assert.equal(res.evidence[0].fetched_at, FETCHED_AT)
  assert.ok(Array.isArray(res.suggestions) && res.suggestions.length > 0)
  assert.ok(res.suggestions.some((item) => item.includes('dd_username')))
})

test('公司名：company_hint=true 并提示改用 dd_company', async () => {
  const fetchImpl = mockFetch((url) =>
    url.includes('wikidata.org')
      ? jsonResponse({ search: [{ id: 'Q312', label: 'Apple Inc.', description: 'American technology company' }] })
      : jsonResponse({ error: 'unmocked' }, 404),
  )
  const res = await investigateName({ name: 'Apple Inc.' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.company_hint, true)
  assert.equal(res.wikidata[0].id, 'Q312')
  assert.equal(res.wikidata[0].label, 'Apple Inc.')
  assert.ok(res.suggestions.some((item) => item.includes('dd_company')))
  assert.match(res.summary, /dd_company/)
})

test('Wikidata 失败软降级：ok=true、仍生成搜索链接', async () => {
  const fetchImpl = mockFetch(() => new Response('', { status: 500 }))
  const res = await investigateName({ name: '张三' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.deepEqual(res.wikidata, [])
  assert.equal(res.search_links.length, 4)
  assert.equal(res.warnings.length, 1)
  assert.match(res.warnings[0], /Wikidata/)
  assert.match(res.summary, /Wikidata 不可用/)
  assert.ok(res.suggestions.some((item) => item.includes('搜索链接')))
})

test('fetch 直接抛错时仍返回统一信封', async () => {
  const fetchImpl = async () => {
    throw new Error('network down')
  }
  const res = await investigateName({ name: '张三' }, { fetchImpl, now: NOW })
  assert.equal(res.ok, true)
  assert.equal(res.tool, 'dd_name')
  assert.equal(res.search_links.length, 4)
  assert.ok(Array.isArray(res.warnings))
})

test('空输入 / 非字符串：ok=false 且不发起任何请求', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({}, 500))
  for (const input of [{}, { name: '' }, { name: '   ' }, { name: 42 }]) {
    const res = await investigateName(input, { fetchImpl, now: NOW })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'name is required')
    assert.equal(res.tool, 'dd_name')
    assert.deepEqual(res.wikidata, [])
    assert.deepEqual(res.search_links, [])
    assert.equal(res.company_hint, false)
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test('lang 归一化：非法语言回退 zh，合法语言透传', async () => {
  const calls = []
  const fetchImpl = mockFetch((url) => {
    calls.push(url)
    return jsonResponse({ search: [] })
  })
  const fallback = await investigateName({ name: '张三', lang: '中文' }, { fetchImpl, now: NOW })
  assert.equal(fallback.lang, 'zh')
  assert.match(calls[0], /language=zh/)
  assert.ok(fallback.warnings.some((warning) => warning.includes('未命中')))

  const english = await investigateName({ name: 'Elon Musk', lang: 'en' }, { fetchImpl, now: NOW })
  assert.equal(english.lang, 'en')
  assert.match(calls[1], /language=en/)
})
