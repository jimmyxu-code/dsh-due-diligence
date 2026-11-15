/**
 * 工具定义层测试：schema 形状、统一信封、execute 行为（mock fetch，不触网）。
 * 运行：node --test test/tool-defs.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TOOL_NAMES, createToolDefinitions, normalizeEnvelope, sanitizeEvidence } from '../lib/tool-defs.mjs'

/**
 * 按 URL 匹配返回预设响应的 mock fetch。
 * @param {(url: string) => { status?: number, body?: string } | null} route 路由函数。
 * @returns {{ fetchImpl: typeof fetch, calls: string[] }} mock。
 */
function mockFetch(route) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    const matched = route(String(url))
    if (matched === null || matched === undefined) return new Response('not found', { status: 404 })
    return new Response(matched.body ?? '', { status: matched.status ?? 200 })
  }
  return { fetchImpl, calls }
}

/**
 * 取一个工具定义。
 * @param {string} name 工具名。
 * @param {Record<string, any>} [options] createToolDefinitions 选项。
 * @returns {Record<string, any>} 工具定义。
 */
function tool(name, options = {}) {
  const found = createToolDefinitions(options).find((definition) => definition.name === name)
  assert.ok(found !== undefined, `missing ${name}`)
  return found
}

/** 假的 exec 上下文。 */
const fakeExec = { signal: new AbortController().signal }

test('createToolDefinitions returns the five tools with model-facing schemas', () => {
  const definitions = createToolDefinitions()
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    [...TOOL_NAMES],
  )
  for (const definition of definitions) {
    assert.ok(definition.description.length > 20, `${definition.name} needs a useful description`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.equal(typeof definition.output, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.ok(Array.isArray(definition.output.schema.required))
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.presentCall, 'function')
    assert.ok(Number.isFinite(definition.timeoutMs))
    // schema 必须可 JSON 序列化（Host 会物化并校验）。
    assert.deepEqual(JSON.parse(JSON.stringify(definition.parameters)), definition.parameters)
    assert.deepEqual(JSON.parse(JSON.stringify(definition.output.schema)), definition.output.schema)
  }
})

test('parameter schemas carry the required arguments from the P1 contract', () => {
  const required = Object.fromEntries(createToolDefinitions().map((definition) => [definition.name, definition.parameters.required]))
  assert.deepEqual(required.dd_username, ['username'])
  assert.deepEqual(required.dd_name, ['name'])
  assert.deepEqual(required.dd_company, ['query'])
  assert.deepEqual(required.dd_domain, ['domain'])
  assert.deepEqual(required.dd_report, ['target', 'target_type', 'summary'])
  const username = tool('dd_username')
  assert.deepEqual(Object.keys(username.parameters.properties).sort(), ['max_results', 'site', 'timeoutMs', 'username', 'verify'])
})

test('optional defineTool stub is applied to every definition', () => {
  const stamped = createToolDefinitions({ defineTool: (definition) => ({ ...definition, stamped: true }) })
  assert.equal(stamped.length, 5)
  assert.ok(stamped.every((definition) => definition.stamped === true))
})

test('normalizeEnvelope and sanitizeEvidence fill safe defaults', () => {
  const envelope = normalizeEnvelope('dd_test', { a: 1 }, {
    ok: true,
    summary: 'ok',
    warnings: ['w', 3],
    evidence: [{ source: 's', url: 'u', confidence: 'high', detail: 'd' }, null],
  })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.tool, 'dd_test')
  assert.deepEqual(envelope.query, { a: 1 })
  assert.deepEqual(envelope.warnings, ['w'])
  assert.equal(envelope.evidence.length, 1)
  assert.equal(envelope.evidence[0].confidence, 'high')
  assert.equal(envelope.error, null)
  assert.deepEqual(sanitizeEvidence('nope'), [])
})

test('dd_username execute scans one site through the sherlock engine', async () => {
  const { fetchImpl, calls } = mockFetch((url) => (url.includes('github.com') ? { status: 200, body: '<title>GitHub</title>' } : null))
  const definition = tool('dd_username', { fetchImpl })
  const result = await definition.execute({ username: 'sherlock-test-user', site: 'GitHub' }, fakeExec)
  assert.equal(result.ok, true)
  assert.equal(result.tool, 'dd_username')
  assert.ok(Array.isArray(result.found))
  assert.equal(result.found.length, 1)
  assert.equal(result.found[0].site, 'GitHub')
  assert.match(result.found[0].url, /github\.com\/sherlock-test-user/)
  assert.equal(result.evidence[0].source, 'sherlock:github')
  assert.ok(result.sites_total >= 1)
  assert.equal(calls.length, 1)
  const rendered = definition.output.render({ username: 'sherlock-test-user' }, result)
  assert.match(rendered[0].text, /GitHub/)
})

test('dd_username verify=true re-fetches hit URLs and marks them verified', async () => {
  const html =
    '<html><head><title>GitHub - sherlock-test-user</title>' +
    '<meta name="description" content="Public profile of sherlock-test-user" /></head></html>'
  const { fetchImpl, calls } = mockFetch((url) => (url.includes('github.com') ? { status: 200, body: html } : null))
  const definition = tool('dd_username', { fetchImpl })
  const result = await definition.execute({ username: 'sherlock-test-user', site: 'GitHub', verify: true }, fakeExec)
  assert.equal(result.ok, true)
  assert.equal(result.verify.enabled, true)
  assert.equal(result.verify.verified, 1)
  assert.equal(result.found[0].verified, true)
  assert.equal(result.found[0].description, 'Public profile of sherlock-test-user')
  assert.ok(calls.length >= 2, 'verify should make a second request')
})

