import { DEFAULTS } from './settings'

/**
 * Carrying what the browser remembers across the app's change of name.
 *
 * Everything the client keeps between visits was stored under `jackscord.*`.
 * Renaming those constants alone would not rename what is already on
 * somebody's disk - it would simply stop finding it, and the app would forget
 * which server it talks to, that you were in a call a moment ago, where you
 * put the corner window, and that you dismissed the banner. The first of
 * those is the serious one: losing the address is being sent back to the
 * first-run screen for no reason you did.
 *
 * So the values are copied to the new names once, before anything reads them.
 *
 * The old keys are left where they are. They are a few hundred bytes, and
 * anybody whose browser still has a cached copy of the older client can go on
 * using them rather than being signed out by a page they did not ask for.
 */

/** Everything the client keeps, by the part of the name that does not change. */
export const KEPT = [
  'server',
  'token',
  'voice.resume',
  'lastdm',
  'notes.seen',
  'pip',
  'shareQuality',
  'getapp.snoozed',
  'recentEmoji',
  /* Which servers have their muted channels hidden. A view of a screen
     rather than a fact about the person, which is why it is here and not on
     the account - and why it has to be carried like everything else that
     lives on the machine. */
  'hideMuted',
  /* How loud each person is. On the machine rather than the account,
     because it is a fact about the speakers somebody is listening
     through - see levels.ts. */
  'levels',
  /* And where the app was last open. Also a fact about this machine: the
     same account on a laptop and at a desk is not in the same place. */
  'where',
] as const

/** The one that is a whole blob of preferences rather than a single value. */
export const BLOB = 'settings'

/** And the one that is per tab rather than per browser. */
export const PER_TAB = ['session'] as const

function move(store: Storage, name: string): void {
  const from = `jackscord.${name}`
  const to = `atrium.${name}`
  /* Never over the top of something already stored under the new name: the
     new one is what this version has been writing, and the old one is older
     by definition. */
  if (store.getItem(to) !== null) return
  const held = store.getItem(from)
  if (held !== null) store.setItem(to, held)
}

/**
 * Whether a stored blob of preferences is one nobody has touched.
 *
 * Compared field by field rather than as text, because the two were written
 * by different versions: a setting added since would be missing from one of
 * them, and a browser is free to write the keys back in any order it likes.
 */
function untouched(raw: string): boolean {
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>
    const fresh = DEFAULTS as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(stored), ...Object.keys(fresh)])) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(fresh[key])) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The preferences, which are one value holding all of them.
 *
 * This one is taken back even when there is something under the new name,
 * which nothing else is. The first build to use the new names did not carry
 * it: it found nothing, started everyone on the defaults, and wrote those
 * defaults straight back - so by the time this runs the new name is occupied
 * by a blob nobody chose, and refusing to write over it would mean the
 * arrangement, the widths, the theme and every toggle stay lost forever.
 *
 * Only over the untouched defaults, though. Somebody who has since changed a
 * setting on the new build meant that change, and it is newer than anything
 * under the old name.
 */
function reclaim(): void {
  const held = localStorage.getItem(`jackscord.${BLOB}`)
  if (held === null) return
  const now = localStorage.getItem(`atrium.${BLOB}`)
  if (now !== null && !untouched(now)) return
  localStorage.setItem(`atrium.${BLOB}`, held)
}

/**
 * Run once, before anything reads a preference.
 *
 * Best-effort throughout: a private window, a full disk or a browser set to
 * refuse storage all throw, and none of them are worth failing to start over.
 * The cost of it not working is the app looking new again.
 */
export function carryOverPreferences(): void {
  try {
    for (const name of KEPT) move(localStorage, name)
    reclaim()
  } catch { /* no storage; nothing to carry */ }
  try {
    for (const name of PER_TAB) move(sessionStorage, name)
  } catch { /* likewise */ }
}
