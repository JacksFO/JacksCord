/**
 * Whether an uncaught error is one this server can carry on after.
 *
 * The policy above it is sound and stays: something thrown from the middle of
 * a request has left state nobody can describe, so the honest thing is to
 * stand down and let a clean one start. The cost of that is not small - it
 * drops every open socket, which means everybody in a voice call - but a
 * server limping along in an unknown state is worse.
 *
 * A dropped connection is not that. It says one socket went away, which is a
 * thing sockets do: a CDN hanging up in the middle of sending a picture
 * somebody linked, a phone going through a tunnel, a laptop lid closing. The
 * state afterwards is completely known - that request is over - and the only
 * reason it ever reached this handler is that the error arrived as an event
 * on a stream rather than as a rejected promise, which is a detail of how
 * node reports it rather than anything about how bad it is.
 *
 * It took the whole server down on 11 September: a remote host reset a
 * connection during an outbound fetch, and everybody was disconnected for the
 * two minutes it took the watchdog to notice. The link somebody posted had
 * nothing to do with this app.
 *
 * Deliberately a list of network conditions rather than "anything with a
 * code". A programming mistake with a `code` property on it should still
 * bring the server down, because that one really has left state nobody can
 * describe.
 */

/** Conditions that mean a connection ended, and nothing else. */
const NETWORK = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
])

/**
 * And the ones node reports by wording rather than by code.
 *
 * `aborted` is what a response is destroyed with when the socket closes
 * before the body is finished; `socket hang up` is the same event a moment
 * earlier, before any response arrived.
 */
const WORDING = new Set(['aborted', 'socket hang up'])

export function survivable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (typeof code === 'string' && NETWORK.has(code)) return true
  return typeof message === 'string' && WORDING.has(message)
}
