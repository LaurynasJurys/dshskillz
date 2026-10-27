/**
 * Model Context Bench, Host half.
 *
 * Exposes one agent tool (`llm_bench`) and one same-origin HTTP stream used by
 * the Settings page. Both drive the benchmark core in `bench.js` against the
 * registered LLM routes, so the agent and the page report identical numbers.
 */

import {
  DEFAULTS,
  generateDocument,
  probeMaxContext,
  randomSeed,
  runSweep,
} from './bench.js'

export const name = 'llm-bench'
export const inject = ['tools', 'llm']

/** JSON body ceiling for the HTTP endpoints; the client sends a few hundred bytes. */
const BODY_LIMIT_BYTES = 64 * 1024
/** One benchmark at a time per Host: concurrent sweeps would measure each other. */
let activeRun = null

/** Format a token count with digit grouping. */
function fmtInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '?'
}

/** Format milliseconds, switching unit above one second. */
function fmtMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`
}

/** Format a throughput figure. */
function fmtRate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)} tok/s` : '?'
}

/**
 * Render one measurement line for the agent-facing result.
 * @param result - measurement from the core.
 * @param widths - precomputed column widths.
 * @returns one padded table row.
 */
function renderRow(result, widths) {
  const actual = result.inputTokens === null ? '?' : fmtInt(result.inputTokens)
  const recall = result.recall === null ? '-' : result.recall.found ? 'yes' : result.recall.truncated ? 'trunc' : 'NO'
  const status = result.ok ? 'ok' : `${result.failure?.code ?? result.finishKind}`
  const cells = [
    fmtInt(result.targetTokens),
    actual,
    fmtMs(result.ttftMs),
    fmtRate(result.prefillTokPerSec),
    fmtRate(result.decodeTokPerSec),
    fmtMs(result.totalMs),
    result.outputTokens === null ? '?' : fmtInt(result.outputTokens),
    recall,
    status,
  ]
  return cells.map((cell, index) => (index < 2 ? cell.padStart(widths[index]) : cell.padEnd(widths[index]))).join('  ')
}

/** Column widths chosen from the data so the plain-text table stays aligned. */
function columnWidths(results) {
  const header = ['target', 'actual', 'TTFT', 'prefill', 'decode', 'total', 'out', 'recall', 'status']
  const rows = results.map((result) => [
    fmtInt(result.targetTokens),
    result.inputTokens === null ? '?' : fmtInt(result.inputTokens),
    fmtMs(result.ttftMs),
    fmtRate(result.prefillTokPerSec),
    fmtRate(result.decodeTokPerSec),
    fmtMs(result.totalMs),
    result.outputTokens === null ? '?' : fmtInt(result.outputTokens),
    result.recall === null ? '-' : result.recall.found ? 'yes' : result.recall.truncated ? 'trunc' : 'NO',
    result.ok ? 'ok' : `${result.failure?.code ?? result.finishKind}`,
  ])
  return header.map((label, index) => Math.max(label.length, ...rows.map((row) => row[index].length)))
}

/**
 * Resolve the route a call should use: explicit arguments, else the session default.
 * @param ctx - plugin context.
 * @param args - tool arguments.
 * @returns the provider/model pair.
 */
async function resolveRoute(ctx, args) {
  const llm = ctx.llm
  const providers = llm.listProviders()
  if (providers.length === 0) throw new Error('No model provider is registered, so there is nothing to benchmark.')
  const explicitProvider = typeof args.provider === 'string' && args.provider.length > 0 ? args.provider : null
  const explicitModel = typeof args.model === 'string' && args.model.length > 0 ? args.model : null
  if (explicitProvider !== null) {
    if (explicitModel !== null) return { provider: explicitProvider, model: explicitModel }
    const models = await llm.listModels(explicitProvider).catch(() => [])
    if (models.length === 0) throw new Error(`Provider "${explicitProvider}" advertises no models.`)
    return { provider: explicitProvider, model: models[0].id }
  }
  if (explicitModel !== null) throw new Error('Pass provider together with model, or neither to use the default route.')
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  const fallbackModels = await llm.listModels(providers[0].id).catch(() => [])
  if (fallbackModels.length === 0) throw new Error(`Provider "${providers[0].id}" advertises no models.`)
  return { provider: providers[0].id, model: fallbackModels[0].id }
}

/** Declared metadata for one route, tolerating adapters that cannot answer. */
async function routeInfo(llm, provider, model) {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return {
      declaredContextWindow: typeof info.context?.contextWindow === 'number' ? info.context.contextWindow : null,
      defaultMaxTokens: typeof info.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null,
      displayName: info.name ?? model,
    }
  } catch {
    return { declaredContextWindow: null, defaultMaxTokens: null, displayName: model }
  }
}

