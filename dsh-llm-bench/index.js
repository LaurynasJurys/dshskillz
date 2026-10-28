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
        normalizeSizes(args.sizes)
        const snapshot = await runThroughTool(ctx, exec, {
          action: 'sweep',
          provider: route.provider,
          model: route.model,
          sizes: args.sizes,
          outputTokens: args.outputTokens,
          repeats: args.repeats,
          needle: args.needle,
        })
        return {
          action,
          ...route,
          declaredContextWindow: snapshot.declaredContextWindow,
          results: snapshot.results,
          summary: snapshot.summary,
        }
      }
      if (action === 'probe') {
        const snapshot = await runThroughTool(ctx, exec, {
          action: 'probe',
          provider: route.provider,
          model: route.model,
          ceilingTokens: args.ceilingTokens ?? info.declaredContextWindow ?? 262_144,
          toleranceTokens: args.toleranceTokens,
          maxProbes: args.maxProbes,
        })
        return { action, ...route, declaredContextWindow: snapshot.declaredContextWindow, summary: snapshot.summary }
      }
      throw new Error(`Unknown action "${action}". Use catalog, sweep, probe, or generate.`)
    },
  }
}

/** Run events kept for replay, so a reader that re-attaches can rebuild the panel. */
const MAX_RUN_EVENTS = 400

/**
 * The most recent run. It lives outside every HTTP request: a reader closing its
 * stream detaches, it does not stop the measurement, so the panel can be left,
 * gone back to, or reloaded while a sweep keeps going.
 */
let current = null
let nextRunId = 1

/** Snapshot of a run that never existed. */
function emptySnapshot() {
  return {
    runId: null,
    status: 'idle',
    action: null,
    provider: null,
    model: null,
    declaredContextWindow: null,
    results: [],
    steps: [],
    summary: null,
    error: null,
    progress: null,
    startedAt: null,
    endedAt: null,
    lastSeq: -1,
  }
}

/**
 * Project one run into the shape a reader renders from.
 * @param run - the run, or null before any run happened.
 * @returns a detached JSON-safe snapshot.
 */
function snapshotOf(run) {
  if (run === null) return emptySnapshot()
  return {
    runId: run.id,
    status: run.status,
    action: run.action,
    provider: run.provider,
    model: run.model,
    declaredContextWindow: run.declaredContextWindow,
    results: run.results,
    steps: run.steps,
    summary: run.summary,
    error: run.error,
    progress: run.progress,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lastSeq: run.nextSeq - 1,
  }
}

/**
 * Fold one event into the run's own state, so a reader that arrives late sees the
 * same numbers as one that watched from the start.
 * @param run - the run receiving the event.
 * @param event - the event payload.
 */
function applyEvent(run, event) {
  switch (event.type) {
    case 'start':
      run.declaredContextWindow = typeof event.declaredContextWindow === 'number' ? event.declaredContextWindow : null
      run.progress = { kind: 'start' }
      break
    case 'run-start':
      run.progress = { kind: 'run', index: event.index, total: event.total, targetTokens: event.targetTokens }
      break
    case 'run':
      run.results.push(event.result)
      run.progress = { kind: 'ran', targetTokens: event.result.targetTokens, ttftMs: event.result.ttftMs }
      break
    case 'probe-start':
      run.progress = { kind: 'probe', probe: event.probe, of: event.of, targetTokens: event.targetTokens }
      break
    case 'probe':
      run.steps.push(event.step)
      run.progress = { kind: 'probed', probe: event.step.probe, outcome: event.step.outcome }
      break
    case 'summary':
      run.summary = event.summary
      break
    case 'error':
      run.error = event.message
      break
    case 'done':
      run.status = typeof event.status === 'string' ? event.status : 'done'
      run.endedAt = Date.now()
      run.progress = null
      break
    default:
      break
  }
}

/**
 * Append one event to the run log and hand it to every attached reader.
 * @param run - the run that produced it.
 * @param event - the event payload.
 */
function publish(run, event) {
  const entry = { runId: run.id, seq: run.nextSeq, event }
  run.nextSeq += 1
  applyEvent(run, event)
  run.log.push(entry)
  if (run.log.length > MAX_RUN_EVENTS) run.log.shift()
  for (const reader of [...run.readers]) reader(entry)
}

/** True while a measurement holds the model's attention. */
function isBusy() {
  return current !== null && current.status === 'running'
}

/**
 * Drive one run to completion, publishing every step as it happens.
 * @param run - the run record to fill.
 * @param spec - resolved route, action, and validated parameters.
 */
