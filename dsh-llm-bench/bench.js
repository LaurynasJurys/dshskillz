/**
 * Benchmark core for the Model Context Bench plugin: synthetic-context
 * generation, one measured model call, a speed sweep, and a bisection probe
 * for the largest usable context.
 *
 * Shared by the agent tool (index.js) and the Settings page HTTP stream
 * (index.js), so both report identical numbers. Host-only: no browser APIs.
 */

/** Context-overflow code the LLM runtime assigns to an over-long request. */
const CONTEXT_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
/** Failure codes that must stop a run instead of being recorded as a data point. */
const FATAL_CODES = new Set(['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'MODEL_NOT_FOUND'])

/** Tunables shared by both entry points unless a caller overrides them. */
export const DEFAULTS = {
  outputTokens: 256,
  repeats: 1,
  needle: true,
  charsPerToken: 3.9,
  toleranceTokens: 512,
  maxProbes: 14,
  hardMaxTokens: 4_000_000,
  maxOutputTokens: 2048,
  maxSizes: 16,
}

/** Small fixed system prompt: it is measured as input tokens too. */
const SYSTEM = 'You are a precise assistant. Follow the reply format exactly.'

/** Word pool for generated documents; ordinary English words, no repeats needed. */
const WORDS = (
  'account bridge canopy delta ember forest granite harbor island jacket kernel ladder ' +
  'meadow nickel orchard pebble quarry river saddle timber umbrella valley walnut yard ' +
  'anchor beacon candle domino echo falcon glacier hollow ink jug kettle lantern marble ' +
  'nectar oak paddle quartz ribbon signal tunnel unity vessel wagon zebra amber boulder ' +
  'cinder driftwood estuary fable gasket heather inlet juniper kiln lumber mist nestle ' +
  'orbit prairie quiver rafter summit thistle uproot vivid willow yonder zephyr alloy ' +
  'basin copper dune flint grove helix isthmus jetty knoll lagoon marsh needle pivot ' +
  'ridge shingle tide upland cascade brim stone feathered narrow distant patient circular ' +
  'quiet steady amber-colored frequent shallow careful modern ancient brittle lucid ' +
  'measure variant border transit lattice module segment pattern chorus balance margin ' +
  'record archive packet channel marker socket buffer cursor frame packet queue stack ' +
  'thread token window column schema index table ledger metric offset region sample'
).split(' ')

/**
 * Deterministic 32-bit PRNG.
 * @param seed - any 32-bit unsigned seed.
 * @returns a function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fresh seed for one request, so no two runs share a prefix (and so a provider
 * prompt cache cannot silently speed up a later run).
 * @returns a random unsigned 32-bit seed.
 */
export function randomSeed() {
  return (Math.random() * 0x1_0000_0000) >>> 0
}

/**
 * Build one unpadded marker token.
 * @param rng - deterministic generator.
 * @returns an 8-character token drawn from an unambiguous alphabet.
 */
export function makeKey(rng) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let key = ''
  for (let i = 0; i < 8; i += 1) key += alphabet[Math.floor(rng() * alphabet.length)]
  return key
}

/**
 * Render one pseudo-sentence of ordinary prose.
 * @param rng - deterministic generator.
 * @returns a sentence of 5-16 words.
 */
function sentence(rng) {
  const length = 5 + Math.floor(rng() * 12)
  const words = []
  for (let i = 0; i < length; i += 1) {
    const word = WORDS[Math.floor(rng() * WORDS.length)]
    words.push(i === 0 ? word[0].toUpperCase() + word.slice(1) : word)
  }
  let text = words.join(' ')
  if (rng() < 0.07) text += ` (${10_000 + Math.floor(rng() * 89_999)})`
  return text + (rng() < 0.05 ? '?' : '.')
}

/**
 * Generate a low-repetition document of a requested character length and
 * optionally hide one `KEY:` marker line inside it.
 * @param request - target length, seed, and marker placement.
 * @returns the document text plus the marker token, if any.
 */
export function generateDocument(request) {
  const rng = mulberry32(request.seed >>> 0)
  const targetChars = Math.max(64, Math.floor(request.targetChars))
  const parts = []
  let length = 0
  while (length < targetChars) {
    const line = sentence(rng)
    parts.push(line)
    length += line.length + 1
  }
  let body = parts.join(' ')
  if (body.length > targetChars) {
    body = body.slice(0, targetChars)
    const cut = body.lastIndexOf(' ')
    if (cut > targetChars * 0.8) body = body.slice(0, cut)
  }
  if (request.needleAt === undefined || request.needleAt === null) return { text: body, key: null, chars: body.length }
  const key = makeKey(rng)
  const at = Math.min(body.length - 1, Math.max(0, Math.round(body.length * request.needleAt)))
  const space = body.indexOf(' ', at)
  const cut = space === -1 ? body.length : space
  const text = `${body.slice(0, cut)}\nKEY: ${key}\n${body.slice(cut)}`
  return { text, key, chars: text.length }
}

/** Copy fixed per-request text, so the estimator can separate it from generated body. */
function framing(needle) {
  const instruction = needle
    ? 'The message below is one long document. Exactly one line in it starts with "KEY:". Read the entire document and reply with only the token that follows "KEY:", and nothing else. If it is not present, reply NOTFOUND.'
    : 'The message below is one long document. Reply with the single word OK, and nothing else.'
  const question = needle ? 'What is the KEY token?' : 'Reply OK.'
  const open = '----- BEGIN DOCUMENT -----\n'
  const close = '\n----- END DOCUMENT -----\n\n'
  return { instruction, question, open, close, fixedChars: instruction.length + question.length + open.length + close.length + 4 }
}

/**
 * Assemble one request prompt sized by an estimated tokens-per-character ratio.
 * @param request - target tokens, ratio, needle flag, and seed.
 * @returns prompt text, marker token, and the character breakdown.
 */
export function planPrompt(request) {
  const ratio = request.charsPerToken
  const needle = request.needle === true
  const { instruction, question, open, close, fixedChars } = framing(needle)
  const needleAt = needle ? 0.35 + (mulberry32(request.seed)() * 0.3) : null
  const bodyChars = Math.max(200, Math.round(request.targetTokens * ratio) - fixedChars)
  const document = generateDocument({ seed: request.seed, targetChars: bodyChars, needleAt })
  const text = `${instruction}\n\n${open}${document.text}${close}${question}`
  return { text, key: document.key, promptChars: text.length, bodyChars: document.chars, fixedChars }
}

/**
 * Classify one failure as context overflow, fatal, or merely a failed data point.
 * @param failure - failure record from a call.
 * @returns 'context' | 'fatal' | 'other'.
 */
export function classifyFailure(failure) {
  if (!failure) return 'other'
  if (failure.code === CONTEXT_EXCEEDED) return 'context'
  if (FATAL_CODES.has(failure.code)) return 'fatal'
  if (failure.code === 'INVALID_REQUEST' && /context|too long|too large|maximum/i.test(failure.message)) return 'context'
  return 'other'
}

/** Read a thrown adapter error into the same failure record the stream uses. */
function failureFromError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'CALL_FAILED'
  return {
    code,
    message: typeof error?.message === 'string' ? error.message.slice(0, 400) : String(error).slice(0, 400),
    status: typeof error?.status === 'number' ? error.status : null,
  }
}

