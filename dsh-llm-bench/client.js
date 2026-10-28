/**
 * Model Context Bench, browser half: a side panel that shows a run owned by the
 * Host. Closing the panel, opening another one, or reloading the page detaches
 * this view; it never stops the measurement, and re-opening replays whatever it
 * missed. The last finished run is also kept in localStorage for the case where
 * the Host itself restarted.
 *
 * Plain-JS client module: `React` comes from the browser module table, all
 * controls are local, and every color comes from a `--dsw-alias-*` theme token.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-llm-bench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'llm-bench'
    /** Sidebar entry id and `main` key; the shell routes one to the other. */
    const PANEL_ID = 'llm-bench'
    /** Where the form and the last finished run survive a Host restart. */
    const STORE_KEY = 'dsh-llm-bench:v2'

    const en = {
      nav: 'Model Bench',
      title: 'Model Context Bench',
      subtitle: 'Measure speed at chosen context sizes, find the largest context a route accepts, and generate the context used for both.',
      provider: 'Provider',
      model: 'Model',
      declaredWindow: 'Declared context',
      notDeclared: 'not declared',
      tokens: 'tokens',
      sizes: 'Context sizes (tokens, comma separated)',
      sizesHint: 'Each number is a target size for generated context. The Actual column is the token count the provider reported.',
      replyCap: 'Reply cap',
      repeats: 'Repeats',
      needle: 'Check retrieval',
      needleHint: 'Hides a KEY marker mid-document and reports whether the model found it, so a fast run still proves the whole context stayed readable.',
      runSweep: 'Run sweep',
      probe: 'Find max context',
      stop: 'Stop',
      clear: 'Clear results',
      starting: 'starting…',
      unavailable: 'The benchmark endpoints are not answering. Is the host half of this plugin loaded?',
      invalidSizes: 'Enter context sizes as numbers of at least 256 tokens.',
      noRoute: 'Choose a provider and model first.',
      busy: 'Another benchmark is already running; showing that run instead.',
      results: 'Measurements',
      noResults: 'No measurements yet. Runs keep going while you work elsewhere.',
      maxContext: 'Max context',
      firstFailing: 'First failing target',
      requestedTarget: 'Requested target',
      tokensMeasured: 'tokens measured',
      tokensEstimated: 'tokens (estimated)',
      tolerance: 'Tolerance',
      copy: 'Copy JSON',
      copied: 'Copied',
      costNote: 'Every run sends real input tokens to the provider and is billed; a probe near a large ceiling sends millions of tokens.',
      runKeepsHint: 'The run continues on the host while you use other panels; reopen this one to see it finish.',
      restored: 'Restored from this browser — the host has no run in memory.',
      stoppedHint: 'Stopped before it finished; the numbers below are partial.',
      colTarget: 'Target',
      colActual: 'Actual',
      colTtft: 'TTFT',
      colPrefill: 'Prefill',
      colDecode: 'Decode',
      colTotal: 'Total',
      colOut: 'Out',
      colRecall: 'Recall',
      colStatus: 'Status',
      colProbe: 'Step',
      colOutcome: 'Outcome',
      outcomePass: 'accepted',
      outcomeContext: 'too large',
      outcomeFatal: 'failed',
      recallYes: 'found',
      recallNo: 'missed',
      recallTruncated: 'truncated',
      recallNone: '—',
      probeOf: 'probe',
      ofProbes: 'of',
      prefillNote: 'Prefill is input tokens over time to first token, so it includes provider queueing and transport. Decode is output tokens over the time between the first and last returned token.',
      probeAborted: 'The search stopped on a failure that is not about size, so these results are partial.',
      ceilingHint: 'The ceiling itself passed, so the real limit is higher. Raise the probe ceiling to push further.',
      probeCeiling: 'Probe ceiling (tokens)',
      probeCeilingAuto: 'auto',
      toleranceLabel: 'Probe tolerance',
    }

    /** Set once in `apply`, so components outside the slot's prop faces can read the locale. */
    let translate = null

    /** Read one dictionary key through the active locale, falling back to this module's text. */
    function tr(key) {
      const fromLocale = typeof translate === 'function' ? translate(key) : undefined
      if (typeof fromLocale === 'string' && fromLocale !== key) return fromLocale
      return en[key] ?? key
    }

    const CSS = [
      '.llmb-root{box-sizing:border-box;flex:auto;width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding-block-start:var(--dsh-frame-top-clearance,0px)}',
      '.llmb-head{flex:0 0 auto;display:flex;flex-direction:column;gap:4px;padding:16px 24px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.llmb-titlerow{display:flex;align-items:baseline;gap:10px;min-width:0}',
      '.llmb-headspacer{flex:1 1 auto}',
      '.llmb-live{color:var(--dsw-alias-brand-primary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.llmb-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 24px 32px}',
      '.llmb-col{display:flex;flex-direction:column;gap:14px;max-width:860px;margin:0 auto;min-width:0}',
      '.llmb-title{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.llmb-sub{margin:0;color:var(--dsw-alias-label-secondary)}',
      '.llmb-icon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
      '.llmb-card{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.llmb-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;min-width:0}',
      '.llmb-field{display:flex;flex-direction:column;gap:4px;flex:1 1 160px;min-width:0}',
      '.llmb-field>span{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.llmb-field.llmb-num{flex:0 1 104px}',
      '.llmb-input{box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit}',
      '.llmb-input:disabled{color:var(--dsw-alias-state-idle-primary)}',
      '.llmb-check{display:flex;gap:6px;align-items:center;flex:0 1 auto;height:32px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.llmb-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.llmb-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.llmb-chip{height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.llmb-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.llmb-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.llmb-btn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.llmb-btn:disabled{cursor:default;color:var(--dsw-alias-state-idle-primary)}',
      '.llmb-btn.llmb-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.llmb-btn.llmb-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.llmb-progress{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.llmb-error{padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}',
      '.llmb-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.llmb-block{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.llmb-h3{margin:0;font-size:13px;font-weight:500}',
      '.llmb-scroll{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.llmb-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}',
      '.llmb-table th{text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.llmb-table td{text-align:right;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.llmb-table tr:last-child td{border-bottom:none}',
      '.llmb-table th:first-child,.llmb-table td:first-child{text-align:left}',
      '.llmb-ok{color:var(--dsw-alias-state-success-primary)}',
      '.llmb-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.llmb-bad{color:var(--dsw-alias-state-error-primary)}',
      '.llmb-figure{display:flex;align-items:baseline;gap:8px;font-variant-numeric:tabular-nums}',
      '.llmb-figure strong{font-size:20px;font-weight:500;line-height:28px}',
      '.llmb-figure span{color:var(--dsw-alias-label-secondary)}',
      '.llmb-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
    ].join('')

    /** Read the persisted form and last run, tolerating absent or corrupt storage. */
    function readStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    }

    /** Persist the form and the last finished run; storage failures are non-fatal. */
    function writeStore(value) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
      } catch {
        /* private mode or quota: keep the run in memory only */
      }
    }

    /** Group digits for large token counts. */
    function formatInt(value) {
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—'
    }

    /** Render a duration, switching unit above one second. */
    function formatMs(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`
    }

    /** Render a throughput figure. */
    function formatRate(value) {
      return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(0)} tok/s` : '—'
    }

    /** Parse the comma-separated size field into ascending unique integers. */
    function parseSizes(text) {
      const sizes = []
      for (const part of String(text).split(/[,;\s]+/)) {
        if (part.length === 0) continue
        const value = Number(part)
        if (!Number.isFinite(value) || value < 256) continue
        sizes.push(Math.round(value))
      }
      const unique = [...new Set(sizes)].sort((a, b) => a - b)
      return unique.slice(0, 16)
    }

    /** The idle run shape, so rendering never has to branch on "no run at all". */
    function idleRun() {
      return {
        runId: null,
        status: 'idle',
        results: [],
        steps: [],
        summary: null,
        error: null,
        progress: null,
        declaredContextWindow: null,
      }
    }

    /**
     * Fold one Host event into the panel's copy of the run, mirroring the Host's
     * own fold so a replayed stream and a live one land in the same shape.
     * @param previous - the run as currently rendered.
     * @param event - one event from the Host stream.
     * @returns the updated run.
     */
    function reduceEvent(previous, event) {
      const run = previous ?? idleRun()
      switch (event.type) {
        case 'start':
          return { ...run, status: 'running', error: null, progress: { kind: 'start' }, declaredContextWindow: event.declaredContextWindow ?? null }
        case 'run-start':
          return { ...run, progress: { kind: 'run', index: event.index, total: event.total, targetTokens: event.targetTokens } }
        case 'run':
          return {
            ...run,
            results: [...run.results, event.result],
            progress: { kind: 'ran', targetTokens: event.result.targetTokens, ttftMs: event.result.ttftMs },
          }
        case 'probe-start':
          return { ...run, progress: { kind: 'probe', probe: event.probe, of: event.of, targetTokens: event.targetTokens } }
        case 'probe':
          return { ...run, steps: [...run.steps, event.step], progress: { kind: 'probed', probe: event.step.probe, outcome: event.step.outcome } }
        case 'summary':
          return { ...run, summary: event.summary }
        case 'error':
          return { ...run, error: event.message }
        case 'done':
          return { ...run, status: typeof event.status === 'string' ? event.status : 'done', progress: null }
        default:
          return run
      }
    }

    /** One table cell for the measurement status. */
    function statusCell(result) {
      if (result.ok) return h('td', { className: 'llmb-ok' }, 'ok')
      const code = result.failure === null || result.failure === undefined ? result.finishKind : result.failure.code
      const className = code === 'CONTEXT_WINDOW_EXCEEDED' ? 'llmb-warn' : 'llmb-bad'
      return h('td', { className }, String(code))
    }

    /** Render the sweep measurement table. */
    function ResultsTable({ results }) {
      const head = [
        tr('colTarget'),
        tr('colActual'),
        tr('colTtft'),
        tr('colPrefill'),
        tr('colDecode'),
        tr('colTotal'),
        tr('colOut'),
        tr('colRecall'),
        tr('colStatus'),
      ]
      const rows = results.map((result, index) =>
        h(
          'tr',
          { key: `${result.targetTokens}-${index}` },
          h('td', null, formatInt(result.targetTokens)),
          h('td', null, formatInt(result.inputTokens)),
          h('td', null, formatMs(result.ttftMs)),
          h('td', null, formatRate(result.prefillTokPerSec)),
          h('td', null, formatRate(result.decodeTokPerSec)),
          h('td', null, formatMs(result.totalMs)),
          h('td', null, formatInt(result.outputTokens)),
          h(
            'td',
            {
              className: result.recall === null
                ? undefined
                : result.recall.found
                  ? 'llmb-ok'
                  : result.recall.truncated
                    ? 'llmb-warn'
                    : 'llmb-bad',
            },
            result.recall === null
              ? tr('recallNone')
              : result.recall.found
                ? tr('recallYes')
                : result.recall.truncated
                  ? tr('recallTruncated')
                  : tr('recallNo'),
          ),
          statusCell(result),
        ),
      )
      return h(
        'div',
        { className: 'llmb-block' },
        h('h3', { className: 'llmb-h3' }, tr('results')),
        h(
          'div',
          { className: 'llmb-scroll' },
          h(
            'table',
            { className: 'llmb-table' },
            h('thead', null, h('tr', null, ...head.map((label, index) => h('th', { key: index }, label)))),
            h('tbody', null, ...rows),
          ),
        ),
        h('p', { className: 'llmb-note' }, tr('prefillNote')),
      )
    }

    /** Render the bisection outcome and its probe steps. */
    function ProbeSummary({ summary, steps, declaredWindow }) {
      const measured = summary === null ? null : typeof summary.maxInputTokens === 'number' ? summary.maxInputTokens : null
      const figure = summary === null
        ? null
        : h(
            'div',
            { className: 'llmb-figure' },
            h('strong', null, `${summary.ceilingReached ? '≥ ' : ''}${formatInt(measured === null ? summary.maxTokens : measured)}`),
            h('span', null, measured === null ? tr('tokensEstimated') : tr('tokensMeasured')),
          )
      const meta = summary === null
        ? []
        : [
            `${tr('declaredWindow')}: ${declaredWindow === null || declaredWindow === undefined ? tr('notDeclared') : formatInt(declaredWindow)}`,
            `${tr('requestedTarget')}: ${formatInt(summary.maxTokens)}`,
            `${tr('firstFailing')}: ${summary.firstFailingTarget === null || summary.firstFailingTarget === undefined ? '—' : formatInt(summary.firstFailingTarget)}`,
            `${tr('tolerance')}: ±${formatInt(summary.tolerance)}`,
          ]
      const rows = steps.map((step) =>
        h(
          'tr',
          { key: `probe-${step.probe}` },
          h('td', null, String(step.probe)),
          h('td', null, formatInt(step.targetTokens)),
          h('td', null, formatInt(step.inputTokens)),
          h('td', null, formatMs(step.ttftMs)),
          h(
            'td',
            { className: step.outcome === 'pass' ? 'llmb-ok' : step.outcome === 'context' ? 'llmb-warn' : 'llmb-bad' },
            step.outcome === 'pass'
              ? tr('outcomePass')
              : step.outcome === 'context'
                ? tr('outcomeContext')
                : String(step.failure === null || step.failure === undefined ? step.outcome : step.failure.code),
          ),
        ),
      )
      const head = [tr('colProbe'), tr('colTarget'), tr('colActual'), tr('colTtft'), tr('colOutcome')]
      return h(
        'div',
        { className: 'llmb-card' },
        h('h3', { className: 'llmb-h3' }, tr('maxContext')),
        summary === null ? null : summary.aborted ? h('div', { className: 'llmb-error' }, tr('probeAborted')) : null,
        figure,
        summary === null ? null : summary.ceilingReached ? h('p', { className: 'llmb-hint' }, tr('ceilingHint')) : null,
        meta.length === 0 ? null : h('div', { className: 'llmb-meta' }, ...meta.map((entry, index) => h('span', { key: index }, entry))),
        rows.length === 0
          ? null
          : h(
              'div',
              { className: 'llmb-scroll' },
              h(
                'table',
                { className: 'llmb-table' },
                h('thead', null, h('tr', null, ...head.map((label, index) => h('th', { key: index }, label)))),
                h('tbody', null, ...rows),
              ),
            ),
      )
    }

    /** Sidebar entry content: the bench glyph, sized by the shell. */
    function SidebarIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'span',
        { className: 'llmb-icon', 'aria-hidden': true },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 64 64', fill: 'none', style: { display: 'block' } },
          h('path', {
            d: 'M12 44a20 20 0 0 1 40 0',
            stroke: 'var(--dsw-alias-brand-primary)',
            strokeWidth: 6,
            strokeLinecap: 'round',
          }),
          h('path', { d: 'M32 44l10-12', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' }),
          h('circle', { cx: 32, cy: 44, r: 4.5, fill: 'currentColor' }),
        ),
      )
    }

    /** Human-readable status line for whatever the run is doing right now. */
    function progressText(progress) {
      if (progress === null || progress === undefined) return null
      if (progress.kind === 'start') return tr('starting')
      if (progress.kind === 'run') return `${formatInt(progress.targetTokens)} ${tr('tokens')}…`
      if (progress.kind === 'ran') return `${formatInt(progress.targetTokens)} ${tr('tokens')} · ${tr('colTtft')} ${formatMs(progress.ttftMs ?? null)}`
      if (progress.kind === 'probe') {
        return `${tr('probeOf')} ${progress.probe} ${tr('ofProbes')} ${progress.of}: ${formatInt(progress.targetTokens)} ${tr('tokens')}`
      }
      if (progress.kind === 'probed') {
        return `${tr('probeOf')} ${progress.probe}: ${
          progress.outcome === 'pass' ? tr('outcomePass') : progress.outcome === 'context' ? tr('outcomeContext') : tr('outcomeFatal')
        }`
      }
      return null
    }

    /**
     * The panel: route selection, sweep and probe controls, and the Host's run.
     * @returns the side panel element tree.
     */
    function Panel() {
      const [saved] = useState(readStore)
      const savedForm = saved !== null && typeof saved.form === 'object' && saved.form !== null ? saved.form : {}
      const [catalog, setCatalog] = useState(null)
      const [loadError, setLoadError] = useState(null)
      const [provider, setProvider] = useState(() => (typeof savedForm.provider === 'string' ? savedForm.provider : ''))
      const [model, setModel] = useState(() => (typeof savedForm.model === 'string' ? savedForm.model : ''))
      const [sizesText, setSizesText] = useState(() =>
        typeof savedForm.sizesText === 'string' ? savedForm.sizesText : '1000, 4000, 16000, 64000',
      )
      const [outputTokens, setOutputTokens] = useState(() =>
        typeof savedForm.outputTokens === 'number' ? savedForm.outputTokens : 256,
      )
      const [repeats, setRepeats] = useState(() => (typeof savedForm.repeats === 'number' ? savedForm.repeats : 1))
      const [needle, setNeedle] = useState(() => (typeof savedForm.needle === 'boolean' ? savedForm.needle : true))
      const [ceilingText, setCeilingText] = useState(() => (typeof savedForm.ceilingText === 'string' ? savedForm.ceilingText : ''))
      const [tolerance, setTolerance] = useState(() => (typeof savedForm.tolerance === 'number' ? savedForm.tolerance : 512))
      const [run, setRun] = useState(null)
      const [restored, setRestored] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [copied, setCopied] = useState(false)
      const readerRef = useRef(null)
      const copiedTimer = useRef(null)

      const applySnapshot = useCallback((snapshot, fromStore) => {
        setRun({ ...idleRun(), ...snapshot })
        setRestored(fromStore === true)
      }, [])

      /** Open the Host event stream for one run, from the first sequence still needed. */
      const attach = useCallback(async (from, runId) => {
        if (readerRef.current !== null) readerRef.current.abort()
        const controller = new AbortController()
        readerRef.current = controller
        try {
          const response = await fetch(`/api/llm-bench/events?from=${from}`, { cache: 'no-store', signal: controller.signal })
          if (!response.ok || response.body === null) return
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              if (line.length > 0) {
                const entry = JSON.parse(line)
                if (entry.runId === runId) setRun((previous) => reduceEvent(previous, entry.event))
              }
              newline = buffer.indexOf('\n')
            }
          }
        } catch {
          /* a detached reader is expected; the run continues on the Host */
        } finally {
          if (readerRef.current === controller) readerRef.current = null
        }
      }, [])

      /** Pull the Host's current run; re-attach while it is still running. */
      const syncState = useCallback(async () => {
        const response = await fetch('/api/llm-bench/state', { cache: 'no-store' })
        if (!response.ok) throw new Error(tr('unavailable'))
        const snapshot = await response.json()
        applySnapshot(snapshot, false)
        if (snapshot.status === 'running') void attach(snapshot.lastSeq + 1, snapshot.runId)
        return snapshot
      }, [applySnapshot, attach])

      useEffect(() => {
        let cancelled = false
        fetch('/api/llm-bench/catalog', { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error(tr('unavailable'))
            return response.json()
          })
          .then((data) => {
            if (cancelled) return
            setCatalog(data)
            setProvider((current) => (current.length > 0 ? current : data.defaults?.provider ?? ''))
            setModel((current) => (current.length > 0 ? current : data.defaults?.model ?? ''))
            if (typeof data.outputTokens === 'number' && typeof savedForm.outputTokens !== 'number') setOutputTokens(data.outputTokens)
          })
          .catch((failure) => {
            if (!cancelled) setLoadError(failure instanceof Error ? failure.message : String(failure))
          })
        return () => {
          cancelled = true
        }
        // Fetched once per panel lifetime; restored inputs win over defaults.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Adopt the Host's run on mount: it may still be running from another panel visit.
      useEffect(() => {
        let cancelled = false
        const stored = saved !== null && typeof saved.lastRun === 'object' && saved.lastRun !== null ? saved.lastRun : null
        syncState()
          .then((snapshot) => {
            if (cancelled) return
            if (snapshot.status === 'idle' && stored !== null) applySnapshot(stored, true)
          })
          .catch(() => {
            if (cancelled) return
            if (stored !== null) applySnapshot(stored, true)
          })
        return () => {
          cancelled = true
          if (readerRef.current !== null) readerRef.current.abort()
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Persist the form always, and the last finished run for a Host restart.
      useEffect(() => {
        const finished = run !== null && run.status !== 'running' && run.runId !== null ? run : null
        writeStore({
          form: { provider, model, sizesText, outputTokens, repeats, needle, ceilingText, tolerance },
          lastRun: finished !== null ? finished : saved !== null && typeof saved.lastRun === 'object' ? saved.lastRun : null,
        })
      }, [provider, model, sizesText, outputTokens, repeats, needle, ceilingText, tolerance, run, saved])

      const providers = catalog === null ? [] : catalog.providers ?? []
      const models = useMemo(() => {
        const found = providers.find((entry) => entry.id === provider)
        return found === undefined ? [] : found.models ?? []
      }, [providers, provider])
      const modelInfo = useMemo(() => models.find((entry) => entry.id === model), [models, model])

      const onProviderChange = useCallback(
        (event) => {
          const next = event.target.value
          setProvider(next)
          setModel((current) => {
            const found = providers.find((entry) => entry.id === next)
            const first = found === undefined ? undefined : found.models?.[0]?.id
            return first ?? current
          })
        },
        [providers],
      )

      const running = run !== null && run.status === 'running'

      const start = useCallback(
        async (action) => {
          if (running) return
          if (provider.length === 0 || model.length === 0) {
            setActionError(tr('noRoute'))
            return
          }
          const sizes = action === 'sweep' ? parseSizes(sizesText) : []
          if (action === 'sweep' && sizes.length === 0) {
            setActionError(tr('invalidSizes'))
            return
          }
          setActionError(null)
          const body = action === 'sweep'
            ? { action, provider, model, sizes, outputTokens, repeats, needle }
            : {
                action,
                provider,
                model,
                toleranceTokens: Math.max(64, tolerance),
                ...(Number(ceilingText) > 0 ? { ceilingTokens: Math.round(Number(ceilingText)) } : {}),
              }
          try {
            const response = await fetch('/api/llm-bench/run', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            const payload = await response.json().catch(() => null)
            if (response.status === 409) {
              setActionError(tr('busy'))
              await syncState()
              return
            }
            if (!response.ok) {
              throw new Error(payload !== null && typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
            }
            applySnapshot(payload, false)
            void attach(payload.lastSeq + 1, payload.runId)
          } catch (failure) {
            setActionError(failure instanceof Error ? failure.message : String(failure))
          }
        },
        [running, provider, model, sizesText, outputTokens, repeats, needle, ceilingText, tolerance, applySnapshot, attach, syncState],
      )

      const stop = useCallback(async () => {
        try {
          await fetch('/api/llm-bench/stop', { method: 'POST' })
        } catch (failure) {
          setActionError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      const clear = useCallback(() => {
        setRun(null)
        setActionError(null)
        setRestored(false)
        try {
          window.localStorage.removeItem(STORE_KEY)
        } catch {
          /* ignore */
        }
      }, [])

      const copy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify({ provider, model, run }, null, 2))
          setCopied(true)
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(false), 1500)
        } catch {
          setCopied(false)
        }
      }, [provider, model, run])

      const results = run === null ? [] : run.results
      const steps = run === null ? [] : run.steps
      const summary = run === null ? null : run.summary
      const progress = run === null ? null : run.progress
      const declaredWindow = run === null ? null : run.declaredContextWindow
      const errorText = actionError ?? (run === null ? null : run.error)
      const hasOutput = results.length > 0 || steps.length > 0 || summary !== null
      const presets = [
        { label: '1k–64k', value: '1000, 4000, 16000, 64000' },
        { label: '20k–200k', value: '20000, 50000, 100000, 200000' },
        { label: '1M', value: '1000000' },
      ]

      return h(
        'div',
        { className: 'llmb-root' },
        h('style', { key: 'llmb-style' }, CSS),
        h(
          'div',
          { className: 'llmb-head' },
          h(
            'div',
            { className: 'llmb-titlerow' },
            h('h1', { className: 'llmb-title' }, tr('title')),
            h('span', { className: 'llmb-headspacer' }),
            running ? h('span', { className: 'llmb-live' }, progressText(progress) ?? tr('starting')) : null,
          ),
          h('p', { className: 'llmb-sub' }, tr('subtitle')),
        ),
        h(
          'div',
          { className: 'llmb-body' },
          h(
            'div',
            { className: 'llmb-col' },
            loadError === null ? null : h('div', { className: 'llmb-error' }, loadError),
            h(
              'div',
              { className: 'llmb-card' },
              h(
                'div',
                { className: 'llmb-row' },
                h(
                  'label',
                  { className: 'llmb-field' },
                  h('span', null, tr('provider')),
                  h(
                    'select',
                    { className: 'llmb-input', value: provider, onChange: onProviderChange, disabled: running },
                    ...providers.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)),
                  ),
                ),
                h(
                  'label',
                  { className: 'llmb-field' },
                  h('span', null, tr('model')),
                  h(
                    'select',
                    { className: 'llmb-input', value: model, onChange: (event) => setModel(event.target.value), disabled: running },
                    ...models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'llmb-meta' },
                h(
                  'span',
                  null,
                  `${tr('declaredWindow')}: ${
                    modelInfo === undefined || modelInfo.contextWindow === null || modelInfo.contextWindow === undefined
                      ? tr('notDeclared')
                      : formatInt(modelInfo.contextWindow)
                  }`,
                ),
              ),
              h(
                'label',
                { className: 'llmb-field' },
                h('span', null, tr('sizes')),
                h('input', {
                  className: 'llmb-input',
                  type: 'text',
                  value: sizesText,
                  spellCheck: false,
                  onChange: (event) => setSizesText(event.target.value),
                  disabled: running,
                }),
              ),
              h(
                'div',
                { className: 'llmb-chips' },
                ...presets.map((preset, index) =>
                  h(
                    'button',
                    { key: index, type: 'button', className: 'llmb-chip', disabled: running, onClick: () => setSizesText(preset.value) },
                    preset.label,
                  ),
                ),
              ),
              h('p', { className: 'llmb-hint' }, tr('sizesHint')),
              h(
                'div',
                { className: 'llmb-row' },
                h(
                  'label',
                  { className: 'llmb-field llmb-num' },
                  h('span', null, tr('replyCap')),
                  h('input', {
                    className: 'llmb-input',
                    type: 'number',
                    min: 1,
                    max: 2048,
                    value: outputTokens,
                    onChange: (event) => setOutputTokens(Math.max(1, Math.min(2048, Math.round(Number(event.target.value) || 1)))),
                    disabled: running,
                  }),
                ),
                h(
                  'label',
                  { className: 'llmb-field llmb-num' },
                  h('span', null, tr('repeats')),
                  h('input', {
                    className: 'llmb-input',
                    type: 'number',
                    min: 1,
                    max: 5,
                    value: repeats,
                    onChange: (event) => setRepeats(Math.max(1, Math.min(5, Math.round(Number(event.target.value) || 1)))),
                    disabled: running,
                  }),
                ),
                h(
                  'label',
                  { className: 'llmb-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: needle,
                    onChange: (event) => setNeedle(event.target.checked),
                    disabled: running,
                  }),
                  h('span', null, tr('needle')),
                ),
              ),
              h('p', { className: 'llmb-hint' }, tr('needleHint')),
              h(
                'div',
                { className: 'llmb-row' },
                h(
                  'label',
                  { className: 'llmb-field llmb-num' },
                  h('span', null, tr('probeCeiling')),
                  h('input', {
                    className: 'llmb-input',
                    type: 'number',
                    min: 1024,
                    placeholder: tr('probeCeilingAuto'),
                    value: ceilingText,
                    onChange: (event) => setCeilingText(event.target.value),
                    disabled: running,
                  }),
                ),
                h(
                  'label',
                  { className: 'llmb-field llmb-num' },
                  h('span', null, tr('toleranceLabel')),
                  h('input', {
                    className: 'llmb-input',
                    type: 'number',
                    min: 64,
                    value: tolerance,
                    onChange: (event) => setTolerance(Math.max(64, Math.round(Number(event.target.value) || 512))),
                    disabled: running,
                  }),
                ),
              ),
              h(
                'div',
                { className: 'llmb-actions' },
                h('button', { type: 'button', className: 'llmb-btn llmb-primary', disabled: running, onClick: () => start('sweep') }, tr('runSweep')),
                h('button', { type: 'button', className: 'llmb-btn', disabled: running, onClick: () => start('probe') }, tr('probe')),
                running ? h('button', { type: 'button', className: 'llmb-btn llmb-danger', onClick: stop }, tr('stop')) : null,
              ),
              errorText === null ? null : h('div', { className: 'llmb-error' }, errorText),
              restored ? h('div', { className: 'llmb-note' }, tr('restored')) : null,
              run !== null && run.status === 'stopped' ? h('p', { className: 'llmb-hint' }, tr('stoppedHint')) : null,
              h('p', { className: 'llmb-note' }, tr('runKeepsHint')),
              h('p', { className: 'llmb-note' }, tr('costNote')),
            ),
            steps.length > 0 || (summary !== null && summary.action === 'probe')
              ? h(ProbeSummary, { summary: summary !== null && summary.action === 'probe' ? summary : null, steps, declaredWindow })
              : null,
            results.length > 0 ? h(ResultsTable, { results }) : null,
            hasOutput ? null : h('p', { className: 'llmb-note' }, tr('noResults')),
            h(
              'div',
              { className: 'llmb-actions' },
              h('button', { type: 'button', className: 'llmb-btn', disabled: !hasOutput, onClick: copy }, copied ? tr('copied') : tr('copy')),
              h('button', { type: 'button', className: 'llmb-btn', disabled: !hasOutput || running, onClick: clear }, tr('clear')),
            ),
          ),
        ),
      )
    }

    /**
     * Activate the browser half: dictionary, sidebar icon, and the main panel
     * keyed by the same id, so the shell routes the icon to this panel.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      translate = t
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'llm-bench: dictionary')
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.inject('sidebar.panellist', () => {
              const stopPanel = ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)
              const stopIcon = ctx.slots.register(
                { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('nav'), locale: NS },
                SidebarIcon,
              )
              return () => {
                stopPanel()
                stopIcon()
              }
            }),
          ),
        'llm-bench: panel',
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
