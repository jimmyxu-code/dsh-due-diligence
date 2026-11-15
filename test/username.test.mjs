/**
 * lib/username.mjs（scanUsername）单元测试。
 * 所有网络都用 mock fetch：禁止真实联网；数据文件只读本地内置快照。
 * 运行：node --test test/username.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { extractHtmlTitle } from '../lib/evidence.mjs'
import { filterSites, loadExclusions, loadSiteManifest, siteRegexState } from '../lib/sherlock-engine.mjs'
import { scanUsername } from '../lib/username.mjs'

/** 造一个 fetch Response 伪对象（够 http.mjs 使用）。 */
function makeResponse(status, body = '', headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: '',
    body,
    headers: new Headers(headers),
    text: async () => body,
  }
}

/** 可注入 fetch：统一记录 {url, init}；matches 为字符串时按 url.includes 匹配。 */
function makeFetch(routes, fallback) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    for (const route of routes) {
      const matched = typeof route.match === 'string' ? url.includes(route.match) : route.match(url, init)
      if (matched) return typeof route.reply === 'function' ? route.reply(url, init, calls.length - 1) : route.reply
    }
    if (typeof fallback === 'function') return fallback(url, init, calls.length - 1)
    return makeResponse(404)
  }
  return { fetchImpl, calls }
}

const FIXED_NOW = Date.parse('2026-11-07T04:00:00.000Z')

test('scanUsername：空输入/非法用户名返回 ok:false 信封（不抛错）', async () => {
  for (const input of [{}, { username: '' }, { username: '   ' }, { username: 123 }]) {
    const result = await scanUsername(input, { fetchImpl: async () => makeResponse(200) })
    assert.equal(result.ok, false)
    assert.equal(result.tool, 'dd_username')
    assert.match(result.error, /username/)
    assert.deepEqual(result.found, [])
    assert.deepEqual(result.evidence, [])
    assert.equal(result.aborted, false)
  }
})

test('scanUsername：含 URL 字符或超长用户名被拒绝', async () => {
  const slash = await scanUsername({ username: 'a/b' }, { fetchImpl: async () => makeResponse(200) })
  assert.equal(slash.ok, false)
  assert.match(slash.error, /无法安全拼进站点 URL/)

  const long = await scanUsername({ username: 'a'.repeat(101) }, { fetchImpl: async () => makeResponse(200) })
  assert.equal(long.ok, false)
  assert.match(long.error, /过长/)
})

test('scanUsername：GitHub 单站命中，返回完整 Evidence 信封与证据', async () => {
  const { fetchImpl, calls } = makeFetch([
    { match: 'github.com', reply: () => makeResponse(200, '<html><title>octocat</title></html>') },
  ])
  const result = await scanUsername(
    { username: 'octocat', site: ['GitHub'] },
    { fetchImpl, now: FIXED_NOW },
  )

  for (const key of ['ok', 'tool', 'query', 'summary', 'evidence', 'warnings', 'error', 'found', 'counts', 'verify', 'elapsed_ms', 'sites_total', 'truncated', 'aborted']) {
    assert.ok(Object.hasOwn(result, key), `信封缺少字段 ${key}`)
  }
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'dd_username')
  assert.equal(result.error, null)
  assert.equal(result.sites_total, 1)
  assert.equal(result.truncated, false)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.query, { username: 'octocat', site: ['GitHub'], timeout_ms: 10000, verify: false, max_results: 100 })
  assert.match(result.summary, /命中 1 个平台/)
  assert.match(result.summary, /扫描 1 站/)

  assert.equal(result.found.length, 1)
  assert.deepEqual(result.found[0], {
    site: 'GitHub',
    url: 'https://www.github.com/octocat',
    status: 'claimed',
    http_status: 200,
    confidence: 'medium',
    verified: null,
    title: null,
    description: null,
    site_name: null,
    enriched: false,
  })

  assert.equal(result.evidence.length, 1)
  const evidence = result.evidence[0]
  assert.equal(evidence.source, 'sherlock:github')
  assert.equal(evidence.url, 'https://www.github.com/octocat')
  assert.equal(evidence.fetched_at, '2026-11-07T04:00:00.000Z')
  assert.equal(evidence.confidence, 'medium')
  assert.match(evidence.detail, /HEAD/)
  assert.match(evidence.detail, /HTTP 200/)

  assert.equal(result.counts.sites_total, 1)
  assert.equal(result.counts.manifest_total, 481)
  assert.equal(result.counts.checked, 1)
  assert.equal(result.counts.claimed, 1)
  assert.equal(result.counts.available, 0)
  assert.equal(result.verify.enabled, false)
  assert.equal(result.verify.timeout_ms, 6000)
  assert.equal(result.verify.concurrency, 10)
  assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'HEAD')
})

