import { describe, expect, it } from 'vitest'
import { joinsRun, RUN_GAP_MS } from './messageRun'

/**
 * Whether a message joins the block above it.
 *
 * The one that was reported: a message at 3am, silence, and a message at
 * 12:35pm joined onto it as though it were part of the same breath. Both were
 * on the same day, and a new day was the only thing about time that broke a
 * run - so the block carried one timestamp, the 3am one, and the lunchtime
 * message read as having been sent then.
 *
 * Times are chosen here rather than taken from the clock, so the test means
 * the same thing at any hour.
 */

const AT = new Date('2026-09-11T03:00:00Z').getTime()
const msg = (over: Partial<Parameters<typeof joinsRun>[1]> = {}) =>
  ({ author_id: 'bailey', created_at: AT, ...over })

describe('a message joining the one above it', () => {
  it('joins when the same person carries straight on', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + 20_000 }), false)).toBe(true)
  })

  it('and does not when somebody else speaks', () => {
    expect(joinsRun(msg(), msg({ author_id: 'jack', created_at: AT + 1000 }), false))
      .toBe(false)
  })

  it('and does not across a new day', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + 1000 }), true)).toBe(false)
  })

  /* An answer is addressed to somebody, so it is worth seeing who is speaking
     again even when it is the same person twice. */
  it('and does not when it answers somebody', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + 1000, reply_to: 'x' }), false))
      .toBe(false)
  })

  it('and does not when there is nothing above it', () => {
    expect(joinsRun(null, msg(), false)).toBe(false)
  })
})

/**
 * And the gap, which is the whole of what was missing.
 */
describe('after a quiet stretch', () => {
  /* The reported case, to the minute: 3am, then 12:35pm the same day. */
  it('stands on its own nine and a half hours later', () => {
    const later = new Date('2026-09-11T12:35:00Z').getTime()
    expect(joinsRun(msg(), msg({ created_at: later }), false)).toBe(false)
  })

  it('and still joins inside the grace period', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + RUN_GAP_MS - 1000 }), false))
      .toBe(true)
  })

  it('and joins right up to the edge of it', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + RUN_GAP_MS }), false)).toBe(true)
  })

  it('but not a moment past it', () => {
    expect(joinsRun(msg(), msg({ created_at: AT + RUN_GAP_MS + 1 }), false))
      .toBe(false)
  })

  /*
   * Clocks are not promised to move forwards. Two messages can carry the same
   * stamp, and one slightly behind the one before it is a server whose clock
   * stepped - neither is a reason to break a block that otherwise belongs
   * together.
   */
  it('and copes with two at the same instant', () => {
    expect(joinsRun(msg(), msg({ created_at: AT }), false)).toBe(true)
  })

  it('and with a stamp that went backwards a little', () => {
    expect(joinsRun(msg(), msg({ created_at: AT - 1500 }), false)).toBe(true)
  })

  it('but a stamp that went a long way backwards still stands apart', () => {
    expect(joinsRun(msg(), msg({ created_at: AT - RUN_GAP_MS - 1 }), false))
      .toBe(false)
  })
})