test('dd_username rejects bad input without throwing', async () => {
  const definition = tool('dd_username', { fetchImpl: () => new Response('', { status: 200 }) })
  const result = await definition.execute({}, fakeExec)
  assert.equal(result.ok, false)
  assert.match(result.error, /username/)
  assert.deepEqual(result.found, [])
})

test('every tool returns a failure envelope instead of throwing on bad input', async () => {
  for (const definition of createToolDefinitions()) {
    const result = await definition.execute({}, fakeExec)
    assert.equal(result.ok, false, `${definition.name} should fail softly`)
    assert.equal(result.tool, definition.name)
    assert.equal(typeof result.error, 'string')
    assert.ok(Array.isArray(result.evidence))
    assert.ok(Array.isArray(result.warnings))
    // 渲染失败信封也不能抛错。
    const rendered = definition.output.render({}, result)
    assert.ok(Array.isArray(rendered))
    assert.equal(rendered[0].type, 'text')
  }
})

test('dd_report writes a Markdown report and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-tool-report-'))
  const definition = tool('dd_report', { reportDir: dir })
  const result = await definition.execute(
    {
      target: 'Apple Inc.',
      target_type: 'company',
      summary: 'Apple 为美国上市公司（SEC CIK 0000320193）。',
      findings: [
        {
          claim: 'SEC CIK 0000320193',
          source: 'sec-edgar',
          url: 'https://data.sec.gov/submissions/CIK0000320193.json',
          confidence: 'high',
          detail: 'Apple Inc.',
        },
      ],
      open_questions: ['是否与 Apple 中国实体为同一集团？'],
    },
    fakeExec,
  )
  assert.equal(result.ok, true)
  assert.match(result.path, /背调报告-Apple-Inc-\d{8}-\d{6}\.md$/)
  assert.ok(result.bytes > 0)
  assert.match(result.markdown, /SEC CIK 0000320193/)
  assert.match(result.markdown, /合规声明/)
  assert.match(result.summary, /报告已生成/)
  assert.equal(result.evidence[0].source, 'sec-edgar')
  const content = await readFile(result.path, 'utf8')
  assert.match(content, /# 背调报告：Apple Inc\./)
})

test('dd_report renders the file path for the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-tool-report-'))
  const definition = tool('dd_report', { reportDir: dir })
  const result = await definition.execute({ target: 'x', target_type: 'other', summary: 's' }, fakeExec)
  const rendered = definition.output.render({}, result)
  assert.match(rendered[0].text, /报告已写入/)
  assert.ok(rendered[0].text.includes(dir))
})

test('domain, company and name tools never throw even when the network fails', async () => {
  const failingFetch = async () => {
    throw new Error('network down')
  }
  const definitions = createToolDefinitions({ fetchImpl: failingFetch })
  const inputs = {
    dd_company: { query: 'Apple' },
    dd_domain: { domain: 'example.com' },
    dd_name: { name: '张三' },
  }
  for (const definition of definitions) {
    if (inputs[definition.name] === undefined) continue
    const result = await definition.execute(inputs[definition.name], fakeExec)
    assert.equal(typeof result.ok, 'boolean', `${definition.name} must return an envelope`)
    assert.equal(result.tool, definition.name)
    assert.ok(Array.isArray(result.evidence))
    const rendered = definition.output.render(inputs[definition.name], result)
    assert.equal(rendered[0].type, 'text')
  }
})

test('aborted execution returns promptly without throwing', async () => {
  const controller = new AbortController()
  controller.abort()
  const definition = tool('dd_username', {
    fetchImpl: () => new Response('', { status: 200 }),
  })
  const result = await definition.execute({ username: 'x', site: 'GitHub' }, { signal: controller.signal })
  assert.equal(typeof result.ok, 'boolean')
  assert.ok(Array.isArray(result.found))
})

test('dd_name returns web_search queries for a person profile workflow', async () => {
  const wikidata = {
    search: [{ id: 'Q1', label: '张三', description: '测试人物' }],
    entities: { Q1: { aliases: { zh: [{ value: 'Zhang San' }] }, labels: {}, descriptions: {} } },
  }
  const definition = tool('dd_name', {
    fetchImpl: async (url) => new Response(JSON.stringify(wikidata), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const result = await definition.execute({ name: '张三', lang: 'zh' }, fakeExec)
  assert.equal(result.ok, true)
  assert.ok(result.wikidata.length >= 1)
  assert.deepEqual(result.wikidata[0].aliases, ['Zhang San'])
  assert.ok(result.web_queries.length >= 3)
  assert.ok(result.web_queries.some((query) => query.includes('张三')))
  const rendered = definition.output.render({ name: '张三' }, result)
  assert.match(rendered[0].text, /web_search/)
})

test('dd_report renders a person profile chapter when profile is supplied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dd-tool-profile-'))
  const definition = tool('dd_report', { reportDir: dir })
  const result = await definition.execute(
    {
      target: '张三',
      target_type: 'person',
      summary: '公开信息画像。',
      profile: {
        basics: ['公开姓名：张三'],
        occupation: ['某公司工程师'],
        accounts: ['GitHub：@zhangsan'],
      },
      findings: [],
      open_questions: [],
    },
    fakeExec,
  )
  assert.equal(result.ok, true)
  assert.match(result.markdown, /## 二、人物画像/)
  assert.match(result.markdown, /### 职业与机构/)
  assert.match(result.markdown, /某公司工程师/)
  assert.match(result.markdown, /## 三、证据表/)
  const rendered = definition.output.render({ target: '张三', profile: {} }, result)
  assert.match(rendered[0].text, /人物画像/)
})