test('scanUsername：message 类型（1337x）errorMsg 命中 → available；未命中 → claimed', async () => {
  const errorMsgBody = '<html><head><title>404 Not Found</title></head></html>'
  const available = await scanUsername(
    { username: 'tester', site: ['1337x'] },
    { fetchImpl: makeFetch([{ match: '1337x', reply: () => makeResponse(200, errorMsgBody) }]).fetchImpl },
  )
  assert.equal(available.found.length, 0)
  assert.equal(available.counts.available, 1)
  assert.equal(available.counts.claimed, 0)

  const claimed = await scanUsername(
    { username: 'tester', site: ['1337x'] },
    { fetchImpl: makeFetch([{ match: '1337x', reply: () => makeResponse(200, '<title>tester profile</title>') }]).fetchImpl },
  )
  assert.equal(claimed.counts.claimed, 1)
  assert.equal(claimed.found[0].site, '1337x')
  assert.equal(claimed.found[0].url, 'https://www.1337x.to/user/tester/')
})

test('scanUsername：response_url（Avizo）禁重定向 302 → available；200 → claimed(high)', async () => {
  const redirect = makeFetch([{ match: 'avizo.cz', reply: () => makeResponse(302) }])
  const available = await scanUsername({ username: 'bob', site: ['Avizo'] }, { fetchImpl: redirect.fetchImpl })
  assert.equal(available.counts.available, 1)
  assert.equal(redirect.calls[0].init.redirect, 'manual')

  const claimed = await scanUsername(
    { username: 'bob', site: ['Avizo'] },
    { fetchImpl: makeFetch([{ match: 'avizo.cz', reply: () => makeResponse(200) }]).fetchImpl },
  )
  assert.equal(claimed.counts.claimed, 1)
  assert.equal(claimed.found[0].confidence, 'high', 'response_url 判定默认 high')
})

test('scanUsername：errorCode（Slides=204）命中 → available', async () => {
  const { fetchImpl } = makeFetch([{ match: 'slides.com', reply: () => makeResponse(204) }])
  const result = await scanUsername({ username: 'bob', site: ['Slides'] }, { fetchImpl })
  assert.equal(result.counts.available, 1)
  assert.equal(result.found.length, 0)
})

test('scanUsername：verify=true 命中且可达 → verified/title/high，且禁重定向', async () => {
  let headCalls = 0
  const { fetchImpl, calls } = makeFetch([
    {
      match: 'github.com',
      reply: (url, init) => {
        if (init.method === 'HEAD') {
          headCalls += 1
          return makeResponse(200)
        }
        return makeResponse(200, '<html><head><title> octocat (Octo Cat) </title></head></html>')
      },
    },
  ])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(headCalls, 1, '探测只发一次 HEAD')
  assert.equal(calls.length, 2, '命中后再发一次 GET 核验')
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[1].init.redirect, 'manual')
  assert.equal(result.found[0].verified, true)
  assert.equal(result.found[0].title, 'octocat (Octo Cat)')
  assert.equal(result.found[0].confidence, 'high')
  assert.equal(result.verify.enabled, true)
  assert.equal(result.verify.checked, 1)
  assert.equal(result.verify.verified, 1)
  assert.equal(result.verify.unreachable, 0)
  assert.match(result.evidence[0].detail, /二次核验 GET .* 可达，标题「octocat \(Octo Cat\)」/)
})

