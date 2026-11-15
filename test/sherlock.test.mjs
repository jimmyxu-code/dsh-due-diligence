/**
 * lib/sherlock-engine.mjs 单元测试（全部脱网：fetch 一律 mock / 不联网）。
 * 运行：node --test test/sherlock.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TIMEOUT_MS,
  SHERLOCK_VERSION,
  WAF_FINGERPRINTS,
  buildProbeRequest,
  clearSherlockDataCache,
  detectWaf,
  filterSites,
  interpolateString,
  judgeResponse,
  loadExclusions,
  loadSiteManifest,
  normalizeErrorCodes,
  normalizeErrorTypes,
  normalizeSiteInput,
  probeSite,
  siteRegexState,
  toEvidenceSource,
} from '../lib/sherlock-engine.mjs'

/** 造一个 fetch Response 伪对象（够 http.mjs 使用）。 */
function makeResponse(status, body = '', extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: '',
    headers: new Headers(),
    body,
    text: async () => body,
    ...extra,
  }
}

/** 可注入的 fetch：返回固定响应并记录调用。 */
function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init, calls.length - 1)
  }
  return { fetchImpl, calls }
}

/** 永远挂起、只在 signal abort 时 reject 的 fetch（测超时/取消）。 */
function hangingFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const signal = init.signal
    const fail = () => reject(Object.assign(new Error('aborted by signal'), { name: 'AbortError' }))
    if (signal?.aborted === true) {
      fail()
      return
    }
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/** 直接判定用：接受 {status, text} 或 makeResponse 伪对象（后者 text 是函数，改用 body）。 */
function judge(siteInfo, response) {
  if (response !== null && typeof response === 'object' && typeof response.text === 'function') {
    return judgeResponse(siteInfo, { status: response.status, text: response.body ?? '' })
  }
  return judgeResponse(siteInfo, response)
}

const GITHUB_INFO = {
  errorType: 'status_code',
  regexCheck: '^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$',
  url: 'https://www.github.com/{}',
  urlMain: 'https://www.github.com/',
  username_claimed: 'blue',
}

test('常量：版本与默认超时与 sherlock v0.16.2 对齐', () => {
  assert.equal(SHERLOCK_VERSION, '0.16.2')
  assert.equal(DEFAULT_TIMEOUT_MS, 10000)
  assert.equal(WAF_FINGERPRINTS.length, 4)
})

test('loadSiteManifest：内置站点库 481 站、忽略 $schema、带缓存', () => {
  clearSherlockDataCache()
  const first = loadSiteManifest()
  assert.equal(first.count, 481)
  assert.equal(first.sites.$schema, undefined)
  assert.ok(first.sites.GitHub)
  assert.equal(first.sites.GitHub.url, 'https://www.github.com/{}')
  const second = loadSiteManifest()
  assert.equal(first, second, '同一路径应命中缓存')
})

test('loadSiteManifest：路径不存在时抛错（由调用方转成软失败）', () => {
  clearSherlockDataCache()
  assert.throws(() => loadSiteManifest({ path: '/nonexistent/sherlock-sites.json' }), /ENOENT|no such file/i)
  clearSherlockDataCache()
})

test('loadExclusions：内置 45 条误报排除名单', () => {
  clearSherlockDataCache()
  const result = loadExclusions()
  assert.equal(result.warning, null)
  assert.equal(result.names.length, 45)
  assert.ok(result.names.includes('Reddit'))
  assert.ok(result.names.includes('social.tchncs.de'))
})

test('loadExclusions：文件缺失只返回 warning，不抛错', () => {
  clearSherlockDataCache()
  const result = loadExclusions({ path: '/nonexistent/false-positive-exclusions.txt' })
  assert.deepEqual(result.names, [])
  assert.match(result.warning, /无法读取误报排除名单/)
  clearSherlockDataCache()
})

