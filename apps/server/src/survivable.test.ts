import { describe, expect, it } from 'vitest'
import { survivable } from './survivable.js'

/**
 * Which uncaught errors the server carries on after.
 *
 * The one that happened: a remote host reset a connection in the middle of an
 * outbound fetch - a picture somebody had linked - and the server stood down,
 * dropping every socket including the voice calls, for the two minutes the
 * watchdog took to notice.
 *
 * The line has to be drawn narrowly in both directions, which is why this
 * tests the refusals as carefully as the allowances: too narrow and the
 * outage happens again, too wide and a real fault is swallowed by a server
 * that carries on in a state nobody can describe.
 */

describe('a connection ending', () => {
  /* Exactly what was in the log on 11 September. */
  it('is survivable: the one that took the server down', () => {
    const err = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
    expect(survivable(err)).toBe(true)
  })

  it('and by code alone', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND']) {
      expect(survivable(Object.assign(new Error('x'), { code })), code).toBe(true)
    }
  })

  /* Node reports the same event by wording when it has no code to give. */
  it('and by wording alone', () => {
    expect(survivable(new Error('aborted'))).toBe(true)
    expect(survivable(new Error('socket hang up'))).toBe(true)
  })
})

describe('and everything else still stands the server down', () => {
  it('an ordinary programming mistake', () => {
    expect(survivable(new TypeError('x is not a function'))).toBe(false)
  })

  /*
   * The one worth being deliberate about: a fault with a code on it is still
   * a fault. "Anything with a code" would have been a shorter rule and would
   * have swallowed these.
   */
  it('and a fault that merely has a code', () => {
    expect(survivable(Object.assign(new Error('out of space'), { code: 'ENOSPC' })))
      .toBe(false)
    expect(survivable(Object.assign(new Error('no such file'), { code: 'ENOENT' })))
      .toBe(false)
    expect(survivable(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })))
      .toBe(false)
  })

  it('and a message that merely mentions one of the words', () => {
    expect(survivable(new Error('the upload was aborted by the user'))).toBe(false)
  })

  it('and things that are not errors at all', () => {
    expect(survivable(null)).toBe(false)
    expect(survivable(undefined)).toBe(false)
    expect(survivable('ECONNRESET')).toBe(false)
    expect(survivable(42)).toBe(false)
    expect(survivable({})).toBe(false)
  })

  /* A code that is not a string - somebody's object shaped like an error. */
  it('and a code that is not a word', () => {
    expect(survivable({ code: 500 })).toBe(false)
  })
})