test('scanUsername：verify=true 命中不可达 → verified:false / low / warning', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: 'github.com',
      reply: (url, init) => (init.method === 'HEAD' ? makeResponse(200) : makeResponse(404)),
    },
  ])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(result.found[0].verified, false)
  assert.equal(result.found[0].confidence, 'low')
  assert.equal(result.verify.unreachable, 1)
  assert.ok(result.warnings.some((warning) => /不可达/.test(warning)))
  assert.match(result.evidence[0].detail, /二次核验不可达/)
})

test('scanUsername：verify 跟随同一账号路径的规范化 301（www→apex）后判可达', async () => {
  let call = 0
  const fetchImpl = async (url, init = {}) => {
    call += 1
    if (call === 1) return makeResponse(200) // HEAD 探测
    assert.equal(init.redirect, 'manual')
    if (call === 2) return makeResponse(301, '', { location: 'https://github.com/octocat' })
    if (call === 3) return makeResponse(200, '<html><title>GitHub - octocat</title></html>')
    throw new Error(`unexpected call ${call}: ${url}`)
  }
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(result.found[0].verified, true)
  assert.equal(result.found[0].confidence, 'high')
  assert.equal(result.found[0].title, 'GitHub - octocat')
  assert.equal(result.verify.verified, 1)
  assert.ok(call >= 3, '规范化重定向应再跟一次')
  assert.match(result.evidence[0].detail, /规范化重定向/)
})

test('scanUsername：verify 遇到指向首页/登录页的重定向判不可达（不把首页 200 当账号）', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: 'github.com',
      reply: (url, init) =>
        init.method === 'HEAD' ? makeResponse(200) : makeResponse(301, '', { location: 'https://github.com/' }),
    },
  ])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(result.found[0].verified, false)
  assert.equal(result.verify.unreachable, 1)
  assert.match(result.evidence[0].detail, /非账号路径/)
})

test('scanUsername：verify 3xx 缺 Location → unreachable', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: 'github.com',
      reply: (url, init) => (init.method === 'HEAD' ? makeResponse(200) : makeResponse(302)),
    },
  ])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(result.found[0].verified, false)
  assert.match(result.evidence[0].detail, /无 Location/)
})

test('scanUsername：verify 阶段网络错误软失败（verified:false，不抛错）', async () => {
  const { fetchImpl } = makeFetch([
    {
      match: 'github.com',
      reply: (url, init) => {
        if (init.method === 'HEAD') return makeResponse(200)
        throw new TypeError('verify ECONNRESET')
      },
    },
  ])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'], verify: true }, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.found[0].verified, false)
  assert.equal(result.found[0].confidence, 'low')
  assert.equal(result.verify.unreachable, 1)
})

test('scanUsername：长尾网络失败软降级，不拖垮整轮扫描', async () => {
  const { fetchImpl } = makeFetch(
    [
      { match: 'github.com', reply: () => makeResponse(200) },
      {
        match: 'slides.com',
        reply: () => {
          throw new TypeError('fetch failed')
        },
      },
    ],
    () => makeResponse(404),
  )
  const result = await scanUsername({ username: 'octocat', site: ['GitHub', 'Slides'] }, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.counts.failed, 1)
  assert.equal(result.counts.claimed, 1)
  assert.equal(result.found.length, 1)
  assert.ok(result.warnings.some((warning) => /请求失败/.test(warning)))

  const allFail = makeFetch([], () => {
    throw new TypeError('no route')
  })
  const failed = await scanUsername({ username: 'octocat', site: ['GitHub', 'Slides'] }, { fetchImpl: allFail.fetchImpl })
  assert.equal(failed.ok, true)
  assert.equal(failed.counts.failed, 2)
  assert.equal(failed.counts.checked, 0)
  assert.deepEqual(failed.found, [])
})

test('scanUsername：WAF 指纹站点计入 counts.waf，不产生命中', async () => {
  const body = '<html><span id="challenge-error-text">blocked</span></html>'
  const { fetchImpl } = makeFetch([{ match: 'github.com', reply: () => makeResponse(200, body) }])
  const result = await scanUsername({ username: 'octocat', site: ['GitHub'] }, { fetchImpl })
  assert.equal(result.counts.waf, 1)
  assert.equal(result.counts.checked, 1)
  assert.equal(result.found.length, 0)
  assert.ok(result.warnings.some((warning) => /WAF/.test(warning)))
})