test('interpolateString：字符串全量替换 + 嵌套对象/数组（对应 Python interpolate_string）', () => {
  assert.equal(interpolateString('https://a.com/{}/x/{}', 'bob'), 'https://a.com/bob/x/bob')
  assert.deepEqual(interpolateString({ query: 'q($n:String){User(name:$n)}', variables: { name: '{}' } }, 'bob'), {
    query: 'q($n:String){User(name:$n)}',
    variables: { name: 'bob' },
  })
  assert.deepEqual(interpolateString(['{}', 1, null], 'bob'), ['bob', 1, null])
})

test('normalizeSiteInput：字符串/逗号分隔/数组，去空保序', () => {
  assert.deepEqual(normalizeSiteInput('GitHub'), ['GitHub'])
  assert.deepEqual(normalizeSiteInput('GitHub, Reddit ,, '), ['GitHub', 'Reddit'])
  assert.deepEqual(normalizeSiteInput(['GitHub', 'GitHub', 'Reddit']), ['GitHub', 'Reddit'])
  assert.deepEqual(normalizeSiteInput(undefined), [])
  assert.deepEqual(normalizeSiteInput(42), [])
})

test('normalizeErrorTypes / normalizeErrorCodes：兼容单值与列表', () => {
  assert.deepEqual(normalizeErrorTypes('message'), ['message'])
  assert.deepEqual(normalizeErrorTypes(['message', 'status_code']), ['message', 'status_code'])
  assert.equal(normalizeErrorTypes('bogus'), null)
  assert.equal(normalizeErrorTypes([]), null)
  assert.equal(normalizeErrorTypes(undefined), null)
  assert.deepEqual(normalizeErrorCodes(404), [404])
  assert.deepEqual(normalizeErrorCodes([404, 204]), [404, 204])
  assert.deepEqual(normalizeErrorCodes(undefined), [])
  assert.deepEqual(normalizeErrorCodes(['404']), [])
})

test('filterSites：全量模式先剔 exclusions 再剔 NSFW，缺字段站点归 invalid', () => {
  const sites = {
    A: { url: 'https://a.com/{}', urlMain: 'https://a.com/', errorType: 'status_code' },
    B: { url: 'https://b.com/{}', urlMain: 'https://b.com/', errorType: 'status_code', isNSFW: true },
    C: { url: 'https://c.com/{}', urlMain: 'https://c.com/', errorType: 'message' },
    D: { url: 'https://d.com/{}', errorType: 'message' },
  }
  const result = filterSites(sites, { exclusions: ['C'] })
  assert.equal(result.mode, 'full')
  assert.deepEqual(result.plan.map((item) => item.name), ['A'])
  assert.deepEqual(result.excluded, ['C'])
  assert.deepEqual(result.nsfw_removed, ['B'])
  assert.deepEqual(result.invalid, ['D'])
  assert.equal(result.manifest_total, 4)
})

test('filterSites：内置站点库筛选结果 418 站（481 - 45 exclusions - 18 NSFW）', () => {
  const { sites } = loadSiteManifest()
  const { names } = loadExclusions()
  const result = filterSites(sites, { exclusions: names })
  assert.equal(result.plan.length, 418)
  assert.equal(result.excluded.length, 45)
  assert.equal(result.nsfw_removed.length, 18)
  assert.ok(!result.plan.some((item) => item.name === 'Reddit'))
  assert.ok(!result.plan.some((item) => item.info.isNSFW === true))
  const all = filterSites(sites, { exclusions: names, ignoreExclusions: true })
  assert.equal(all.plan.length, 462)
  const withNsfw = filterSites(sites, { exclusions: names, excludeNsfw: false })
  assert.equal(withNsfw.plan.length, 436)
})

test('filterSites：显式 site 大小写不敏感、放行 exclusions/NSFW、报告缺失站点', () => {
  const { sites } = loadSiteManifest()
  const { names } = loadExclusions()
  const result = filterSites(sites, { site: ['github', 'REDDIT', 'Pornhub', 'NoSuchSite'], exclusions: names })
  assert.equal(result.mode, 'filtered')
  assert.deepEqual(result.plan.map((item) => item.name), ['GitHub', 'Reddit', 'Pornhub'])
  assert.deepEqual(result.missing, ['NoSuchSite'])
  assert.deepEqual(result.excluded, [])
  assert.deepEqual(result.nsfw_removed, [])
})

