import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberedLevels, rememberLevel } from './levels'
import { emptyCall, keyOf, volumeOf } from './call'

/**
 * How loud each person is, kept between calls.
 *
 * Turning somebody's screen share down lasted until the call ended, so the
 * friend whose game is always twice as loud as everybody else had to be
 * turned down again every time. Reported exactly that way.
 */

beforeEach(() => { localStorage.clear() })

describe('remembering how loud somebody is', () => {
  const share = keyOf('share', 'bailey')
  const voice = keyOf('voice', 'bailey')

  it('has nothing to say to begin with', () => {
    expect(rememberedLevels().size).toBe(0)
  })

  it('and keeps what it was told', () => {
    rememberLevel(share, 40)
    expect(rememberedLevels().get(share)).toBe(40)
  })

  /* The one that was reported: it has to survive the call ending, which is
     what building a fresh call does. */
  it('and a new call starts with it already applied', () => {
    rememberLevel(share, 40)
    expect(volumeOf(emptyCall(), share, 100)).toBeCloseTo(0.4)
  })

  it('and without it, a share is still full volume', () => {
    expect(volumeOf(emptyCall(), share, 100)).toBe(1)
  })

  /*
   * A game turned down must not take the person describing it with it. That
   * is the whole reason a person's voice and their screen are different keys,
   * so it is worth a test rather than an assumption.
   */
  it('and turning a screen down leaves the voice alone', () => {
    rememberLevel(share, 20)
    const call = emptyCall()
    expect(volumeOf(call, share, 100)).toBeCloseTo(0.2)
    expect(volumeOf(call, voice, 100)).toBe(1)
  })

  it('and one person does not set another', () => {
    rememberLevel(share, 20)
    expect(rememberedLevels().get(keyOf('share', 'keeko'))).toBeUndefined()
  })

  it('and the last word wins', () => {
    rememberLevel(share, 20)
    rememberLevel(share, 75)
    expect(rememberedLevels().get(share)).toBe(75)
  })
})

/**
 * And it cannot be the reason a call fails to open.
 *
 * This runs on the way in. A store somebody has hand-edited, or a private
 * window that refuses storage outright, has to end with everybody at their
 * usual volume rather than with an exception.
 */
describe('when the store is unusable', () => {
  it('shrugs off something that is not JSON', () => {
    localStorage.setItem('atrium.levels', 'not json at all')
    expect(() => rememberedLevels()).not.toThrow()
    expect(rememberedLevels().size).toBe(0)
  })

  it('and something that is JSON but not a map of numbers', () => {
    localStorage.setItem('atrium.levels', '["a","b"]')
    expect(rememberedLevels().size).toBe(0)
  })

  /* Values out of range are dropped rather than clamped: a number that
     cannot have come from the slider is a file to distrust, not to repair. */
  it('and drops values that could not have come from the slider', () => {
    localStorage.setItem('atrium.levels', JSON.stringify({
      'share:a': 250, 'share:b': -5, 'share:c': null, 'share:d': 'loud', 'share:e': 60,
    }))
    const held = rememberedLevels()
    expect(held.size).toBe(1)
    expect(held.get('share:e' as never)).toBe(60)
  })

  it('and a store that refuses to be read', () => {
    const boom = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('refused')
    })
    expect(() => rememberedLevels()).not.toThrow()
    expect(rememberedLevels().size).toBe(0)
    boom.mockRestore()
  })

  it('and a store that refuses to be written', () => {
    const boom = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(() => rememberLevel(keyOf('share', 'bailey'), 30)).not.toThrow()
    boom.mockRestore()
  })
})