test('scanUsername：regexCheck 不匹配 → counts.illegal 且不发请求', async () => {
  const { fetchImpl, calls } = makeFetch([{ match: '1337x', reply: () => makeResponse(200) }])
  const result = await scanUsername({ username: 'ab', site: ['1337x'] }, { fetchImpl })
  assert.equal(result.counts.illegal, 1)
  assert.equal(result.counts.checked, 0)
  assert.equal(calls.length, 0, '用户名不符合 regexCheck 时不应发请求')
  assert.equal(result.found.length, 0)
})

test('scanUsername：自定义站点库（临时 JSON）覆盖 invalid-regex / 缺字段 / 非法正则', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-username-'))
  try {
    const manifestPath = join(dir, 'sites.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        Alpha: { errorType: 'status_code', url: 'https://alpha.test/{}', urlMain: 'https://alpha.test/' },
        Beta: { errorType: 'message', errorMsg: 'no-such-user', url: 'https://beta.test/{}', urlMain: 'https://beta.test/' },
        Gamma: { errorType: 'status_code', regexCheck: '(', url: 'https://gamma.test/{}', urlMain: 'https://gamma.test/' },
        Delta: { errorType: 'status_code', regexCheck: '^[0-9]+$', url: 'https://delta.test/{}', urlMain: 'https://delta.test/' },
        Epsilon: { errorType: 'status_code', url: 'https://epsilon.test/{}' },
      }),
      'utf8',
    )
    const exclusionsPath = join(dir, 'exclusions.txt')
    writeFileSync(exclusionsPath, 'Alpha\n', 'utf8')
    const { fetchImpl, calls } = makeFetch(
      [
        { match: 'alpha.test', reply: () => makeResponse(200) },
        { match: 'beta.test', reply: () => makeResponse(200, 'no-such-user') },
      ],
      () => makeResponse(404),
    )
    const result = await scanUsername(
      { username: 'abc', site: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'] },
      { fetchImpl, manifestPath, exclusionsPath },
    )
    assert.equal(result.ok, true)
    assert.equal(result.counts.manifest_total, 5)
    assert.equal(result.sites_total, 4, 'Epsilon 缺 urlMain 被跳过')
    assert.equal(result.counts.claimed, 1)
    assert.equal(result.counts.available, 1)
    assert.equal(result.counts.skipped_invalid_regex, 1)
    assert.equal(result.counts.illegal, 1)
    assert.equal(calls.length, 2, '只对 Alpha/Beta 发请求')
    assert.ok(result.warnings.some((warning) => /缺 url\/urlMain/.test(warning)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanUsername：全量扫描默认剔除 45 exclusions + 18 NSFW（418 站）', async () => {
  const { fetchImpl, calls } = makeFetch([], () => makeResponse(404))
  const result = await scanUsername({ username: 'octocat' }, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.counts.manifest_total, 481)
  assert.equal(result.counts.sites_total, 418)
  assert.equal(result.counts.excluded, 45)
  assert.equal(result.counts.nsfw_removed, 18)
  assert.equal(result.counts.failed, 0)
  assert.equal(result.counts.unknown, 0)
  assert.equal(result.counts.waf, 0)

  // 计数用站点库独立复算：octocat 会让 2 个站 regexCheck 不匹配 → illegal（不发请求）；
  // 其余站点 mock 一律 404：message 类型空正文判 claimed（与 sherlock 一致），其余 available。
  const { sites } = loadSiteManifest()
  const { names } = loadExclusions()
  const plan = filterSites(sites, { exclusions: names }).plan
  const expected = { claimed: 0, available: 0, illegal: 0 }
  for (const { info } of plan) {
    if (siteRegexState(info, 'octocat') === 'mismatch') {
      expected.illegal += 1
      continue
    }
    const types = Array.isArray(info.errorType) ? info.errorType : [info.errorType]
    if (types.includes('message')) expected.claimed += 1
    else expected.available += 1
  }
  assert.equal(result.counts.illegal, expected.illegal)
  assert.equal(result.counts.claimed, expected.claimed)
  assert.equal(result.counts.available, expected.available)
  assert.equal(result.counts.checked, expected.claimed + expected.available)
  assert.equal(calls.length, expected.claimed + expected.available, '每个非 illegal 站点恰好一次探测请求')
  assert.equal(result.truncated, expected.claimed > 100)
  assert.equal(result.found.length, Math.min(100, expected.claimed))

  const hostnames = calls.map(({ url }) => new URL(url).hostname)
  for (const banned of ['reddit.com', 'tiktok.com', 'pornhub.com', 'spotify.com']) {
    assert.ok(!hostnames.some((host) => host === banned || host.endsWith(`.${banned}`)), `${banned} 应被默认剔除`)
  }
})

test('scanUsername：显式 site 放行 exclusions/NSFW 站点', async () => {
  const { fetchImpl, calls } = makeFetch(
    [
      { match: 'reddit.com', reply: () => makeResponse(200, '<html>reddit profile</html>') },
      { match: 'pornhub.com', reply: () => makeResponse(404) },
    ],
    () => makeResponse(404),
  )
  const result = await scanUsername({ username: 'octocat', site: ['Reddit', 'Pornhub'] }, { fetchImpl })
  assert.equal(result.sites_total, 2)
  assert.equal(result.counts.excluded, 0)
  assert.equal(result.counts.nsfw_removed, 0)
  assert.equal(result.counts.claimed, 1)
  assert.equal(result.found[0].site, 'Reddit')
  assert.equal(calls.length, 2)
  assert.ok(result.warnings.some((warning) => /误报排除名单中的站点：Reddit/.test(warning)))
  assert.ok(result.warnings.some((warning) => /显式指定了 NSFW 站点：Pornhub/.test(warning)))
})

test('scanUsername：maxResults 截断（按置信度排序）且支持 snake_case 别名', async () => {
  const { fetchImpl } = makeFetch([
    { match: 'avizo.cz', reply: () => makeResponse(200) },
    { match: 'github.com', reply: () => makeResponse(200) },
    { match: '1337x.to', reply: () => makeResponse(200, '<title>tester</title>') },
  ])
  const result = await scanUsername(
    { username: 'tester', site: ['GitHub', 'Avizo', '1337x'], max_results: 2 },
    { fetchImpl },
  )
  assert.equal(result.counts.claimed, 3)
  assert.equal(result.found.length, 2)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.found.map((item) => item.site), ['Avizo', '1337x'])
  assert.ok(result.warnings.some((warning) => /截断/.test(warning)))
  assert.equal(result.query.max_results, 2)

  const clamp = await scanUsername(
    { username: 'tester', site: ['GitHub'], maxResults: 0 },
    { fetchImpl: makeFetch([{ match: 'github.com', reply: () => makeResponse(200) }]).fetchImpl },
  )
  assert.equal(clamp.query.max_results, 1)
  assert.ok(clamp.warnings.some((warning) => /maxResults 已收敛/.test(warning)))
})