test('detectWaf：4 条指纹逐条命中，普通页/空正文不误报', () => {
  const body = `prefix ${WAF_FINGERPRINTS[0].needle} suffix`
  for (const fingerprint of WAF_FINGERPRINTS) {
    const hit = detectWaf(`x${fingerprint.needle}y`)
    assert.equal(hit.hit, true, fingerprint.label)
    assert.equal(hit.label, fingerprint.label)
  }
  assert.deepEqual(detectWaf(body), { hit: true, label: WAF_FINGERPRINTS[0].label })
  assert.deepEqual(detectWaf('<html><title>hello</title></html>'), { hit: false, label: null })
  assert.deepEqual(detectWaf(''), { hit: false, label: null })
  assert.deepEqual(detectWaf(null), { hit: false, label: null })
})

test('judgeResponse status_code：200→claimed，404/3xx/5xx/非 2xx→available', () => {
  const claim = judge(GITHUB_INFO, makeResponse(200))
  assert.equal(claim.status, 'claimed')
  assert.equal(claim.http_status, 200)
  assert.equal(claim.confidence, 'medium')
  assert.equal(claim.decided_by, 'status_code')

  assert.equal(judge(GITHUB_INFO, makeResponse(404)).status, 'available')
  assert.equal(judge(GITHUB_INFO, makeResponse(301)).status, 'available')
  assert.equal(judge(GITHUB_INFO, makeResponse(500)).status, 'available')
  assert.equal(judge(GITHUB_INFO, makeResponse(199)).status, 'available')
})

test('judgeResponse status_code：errorCode 单值/列表；2xx 命中 errorCode 判 available', () => {
  const withCode = { errorType: 'status_code', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorCode: 404 }
  const hit = judge(withCode, makeResponse(404))
  assert.equal(hit.status, 'available')
  assert.match(hit.detail, /errorCode/)

  const soft404 = { errorType: 'status_code', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorCode: [200, 204] }
  assert.equal(judge(soft404, makeResponse(200)).status, 'available')
  assert.equal(judge(soft404, makeResponse(204)).status, 'available')
  assert.equal(judge(soft404, makeResponse(201)).status, 'claimed', 'errorCode 未命中且为 2xx')
})

test('judgeResponse message：errorMsg 未命中→claimed，命中字符串/列表任一条→available', () => {
  const site = {
    errorType: 'message',
    url: 'https://x.com/{}',
    urlMain: 'https://x.com/',
    errorMsg: 'This account does not exist',
  }
  assert.equal(judge(site, makeResponse(200, '<html>real profile</html>')).status, 'claimed')
  assert.equal(judge(site, makeResponse(200, '<p>This account does not exist</p>')).status, 'available')

  const listSite = {
    errorType: 'message',
    url: 'https://x.com/{}',
    urlMain: 'https://x.com/',
    errorMsg: ['<title>Error</title>', '<title>404 Not Found</title>'],
  }
  assert.equal(judge(listSite, makeResponse(200, '<title>404 Not Found</title>')).status, 'available')
  assert.equal(judge(listSite, makeResponse(200, '<title>Profile</title>')).status, 'claimed')
  assert.equal(judge(listSite, makeResponse(404, '<title>Profile</title>')).status, 'claimed', 'message 类型不看状态码')
})

test('judgeResponse message：缺少 errorMsg 规则时 unknown 而不是抛错（Python 会 TypeError）', () => {
  const broken = { errorType: 'message', url: 'https://x.com/{}', urlMain: 'https://x.com/' }
  const result = judge(broken, makeResponse(200, '<html></html>'))
  assert.equal(result.status, 'unknown')
  assert.match(result.detail, /errorMsg/)
  const empty = { ...broken, errorMsg: [] }
  assert.equal(judge(empty, makeResponse(200, '')).status, 'unknown')
})

