/**
 * retryPolicy.js — pure functions implementing §25's bounded exponential
 * backoff: "5 sec, 15 sec, 30 sec, 1 min, 5 min", then BLOCKED. No infinite
 * retries, ever — this is the whole point of the schedule being finite.
 */
const BACKOFF_SCHEDULE_MS = [5_000, 15_000, 30_000, 60_000, 300_000]
const MAX_RETRIES = BACKOFF_SCHEDULE_MS.length

/**
 * Given how many retries a sync event has already had, decides what happens
 * next: another scheduled attempt (FAILED, with a nextAttemptAt), or giving
 * up for good (BLOCKED — §25: "create an incident, do not continuously
 * hammer the server").
 */
function nextAttempt(retryCount, now = new Date()) {
  if (retryCount >= MAX_RETRIES) {
    return { status: 'BLOCKED', nextAttemptAt: null }
  }
  const delayMs = BACKOFF_SCHEDULE_MS[retryCount]
  return { status: 'FAILED', nextAttemptAt: new Date(now.getTime() + delayMs) }
}

/**
 * Retry-storm detection (§25/§27): an abnormal burst of attempts in a short
 * window is itself an anomaly signal, independent of any single attempt's
 * outcome — e.g. a client stuck in a PENDING -> SYNCING -> FAILED -> retry
 * loop tighter than the schedule above should allow.
 */
function isRetryStorm(attemptTimestamps, { windowMs = 60_000, threshold = 8 } = {}) {
  const cutoff = Date.now() - windowMs
  const recent = attemptTimestamps.filter((t) => t.getTime() >= cutoff)
  return recent.length > threshold
}

module.exports = { BACKOFF_SCHEDULE_MS, MAX_RETRIES, nextAttempt, isRetryStorm }
