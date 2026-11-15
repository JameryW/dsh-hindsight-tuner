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

import { configPath, readConfigFile } from '../lib/config-file.js'
import {
  bankResolution,
  diagPath,
  effectiveServer,
  optedOut,
  projectName,
  summarizeActivity,
} from '../lib/diagnostics.js'

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
    return new URL(url).origin
  } catch {
    return String(url ?? '').replace(/\/+$/, '')
  }
}

async function request(url, token, timeoutMs = 5000) {
  const headers = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  let body = ''
  try {
    body = (await response.text()).slice(0, 300)
  } catch {
    // The status code is already enough to report.
  }
  return { status: response.status, body }
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
    const server = effectiveServer(config)
    const expectedOrigin = originOf(server.apiUrl)
    check('server', server.disabled ? 'fail' : 'pass', `mode ${server.mode} · ${server.apiUrl}${server.disabled ? ' · disabled in config' : ''}`)

    if (!server.disabled) {
      try {
        const health = await request(`${server.apiUrl.replace(/\/+$/, '')}/health`, server.token)
        if (health.status === 200) pass('health', `${server.apiUrl}/health -> 200`)
        else fail('health', `${server.apiUrl}/health -> ${health.status} ${health.body}`)
      } catch (error) {
        fail('health', `${server.apiUrl}/health unreachable: ${error.message}`)
      }

      let resolution = null
      try {
        resolution = bankResolution(config, repo, cwd)
      } catch (error) {
        fail('bank', `could not resolve the bank: ${error.message}`)
      }
      if (resolution) {
        const bank = resolution.bank
        const url = `${server.apiUrl.replace(/\/+$/, '')}/v1/default/banks/${encodeURIComponent(bank)}/pages/tree`
        try {
          const tree = await request(url, server.token)
          if (tree.status === 200) pass('bank', `${bank} (${resolution.source}) is seeded`)
          else if (tree.status === 404) note('bank', `${bank} (${resolution.source}) is not seeded yet — run one DSH session, then re-run this script`)
          else fail('bank', `${bank} -> ${tree.status} ${tree.body}`)
        } catch (error) {
          fail('bank', `${bank} unreachable: ${error.message}`)
        }
        if (optedOut(config, cwd)) note('opt-in', 'this directory is opted out of memory; the integration will not inject here')
      }

      try {
        const activity = summarizeActivity({ expectedOrigin, harness: 'dsh' })
        if (activity.foreignFailures > 0 && activity.lastFailure) {
          const newest = Date.parse(activity.lastFailure.ts ?? '')
          const recent = Number.isFinite(newest) && Date.now() - newest <= STALE_MS
          if (recent) {
            fail(
              'stale',
              `the newest journal failure targets ${activity.lastEndpoint ?? 'another server'} but the config points at ${expectedOrigin}: the running process loaded the old config (restart DSH). ${activity.foreignFailures} failures to another server in the window.`,
            )
          } else {
            note('stale', `${activity.foreignFailures} historical failures to another server, none in the last 15 minutes`)
          }
        } else {
          pass('stale', 'no failures against a different server in the journal window')
        }
        const injected = activity.recent?.inject_ok ?? 0
        if (injected > 0) pass('recall', `${injected} successful recall(s) from the DSH harness in the window · ${diagPath()}`)
        else note('recall', `no successful recall from the DSH harness yet in the window · ${diagPath()} (start a session first)`)
      } catch (error) {
        fail('journal', `could not read ${diagPath()}: ${error.message}`)
      }
    }
  }

  const failed = results.filter((result) => result.status === 'fail')
  if (json) {
    console.log(JSON.stringify({ cwd, repo, passed: failed.length === 0, results }, null, 2))  } else {
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