/**
 * Stream one request and measure it.
 *
 * TTFT is measured to the first text or reasoning delta; prefill throughput is
 * input tokens over TTFT, so it includes provider queueing and transport.
 * Decode throughput is output tokens over the time between the first and last
 * delta. Both are reported as measured, not modelled.
 * @param request - model route, prompt, output cap, and cancellation.
 * @returns one measurement record.
 */
export async function measureCall(request) {
  const started = performance.now()
  let ttftMs = null
  let lastDeltaAt = null
  let usage = null
  let finish = null
  let text = ''
  let thrown = null
  try {
    const stream = request.llm.stream({
      provider: request.provider,
      model: request.model,
      ...(request.system === undefined ? {} : { system: request.system }),
      messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
      maxTokens: request.maxTokens,
      temperature: 0,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    for await (const chunk of stream) {
      const at = performance.now()
      if (chunk.type === 'text-delta') {
        text += chunk.text
        if (ttftMs === null) ttftMs = at - started
        lastDeltaAt = at
      } else if (chunk.type === 'reasoning-delta') {
        if (ttftMs === null) ttftMs = at - started
        lastDeltaAt = at
      } else if (chunk.type === 'usage') {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
  } catch (error) {
    if (request.signal?.aborted) throw error
    thrown = failureFromError(error)
  }
  const ended = performance.now()
  const finishKind = finish?.kind ?? (thrown === null ? 'incomplete' : 'error')
  const failure = thrown ?? (finishKind === 'error' ? finish.failure : null) ?? (finishKind === 'aborted' ? finish.failure : null)
  const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : null
  const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : null
  const decodeWindowMs = ttftMs === null || lastDeltaAt === null ? null : Math.max(0, lastDeltaAt - started - ttftMs)
  return {
    ok: failure === null && (finishKind === 'stop' || finishKind === 'max-tokens'),
    finishKind,
    failure: failure ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens: typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : null,
    cacheWriteTokens: typeof usage?.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : null,
    reasoningTokens: typeof usage?.reasoningTokens === 'number' ? usage.reasoningTokens : null,
    ttftMs: ttftMs === null ? null : Math.round(ttftMs),
    totalMs: Math.round(ended - started),
    prefillTokPerSec: inputTokens !== null && ttftMs !== null && ttftMs > 0 ? inputTokens / (ttftMs / 1000) : null,
    decodeTokPerSec: outputTokens !== null && decodeWindowMs !== null && decodeWindowMs > 0 ? outputTokens / (decodeWindowMs / 1000) : null,
    reply: text.replace(/\s+/g, ' ').trim().slice(0, 160),
  }
}

/** Keep one calibration outlier from permanently skewing later request sizes. */
function clampRatio(value) {
  if (!Number.isFinite(value)) return null
  return Math.min(6, Math.max(2.5, value))
}

/**
 * Measure one context size: build the prompt, call the model, and record how
 * far the actual token count landed from the requested one.
 * @param request - route, target size, calibration ratio, and options.
 * @returns measurement plus prompt-shape facts.
 */
export async function runOne(request) {
  const seeded = request.seed ?? randomSeed()
  const planned = planPrompt({
    targetTokens: request.targetTokens,
    charsPerToken: request.charsPerToken ?? DEFAULTS.charsPerToken,
    needle: request.needle,
    seed: seeded,
  })
  const measured = await measureCall({
    llm: request.llm,
    provider: request.provider,
    model: request.model,
    system: SYSTEM,
    prompt: planned.text,
    maxTokens: Math.max(1, Math.min(DEFAULTS.maxOutputTokens, request.outputTokens)),
    signal: request.signal,
  })
  const needlePresent = planned.key !== null
  const recall = needlePresent && measured.ok
    ? {
        found: measured.reply.toUpperCase().includes(planned.key),
        key: planned.key,
        // A reply cut off by the output cap cannot prove the marker was missing.
        truncated: measured.finishKind === 'max-tokens',
      }
    : null
  let measuredRatio = null
  if (measured.inputTokens !== null && measured.inputTokens > 0) {
    const overheadTokens = planned.fixedChars / (request.charsPerToken ?? DEFAULTS.charsPerToken)
    const bodyTokens = measured.inputTokens - overheadTokens
    if (bodyTokens > 50) measuredRatio = clampRatio(planned.bodyChars / bodyTokens)
  }
  return {
    targetTokens: request.targetTokens,
    seed: seeded,
    key: planned.key,
    promptChars: planned.promptChars,
    charsPerTokenMeasured: measuredRatio,
    recall,
    ...measured,
  }
}

/** Abort the run with the signal's own reason so callers can distinguish it. */
function throwIfAborted(signal, emit) {
  if (!signal?.aborted) return
  const reason = signal.reason instanceof Error ? signal.reason : new Error('aborted')
  emit?.({ type: 'error', message: reason.message })
  throw reason
}

/**
 * Run a speed sweep over ascending context sizes, recalibrating the
 * characters-per-token estimate from each successful call.
 * @param request - route, sizes, repeats, and an event sink.
 * @returns the measurements in execution order.
 */
export async function runSweep(request) {
  const emit = request.emit ?? (() => {})
  const repeats = Math.max(1, Math.min(5, Math.round(request.repeats ?? DEFAULTS.repeats)))
  let ratio = request.charsPerToken ?? DEFAULTS.charsPerToken
  const results = []
  if (request.calibrate !== false) {
    const calibration = await runOne({
      llm: request.llm,
      provider: request.provider,
      model: request.model,
      targetTokens: Math.max(1000, Math.min(4000, request.sizes[0])),
      outputTokens: 8,
      charsPerToken: ratio,
      needle: false,
      signal: request.signal,
    })
    if (classifyFailure(calibration.failure) === 'fatal') {
      emit({ type: 'error', message: `${calibration.failure.code}: ${calibration.failure.message}` })
      return results
    }
    if (calibration.charsPerTokenMeasured !== null) ratio = calibration.charsPerTokenMeasured
  }
  const total = request.sizes.length * repeats
  for (let index = 0; index < request.sizes.length; index += 1) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      throwIfAborted(request.signal, emit)
      const target = request.sizes[index]
      emit({ type: 'run-start', index, repeat, total, targetTokens: target, charsPerToken: ratio })
      const result = await runOne({
        llm: request.llm,
        provider: request.provider,
        model: request.model,
        targetTokens: target,
        outputTokens: request.outputTokens ?? DEFAULTS.outputTokens,
        charsPerToken: ratio,
        needle: request.needle ?? DEFAULTS.needle,
        signal: request.signal,
      })
      if (result.charsPerTokenMeasured !== null) ratio = result.charsPerTokenMeasured
      if (result.finishKind === 'aborted') throw request.signal?.reason ?? new Error('aborted')
      emit({ type: 'run', result })
      results.push(result)
      if (classifyFailure(result.failure) === 'fatal') {
        emit({ type: 'error', message: `${result.failure.code}: ${result.failure.message}` })
        return results
      }
    }
  }
  return results
}

/**
 * Find the largest context the route accepts, by bisection over estimated
 * token counts. A probe is a real request with a short reply, so each step also
 * reports whether the model could retrieve the marker placed mid-document.
 * @param request - route, ceiling, tolerance, and an event sink.
 * @returns the search outcome and every probe step.
 */
export async function probeMaxContext(request) {
  const emit = request.emit ?? (() => {})
  const tolerance = Math.max(64, Math.round(request.toleranceTokens ?? DEFAULTS.toleranceTokens))
  const maxProbes = Math.max(1, Math.min(24, Math.round(request.maxProbes ?? DEFAULTS.maxProbes)))
  const ceiling = Math.max(1024, Math.min(DEFAULTS.hardMaxTokens, Math.round(request.ceilingTokens)))
  let ratio = request.charsPerToken ?? DEFAULTS.charsPerToken
  const steps = []
  let best = { tokens: 0, inputTokens: 0, recall: null }
  let smallestFailure = null

  const probe = async (targetTokens) => {
    throwIfAborted(request.signal, emit)
    const stepIndex = steps.length + 1
    emit({ type: 'probe-start', probe: stepIndex, of: maxProbes, targetTokens })
    const result = await runOne({
      llm: request.llm,
      provider: request.provider,
      model: request.model,
      targetTokens,
      outputTokens: 512,
      charsPerToken: ratio,
      needle: true,
      signal: request.signal,
    })
    if (result.charsPerTokenMeasured !== null) ratio = result.charsPerTokenMeasured
    if (result.finishKind === 'aborted') throw request.signal?.reason ?? new Error('aborted')
    const kind = result.ok ? 'pass' : classifyFailure(result.failure)
    const step = {
      probe: stepIndex,
      targetTokens,
      inputTokens: result.inputTokens,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      prefillTokPerSec: result.prefillTokPerSec,
      outcome: kind,
      failure: result.failure,
      recall: result.recall?.found ?? null,
    }
    steps.push(step)
    emit({ type: 'probe', step })
    return step
  }

  // Learn this document's tokens-per-character ratio from one small call, so the
  // first probe lands near the requested ceiling instead of far below it.
  if (request.calibrate !== false) {
    const calibration = await runOne({
      llm: request.llm,
      provider: request.provider,
      model: request.model,
      targetTokens: Math.max(1000, Math.min(4000, Math.round(ceiling * 0.01))),
      outputTokens: 8,
      charsPerToken: ratio,
      needle: false,
      signal: request.signal,
    })
    if (classifyFailure(calibration.failure) === 'fatal') {
      emit({ type: 'error', message: `${calibration.failure.code}: ${calibration.failure.message}` })
      const summary = { action: 'probe', ceilingReached: false, maxTokens: 0, maxInputTokens: null, ceilingTokens: ceiling, steps, aborted: true }
      emit({ type: 'summary', summary })
      return summary
    }
    if (calibration.charsPerTokenMeasured !== null) ratio = calibration.charsPerTokenMeasured
  }

  const first = await probe(ceiling)
  if (first.outcome === 'fatal') {
    emit({ type: 'error', message: `${first.failure.code}: ${first.failure.message}` })
    const summary = { action: 'probe', ceilingReached: false, maxTokens: 0, maxInputTokens: null, ceilingTokens: ceiling, steps, aborted: true }
    emit({ type: 'summary', summary })
    return summary
  }
  if (first.outcome === 'pass') {
    best = { tokens: ceiling, inputTokens: first.inputTokens ?? ceiling, recall: first.recall }
    const summary = {
      action: 'probe',
      ceilingReached: true,
      ceilingTokens: ceiling,
      maxTokens: ceiling,
      maxInputTokens: first.inputTokens,
      recall: first.recall,
      tolerance,
      steps,
    }
    emit({ type: 'summary', summary })
    return summary
  }
  let low = 0
  let high = ceiling
  smallestFailure = first
  while (steps.length < maxProbes && high - low > tolerance) {
    const mid = Math.floor((low + high) / 2)
    const step = await probe(mid)
    if (step.outcome === 'pass') {
      low = mid
      best = { tokens: mid, inputTokens: step.inputTokens ?? mid, recall: step.recall }
    } else if (step.outcome === 'fatal') {
      emit({ type: 'error', message: `${step.failure.code}: ${step.failure.message}` })
      const summary = {
        action: 'probe',
        ceilingReached: false,
        ceilingTokens: ceiling,
        maxTokens: best.tokens,
        maxInputTokens: best.inputTokens,
        tolerance,
        steps,
        aborted: true,
      }
      emit({ type: 'summary', summary })
      return summary
    } else {
      high = mid
      smallestFailure = step
    }
  }
  const summary = {
    action: 'probe',
    ceilingReached: false,
    ceilingTokens: ceiling,
    maxTokens: best.tokens,
    maxInputTokens: best.inputTokens,
    recall: best.recall,
    firstFailingTarget: smallestFailure === null ? null : smallestFailure.targetTokens,
    tolerance,
    steps,
  }
  emit({ type: 'summary', summary })
  return summary
}
