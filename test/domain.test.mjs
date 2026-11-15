/**
 * dd_domain 单元测试：全部通过注入 mock fetch 完成，禁止真实网络。
 * 覆盖：URL 归一化、RDAP/crt.sh/Wayback 汇总、crt.sh 502 重试成功、Wayback 无存档、
 * RDAP 失败软降级、非法/空域名不发起请求。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { investigateDomain, normalizeDomain } from '../lib/domain.mjs'

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

/** rdap.org/domain/example.com 的真实形状（2026-11-07 实测裁剪）。 */
const RDAP_BODY = {
  objectClassName: 'domain',
  ldhName: 'EXAMPLE.COM',
  status: ['client delete prohibited', 'client transfer prohibited'],
  entities: [
    {
      objectClassName: 'entity',
      handle: '376',
      roles: ['registrar'],
      vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Namecheap, Inc.']]],
    },
  ],
  events: [
    { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' },
  ],
  nameservers: [{ objectClassName: 'nameserver', ldhName: 'ELLIOTT.NS.CLOUDFLARE.COM' }, { ldhName: 'HERA.NS.CLOUDFLARE.COM' }],
}

/** crt.sh 响应形状：含通配符、重复名与无关域名。 */
const CRT_BODY = [
  {
    issuer_ca_id: 1,
    issuer_name: "C=US, O=Let's Encrypt, CN=R3",
    common_name: 'example.com',
    name_value: 'example.com\nwww.example.com',
    id: 101,
    not_before: '2026-01-01T00:00:00Z',
    not_after: '2026-04-01T00:00:00Z',
  },
  {
    issuer_ca_id: 1,
    issuer_name: "C=US, O=Let's Encrypt, CN=R3",
    common_name: '*.example.com',
    name_value: '*.example.com\napi.example.com',
    id: 102,
    not_before: '2026-02-01T00:00:00Z',
    not_after: '2026-05-01T00:00:00Z',
  },
  { issuer_ca_id: 2, issuer_name: 'CA', common_name: 'other.com', name_value: 'other.com', id: 103 },
]

/** Wayback 有存档。 */
const WAYBACK_BODY = {
  url: 'example.com',
  archived_snapshots: {
    closest: { status: '200', available: true, url: 'http://web.archive.org/web/20261106210337/https://example.com/', timestamp: '20261106210337' },
  },
}

test('example.com：URL 归一化 + RDAP/crt.sh/Wayback 汇总', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('rdap.org/domain/example.com')) return jsonResponse(RDAP_BODY)
    if (url.includes('crt.sh')) return jsonResponse(CRT_BODY)
    if (url.includes('archive.org/wayback')) return jsonResponse(WAYBACK_BODY)
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateDomain({ domain: 'https://Example.COM/path?a=1' }, { fetchImpl, now: NOW })

  // 统一信封
  assert.equal(res.tool, 'dd_domain')
  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.equal(res.domain, 'example.com')
  assert.equal(res.query, 'example.com')
  assert.match(res.summary, /example\.com/)

  // RDAP
  assert.equal(res.rdap.ok, true)
  assert.equal(res.rdap.error, null)
  assert.equal(res.rdap.registrar, 'Namecheap, Inc.')
  assert.equal(res.rdap.created, '1995-08-14T04:00:00Z')
  assert.equal(res.rdap.expires, '2027-08-13T04:00:00Z')
  assert.deepEqual(res.rdap.status, ['client delete prohibited', 'client transfer prohibited'])
  assert.deepEqual(res.rdap.nameservers, ['elliott.ns.cloudflare.com', 'hera.ns.cloudflare.com'])

  // crt.sh 证书与去重子域
  assert.equal(res.certificates.ok, true)
  assert.equal(res.certificates.count, 3)
  assert.equal(res.certificates.entries.length, 2)
  assert.ok(res.certificates.entries.every((entry) => entry.common_name.includes('example.com')))
  assert.deepEqual(res.subdomains, ['api.example.com', 'www.example.com'])

  // Wayback
  assert.equal(res.wayback.ok, true)
  assert.equal(res.wayback.available, true)
  assert.equal(res.wayback.timestamp, '20261106210337')
  assert.match(res.wayback.snapshot_url, /web\.archive\.org/)

  // 证据：多源 + 固定时间戳
  assert.ok(res.evidence.some((item) => item.source.includes('RDAP')))
  assert.ok(res.evidence.some((item) => item.source.includes('crt.sh')))
  assert.ok(res.evidence.some((item) => item.source.includes('Wayback')))
  for (const item of res.evidence) assert.equal(item.fetched_at, FETCHED_AT)
  assert.ok(Array.isArray(res.next_steps) && res.next_steps.length > 0)
})