async function executeRun(run, spec) {
  const emit = (event) => publish(run, event)
  try {
    publish(run, {
      type: 'start',
      action: run.action,
      provider: run.provider,
      model: run.model,
      declaredContextWindow: spec.declaredContextWindow ?? null,
    })
    if (run.action === 'sweep') {
      await runSweep({
        llm: spec.llm,
        provider: run.provider,
        model: run.model,
        sizes: spec.sizes,
        outputTokens: spec.outputTokens,
        repeats: spec.repeats,
        needle: spec.needle,
        signal: run.controller.signal,
        emit,
      })
      publish(run, {
        type: 'summary',
        summary: { action: 'sweep', outputTokens: spec.outputTokens, repeats: spec.repeats, results: run.results },
      })
    } else {
      await probeMaxContext({
        llm: spec.llm,
        provider: run.provider,
        model: run.model,
        ceilingTokens: spec.ceilingTokens,
        toleranceTokens: spec.toleranceTokens,
        maxProbes: spec.maxProbes,
        signal: run.controller.signal,
        emit,
      })
    }
    publish(run, { type: 'done', status: run.controller.signal.aborted ? 'stopped' : 'done' })
  } catch (error) {
    const stopped = run.controller.signal.aborted
    if (!stopped) publish(run, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    publish(run, { type: 'done', status: stopped ? 'stopped' : 'error' })
  }
}

/** Round one numeric input into its accepted range, ignoring garbage. */
function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

/**
 * Resolve the route and start one measured run.
 * @param ctx - plugin context.
 * @param body - request or tool arguments.
 * @param signal - optional external cancellation, such as a tool call being aborted.
 * @returns the started run record.
 */
async function startRun(ctx, body, signal) {
  if (isBusy()) throw new Error('Another benchmark is already running; stop it from the Model Bench panel or wait for it to finish.')
  const action = body.action === 'probe' ? 'probe' : 'sweep'
  const route = await resolveRoute(ctx, { provider: body.provider, model: body.model })
  const info = await routeInfo(ctx.llm, route.provider, route.model)
  const spec = {
    action,
    llm: ctx.llm,
    provider: route.provider,
    model: route.model,
    declaredContextWindow: info.declaredContextWindow,
  }
  if (action === 'sweep') {
    spec.sizes = normalizeSizes(body.sizes)
    spec.outputTokens = clampInt(body.outputTokens, DEFAULTS.outputTokens, 1, DEFAULTS.maxOutputTokens)
    spec.repeats = clampInt(body.repeats, DEFAULTS.repeats, 1, 5)
    spec.needle = body.needle !== false
  } else {
    spec.ceilingTokens = clampInt(body.ceilingTokens, info.declaredContextWindow ?? 262_144, 1024, DEFAULTS.hardMaxTokens)
    spec.toleranceTokens = clampInt(body.toleranceTokens, DEFAULTS.toleranceTokens, 64, 1_000_000)
    spec.maxProbes = clampInt(body.maxProbes, DEFAULTS.maxProbes, 1, 24)
  }
  const run = {
    id: nextRunId,
    action,
    provider: route.provider,
    model: route.model,
    declaredContextWindow: spec.declaredContextWindow,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    results: [],
    steps: [],
    summary: null,
    error: null,
    progress: null,
    log: [],
    nextSeq: 0,
    readers: new Set(),
    controller: new AbortController(),
    done: null,
  }
  nextRunId += 1
  current = run
  if (signal !== undefined) {
    const relay = () => run.controller.abort(signal.reason)
    if (signal.aborted) relay()
    else signal.addEventListener('abort', relay, { once: true })
  }
  run.done = executeRun(run, spec)
  return run
}

/**
 * Run one benchmark for the agent tool and wait for its outcome.
 * @param ctx - plugin context.
 * @param exec - tool execution, whose cancellation stops the run.
 * @param body - tool arguments.
 * @returns the finished run snapshot.
 */
async function runThroughTool(ctx, exec, body) {
  const run = await startRun(ctx, body, exec.signal)
  const snapshot = await run.done.then(() => snapshotOf(run))
  if (snapshot.status === 'stopped') throw new Error('The benchmark was stopped before it finished.')
  if (snapshot.error !== null) throw new Error(snapshot.error)
  return snapshot
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

/** One route guard shared by the write endpoints. */
function guardWrite(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'use POST' })
    return false
  }
  if (!trustedRequest(request)) {
    sendJson(response, 403, { error: 'untrusted origin' })
    return false
  }
  return true
}

/**
 * Register the benchmark endpoints on the Host web server.
 * @param ctx - plugin context.
 * @param webServer - Host web server service.
 * @returns one disposer for every route.
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
  const state = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/state',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'use GET' })
        return
      }
      sendJson(response, 200, snapshotOf(current))
    },
  })
  const run = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/run',
    handler: async (request, response) => {
      if (!guardWrite(request, response)) return
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (isBusy()) {
        sendJson(response, 409, { error: 'another benchmark is already running; stop it first', runId: current.id })
        return
      }
      try {
        const started = await startRun(ctx, body)
        sendJson(response, 202, snapshotOf(started))
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  const events = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/events',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'use GET' })
        return
      }
      const snapshot = current
      if (snapshot === null) {
        sendJson(response, 404, { error: 'no benchmark has run yet' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const from = clampInt(url.searchParams.get('from'), 0, 0, Number.MAX_SAFE_INTEGER)
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/x-ndjson; charset=utf-8',
        'x-accel-buffering': 'no',
      })
      const send = (entry) => {
        if (response.writableEnded) return
        response.write(`${JSON.stringify(entry)}\n`)
        if (entry.event.type === 'done') response.end()
      }
      for (const entry of snapshot.log) if (entry.seq >= from) send(entry)
      if (snapshot.status !== 'running') {
        if (!response.writableEnded) response.end()
        return
      }
      snapshot.readers.add(send)
      response.on('close', () => snapshot.readers.delete(send))
    },
  })
  const stop = webServer.register({
    kind: 'exact',
    path: '/api/llm-bench/stop',
    handler: (request, response) => {
      if (!guardWrite(request, response)) return
      if (!isBusy()) {
        sendJson(response, 200, { ok: false, status: current === null ? 'idle' : current.status })
        return
      }
      current.controller.abort(new Error('stopped from the Model Bench panel'))
      sendJson(response, 200, { ok: true, runId: current.id })
    },
  })
  return () => {
    catalog()
    state()
    run()
    events()
    stop()
  }
}

/**
 * Activate the Host half: agent tool plus, when the web server is present,
 * the panel endpoints. Runs outlive their readers, so the panel is a view of
 * Host state rather than the owner of it.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(toolDefinition(ctx)), 'llm-bench: tool')
  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountRoutes(host, host.webServer), 'llm-bench: web routes')
  })
}
