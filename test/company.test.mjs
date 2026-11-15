/**
 * dd_company 单元测试：全部通过注入 mock fetch 完成，禁止真实网络。
 * 覆盖：Apple → SEC CIK 0000320193 + GLEIF 候选、中国公司 DeepLink、CIK 直查、
 * 分源软降级、全源失败、空输入/非法输入、looksLikeCompanyName 启发式。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { investigateCompany, looksLikeCompanyName } from '../lib/company.mjs'

const NOW = Date.parse('2026-11-07T03:00:00.000Z')
const FETCHED_AT = new Date(NOW).toISOString()
const GLEIF_LEI = 'HWUPKR0MPOU8FGXBT394'

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

/** Apple 全套数据源 mock。 */
function appleMock() {
  return mockFetch((url) => {
    if (url.includes('/fuzzycompletions')) {
      return jsonResponse({
        data: [
          {
            type: 'fuzzycompletions',
            attributes: { value: 'Apple Inc.' },
            relationships: { 'lei-records': { data: { type: 'lei-records', id: GLEIF_LEI } } },
          },
        ],
      })
    }
    if (url.includes(`/lei-records/${GLEIF_LEI}`)) {
      return jsonResponse({
        data: {
          type: 'lei-records',
          id: GLEIF_LEI,
          attributes: {
            lei: GLEIF_LEI,
            entity: { legalName: { name: 'Apple Inc.' }, jurisdiction: 'US-CA', status: 'ACTIVE' },
            registration: { status: 'ISSUED', initialRegistrationDate: '2012-06-06T15:53:00Z' },
          },
        },
      })
    }
    if (url.includes('efts.sec.gov')) {
      return jsonResponse({
        hits: {
          hits: [
            {
              _source: {
                ciks: ['0000320193'],
                display_names: ['APPLE COMPUTER INC  (AAPL)  (CIK 0000320193)'],
              },
            },
          ],
        },
      })
    }
    if (url.includes('data.sec.gov/submissions/CIK0000320193.json')) {
      return jsonResponse({ cik: '0000320193', name: 'Apple Inc.', tickers: ['AAPL'], exchanges: ['Nasdaq'], entityType: 'operating' })
    }
    if (url.includes('wikidata.org')) {
      return jsonResponse({
        search: [
          {
            id: 'Q312',
            label: 'Apple Inc.',
            description: 'American multinational technology company based in Cupertino, California',
            url: '//www.wikidata.org/wiki/Q312',
          },
        ],
      })
    }
    return jsonResponse({ error: 'unmocked' }, 404)
  })
}

test('Apple：命中 SEC CIK 0000320193 + GLEIF 候选 + Wikidata', async () => {
  const fetchImpl = appleMock()
  const res = await investigateCompany({ query: 'Apple' }, { fetchImpl, now: NOW })

  // 统一信封
  assert.equal(res.tool, 'dd_company')
  assert.equal(res.query, 'Apple')
  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.equal(typeof res.summary, 'string')
  assert.match(res.summary, /0000320193/)

  // SEC 候选（Apple 验收要求）
  const sec = res.candidates.find((item) => item.source === 'SEC EDGAR')
  assert.ok(sec, 'SEC 候选缺失')
  assert.equal(sec.id, '0000320193')
  assert.equal(sec.name, 'Apple Inc.')
  assert.equal(sec.jurisdiction, 'US')
  assert.equal(sec.confidence, 'high')
  assert.match(sec.url, /CIK=0000320193/)

  // GLEIF 候选
  const gleif = res.candidates.find((item) => item.source === 'GLEIF')
  assert.ok(gleif, 'GLEIF 候选缺失')
  assert.equal(gleif.id, GLEIF_LEI)
  assert.equal(gleif.name, 'Apple Inc.')
  assert.equal(gleif.jurisdiction, 'US-CA')
  assert.match(gleif.url, new RegExp(GLEIF_LEI))

  // 分源状态（DSH schema 的 gleif / sec / wikidata / sources）
  assert.equal(res.sources.gleif.ok, true)
  assert.equal(res.sources.sec.ok, true)
  assert.equal(res.sources.wikidata.ok, true)
  assert.equal(res.gleif.ok, true)
  assert.ok(res.gleif.count >= 1)
  assert.equal(res.sec.ok, true)
  assert.equal(res.sec.cik, '0000320193')
  assert.deepEqual(res.sec.tickers, ['AAPL'])
  assert.match(res.sec.filings_url, /0000320193/)
  assert.equal(res.wikidata[0].id, 'Q312')
  assert.equal(res.wikidata[0].label, 'Apple Inc.')
  assert.deepEqual(res.deep_links, [])

  // 证据：多源 + 固定时间戳
  const sources = res.evidence.map((item) => item.source)
  assert.ok(sources.includes('GLEIF'))
  assert.ok(sources.includes('SEC EDGAR'))
  assert.ok(sources.includes('Wikidata'))
  for (const item of res.evidence) assert.equal(item.fetched_at, FETCHED_AT)

  // SEC 请求必须带清楚的 UA
  const secCall = fetchImpl.calls.find((call) => call.url.includes('efts.sec.gov'))
  assert.ok(secCall, '未请求 SEC 全文检索')
  assert.match(secCall.init.headers['user-agent'], /dsh-due-diligence/)
  assert.match(secCall.init.headers['user-agent'], /contact:/)
  assert.ok(Array.isArray(res.next_steps) && res.next_steps.length > 0)
})