test('scanUsername：命中排序稳定（response_url 高置信度优先，同级按站点名）', async () => {
  const { fetchImpl } = makeFetch([
    { match: 'avizo.cz', reply: () => makeResponse(200) },
    { match: 'github.com', reply: () => makeResponse(200) },
    { match: '1337x.to', reply: () => makeResponse(200, '<title>tester</title>') },
  ])
  const result = await scanUsername({ username: 'tester', site: ['GitHub', 'Avizo', '1337x'] }, { fetchImpl })
  assert.deepEqual(result.found.map((item) => item.site), ['Avizo', '1337x', 'GitHub'])
  assert.deepEqual(result.found.map((item) => item.confidence), ['high', 'medium', 'medium'])
})

test('scanUsername：未知站点仅告警；全部未知时 ok:false', async () => {
  const mixed = await scanUsername(
    { username: 'octocat', site: ['GitHub', 'NoSuchSite'] },
    { fetchImpl: makeFetch([{ match: 'github.com', reply: () => makeResponse(200) }]).fetchImpl },
  )
  assert.equal(mixed.ok, true)
  assert.equal(mixed.sites_total, 1)
  assert.ok(mixed.warnings.some((warning) => /未找到站点：NoSuchSite/.test(warning)))

  const none = await scanUsername({ username: 'octocat', site: ['NoSuchSite'] }, { fetchImpl: async () => makeResponse(200) })
  assert.equal(none.ok, false)
  assert.match(none.error, /未找到可用站点/)
  assert.deepEqual(none.found, [])
})

