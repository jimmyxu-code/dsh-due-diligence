/**
 * 网络小工具：超时、取消、并发池、软失败 JSON 抓取。
 *
 * 约束（背调模式 P1）：
 * - 所有请求 8–20s 超时，可用 exec.signal 取消；
 * - 每个数据源并发 ≤4、全局并发 ≤10；
 * - 失败返回 {ok:false,...}，不把网络错误抛给模型。
 *
 * 纯模块：默认使用 globalThis.fetch，测试通过 fetchImpl 注入 mock。
 */

/** 对数据源声明身份的 UA；SEC 要求可联系 UA（≤10 req/s）。 */
export const USER_AGENT =
  'dsh-due-diligence/0.2.1 (+https://github.com/jimmyxu-code/dsh-due-diligence)'

/** 默认请求超时。 */
export const DEFAULT_TIMEOUT_MS = 15000

/** 默认响应体上限（5MB），防御异常大响应。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/**
 * 一次 HTTP 失败（网络/超时/状态/体积）。
 */
export class HttpFailure extends Error {
  /**
   * @param {string} message 人类可读消息。
   * @param {{ url?: string, status?: number, code?: string }} [info] 附加信息。
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'HttpFailure'
    this.url = info.url
    this.status = info.status
    this.code = info.code ?? 'http'
  }
}

/**
 * 把任意错误渲染成一行文本。
 * @param {unknown} error 错误。
 * @returns {string} 文本。
 */
export function describeError(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/**
 * 是否为取消错误。
 * @param {unknown} error 错误。
 * @returns {boolean} 是否取消。
 */
export function isAbortFailure(error) {
  if (error instanceof HttpFailure) return error.code === 'aborted'
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

/**
 * 构造取消错误。
 * @returns {HttpFailure} 取消错误。
 */
export function abortFailure() {
  return new HttpFailure('request aborted by caller', { code: 'aborted' })
}

/**
 * 带超时与外部取消的 fetch。
 * @param {string} url 地址。
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   headers?: Record<string,string>,
 *   method?: string,
 *   body?: string,
 *   redirect?: 'follow'|'manual'|'error',
 *   maxBytes?: number,
 * }} [options] 选项。
 * @returns {Promise<{ status: number, ok: boolean, url: string, headers: Headers|null, text: string }>} 响应。
 */
export async function requestText(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new HttpFailure('fetch is unavailable', { url, code: 'no_fetch' })
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES
  const external = options.signal
  if (external?.aborted) throw abortFailure()

  /** @type {AbortSignal[]} */
  const signals = []
  if (external !== undefined) signals.push(external)
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined

  let response
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(options.headers ?? {}) },
      body: options.body,
      redirect: options.redirect ?? 'follow',
      signal,
    })
  } catch (error) {
    if (external?.aborted) throw abortFailure()
    if (signal?.aborted) throw new HttpFailure(`request timed out after ${timeoutMs}ms`, { url, code: 'timeout' })
    throw new HttpFailure(`network error: ${describeError(error)}`, { url, code: 'network' })
  }

  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpFailure(`response too large (${declared} bytes)`, { url, status: response.status, code: 'too_large' })
  }

  let text
  try {
    text = await response.text()
  } catch (error) {
    if (external?.aborted || signal?.aborted) throw abortFailure()
    throw new HttpFailure(`failed reading response: ${describeError(error)}`, { url, status: response.status, code: 'body' })
  }
  if (text.length > maxBytes) {
    throw new HttpFailure(`response too large (${text.length} chars)`, { url, status: response.status, code: 'too_large' })
  }
  return {
    status: response.status,
    ok: response.ok === true,
    url: typeof response.url === 'string' && response.url !== '' ? response.url : url,
    headers: response.headers ?? null,
    text,
  }
}

/**
 * 宽松 JSON 抓取：任何失败都变成 {ok:false}，绝不抛网络错误。
 * @param {string} url 地址。
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   headers?: Record<string,string>,
 *   method?: string,
 *   body?: string,
 *   redirect?: 'follow'|'manual'|'error',
 *   maxBytes?: number,
 *   requireOk?: boolean,
 * }} [options] 选项。
 * @returns {Promise<
 *   | { ok: true, data: unknown, status: number, url: string, text: string }
 *   | { ok: false, error: string, code: string, status: number|null, url: string }
 * >} 结果。
 */
export async function fetchJson(url, options = {}) {
  let response
  try {
    response = await requestText(url, options)
  } catch (error) {
    return {
      ok: false,
      error: describeError(error),
      code: error instanceof HttpFailure ? error.code : 'network',
      status: error instanceof HttpFailure && Number.isFinite(error.status) ? error.status : null,
      url,
    }
  }
  if (options.requireOk !== false && !response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, code: 'status', status: response.status, url: response.url }
  }
  try {
    const data = JSON.parse(response.text)
    return { ok: true, data, status: response.status, url: response.url, text: response.text }
  } catch {
    return { ok: false, error: 'response is not valid JSON', code: 'json', status: response.status, url: response.url }
  }
}

/**
 * 并发池：最多 limit 个 worker 同时跑，顺序保留；遇取消立即停止启动新任务。
 * worker 自己负责软失败（捕获异常返回占位值）。
 * @template T, R
 * @param {readonly T[]} items 输入。
 * @param {number} limit 并发上限。
 * @param {(item: T, index: number) => Promise<R>} worker 工作函数。
 * @param {{ signal?: AbortSignal }} [options] 选项。
 * @returns {Promise<R[]>} 与输入同序的结果。
 */
export async function mapLimit(items, limit, worker, options = {}) {
  const list = Array.from(items)
  /** @type {R[]} */
  const results = new Array(list.length)
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, list.length))
  let next = 0
  const runners = []
  for (let runner = 0; runner < size; runner += 1) {
    runners.push(
      (async () => {
        while (true) {
          if (options.signal?.aborted === true) return
          const index = next
          next += 1
          if (index >= list.length) return
          results[index] = await worker(list[index], index)
        }
      })(),
    )
  }
  await Promise.all(runners)
  return results
}

/**
 * 简单重试：默认只重试非取消、非 4xx 的失败；delayMs 线性递增。
 * @template T
 * @param {() => Promise<T>} action 动作。
 * @param {{ retries?: number, delayMs?: number, shouldRetry?: (error: unknown) => boolean, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal }} [options] 选项。
 * @returns {Promise<T>} 动作结果。
 */
export async function retry(action, options = {}) {
  const retries = Number.isFinite(options.retries) ? Math.max(0, options.retries) : 1
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 800
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const shouldRetry =
    options.shouldRetry ??
    ((error) => {
      if (isAbortFailure(error)) return false
      const status = Number(error?.status ?? Number.NaN)
      if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) return false
      return true
    })
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted === true) throw abortFailure()
    try {
      return await action()
    } catch (error) {
      lastError = error
      if (attempt === retries || shouldRetry(error) !== true) throw error
      await sleep(delayMs * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * 带超时的 Promise 包装（用于整体数据源预算）。
 * @template T
 * @param {Promise<T>} promise 原 promise。
 * @param {number} timeoutMs 超时。
 * @param {string} [label] 标签。
 * @returns {Promise<T>} 结果。
 */
export async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HttpFailure(`${label} timed out after ${timeoutMs}ms`, { code: 'timeout' })), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
