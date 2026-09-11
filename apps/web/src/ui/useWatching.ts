import { useEffect, useState } from 'react'
import { isWatching, onAttentionChange } from '../lib/attention'

/**
 * Whether anybody is looking at this window, as something to draw from.
 *
 * attention.ts already answers this and already tells anybody who asks. The
 * three lines that turn "tell me when it changes" into "re-draw when it
 * changes" had been written out twice before this, and the places that
 * needed it third and fourth did not have them - which is the shape of every
 * half-applied setting in this app.
 *
 * The attribute on the root element covers anything CSS can do on its own.
 * This is for the rest: a video that has to be told to stop, or a word that
 * should not change while nobody is there to read it changing.
 */
export function useWatching(): boolean {
  const [watching, setWatching] = useState(() => isWatching())
  useEffect(() => onAttentionChange(setWatching), [])
  return watching
}
