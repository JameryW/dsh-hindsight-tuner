// Post-restart verification for the live machine.
//
// The plugin can only read files; it cannot see which configuration a running
// process loaded into memory. This script closes that gap from the outside:
// it resolves the effective config, asks the server it names for its health,
// asks for the bank this directory would use, and checks the journal for the
// signature of a process that predates the config (failures against a
// different origin).
//
//   node scripts/verify-live.mjs
//   node scripts/verify-live.mjs --json
//
// Exit code 0 means every hard check passed. A not-yet-seeded bank is a note,
// not a failure: Hindsight creates it on the first real session.

import { readConfigFile, tunerState } from '../lib/config-file.js'
import {
  bankResolution,
  diagPath,
  effectiveConfig,
  effectiveServer,
  findIntegration,
  optedOut,
  projectName,
  summarizeActivity,
} from '../lib/diagnostics.js'
import { summarizeTunerJournal } from '../lib/log.js'

const STALE_MS = 15 * 60_000

const results = []
function check(name, status, detail) {
  results.push({ name, status, detail })
}
function pass(name, detail) {
  check(name, 'pass', detail)
}
function note(name, detail) {
  check(name, 'note', detail)
}
function fail(name, detail) {
  check(name, 'fail', detail)
}

function originOf(url) {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return String(url ?? '').replace(/\/+$/, '').toLowerCase()
  }
}

async function request(url, token, timeoutMs = 5000) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  let raw = ''
  try {
    raw = await response.text()
  } catch {
    // The status code is already enough to report.
  }
  return { status: response.status, body: raw.slice(0, 300), raw }
}

/** Whether a 200 `/pages/tree` payload describes an empty bank (`roots: []` or `pages: []`). */
function isEmptyPageTree(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return false
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const lists = [parsed.roots, parsed.pages].filter(Array.isArray)
    return lists.length > 0 && lists.every((list) => list.length === 0)
  } catch {
    return false
  }
}

