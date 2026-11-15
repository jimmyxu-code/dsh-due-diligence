/**
 * lib/http.mjs 与 lib/evidence.mjs 的单元测试：全部用 mock fetch，不触网。
 * 运行：node --test test/shared.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HttpFailure,
  abortFailure,
  describeError,
  fetchJson,
  isAbortFailure,
  mapLimit,
  requestText,
  retry,
  withTimeout,
  USER_AGENT,
} from '../lib/http.mjs'
import {
  clampText,
  combineConfidence,
  countByConfidence,
  dedupeEvidence,
  dedupeStrings,
  extractHtmlTitle,
  isoNow,
  listSources,
  makeEvidence,
  sortByConfidence,
} from '../lib/evidence.mjs'

/**
 * 构造一个 mock fetch，按顺序返回预设响应。
 * @param {Array<() => Response|Promise<Response>>} steps 响应工厂。
 * @returns {typeof fetch & { calls: any[] }} mock。
 */
function mockFetch(steps) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const step = steps[Math.min(steps.length - 1, calls.length - 1)]
    if (step === undefined) throw new Error('no mock response')
    return step()
  }
  impl.calls = calls
  return impl
}

/**
 * 构造 Response（Node 内置）。
 * @param {string} body 正文。
 * @param {{ status?: number, headers?: Record<string,string> }} [init] 选项。
 * @returns {Response} 响应。
 */
function jsonResponse(body, init = {}) {
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
}

test('makeEvidence fills defaults and rejects a missing source', () => {
  const evidence = makeEvidence({ source: 'gleif', url: 'https://api.gleif.org/x', now: Date.UTC(2026, 10, 7), detail: 'hit' })
  assert.equal(evidence.source, 'gleif')
  assert.equal(evidence.url, 'https://api.gleif.org/x')
  assert.equal(evidence.fetched_at, '2026-11-07T00:00:00.000Z')
  assert.equal(evidence.confidence, 'medium')
  assert.equal(evidence.detail, 'hit')
  assert.throws(() => makeEvidence({}), /source is required/)
  assert.equal(makeEvidence({ source: 'x', confidence: 'nope' }).confidence, 'medium')
})

test('evidence helpers dedupe, count, sort and list sources', () => {
  const list = [
    makeEvidence({ source: 'a', url: 'u1', confidence: 'low', detail: 'd' }),
    makeEvidence({ source: 'a', url: 'u1', confidence: 'low', detail: 'd' }),
    makeEvidence({ source: 'b', url: 'u2', confidence: 'high' }),
    makeEvidence({ source: 'c', url: 'u3', confidence: 'medium' }),
  ]
  assert.equal(dedupeEvidence(list).length, 3)
  assert.deepEqual(countByConfidence(dedupeEvidence(list)), { high: 1, medium: 1, low: 1, total: 3 })
  assert.deepEqual(listSources(list), ['a', 'b', 'c'])
  assert.deepEqual(
    sortByConfidence(list).map((item) => item.confidence),
    ['high', 'medium', 'low', 'low'],
  )
  assert.equal(combineConfidence('high', 'low'), 'low')
  assert.equal(combineConfidence(undefined, 'high'), 'high')
})

test('string helpers trim, dedupe, clamp and extract titles', () => {
  assert.deepEqual(dedupeStrings([' a ', 'a', '', 3, 'b']), ['a', 'b'])
  assert.equal(clampText('abcdef', 4), 'abc…')
  assert.equal(clampText(123), '')
  assert.equal(isoNow(Date.UTC(2026, 0, 2)), '2026-01-02T00:00:00.000Z')
  assert.equal(extractHtmlTitle('<html><head><title>  Hello   World </title></head></html>'), 'Hello World')
  assert.equal(extractHtmlTitle('<html></html>'), '')
})

test('requestText sends the plugin user agent and reads text', async () => {
  const fetchImpl = mockFetch([() => new Response('hello', { status: 200 })])
  const response = await requestText('https://example.org/a', { fetchImpl, timeoutMs: 1000 })
  assert.equal(response.status, 200)
  assert.equal(response.text, 'hello')
  assert.equal(fetchImpl.calls[0].init.headers['user-agent'], USER_AGENT)
})

