/**
 * dsh-due-diligence 宿主半侧。
 *
 * cordis.patch.yml 的 preset-dd 在「背调」preset 作用域内挂载本包（tool-dd 行），
 * 所以这里注册的 dd_* 工具只对背调模式可见，聊天模式和其它模式看不到。
 *
 * 稳定性优先：只做 ctx.tools.register，不监听 registry 事件、不做工具面 restrict、
 * 不写 ctx.effect（2026-11-07 实测：在 tools/change 监听里反复 restrict 会造成
 * registry 事件回环，Host 反复失败退出；已移除该机制）。
 *
 * 不 import 任何 @deepseek-ai 包：workspace 里以 `link:` 安装的插件，其真实路径在
 * profile 之外，Host 的模块解析拦截层不会把 `@deepseek-ai/*` 映射到安装内副本
 * （2026-11-07 在 DSH 0.2.2-rc.1 实测为 ERR_MODULE_NOT_FOUND）。因此直接按公开
 * `ctx.tools.register(ToolDefinition)` 契约注册，字段与 defineTool 产物一致，
 * 由 Host 的注册表校验原始参数/输出 schema。
 */

import { createToolDefinitions } from './lib/tool-defs.mjs'

export const name = 'dsh-due-diligence'

/** 等待 tools 注册表就绪后再注册（Cordis 插件导出 inject 约定）。 */
export const inject = ['tools']

/**
 * 把 5 个 dd_* 工具注册到当前插件作用域。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ reportDir?: string }} [config] 可选配置；不传则用默认报告目录/环境变量。
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const fromConfig = typeof config?.reportDir === 'string' ? config.reportDir.trim() : ''
  const fromEnv = typeof process.env.DSH_DD_REPORT_DIR === 'string' ? process.env.DSH_DD_REPORT_DIR.trim() : ''
  const reportDir = fromConfig !== '' ? fromConfig : fromEnv !== '' ? fromEnv : undefined
  const tools = createToolDefinitions({ reportDir })
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
}