async function main() {
  const json = process.argv.includes('--json')
  const cwd = process.cwd()
  const project = projectName(cwd)
  const repo = project.name

  let config = null
  const read = readConfigFile()
  if (read.kind === 'ok') {
    config = read.config
    pass('config', `${read.path} present`)
  } else if (read.kind === 'missing') {
    fail('config', `${read.path} does not exist; the integration has nothing to read`)
  } else {
    fail('config', `${read.path} is ${read.kind}: ${read.error}`)
  }

  if (config) {
    const baseLayers = effectiveConfig(config, { cwd })
    let resolution = null
    try {
      resolution = bankResolution(baseLayers.config, repo, cwd)
    } catch (error) {
      fail('bank', `could not resolve the bank: ${error.message}`)
    }
    const layers = effectiveConfig(config, { cwd, bank: resolution?.base ?? resolution?.bank })
    const effective = layers.config
    const server = effectiveServer(effective, {}, { tokenSource: layers.tokenSource })
    const isOptedOut = optedOut(effective, cwd)
    const disabled = server.disabled || isOptedOut
    const expectedOrigin = originOf(server.apiUrl)
    check(
      'server',
      disabled ? 'fail' : 'pass',
      `mode ${server.mode} · ${server.apiUrl}${server.disabled ? ' · disabled in config' : isOptedOut ? ' · optInOnly excludes this directory' : ''}`,
    )

    if (!disabled) {
      let bankStatus = null
      let bankEmpty = false
      let bankFailed = false

      try {
        const health = await request(`${server.apiUrl.replace(/\/+$/, '')}/health`, server.token)
        if (health.status === 200) pass('health', `${server.apiUrl}/health -> 200`)
        else fail('health', `${server.apiUrl}/health -> ${health.status} ${health.body}`)
      } catch (error) {
        fail('health', `${server.apiUrl}/health unreachable: ${error.message}`)
      }

      if (resolution) {
        const bank = resolution.bank
        const url = `${server.apiUrl.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bank)}/pages/tree`
        try {
          const tree = await request(url, server.token)
          bankStatus = tree.status
          if (tree.status === 200) {
            // A reachable bank can still be empty: the daemon creates the bank on
            // the first probe and only sessions that retain memories fill it. An
            // empty tree is reported as a note, not "seeded", so a machine that
            // has never memorised anything is not mistaken for a working memory.
            if (isEmptyPageTree(tree.raw)) {
              bankEmpty = true
              note('bank', `${bank} (${resolution.source}) exists but has no pages yet — sessions will fill it as they retain memory`)
            } else {
              pass('bank', `${bank} (${resolution.source}) is seeded`)
            }
          } else if (tree.status === 404) {
            note('bank', `${bank} (${resolution.source}) is not seeded yet — run one DSH session, then re-run this script`)
          } else {
            bankFailed = true
            fail('bank', `${bank} -> ${tree.status} ${tree.body}`)
          }
        } catch (error) {
          bankFailed = true
          fail('bank', `${bank} unreachable: ${error.message}`)
        }
      } else {
        bankFailed = true
      }

      let tuner = null
      let tunerReadError = null
      try {
        tuner = summarizeTunerJournal({ windowHours: 24 })
      } catch (error) {
        tunerReadError = error
      }

      let injected = 0
      let lastInjectAt = Number.NaN
      try {
        const activity = summarizeActivity({ expectedOrigin, harness: 'dsh' })
        const seen = activity.lastFailure?.endpoint ?? activity.lastEndpoint
        const newest = Date.parse(activity.lastFailure?.ts ?? '')
        const extSucceeded = Date.parse(activity.lastSuccess?.ts ?? '')
        const builtinSucceeded = Date.parse(tuner?.builtin?.lastSuccess?.ts ?? '')
        const succeeded = Math.max(
          Number.isFinite(extSucceeded) ? extSucceeded : -Infinity,
          Number.isFinite(builtinSucceeded) ? builtinSucceeded : -Infinity,
        )
        // lastSuccess counts only server-confirmed work (pages/retain/reflect/recall).
        // A local injection is not recovery: a process still on the old config
        // fails its fetch and then injects its static guide within milliseconds.
        const recovered = Number.isFinite(succeeded) && Number.isFinite(newest) && succeeded > newest
        const daemonStarted = Date.parse(activity.lastDaemonStart?.ts ?? '')
        const restartedAfterFailure = Number.isFinite(daemonStarted) && Number.isFinite(newest) && daemonStarted > newest
        const seenOrigin = seen ? originOf(seen) : null
        if (seenOrigin && seenOrigin !== expectedOrigin && !recovered) {
          const recent = Number.isFinite(newest) && Date.now() - newest <= STALE_MS
          if (recent) {
            fail(
              'stale',
              `the newest journal failure targets ${seenOrigin} but the config points at ${expectedOrigin}: the running process loaded the old config (restart DSH). ${activity.foreignFailures} failures to another server in the window.`,
            )
          } else {
            note('stale', `${activity.foreignFailures} historical failures to another server, none in the last 15 minutes`)
          }
        } else if (activity.foreignFailures > 0) {
          note(
            'stale',
            recovered
              ? `newer DSH success recorded after earlier failures to another server (${activity.foreignFailures} in window)`
              : `${activity.foreignFailures} historical failures to another server; newest failure matches the configured server`,
          )
        } else {
          pass('stale', 'no failures against a different server in the journal window')
        }

        const recent = activity.recent ?? {}
        const extInjected = recent.inject_ok ?? 0
        const builtinInjected = tuner?.builtin?.injected ?? 0
        injected = extInjected + builtinInjected
        const extInjectAt = activity.lastInject?.ts ? Date.parse(activity.lastInject.ts) : Number.NaN
        const builtinInjectAt = tuner?.builtin?.lastInject?.ts ? Date.parse(tuner.builtin.lastInject.ts) : Number.NaN
        lastInjectAt = Math.max(
          Number.isFinite(extInjectAt) ? extInjectAt : -Infinity,
          Number.isFinite(builtinInjectAt) ? builtinInjectAt : -Infinity,
        )
        if (!Number.isFinite(lastInjectAt) || lastInjectAt === -Infinity) lastInjectAt = Number.NaN
        const realRecallOk = (recent.pages_ok ?? 0) + (recent.reflect_ok ?? 0) + (recent.recall_ok ?? 0) + (recent.inject_pages ?? 0)
          + (tuner?.builtin?.pagesOk ?? 0) + (tuner?.builtin?.recallOk ?? 0) + (tuner?.builtin?.reflectOk ?? 0)
        const recallFailures = (recent.pages_failed ?? 0) + (recent.reflect_failed ?? 0) + (recent.recall_failed ?? 0)
          + (activity.authFailures ?? 0) + (tuner?.builtin?.errors ?? 0)
        const onlyStaticGuide = extInjected > 0 && builtinInjected === 0 && (
          bankStatus === 401
          || bankStatus === 403
          || (realRecallOk === 0 && (recallFailures > 0 || bankFailed))
        )
        // An unseeded or empty bank is the documented cold state (see "Verifying
        // a restart" in the README): the integration injects its static guide, so
        // there is no project memory yet and recall is reported as a NOTE. A
        // 401/403 is never explained that way — that is a token/config problem
        // and stays a failure.
        const unseeded = (bankStatus === 404 || bankEmpty) && realRecallOk === 0 && (activity.authFailures ?? 0) === 0

        if (injected > 0) {
          if (unseeded) {
            const stateText = bankStatus === 404 ? 'bank is not seeded yet' : 'bank has no pages yet'
            note('recall', `${injected} inject_ok event(s) recorded, but ${stateText} (static guide only) · ${diagPath()}`)
          } else if (onlyStaticGuide) {
            if (restartedAfterFailure) {
              note('recall', `${injected} inject_ok event(s) predate a daemon restart — no DSH turn has run since; start one session to confirm live recall · ${diagPath()}`)
            } else {
              fail('recall', `${injected} inject_ok event(s) in journal, but server recall/pages failed (static tool guide only, no project memory) · ${diagPath()}`)
            }
          } else if (builtinInjected > 0 && extInjected === 0) {
            pass('recall', `${builtinInjected} successful built-in recall(s) in the window · ${tuner.path}`)
          } else {
            pass('recall', `${injected} successful recall(s) from the DSH harness in the window · ${diagPath()}`)
          }
        } else {
          note('recall', `no successful recall from the DSH harness yet in the window · ${diagPath()} (start a session first)`)
        }
      } catch (error) {
        fail('journal', `could not read ${diagPath()}: ${error.message}`)
      }

      try {
        if (tunerReadError) throw tunerReadError
        const state = tunerState()
        const governed = tuner.tierSelected + tuner.capped + tuner.skipped + tuner.deltas + tuner.reentered + tuner.viewed
        // state.json only proves a tuner profile exists; it can be edited or
        // written by an earlier session, so it must not stand in for tune
        // activity inside the journal window (that masked "auto-tune never ran").
        const tuneRan = tuner.tuneApplied > 0 || tuner.tuneRequested > 0 || tuner.tuneSkipped > 0
        const activatedAt = tuner.lastActivated?.ts ? Date.parse(tuner.lastActivated.ts) : Number.NaN
        const injectSinceActivated = injected > 0 && (!Number.isFinite(activatedAt) || (Number.isFinite(lastInjectAt) && lastInjectAt >= activatedAt))
        const expectsTierEvents = tuner.lastActivated?.cap !== 0
          && (tuner.lastActivated?.budgetPolicy === 'adaptive' || tuner.lastActivated?.budgetPolicy === 'scenario')

        if (tuner.tuneErrorActive) {
          fail('tuner', `auto-tune failed (${tuner.tuneFailed}x): ${tuner.lastTuneError ?? 'unknown error'} · ${tuner.path}`)
        } else if (!tuner.exists && !state.exists) {
          note('tuner', `no tuner state or journal yet · ${tuner.path} (open a DSH session with dsh-hindsight-tuner enabled)`)
        } else if (tuner.activated > 0 && tuner.lastActivated?.autoTune === true && !tuneRan && injectSinceActivated) {
          const stateNote = state.exists
            ? `only ${state.path} exists, no tune events`
            : `no ${state.path}`
          fail('tuner', `plugin activated with autoTune=true, but auto-tune never ran (${injected} DSH inject_ok, 0 tune events, ${stateNote})`)
        } else if (tuner.activated > 0 && expectsTierEvents && injectSinceActivated && governed === 0) {
          fail('tuner', `plugin activated (budgetPolicy=${tuner.lastActivated.budgetPolicy}), DSH injected after activation, but 0 governed events reached tuner (hook order or lifecycle mismatch)`)
        } else if (governed > 0 || tuneRan) {
          const parts = []
          if (governed > 0) parts.push(`${governed} governed event(s) (${tuner.tierSelected} tiered · ${tuner.capped} capped · ${tuner.skipped} skipped)`)
          else if (tuner.activated > 0) parts.push(`activated (${tuner.activated}x)`)
          if (state.exists) parts.push(`state.json (${state.applied.length} applied)`)
          else if (tuner.tuneApplied > 0 || tuner.tuneRequested > 0) parts.push(`${tuner.tuneApplied + tuner.tuneRequested} tune run(s)`)
          pass('tuner', `${parts.join(' · ')} · ${tuner.path}`)
        } else {
          note('tuner', `activated (${tuner.activated}x), waiting for first DSH session or injection · ${tuner.path}`)
        }
      } catch (error) {
        fail('tuner', `could not read tuner state: ${error.message}`)
      }
    } else if (isOptedOut) {
      note('opt-in', 'this directory is opted out of memory; the integration will not inject here')
    }
  }

  const failed = results.filter((result) => result.status === 'fail')
  const integration = findIntegration()
  const lane = integration.installed && integration.enabled !== false ? 'external' : 'builtin'
  if (json) {
    console.log(JSON.stringify({ cwd, repo, lane, passed: failed.length === 0, results }, null, 2))
  } else {
    const mark = { pass: 'PASS', note: 'NOTE', fail: 'FAIL' }
    for (const result of results) console.log(`${mark[result.status].padEnd(5)} ${result.name.padEnd(8)} ${result.detail}`)
    console.log(`${failed.length === 0 ? 'verify: all checks passed' : `verify: ${failed.length} check(s) failed`}`)
  }
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`verify: ${error.message}`)
  process.exitCode = 1
})
