/**
 * Bounded, condition-based waiting for the suites.
 *
 * Auto-tune and journal work runs off the event that triggered it, so a fixed
 * `setTimeout` is both slower than necessary and flaky on a loaded machine: it
 * either waits after the write already happened or wakes too early. Polling the
 * condition returns on the first attempt when the work is synchronous and gives
 * asynchronous work a bounded window instead of a guessed one.
 */
export async function waitFor(predicate, { attempts = 100, delay = 10, label = 'condition' } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await predicate()) return
    } catch (error) {
      // A predicate that reads a file or parses JSON that is not there yet is
      // simply reporting "not ready", not a test failure.
      lastError = error
    }
    await new Promise((done) => setTimeout(done, delay))
  }
  const detail = lastError ? ` (last error: ${lastError.message})` : ''
  throw new Error(`waitFor: ${label} did not become true within ${attempts} attempts${detail}`)
}