/** Normalize the requested sweep sizes. */
function normalizeSizes(input) {
  const raw = Array.isArray(input) ? input : []
  const sizes = []
  for (const value of raw) {
    const size = Number(value)
    if (!Number.isFinite(size) || size < 256) continue
    sizes.push(Math.min(DEFAULTS.hardMaxTokens, Math.round(size)))
  }
  if (sizes.length === 0) throw new Error('sizes must list at least one context size in tokens (minimum 256).')
  if (sizes.length > DEFAULTS.maxSizes) throw new Error(`sizes accepts at most ${DEFAULTS.maxSizes} entries.`)
  return sizes.sort((a, b) => a - b)
}

/**
 * Build the agent tool definition.
 * @param ctx - plugin context.
 * @returns the tool definition object.
 */
function toolDefinition(ctx) {
  return {
    name: 'llm_bench',
    description:
      'Benchmark one model route: measure speed at several context sizes, or find the largest context it accepts. Generates its own synthetic context. Each measurement is a real model request that bills input tokens and takes provider time; a probe near a large ceiling can send millions of input tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['catalog', 'sweep', 'probe', 'generate'],
          description:
            'catalog lists routes and their declared context windows. sweep measures speed at each requested size. probe bisects for the largest accepted context. generate samples the generated context without calling a model.',
        },
        provider: {
          type: 'string',
          description: 'Provider route to benchmark. Omit both provider and model to use the session default route.',
        },
        model: {
          type: 'string',
          description: 'Model id on that route. Required when provider is given.',
        },
        sizes: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'sweep only: input context sizes in tokens, ascending after sorting, minimum 256, at most 16 entries. Each entry costs one real request.',
        },
        outputTokens: {
          type: 'integer',
          description: 'sweep only: reply cap per run, 1-2048. Reasoning models spend part of it before any visible text, and a reply cut off by this cap cannot prove retrieval. Default 256.',
        },
        repeats: {
          type: 'integer',
          description: 'sweep only: runs per size, 1-5. Default 1.',
        },
        needle: {
          type: 'boolean',
          description:
            'sweep only: hide a KEY marker in the context and report whether the model retrieved it, which shows the whole context stayed readable. Default true.',
        },
        ceilingTokens: {
          type: 'integer',
          description:
            'probe only: upper bound of the search. Defaults to the declared context window, else 262144. Never exceeds 4000000.',
        },
        toleranceTokens: {
          type: 'integer',
          description: 'probe only: stop once the search bracket is this narrow. Default 512.',
        },
        maxProbes: {
          type: 'integer',
          description: 'probe only: request budget, 1-24. Default 14.',
        },
        sampleTokens: {
          type: 'integer',
          description: 'generate only: document size in tokens for the returned sample. Default 4000.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          declaredContextWindow: { type: 'integer' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          summary: { type: 'object', additionalProperties: true },
          sample: { type: 'object', additionalProperties: true },
          providers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        const blocks = []
        const header = `${value.provider}/${value.model}`
        if (value.action === 'catalog') {
          const lines = [`Registered model routes (${value.providers.length} providers):`]
          for (const provider of value.providers) {
            lines.push(`  ${provider.id} — ${provider.name}`)
            for (const model of provider.models) {
              const window = model.contextWindow === null ? 'unknown declared window' : `${fmtInt(model.contextWindow)} declared tokens`
              lines.push(`    ${model.id} (${window})`)
            }
          }
          blocks.push({ type: 'text', text: lines.join('\n') })
          return blocks
        }
        if (value.action === 'generate') {
          blocks.push({
            type: 'text',
            text: `Generated ${fmtInt(value.sample.estimatedTokens)} tokens of context (${fmtInt(value.sample.chars)} chars, seed ${value.sample.seed}).\n\n${value.sample.preview}\n…`,
          })
          return blocks
        }
        const declared = value.declaredContextWindow === null ? 'declared window unknown' : `${fmtInt(value.declaredContextWindow)} declared tokens`
        if (value.action === 'sweep') {
          const results = value.results
          const widths = columnWidths(results)
          const headerCells = ['target', 'actual', 'TTFT', 'prefill', 'decode', 'total', 'out', 'recall', 'status']
          const lines = [
            `Speed sweep on ${header} (${declared}), reply cap ${value.summary.outputTokens} tokens.`,
            headerCells.map((cell, index) => (index < 2 ? cell.padStart(widths[index]) : cell.padEnd(widths[index]))).join('  '),
            ...results.map((result) => renderRow(result, widths)),
          ]
          const failed = results.filter((result) => !result.ok)
          if (failed.length > 0) {
            lines.push('', 'Failures:')
            for (const result of failed) lines.push(`  ${fmtInt(result.targetTokens)} → ${result.failure?.code}: ${result.failure?.message}`)
          }
          lines.push('', 'prefill = input tokens / time to first token (includes queueing and transport); decode = output tokens / time from first to last token.')
          if (results.some((result) => result.recall !== null && result.recall.truncated && !result.recall.found)) lines.push('trunc = the reply hit the output cap before naming the marker, so retrieval is unknown.')
          blocks.push({ type: 'text', text: lines.join('\n') })
          return blocks
        }
        const summary = value.summary
        const lines = [`Max-context probe on ${header} (${declared}).`]
        const accepted = typeof summary.maxInputTokens === 'number'
          ? `${fmtInt(summary.maxInputTokens)} measured input tokens (requested target ${fmtInt(summary.maxTokens)})`
          : `a request targeted at ${fmtInt(summary.maxTokens)} tokens, whose actual size the provider did not report`
        if (summary.aborted) lines.push('Stopped early by a non-size failure; the numbers below are partial.')
        if (summary.ceilingReached) lines.push(`The ceiling itself passed: the route accepted ${accepted}. Raise ceilingTokens to push higher.`)
        else lines.push(`Largest accepted context: ${accepted}; the next target, ${fmtInt(summary.firstFailingTarget)}, was rejected. Tolerance ±${fmtInt(summary.tolerance ?? DEFAULTS.toleranceTokens)}.`)
        if (summary.recall !== undefined && summary.recall !== null) lines.push(`Marker retrieval at that size: ${summary.recall ? 'yes' : 'NO'}.`)
        lines.push('', 'steps:')
        for (const step of summary.steps) {
          const outcome = step.outcome === 'pass' ? 'pass' : step.outcome === 'context' ? 'too large' : (step.failure?.code ?? step.outcome)
          lines.push(`  ${fmtInt(step.targetTokens)} → ${step.inputTokens === null ? '?' : fmtInt(step.inputTokens)} actual, ${outcome}, ${fmtMs(step.ttftMs)}`)
        }
        blocks.push({ type: 'text', text: lines.join('\n') })
        return blocks
      },
    },
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const action = args.action
      if (action === 'catalog') {
        const providers = []
        for (const provider of ctx.llm.listProviders()) {
          const models = await ctx.llm.listModels(provider.id).catch(() => [])
          const rows = []
          for (const model of models) {
            const info = await routeInfo(ctx.llm, provider.id, model.id)
            rows.push({ id: model.id, name: model.name ?? model.id, contextWindow: info.declaredContextWindow })
          }
          providers.push({ id: provider.id, name: provider.name ?? provider.id, models: rows })
        }
        return { action, providers }
      }
      const route = await resolveRoute(ctx, args)
      const info = await routeInfo(ctx.llm, route.provider, route.model)
      if (action === 'generate') {
        const tokens = Math.max(256, Math.min(DEFAULTS.hardMaxTokens, Math.round(Number(args.sampleTokens ?? 4000))))
        const seed = randomSeed()
        const chars = Math.round(tokens * DEFAULTS.charsPerToken)
        const document = generateDocument({ seed, targetChars: chars, needleAt: 0.5 })
        return {
          action,
          ...route,
          declaredContextWindow: info.declaredContextWindow,
          sample: {
            seed,
            estimatedTokens: tokens,
            chars: document.chars,
            key: document.key,
            preview: document.text.slice(0, 1200),
          },
        }
      }
      if (action === 'sweep') {
        const sizes = normalizeSizes(args.sizes)
        const outputTokens = Math.max(1, Math.min(DEFAULTS.maxOutputTokens, Math.round(Number(args.outputTokens ?? DEFAULTS.outputTokens))))
        return withBenchmarkLock(exec, async (signal) => {
          const results = await runSweep({
            llm: ctx.llm,
            provider: route.provider,
            model: route.model,
            sizes,
            outputTokens,
            repeats: args.repeats,
            needle: args.needle,
            signal,
          })
          return {
            action,
            ...route,
            declaredContextWindow: info.declaredContextWindow,
            results,
            summary: { action, outputTokens },
          }
        })
      }
      if (action === 'probe') {
        const ceiling = Math.max(
          1024,
          Math.min(
            DEFAULTS.hardMaxTokens,
            Math.round(Number(args.ceilingTokens ?? info.declaredContextWindow ?? 262_144)),
          ),
        )
        return withBenchmarkLock(exec, async (signal) => {
          const summary = await probeMaxContext({
            llm: ctx.llm,
            provider: route.provider,
            model: route.model,
            ceilingTokens: ceiling,
            toleranceTokens: args.toleranceTokens,
            maxProbes: args.maxProbes,
            signal,
          })
          return { action, ...route, declaredContextWindow: info.declaredContextWindow, summary }
        })
      }
      throw new Error(`Unknown action "${action}". Use catalog, sweep, probe, or generate.`)
    },
  }
}