test('judgeResponse response_url：禁重定向后 2xx→claimed(high)，非 2xx→available', () => {
  const site = { errorType: 'response_url', url: 'https://x.com/{}', urlMain: 'https://x.com/' }
  const claimed = judge(site, makeResponse(200, 'profile'))
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.decided_by, 'response_url')
  assert.equal(claimed.confidence, 'high')
  assert.equal(judge(site, makeResponse(204)).status, 'claimed')
  assert.equal(judge(site, makeResponse(302)).status, 'available')
})

test('judgeResponse：WAF 指纹优先级最高（先于 errorType 判定）', () => {
  const messageSite = { errorType: 'message', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorMsg: 'gone' }
  const wafBody = `<html>${WAF_FINGERPRINTS[1].needle}</html>`
  const result = judge(messageSite, makeResponse(200, wafBody))
  assert.equal(result.status, 'waf')
  assert.match(result.detail, /WAF/)
  // 未知 errorType 也会先被 WAF 拦下，与 Python 分支顺序一致
  const unknownType = judge({ errorType: 'bogus', url: 'https://x.com/{}' }, makeResponse(200, wafBody))
  assert.equal(unknownType.status, 'waf')
})

test('judgeResponse：未知 errorType → unknown（Python 记 UNKNOWN 且整轮不崩）', () => {
  assert.equal(judge({ errorType: 'bogus', url: 'x' }, makeResponse(200)).status, 'unknown')
  assert.equal(judge({ url: 'x' }, makeResponse(200)).status, 'unknown')
  assert.equal(judge({ errorType: ['bogus'] }, makeResponse(200)).status, 'unknown')
})

test('judgeResponse：多 errorType 组合按 message→status_code→response_url 顺序覆盖', () => {
  const combo = {
    errorType: ['message', 'status_code'],
    errorMsg: 'nope',
    url: 'https://x.com/{}',
    urlMain: 'https://x.com/',
  }
  // message 判 claimed，status_code 404 覆盖为 available
  assert.equal(judge(combo, makeResponse(404, '<html></html>')).status, 'available')
  // message 判 available 后 status_code 不再覆盖
  assert.equal(judge(combo, makeResponse(404, 'nope')).status, 'available')

  const combo2 = { errorType: ['message', 'response_url'], errorMsg: 'nope', url: 'https://x.com/{}' }
  const claimed = judge(combo2, makeResponse(200, '<html></html>'))
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.decided_by, 'response_url')
})

test('siteRegexState：none/ok/mismatch/非法正则', () => {
  assert.equal(siteRegexState({}, 'bob'), 'none')
  assert.equal(siteRegexState({ regexCheck: '^[a-z]+$' }, 'bob'), 'ok')
  assert.equal(siteRegexState({ regexCheck: '^[a-z]+$' }, 'Bob 1'), 'mismatch')
  assert.equal(siteRegexState({ regexCheck: '(' }, 'bob'), 'invalid')
})

test('buildProbeRequest：status_code 默认 HEAD、headers 用 sherlock UA、URL 插值', () => {
  const request = buildProbeRequest('GitHub', GITHUB_INFO, 'octocat')
  assert.equal(request.ok, true)
  assert.equal(request.url, 'https://www.github.com/octocat')
  assert.equal(request.probe_url, 'https://www.github.com/octocat')
  assert.equal(request.method, 'HEAD')
  assert.equal(request.redirect, 'follow')
  assert.match(request.headers['user-agent'], /Firefox\/129\.0/)
  assert.deepEqual(request.error_types, ['status_code'])
})

test('buildProbeRequest：urlProbe 优先、response_url 禁重定向、message 用 GET', () => {
  const responseUrlSite = {
    errorType: 'response_url',
    url: 'https://x.com/{}',
    urlProbe: 'https://x.com/probe/{}',
    urlMain: 'https://x.com/',
  }
  const redirectRequest = buildProbeRequest('X', responseUrlSite, 'bob')
  assert.equal(redirectRequest.ok, true)
  assert.equal(redirectRequest.url, 'https://x.com/bob')
  assert.equal(redirectRequest.probe_url, 'https://x.com/probe/bob')
  assert.equal(redirectRequest.redirect, 'manual')
  assert.equal(redirectRequest.method, 'GET')

  const messageSite = { errorType: 'message', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorMsg: 'gone' }
  assert.equal(buildProbeRequest('X', messageSite, 'bob').method, 'GET')
})