test('scanUsername：站点库缺失 → ok:false；exclusions 缺失仅告警（软降级）', async () => {
  const broken = await scanUsername(
    { username: 'octocat', site: ['GitHub'] },
    { fetchImpl: async () => makeResponse(200), manifestPath: '/nonexistent/sherlock-sites.json' },
  )
  assert.equal(broken.ok, false)
  assert.match(broken.error, /站点库加载失败/)

  const degraded = await scanUsername(
    { username: 'octocat', site: ['GitHub'] },
    {
      fetchImpl: makeFetch([{ match: 'github.com', reply: () => makeResponse(200) }]).fetchImpl,
      exclusionsPath: '/nonexistent/exclusions.txt',
    },
  )
  assert.equal(degraded.ok, true)
  assert.ok(degraded.warnings.some((warning) => /无法读取误报排除名单/.test(warning)))
})

test('scanUsername：exec.signal 取消 → 返回部分结果并标 aborted', async () => {
  const controller = new AbortController()
  let count = 0
  const fetchImpl = async (url, init = {}) => {
    count += 1
    if (count === 5) {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    return makeResponse(404)
  }
  const result = await scanUsername({ username: 'octocat' }, { fetchImpl, signal: controller.signal })
  assert.equal(result.ok, true)
  assert.equal(result.aborted, true)
  assert.equal(result.counts.aborted, 1)
  assert.ok(result.counts.checked + result.counts.aborted < 418, '取消后应提前停止')
  assert.ok(result.warnings.some((warning) => /取消/.test(warning)))
})

test('scanUsername：开始前已取消 → aborted:true 且无结果', async () => {
  const controller = new AbortController()
  controller.abort()
  const { fetchImpl, calls } = makeFetch([], () => makeResponse(200))
  const result = await scanUsername({ username: 'octocat' }, { fetchImpl, signal: controller.signal })
  assert.equal(result.ok, true)
  assert.equal(result.aborted, true)
  assert.equal(result.sites_total, 418)
  assert.equal(result.counts.checked, 0)
  assert.equal(result.counts.aborted, 0)
  assert.deepEqual(result.found, [])
  assert.equal(calls.length, 0)
})

test('scanUsername：Anilist POST payload 集成（方法/URL/body 正确，命中 URL 仍是账号页）', async () => {
  const { fetchImpl, calls } = makeFetch([{ match: 'graphql.anilist.co', reply: () => makeResponse(200) }])
  const result = await scanUsername({ username: 'tester', site: ['Anilist'] }, { fetchImpl })
  assert.equal(result.counts.claimed, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://graphql.anilist.co/')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: 'query($name:String){User(name:$name){id}}',
    variables: { name: 'tester' },
  })
  assert.equal(result.found[0].url, 'https://anilist.co/user/tester/')
})

test('scanUsername：site 支持逗号字符串；timeoutMs 越界收敛并告警', async () => {
  const { fetchImpl } = makeFetch(
    [
      { match: 'github.com', reply: () => makeResponse(200) },
      { match: 'avizo.cz', reply: () => makeResponse(200) },
    ],
    () => makeResponse(404),
  )
  const result = await scanUsername({ username: 'tester', site: 'GitHub, Avizo', timeoutMs: 10 }, { fetchImpl })
  assert.equal(result.sites_total, 2)
  assert.equal(result.query.timeout_ms, 1000)
  assert.ok(result.warnings.some((warning) => /timeoutMs 已收敛/.test(warning)))
})

test('scanUsername：extractHtmlTitle 与 title 字段配合（标题空白归一化）', () => {
  assert.equal(extractHtmlTitle('<html><title>  hello   world </title></html>'), 'hello world')
  assert.equal(extractHtmlTitle('<html>no title</html>'), '')
})