/**
 * Serialize measurements across the agent tool and the Settings page: two
 * overlapping benchmarks would measure each other instead of the model.
 * @param exec - tool execution whose cancellation also stops the model calls.
 * @param operation - the measurement run, given the shared abort signal.
 * @returns the operation result.
 */
async function withBenchmarkLock(exec, operation) {
  if (activeRun !== null) {
    throw new Error('Another benchmark is already running; wait for it to finish, or stop it from the Model Bench page.')
  }
  const controller = new AbortController()
  activeRun = controller
  const relay = () => controller.abort(exec.signal.reason)
  exec.signal.addEventListener('abort', relay)
  try {
    return await operation(controller.signal)
  } finally {
    exec.signal.removeEventListener('abort', relay)
    activeRun = null
  }
}

/** Reject a request whose browser Origin belongs to another site. */
function trustedRequest(request) {
  const host = request.headers.host
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Send one JSON response. */
function sendJson(response, status, value) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

/** Read and parse a bounded JSON body. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/**
 * Register the benchmark endpoints on the Host web server.
 * @param ctx - plugin context.
 * @param webServer - Host web server service.
 * @returns one disposer for both routes.
 */
function mountRoutes(ctx, webServer) {
  const catalog = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/catalog',
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'use GET' })
        return
      }
      try {
        const providers = []
        for (const provider of ctx.llm.listProviders()) {
          const models = await ctx.llm.listModels(provider.id).catch(() => [])
          const rows = []
          for (const model of models) {
            const info = await routeInfo(ctx.llm, provider.id, model.id)
            rows.push({ id: model.id, name: model.name ?? model.id, contextWindow: info.declaredContextWindow })
          }
          providers.push({ id: provider.id, name: provider.name ?? provider.id, models: rows })
        }
        const selection = ctx.get('agentDefaultModel')?.currentSelection()
        sendJson(response, 200, {
          providers,
          defaults: {
            provider: typeof selection?.provider === 'string' ? selection.provider : providers[0]?.id ?? null,
            model: typeof selection?.model === 'string' ? selection.model : providers[0]?.models[0]?.id ?? null,
          },
          defaultsSizes: [1000, 4000, 16000, 64000],
          outputTokens: DEFAULTS.outputTokens,
          hardMaxTokens: DEFAULTS.hardMaxTokens,
        })
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  const run = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/run',
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'use POST' })
        return
      }
      if (!trustedRequest(request)) {
        sendJson(response, 403, { error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (activeRun !== null) {
        sendJson(response, 409, { error: 'another benchmark is already running; stop it first' })
        return
      }
      const controller = new AbortController()
      activeRun = controller
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        'x-accel-buffering': 'no',
      })
      const emit = (event) => {
        if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`)
      }
      response.on('close', () => {
        if (!response.writableEnded) controller.abort(new Error('benchmark stopped by the page'))
      })
      try {
        const action = body.action === 'probe' ? 'probe' : 'sweep'
        const route = await resolveRoute(ctx, {
          provider: body.provider,
          model: body.model,
        })
        const info = await routeInfo(ctx.llm, route.provider, route.model)
        emit({
          type: 'start',
          action,
          provider: route.provider,
          model: route.model,
          declaredContextWindow: info.declaredContextWindow,
        })
        if (action === 'sweep') {
          const sizes = normalizeSizes(body.sizes)
          const outputTokens = Math.max(1, Math.min(DEFAULTS.maxOutputTokens, Math.round(Number(body.outputTokens ?? DEFAULTS.outputTokens))))
          const repeats = Math.max(1, Math.min(5, Math.round(Number(body.repeats ?? 1))))
          const results = await runSweep({
            llm: ctx.llm,
            provider: route.provider,
            model: route.model,
            sizes,
            outputTokens,
            repeats,
            needle: body.needle !== false,
            signal: controller.signal,
            emit,
          })
          emit({ type: 'summary', summary: { action, outputTokens, repeats, results } })
        } else {
          await probeMaxContext({
            llm: ctx.llm,
            provider: route.provider,
            model: route.model,
            ceilingTokens: Math.max(1024, Math.min(DEFAULTS.hardMaxTokens, Math.round(Number(body.ceilingTokens ?? info.declaredContextWindow ?? 262_144)))),
            toleranceTokens: body.toleranceTokens,
            maxProbes: body.maxProbes,
            signal: controller.signal,
            emit,
          })
        }
        emit({ type: 'done' })
      } catch (error) {
        if (!controller.signal.aborted) {
          emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      } finally {
        activeRun = null
        if (!response.writableEnded) response.end()
      }
    },
  })
  return () => {
    catalog()
    run()
  }
}

/**
 * Activate the Host half: agent tool plus, when the web server is present,
 * the Settings page endpoints.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(toolDefinition(ctx)), 'llm-bench: tool')
  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountRoutes(host, host.webServer), 'llm-bench: web routes')
  })
}