test('buildProbeRequest：自定义 headers 合并、request_method=POST + JSON payload', () => {
  const site = {
    errorType: 'status_code',
    url: 'https://anilist.co/user/{}/',
    urlMain: 'https://anilist.co/',
    urlProbe: 'https://graphql.anilist.co/',
    request_method: 'POST',
    request_payload: { query: 'query($name:String){User(name:$name){id}}', variables: { name: '{}' } },
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'k1' },
  }
  const request = buildProbeRequest('Anilist', site, 'bob')
  assert.equal(request.ok, true)
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.headers['x-api-key'], 'k1')
  assert.match(request.headers['user-agent'], /Firefox/)
  assert.deepEqual(JSON.parse(request.body), {
    query: 'query($name:String){User(name:$name){id}}',
    variables: { name: 'bob' },
  })

  // 未显式给 content-type 时自动补 application/json
  const noType = buildProbeRequest('Y', { ...site, headers: undefined }, 'bob')
  assert.equal(noType.headers['content-type'], 'application/json')
})

test('buildProbeRequest：空格转 %20、未知方法与缺字段转错误（不抛错）', () => {
  const spaced = buildProbeRequest('X', { errorType: 'message', url: 'https://x.com/{}/a', urlMain: 'https://x.com/', errorMsg: 'g' }, 'john doe')
  assert.equal(spaced.url, 'https://x.com/john%20doe/a')

  const badMethod = buildProbeRequest('X', { errorType: 'message', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorMsg: 'g', request_method: 'PATCH' }, 'bob')
  assert.equal(badMethod.ok, false)
  assert.match(badMethod.error, /request_method/)

  const missingUrl = buildProbeRequest('X', { errorType: 'message' }, 'bob')
  assert.equal(missingUrl.ok, false)

  const badType = buildProbeRequest('X', { errorType: 'nope', url: 'https://x.com/{}', urlMain: 'https://x.com/' }, 'bob')
  assert.equal(badType.ok, false)
})

test('buildProbeRequest：payload 遇到默认 GET/HEAD 时改 POST（Node fetch 限制，已在文件头注明差异）', () => {
  const site = {
    errorType: 'status_code',
    url: 'https://x.com/{}',
    urlMain: 'https://x.com/',
    request_payload: { name: '{}' },
  }
  assert.equal(buildProbeRequest('X', site, 'bob').method, 'POST')
})

test('probeSite：GitHub 式 HEAD 200 → claimed，method/http_status/置信度正确', async () => {
  const { fetchImpl, calls } = makeFetch(() => makeResponse(200))
  const result = await probeSite('GitHub', GITHUB_INFO, { username: 'octocat', fetchImpl })
  assert.equal(result.status, 'claimed')
  assert.equal(result.http_status, 200)
  assert.equal(result.method, 'HEAD')
  assert.equal(result.url, 'https://www.github.com/octocat')
  assert.equal(result.confidence, 'medium')
  assert.equal(result.error, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'HEAD')
  assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0)
})

test('probeSite：404 → available；response_url 302 → available 且 redirect=manual', async () => {
  const notFound = makeFetch(() => makeResponse(404))
  const available = await probeSite('GitHub', GITHUB_INFO, { username: 'nobody', fetchImpl: notFound.fetchImpl })
  assert.equal(available.status, 'available')
  assert.equal(available.http_status, 404)

  const responseUrlSite = { errorType: 'response_url', url: 'https://x.com/{}', urlMain: 'https://x.com/' }
  const redirectCase = makeFetch(() => makeResponse(302))
  const result = await probeSite('X', responseUrlSite, { username: 'nobody', fetchImpl: redirectCase.fetchImpl })
  assert.equal(result.status, 'available')
  assert.equal(redirectCase.calls[0].init.redirect, 'manual')
})