test('requestText maps failures to typed soft-failure codes', async () => {
  const timeoutFetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  await assert.rejects(requestText('https://x', { fetchImpl: timeoutFetch, timeoutMs: 5 }), (error) => {
    assert.ok(error instanceof HttpFailure)
    assert.equal(error.code, 'timeout')
    return true
  })
  const networkFetch = async () => {
    throw new Error('boom')
  }
  await assert.rejects(requestText('https://x', { fetchImpl: networkFetch }), (error) => {
    assert.equal(error.code, 'network')
    return true
  })
  const bigFetch = mockFetch([() => new Response('x'.repeat(100), { status: 200 })])
  await assert.rejects(requestText('https://x', { fetchImpl: bigFetch, maxBytes: 10 }), (error) => {
    assert.equal(error.code, 'too_large')
    return true
  })
})

test('fetchJson returns tagged results instead of throwing', async () => {
  const ok = await fetchJson('https://example.org/ok', {
    fetchImpl: mockFetch([() => jsonResponse('{"a":1}')]),
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.data, { a: 1 })

  const status = await fetchJson('https://example.org/500', {
    fetchImpl: mockFetch([() => jsonResponse('oops', { status: 502 })]),
  })
  assert.equal(status.ok, false)
  assert.equal(status.code, 'status')
  assert.equal(status.status, 502)

  const badJson = await fetchJson('https://example.org/html', {
    fetchImpl: mockFetch([() => new Response('<html>', { status: 200 })]),
  })
  assert.equal(badJson.ok, false)
  assert.equal(badJson.code, 'json')

  const network = await fetchJson('https://example.org/down', {
    fetchImpl: mockFetch([
      () => {
        throw new Error('ECONNRESET')
      },
    ]),
  })
  assert.equal(network.ok, false)
  assert.equal(network.code, 'network')
})

test('abort signal stops a request and is reported as aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(requestText('https://x', { fetchImpl: mockFetch([() => jsonResponse('{}')]), signal: controller.signal }), (error) => {
    assert.equal(isAbortFailure(error), true)
    assert.equal(error.code, 'aborted')
    return true
  })
  assert.equal(abortFailure().code, 'aborted')
})

test('mapLimit preserves order and bounds concurrency', async () => {
  let running = 0
  let peak = 0
  const result = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
    return value * 2
  })
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14])
  assert.ok(peak <= 3, `peak concurrency ${peak} should be <= 3`)
})

test('mapLimit stops starting work after cancellation', async () => {
  const controller = new AbortController()
  const started = []
  const result = await mapLimit(
    [1, 2, 3, 4, 5, 6],
    2,
    async (value) => {
      started.push(value)
      if (value === 1) controller.abort()
      return value
    },
    { signal: controller.signal },
  )
  assert.equal(result[0], 1)
  assert.ok(started.length < 6)
})

test('retry retries retryable failures and stops at the budget', async () => {
  let attempts = 0
  const value = await retry(
    async () => {
      attempts += 1
      const error = new HttpFailure('boom', { status: 502 })
      if (attempts < 3) throw error
      return 'ok'
    },
    { retries: 2, delayMs: 1 },
  )
  assert.equal(value, 'ok')
  assert.equal(attempts, 3)

  let denied = 0
  await assert.rejects(
    retry(
      async () => {
        denied += 1
        throw new HttpFailure('nope', { status: 404 })
      },
      { retries: 2, delayMs: 1 },
    ),
  )
  assert.equal(denied, 1)
})

test('withTimeout rejects with a timeout failure', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'demo'), /demo timed out/)
  assert.equal(await withTimeout(Promise.resolve(1), 100), 1)
})

test('describeError renders messages', () => {
  assert.equal(describeError(new Error('x')), 'x')
  assert.equal(describeError('plain'), 'plain')
})