test('crt.sh 第一次 502，retry 1 次后成功', async () => {
  let crtCalls = 0
  const fetchImpl = mockFetch((url) => {
    if (url.includes('crt.sh')) {
      crtCalls += 1
      return crtCalls === 1 ? new Response('bad gateway', { status: 502 }) : jsonResponse(CRT_BODY)
    }
    if (url.includes('rdap.org')) return jsonResponse({ error: 'not found' }, 404)
    if (url.includes('archive.org/wayback')) return jsonResponse(WAYBACK_BODY)
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateDomain({ domain: 'example.com' }, { fetchImpl, now: NOW, sleep: async () => {} })

  assert.equal(crtCalls, 2, 'crt.sh 应恰好请求 2 次（502 → 重试）')
  assert.equal(res.certificates.ok, true)
  assert.equal(res.certificates.count, 3)
  assert.equal(res.ok, true)
  assert.ok(res.warnings.some((warning) => warning.includes('RDAP')), 'RDAP 404 应进入 warnings')
})

test('Wayback 无存档：ok=true 但 available=false', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('rdap.org')) return jsonResponse(RDAP_BODY)
    if (url.includes('crt.sh')) return jsonResponse([])
    if (url.includes('archive.org/wayback')) return jsonResponse({ url: 'example.com', archived_snapshots: {} })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateDomain({ domain: 'example.com' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.wayback.ok, true)
  assert.equal(res.wayback.available, false)
  assert.equal(res.wayback.snapshot_url, null)
  assert.equal(res.certificates.count, 0)
  assert.deepEqual(res.subdomains, [])
  assert.ok(res.warnings.some((warning) => warning.includes('Wayback 无存档')))
  assert.match(res.summary, /Wayback 无存档/)
})

test('RDAP 失败软降级：其它源照常返回', async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes('rdap.org')) return jsonResponse({ error: 'rdap down' }, 500)
    if (url.includes('crt.sh')) return jsonResponse(CRT_BODY)
    if (url.includes('archive.org/wayback')) return jsonResponse({ url: 'example.com', archived_snapshots: {} })
    return jsonResponse({ error: 'unmocked' }, 404)
  })
  const res = await investigateDomain({ domain: 'example.com' }, { fetchImpl, now: NOW })

  assert.equal(res.ok, true)
  assert.equal(res.error, null)
  assert.equal(res.rdap.ok, false)
  assert.equal(typeof res.rdap.error, 'string')
  assert.deepEqual(res.rdap.status, [])
  assert.deepEqual(res.rdap.nameservers, [])
  assert.ok(res.warnings.some((warning) => warning.includes('RDAP')))
  assert.equal(res.certificates.ok, true)
})

test('所有源失败：ok=false + error 字符串，且绝不抛错', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({ error: 'down' }, 500))
  const res = await investigateDomain({ domain: 'example.com' }, { fetchImpl, now: NOW, sleep: async () => {} })

  assert.equal(res.ok, false)
  assert.equal(typeof res.error, 'string')
  assert.match(res.error, /所有数据源查询失败/)
  assert.equal(res.rdap.ok, false)
  assert.equal(res.certificates.ok, false)
  assert.equal(res.wayback.ok, false)
  assert.equal(res.domain, 'example.com')
})

test('空输入 / 非法域名：ok=false 且不发起任何请求', async () => {
  const fetchImpl = mockFetch(() => jsonResponse({}, 500))
  for (const input of [{}, { domain: '' }, { domain: '   ' }, { domain: 42 }]) {
    const res = await investigateDomain(input, { fetchImpl, now: NOW })
    assert.equal(res.ok, false)
    assert.equal(res.error, 'domain is required')
    assert.equal(res.tool, 'dd_domain')
    assert.deepEqual(res.subdomains, [])
  }
  for (const domain of ['not a domain', 'http://', '-bad.com', 'localhost', '1.2.3.4', 'exa_mple.com']) {
    const res = await investigateDomain({ domain }, { fetchImpl, now: NOW })
    assert.equal(res.ok, false, `应判非法：${domain}`)
    assert.match(res.error, /^invalid domain:/)
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test('normalizeDomain：常见输入归一化与拒绝', () => {
  assert.equal(normalizeDomain('EXAMPLE.com.'), 'example.com')
  assert.equal(normalizeDomain('https://user:pass@Sub.Example.com:8443/x?y=1#z'), 'sub.example.com')
  assert.equal(normalizeDomain('http://example.com'), 'example.com')
  assert.equal(normalizeDomain('例子.中国'), 'xn--fsqu00a.xn--fiqs8s')
  for (const value of ['', '   ', 'not_a_domain', 'http://', '1.2.3.4', '-bad.com', null, undefined, 42]) {
    assert.equal(normalizeDomain(value), null, `应拒绝：${String(value)}`)
  }
  assert.equal(normalizeDomain(`a.${'b'.repeat(300)}`), null, '超长域名应拒绝')
})
