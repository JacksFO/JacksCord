import type { StreamKey } from './call'

/**
 * How loud each person is, kept between calls.
 *
 * Turning somebody's screen share down is a decision about that person, and
 * it lasted until the call ended - so the friend whose game is always twice
 * as loud as everybody else had to be turned down again every single time.
 * Reported exactly that way.
 *
 * On the machine rather than on the account, for the same reason the panel
 * widths and the hidden-muted servers are: it is a fact about the speakers
 * somebody is listening through, not about who they are. The same person on
 * a laptop in a quiet room wants something different from the same person at
 * a desk with a subwoofer under it.
 *
 * Keyed by StreamKey, which already carries both who and which sound of
 * theirs - so a game turned down does not take the person describing it with
 * it, which is the whole reason those are separate in the first place.
 */

const WHERE = 'atrium.levels'

/** Anything outside this is not a volume, whatever the file says. */
const sane = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100

/**
 * What was remembered, or nothing.
 *
 * Never throws and never returns junk: this runs on the way into a call, and
 * a stored value somebody has hand-edited - or a private window that refuses
 * storage altogether - must not be the reason a call fails to open.
 */
export function rememberedLevels(): Map<StreamKey, number> {
  const out = new Map<StreamKey, number>()
  try {
    const raw = localStorage.getItem(WHERE)
    if (!raw) return out
    const held = JSON.parse(raw) as unknown
    if (!held || typeof held !== 'object') return out
    for (const [key, value] of Object.entries(held as Record<string, unknown>)) {
      if (sane(value)) out.set(key as StreamKey, value)
    }
  } catch {
    /* Unreadable, unparseable, or refused. Everybody starts at their usual
       volume, which is where they were before this existed. */
  }
  return out
}

/**
 * Write one down.
 *
 * The whole map each time rather than an append, because it is a handful of
 * numbers and reading it back is the only way to keep a second window from
 * dropping what the first one set.
 */
export function rememberLevel(key: StreamKey, level: number): void {
  if (!sane(level)) return
  try {
    const held: Record<string, number> = {}
    for (const [k, v] of rememberedLevels()) held[k] = v
    held[key] = level
    localStorage.setItem(WHERE, JSON.stringify(held))
  } catch {
    /* A full or refused store. The level still applies for this call; it
       simply will not be there next time. */
  }
}
