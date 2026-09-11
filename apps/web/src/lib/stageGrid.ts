/**
 * How big each face should be, and how many across.
 *
 * The stage laid itself out with `repeat(auto-fit, minmax(300px, 1fr))` and
 * packed the rows at the top. Three people in a window a thousand pixels wide
 * got three tiles of about three hundred - each a hundred and eighty tall,
 * because a tile keeps 16:9 - and the remaining seven hundred pixels of the
 * pane stayed empty. Reported with a picture of exactly that: three small
 * faces along the top, a screen share the size of a postage stamp, and more
 * than half the window showing nothing at all.
 *
 * The reason it cannot be fixed in the stylesheet alone is that the answer
 * depends on two things CSS will not let a grid consider together: how many
 * people are in the call, and how tall the box is. A column count that is
 * right for four people in a wide window is wrong for two in a short one.
 *
 * So it is worked out here, from the box and the count, and it is a pure
 * function of both - which is the only reason it can be tested at all. Given
 * a size and a number of faces it says how many columns to use and how large
 * each tile may be; the component measures the box and applies it.
 */

export type Grid = {
  /** How many across. */
  columns: number
  /** And how many down, which follows. */
  rows: number
  /** The size of one tile, in pixels. */
  width: number
  height: number
}

/** Nothing to lay out. */
const NONE: Grid = { columns: 1, rows: 0, width: 0, height: 0 }

/**
 * The arrangement that makes each face as large as it can be.
 *
 * Every column count from one to "one each" is tried and the biggest tile
 * wins. That sounds expensive and is not: a call has a handful of people in
 * it, so this is a loop of about eight, run when the window changes size.
 *
 * Both directions are considered for each: a row of wide tiles can be limited
 * by the width, and a column of them by the height, and which one binds
 * changes with the shape of the window. Taking the smaller of the two answers
 * is what stops a tile overflowing the box it is in - which matters more than
 * it sounds, because a tile that keeps its aspect ratio while overflowing
 * lies invisibly across the controls underneath it.
 */
export function bestGrid({ count, width, height, gap = 12, ratio = 16 / 9 }: {
  count: number
  width: number
  height: number
  gap?: number
  ratio?: number
}): Grid {
  if (count <= 0 || width <= 0 || height <= 0) return NONE

  let best: Grid = NONE
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)

    /* As wide as the columns allow... */
    const byWidth = (width - gap * (columns - 1)) / columns
    /* ...and as wide as the rows allow, which is a height turned sideways. */
    const byHeight = ((height - gap * (rows - 1)) / rows) * ratio

    const w = Math.min(byWidth, byHeight)
    if (w <= 0) continue
    const h = w / ratio
    /* Compared by area rather than by width: two columns of squat tiles can
       be wider and still show less of somebody than three taller ones. */
    if (w * h > best.width * best.height) {
      best = { columns, rows, width: w, height: h }
    }
  }
  return best
}