const CN_QUERY = '阿里巴巴（中国）有限公司'

test('中国公司：只生成 4 个官方/商业 Deep Link，绝不抓取', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/fuzzycompletions')) return jsonResponse({ data: [] })
    if (url.includes('efts.sec.gov')) return jsonResponse({ hits: { hits: [] } })
    if (url.includes('wikidata.org')) return jsonResponse({ search: [] })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateCompany({ query: CN_QUERY }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.deepEqual(res.candidates, [])
  assert.equal(res.deep_links.length, 4)
  assert.deepEqual(res.deep_links.map((item) => item.label), ['天眼查', '企查查', '爱企查', 'GSXT'])
  const encoded = encodeURIComponent(CN_QUERY)
  for (const link of res.deep_links.slice(0, 3)) {
    assert.ok(link.url.includes(encoded), `Deep Link 未编码查询词：${link.url}`)
    assert.match(link.url, /^https:\/\//)
  }
  assert.match(res.deep_links[3].url, /gsxt\.gov\.cn/)
  assert.equal(res.sources.deeplink.ok, true)
  assert.equal(res.sources.deeplink.count, 4)
  assert.ok(res.warnings.some((w) => w.includes('不抓取')))
  assert.ok(res.next_steps.some((step) => step.includes('企查查') || step.includes('Deep Link')))
  assert.match(res.summary, /中国工商检索入口/)
  // 只请求免费境外源，且没有任何中国站点请求
  assert.ok(fetchImpl.calls.every((call) => /gleif|sec\.gov|wikidata/.test(call.url)))
  // CJK 查询不生成 inc./ltd 变体：只有 1 次 fuzzycompletions
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('/fuzzycompletions')).length, 1)
})

test('SEC 命中排序：Apple Inc.（0000320193）优先于同前缀的 Apple Hospitality', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('efts.sec.gov')) {
      return jsonResponse({
        hits: {
          hits: [
            { _source: { ciks: ['0001418121'], display_names: ['Apple Hospitality REIT, Inc.  (APLE)  (CIK 0001418121)'] } },
            { _source: { ciks: ['0000320193'], display_names: ['APPLE COMPUTER INC  (AAPL)  (CIK 0000320193)'] } },
          ],
        },
      })
    }
    if (url.includes('data.sec.gov/submissions/CIK0001418121.json')) {
      return jsonResponse({ name: 'Apple Hospitality REIT, Inc.', tickers: ['APLE'], exchanges: ['NYSE'] })
    }
    if (url.includes('data.sec.gov/submissions/CIK0000320193.json')) {
      return jsonResponse({ name: 'Apple Inc.', tickers: ['AAPL'], exchanges: ['Nasdaq'] })
    }
    if (url.includes('/fuzzycompletions')) return jsonResponse({ data: [] })
    if (url.includes('wikidata.org')) return jsonResponse({ search: [] })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateCompany({ query: 'Apple' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.sec.cik, '0000320193', '顶层 SEC 应优先返回 Apple Inc.')
  assert.equal(res.sec.name, 'Apple Inc.')
  assert.deepEqual(res.sec.tickers, ['AAPL'])
  const ids = res.candidates.filter((item) => item.source === 'SEC EDGAR').map((item) => item.id)
  assert.ok(ids.includes('0000320193'))
  assert.ok(ids.includes('0001418121'))
})

