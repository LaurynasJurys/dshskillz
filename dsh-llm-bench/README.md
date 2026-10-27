# Model Context Bench

A DeepSeek Harness plugin that measures what a model route actually does at different
context sizes: speed at chosen sizes, the largest context it accepts, and the synthetic
context used to test both.

Installed in the current DSH profile as `@local/dsh-llm-bench` (linked from the authoring
directory).

## Install

This directory is a DSH bundle package (`package.json` → `dsh.bundle.patch`), so it is
installed by path, not by copying files into the profile: give its absolute path to the
Plugin Manager's `install_bundle` action. That links the checkout into the profile, inserts
one Loader row (`llm-bench`), and activates the `llm_bench` tool plus the
Settings → Model Bench page. Host code changes then need a disable/enable cycle; browser code
changes need a page refresh.

## Two entry points, one core

Both drive `bench.js`, so the agent and the page report identical numbers.

- **Agent tool `llm_bench`** — actions `catalog`, `sweep`, `probe`, `generate`.
- **Settings → Model Bench** — the same sweeps and probes with a live table, a stop
  button, and a JSON copy of the last run.

## What is measured

Every measurement is one real model request whose input is generated prose of a
requested size:

| Field | Meaning |
| --- | --- |
| Target | requested context size in tokens (an estimate) |
| Actual | input tokens the provider reported for the request |
| TTFT | time from request start to the first text or reasoning delta |
| Prefill | input tokens ÷ TTFT — includes provider queueing and transport |
| Decode | output tokens ÷ time between the first and last delta |
| Out | output tokens the provider reported, which includes hidden reasoning tokens |
| Recall | whether the model returned the `KEY:` marker hidden mid-document |
| Status | `ok`, or the provider failure code (`CONTEXT_WINDOW_EXCEEDED`, `AUTH`, …) |

The generator writes low-repetition pseudo-English prose (seeded, different every run, so
a provider prompt cache cannot speed up a later run) and hides one `KEY: <token>` line at
a random position in the middle third. Recall is what makes a fast run at a large size
meaningful: it proves the whole context stayed readable, not just accepted.

Sizes and probe ceilings are token *estimates*; each call is calibrated against the
tokens-per-character ratio the provider reports, so estimated and actual sizes usually
land within a few percent.

## Max-context probe

Bisection, after one small calibration call:

1. Probe the ceiling (the declared context window unless `ceilingTokens` is given).
2. If it passes, report `≥ ceiling` and stop.
3. Otherwise bisect between the largest accepted and smallest rejected target until the
   bracket is narrower than `toleranceTokens` (default 512), within `maxProbes` requests.

A failure is classified before it is believed: only `CONTEXT_WINDOW_EXCEEDED` (or a 400
whose message names the context bound) counts as "too large". `AUTH`, `QUOTA`, or rate
limits stop the probe and are reported, so a credential problem cannot masquerade as a
small context window. Providers that silently truncate an over-long prompt instead of
rejecting it will pass the probe; their recall result is the honest signal there.

## Cost

Every run bills real input tokens. A probe near a 1M-token ceiling can send millions of
input tokens, and success steps are the expensive ones (a rejected step returns before
prefill). One benchmark runs at a time across both entry points; starting a second one is
refused rather than measured against the first.

## Files

- `bench.js` — context generation, one measured call, sweep, probe. Host-only.
- `index.js` — Host plugin: the `llm_bench` tool plus `/api/llm-bench/catalog` and
  `/api/llm-bench/run` (same-origin POST, NDJSON stream, loopback for non-browser callers).
- `client.js` — browser half: the Settings page in the `settings.section` slot.
- `cordis.patch.yml`, `package.json`, `locale/en.json`, `icon.svg` — bundle manifest,
  display metadata, and icon.

Development note: a Host code change needs a reload (`plugin_manager set_bundle`
off/on); a browser code change needs a page refresh.