test('probeSite：message 类型 errorMsg 命中 → available；未命中 → claimed', async () => {
  const site = { errorType: 'message', url: 'https://x.com/{}', urlMain: 'https://x.com/', errorMsg: 'gone-forever' }
  const hit = await probeSite('X', site, { username: 'bob', fetchImpl: makeFetch(() => makeResponse(200, 'gone-forever')).fetchImpl })
  assert.equal(hit.status, 'available')
  const miss = await probeSite('X', site, { username: 'bob', fetchImpl: makeFetch(() => makeResponse(200, 'profile')).fetchImpl })
  assert.equal(miss.status, 'claimed')
})

test('probeSite：WAF 指纹 → waf', async () => {
  const body = `<html><body>${WAF_FINGERPRINTS[2].needle}</body></html>`
  const { fetchImpl } = makeFetch(() => makeResponse(200, body))
  const result = await probeSite('GitHub', GITHUB_INFO, { username: 'bob', fetchImpl })
  assert.equal(result.status, 'waf')
  assert.match(result.detail, /WAF/)
})

test('probeSite：regexCheck 不匹配 → illegal 且不发请求；非法正则 → unknown/invalid-regex', async () => {
  const { fetchImpl, calls } = makeFetch(() => makeResponse(200))
  const illegal = await probeSite('GitHub', GITHUB_INFO, { username: 'bad name!', fetchImpl })
  assert.equal(illegal.status, 'illegal')
  assert.equal(calls.length, 0, 'regexCheck 不匹配时不应发请求')

  const broken = await probeSite('X', { ...GITHUB_INFO, regexCheck: '(' }, { username: 'bob', fetchImpl })
  assert.equal(broken.status, 'unknown')
  assert.equal(broken.code, 'invalid-regex')
  assert.equal(calls.length, 0)
})

test('probeSite：网络错误 → failed（软失败，不抛错）', async () => {
  const { fetchImpl } = makeFetch(() => {
    throw new TypeError('fetch failed: ECONNRESET')
  })
  const result = await probeSite('GitHub', GITHUB_INFO, { username: 'bob', fetchImpl })
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'network')
  assert.match(result.error, /ECONNRESET/)
})

test('probeSite：超时 → failed/timeout（默认 10s，测试用 20ms）', async () => {
  const result = await probeSite('GitHub', GITHUB_INFO, { username: 'bob', fetchImpl: hangingFetch, timeoutMs: 20 })
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'timeout')
})

test('probeSite：外部 signal 取消 → aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await probeSite('GitHub', GITHUB_INFO, {
    username: 'bob',
    fetchImpl: hangingFetch,
    signal: controller.signal,
  })
  assert.equal(result.status, 'aborted')
  assert.equal(result.code, 'aborted')
})

test('probeSite：自定义 headers 与 urlProbe 生效', async () => {
  const site = {
    errorType: 'status_code',
    url: 'https://discord.com/{}',
    urlMain: 'https://discord.com/',
    urlProbe: 'https://discord.com/api/probe',
    request_method: 'POST',
    request_payload: { username: '{}' },
    headers: { 'Content-Type': 'application/json', 'x-secret': 's1' },
  }
  const { fetchImpl, calls } = makeFetch(() => makeResponse(200))
  const result = await probeSite('Discord', site, { username: 'bob', fetchImpl })
  assert.equal(result.status, 'claimed')
  assert.equal(calls[0].url, 'https://discord.com/api/probe')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['x-secret'], 's1')
  assert.equal(result.url, 'https://discord.com/bob', '对外 URL 仍是人类可读的账号页')
})

test('toEvidenceSource：站点名转证据 source 标识', () => {
  assert.equal(toEvidenceSource('GitHub'), 'sherlock:github')
  assert.equal(toEvidenceSource('Apple Developer'), 'sherlock:apple-developer')
  assert.equal(toEvidenceSource('social.tchncs.de'), 'sherlock:social.tchncs.de')
  assert.equal(toEvidenceSource('  '), 'sherlock:unknown')
})