test('部分数据源失败：软降级并保留其它源结果', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('efts.sec.gov') || url.includes('data.sec.gov')) return jsonResponse({ error: 'blocked' }, 500)
    if (url.includes('/fuzzycompletions')) return jsonResponse({ data: [] })
    if (url.includes('wikidata.org')) return jsonResponse({ search: [{ id: 'Q312', label: 'Apple Inc.', description: 'tech company' }] })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateCompany({ query: 'Apple' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.equal(res.sec.ok, false)
  assert.equal(typeof res.sec.error, 'string')
  assert.ok(res.warnings.some((w) => w.includes('SEC EDGAR')))
  assert.equal(res.wikidata.length, 1)
})

test('所有数据源失败：ok=false + error 字符串，且绝不抛错', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ error: 'down' }, 500))
  const res = await investigateCompany({ query: 'Unknown Corp' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, false)
  assert.equal(typeof res.error, 'string')
  assert.match(res.error, /所有数据源查询失败/)
  assert.equal(res.sources.gleif.ok, false)
  assert.equal(res.sources.sec.ok, false)
  assert.equal(res.sources.wikidata.ok, false)
  assert.deepEqual(res.deep_links, [])
  assert.ok(Array.isArray(res.next_steps))
  assert.deepEqual(res.candidates, [])
})

test('fetch 直接抛错时仍返回统一信封', async () => {
  const fetchImpl = async () => {
    throw new Error('network down')
  }
  const res = await investigateCompany({ query: 'Apple' }, { fetchImpl, now: NOW })
  assert.equal(res.ok, false)
  assert.equal(typeof res.error, 'string')
  assert.equal(res.tool, 'dd_company')
})

test('CIK 直查：0000320193 不再走全文检索', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('data.sec.gov/submissions/CIK0000320193.json')) {
      return jsonResponse({ name: 'Apple Inc.', tickers: ['AAPL'], exchanges: ['Nasdaq'], entityType: 'operating' })
    }
    if (url.includes('/fuzzycompletions')) return jsonResponse({ data: [] })
    if (url.includes('wikidata.org')) return jsonResponse({ search: [] })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateCompany({ query: '0000320193' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.sec.cik, '0000320193')
  const sec = res.candidates.find((item) => item.source === 'SEC EDGAR')
  assert.equal(sec.id, '0000320193')
  assert.equal(fetchImpl.calls.filter((call) => call.url.includes('efts.sec.gov')).length, 0)
})

test('空输入 / 非字符串：ok=false 且不发起任何请求', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({}, 500))
  for (const input of [{ query: '' }, { query: '   ' }, {}, { query: 42 }]) {
    const res = await investigateCompany(input, { fetchImpl, now: NOW })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'company query is required')
    assert.equal(res.tool, 'dd_company')
    assert.deepEqual(res.candidates, [])
    assert.deepEqual(res.evidence, [])
    assert.equal(res.error === null, false)
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test('looksLikeCompanyName：后缀启发式', () => {
  for (const name of ['Apple Inc.', 'Apple, Inc', 'ACME Corp', 'Example Ltd', 'Foo Holdings', '阿里巴巴集团', '某某科技有限公司', 'Goldman Sachs Group']) {
    assert.equal(looksLikeCompanyName(name), true, `应判为公司名：${name}`)
  }
  for (const name of ['张三', 'John Smith', 'Elon Musk', 'sherlock', '', '   ', null, undefined, 42]) {
    assert.equal(looksLikeCompanyName(name), false, `不应判为公司名：${String(name)}`)
  }
})
