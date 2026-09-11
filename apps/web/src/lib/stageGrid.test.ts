import { describe, expect, it } from 'vitest'
import { bestGrid } from './stageGrid'

/**
 * How big each face should be, and how many across.
 *
 * The reported case first, because it is the whole reason this exists: three
 * people in a stage about a thousand pixels wide and eight hundred tall used
 * a fifth of it, and the rest of the window showed nothing.
 */

/* The pane from the screenshot, near enough: 1075 wide, and the body between
   the header and the controls is about 800 tall. */
const PANE = { width: 1043, height: 800 }

describe('three people on a stage', () => {
  it('fills the height instead of sitting in a strip along the top', () => {
    const grid = bestGrid({ count: 3, ...PANE })
    const used = (grid.rows * grid.height + 12 * (grid.rows - 1)) / PANE.height

    /*
     * What it used to do: three across, each about 340 by 190, in one row -
     * a quarter of the height, with six hundred pixels of nothing underneath.
     * Measured as the share of the pane it covers, because "the space is
     * wasted" is what was reported and a share is what that means.
     *
     * It comes out two across and two down, at 515 by 290, using about three
     * quarters of the height. Two columns beat three because a tile keeps
     * 16:9: three across is limited by the width and stays short, where two
     * across can be half again as tall.
     */
    expect(used, 'the stage is still mostly empty').toBeGreaterThan(0.6)
    expect(grid.height).toBeGreaterThan(250)
  })

  it('and nothing falls outside the box it was given', () => {
    const grid = bestGrid({ count: 3, ...PANE })
    const used = grid.rows * grid.height + 12 * (grid.rows - 1)
    const across = grid.columns * grid.width + 12 * (grid.columns - 1)
    expect(used).toBeLessThanOrEqual(PANE.height + 0.5)
    expect(across).toBeLessThanOrEqual(PANE.width + 0.5)
  })

  it('and the tiles keep their shape', () => {
    const grid = bestGrid({ count: 3, ...PANE })
    expect(grid.width / grid.height).toBeCloseTo(16 / 9, 5)
  })
})

describe('however many there are', () => {
  it('gives one person the whole stage', () => {
    const grid = bestGrid({ count: 1, ...PANE })
    expect(grid.columns).toBe(1)
    expect(grid.rows).toBe(1)
  })

  /* Every count has to fit: a tile larger than its share is one that lies
     across whatever is underneath it, which on this stage is the controls. */
  it('and never overflows, at any size anybody will have', () => {
    for (let count = 1; count <= 16; count++) {
      const grid = bestGrid({ count, ...PANE })
      const down = grid.rows * grid.height + 12 * (grid.rows - 1)
      const across = grid.columns * grid.width + 12 * (grid.columns - 1)
      expect(down, `${count} faces run off the bottom`).toBeLessThanOrEqual(PANE.height + 0.5)
      expect(across, `${count} faces run off the side`).toBeLessThanOrEqual(PANE.width + 0.5)
      expect(grid.columns * grid.rows, `${count} faces do not fit`).toBeGreaterThanOrEqual(count)
    }
  })

  /* More people means smaller faces, which is the only honest direction. */
  it('and each one is smaller than the last', () => {
    let last = Infinity
    for (let count = 1; count <= 10; count++) {
      const grid = bestGrid({ count, ...PANE })
      expect(grid.width, `${count} faces got bigger`).toBeLessThanOrEqual(last + 0.5)
      last = grid.width
    }
  })
})

describe('odd shapes', () => {
  it('stacks them when the window is tall and narrow', () => {
    const grid = bestGrid({ count: 2, width: 400, height: 900 })
    expect(grid.columns).toBe(1)
    expect(grid.rows).toBe(2)
  })

  it('and puts them side by side when it is short and wide', () => {
    const grid = bestGrid({ count: 2, width: 1600, height: 300 })
    expect(grid.columns).toBe(2)
    expect(grid.rows).toBe(1)
  })

  /* A pane can be measured at nothing for a frame, while it is being opened
     or while the window is minimised. It must not answer with a negative
     tile, which lays out as an element the browser will not draw. */
  it('and says nothing for a box with no size', () => {
    for (const box of [{ width: 0, height: 0 }, { width: 500, height: 0 }, { width: 0, height: 500 }]) {
      const grid = bestGrid({ count: 3, ...box })
      expect(grid.width).toBe(0)
      expect(grid.height).toBe(0)
    }
  })

  it('and for nobody at all', () => {
    expect(bestGrid({ count: 0, ...PANE }).rows).toBe(0)
  })

  /* A gap of nothing is a legitimate ask and must not divide by anything. */
  it('and copes with no gap between them', () => {
    const grid = bestGrid({ count: 4, ...PANE, gap: 0 })
    expect(grid.columns * grid.width).toBeLessThanOrEqual(PANE.width + 0.5)
    expect(grid.rows * grid.height).toBeLessThanOrEqual(PANE.height + 0.5)
  })
})
