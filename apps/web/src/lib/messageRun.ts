/**
 * Whether a message joins the one above it, or stands on its own.
 *
 * A run of messages from one person is drawn as one block: the first carries
 * the avatar, the name and the time, and the rest are just lines underneath.
 * That is right for somebody typing three sentences in a row, and wrong the
 * moment there is a gap - because the only timestamp on the block is the one
 * at the top, so a message sent hours later reads as having been sent then.
 *
 * Reported exactly that way: a message at 3am, nothing in between, and a
 * message at 12:35pm the next lunchtime joined onto it as though it were part
 * of the same breath. Both were on the same day, and a new day was the only
 * thing about time that broke a run.
 *
 * Its own file, and pure, because "is this the same run" is a rule rather
 * than a detail of drawing - and a rule with a clock in it is worth being
 * able to test at a chosen moment rather than at whatever time the suite
 * happens to run.
 */

/**
 * How long a quiet gap has to be before the next message stands on its own.
 *
 * Five minutes, which is what was asked for. Discord uses about seven. The
 * exact number matters less than there being one: the cost of being slightly
 * too eager is a name repeated, and the cost of having none at all is a
 * timestamp that lies.
 */
export const RUN_GAP_MS = 5 * 60_000

/** The little a run needs to know about a message. */
export type InRun = {
  author_id: string
  created_at: number
  /** Present when this message answers another. */
  reply_to?: unknown
}

/**
 * Whether `m` carries on from `prev`.
 *
 * The order is the order it reads in: a new day, a different person, an
 * answer to somebody, and then the gap. The first three were already the
 * rule; the last is the one that was missing.
 */
export function joinsRun(
  prev: InRun | null | undefined,
  m: InRun,
  newDay: boolean,
  gap = RUN_GAP_MS,
): boolean {
  if (newDay) return false
  if (!prev || prev.author_id !== m.author_id) return false
  /* An answer is addressed to somebody, so it is worth seeing who is speaking
     again even when it is the same person twice. */
  if (m.reply_to) return false
  /*
   * Clocks are not promised to move forwards here. Two messages can arrive
   * with the same stamp, and a stamp slightly behind the one before it is a
   * server whose clock stepped - neither is a reason to break a block, so the
   * distance is what counts rather than the direction.
   */
  return Math.abs(m.created_at - prev.created_at) <= gap
}
