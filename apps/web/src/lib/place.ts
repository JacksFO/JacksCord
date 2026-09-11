import type { Id, Space } from './wire'

/**
 * Where the app opens: where you were, and Home the first time.
 *
 * It used to open on `spaces[0]` - not where you were last, the first tile in
 * the rail - so the same server opened every launch whatever you had been
 * doing. Reported as "it always opens at Basement", which is exactly what it
 * did, and it was not even trying to do otherwise.
 *
 * Straight to Home was the first answer and it is the wrong shape: somebody
 * who was mid-conversation in a server last night wants that server, and
 * being sent to Home every morning is the same disregard in the other
 * direction. What was actually wrong is that it ignored you. So it remembers.
 *
 * Home is the first run, which is the moment it matters: a new account has no
 * servers and nothing to go back to. And Home is a place like any other, so
 * somebody who likes opening there only has to be there when they close it.
 *
 * The harm in the old behaviour was worse than untidiness, and it is gone
 * either way: opening a channel marks it read, so landing in one on launch
 * cleared what was waiting there before anybody had looked at it.
 */

/** One of the two things the rail can be pointing at. */
export type Place = { kind: 'space'; id: Id } | { kind: 'dms' }

/** And which full-window page is over it, if any. */
export type Screen = { where: Place; page: 'home' | 'friends' | null }

const WHERE = 'atrium.where'

/** Home, for an account that has never been anywhere. */
export const FIRST_RUN: Screen = { where: { kind: 'dms' }, page: 'home' }

function sane(held: unknown): Screen | null {
  if (!held || typeof held !== 'object') return null
  const { where, page } = held as { where?: unknown; page?: unknown }
  if (!where || typeof where !== 'object') return null
  const { kind, id } = where as { kind?: unknown; id?: unknown }
  const onPage = page === 'home' || page === 'friends' ? page : null
  if (kind === 'dms') return { where: { kind: 'dms' }, page: onPage }
  if (kind === 'space' && typeof id === 'string' && id) {
    /* A page is a thing over the conversations list; it never sits over a
       server, so remembering one there would draw Home on top of it. */
    return { where: { kind: 'space', id }, page: null }
  }
  return null
}

/**
 * Where to open, given what is actually there now.
 *
 * The list of servers is asked rather than trusted: somebody can be removed
 * from a server, or leave one, between closing the app and opening it - and
 * a rail pointing at a server that is not in it shows an empty middle with
 * nothing to click.
 */
export function openingScreen(spaces: readonly Space[]): Screen {
  let held: Screen | null = null
  try {
    const raw = localStorage.getItem(WHERE)
    held = raw ? sane(JSON.parse(raw) as unknown) : null
  } catch {
    /* Unreadable or refused. Home, which is where a first run goes. */
  }
  if (!held) return FIRST_RUN
  /* Pulled out so the narrowing survives the closure below - inside it, the
     compiler can no longer promise `held` is still the same thing. */
  const at = held.where
  if (at.kind === 'space' && !spaces.some((s) => s.id === at.id)) return FIRST_RUN
  return held
}

/** Written down as it changes, so the next launch has somewhere to go. */
export function rememberScreen(screen: Screen): void {
  try {
    localStorage.setItem(WHERE, JSON.stringify(screen))
  } catch {
    /* A full or refused store. It opens on Home next time, which is the
       same answer it gave before any of this existed. */
  }
}
