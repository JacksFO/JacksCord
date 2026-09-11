import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

/**
 * Taking the room out of somebody's microphone.
 *
 * Reported twice in one sitting: a keyboard audible under somebody talking,
 * and a fan that arrived as air brushing across the mic. Noise suppression
 * was already on - it has been on by default all along - and that is the
 * problem rather than the oversight. The browser's own is tuned to pull
 * speech out of hiss, and a keyboard is neither: it is short, broad and loud,
 * so it goes straight through. A fan is steady enough that the browser treats
 * it as part of the room and leaves it.
 *
 * RNNoise is a small recurrent network trained on exactly this, and it runs
 * here rather than anywhere else: a hundred and fifty kilobytes of WebAssembly
 * on each person's own machine, in an audio worklet, on the way out. Nothing
 * is sent anywhere to be cleaned and nothing is paid for by the minute, which
 * rules it in at ten people and at a hundred alike - the cost is the same
 * either way, because it is not our cost.
 *
 * Attached to the track LiveKit already publishes rather than replacing the
 * capture path. Muting, switching device, changing quality and everything
 * else keeps working because none of it is touched.
 */

/** What RNNoise was trained at. Anything else and it is the wrong network. */
const WANTS_HZ = 48_000

/** Loaded once and kept: the same bytes serve every call in a session. */
let binary: ArrayBuffer | null = null
let addedModule: AudioContext | null = null

/**
 * A LiveKit audio processor, or nothing.
 *
 * Deliberately shaped so that every way this can fail ends with the plain
 * microphone being published. A denoiser that does not load is a quiet
 * disappointment; a denoiser that takes somebody's voice away with it is an
 * app that cannot be used to talk to people, and only one of those is worth
 * risking on a feature nobody asked to depend on.
 */
export function rnnoise() {
  let node: RnnoiseWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let sink: MediaStreamAudioDestinationNode | null = null

  /*
   * Typed with the property optional rather than "possibly undefined": this
   * is handed to LiveKit, which asks for one that may be absent, and absent
   * and present-but-undefined are different things to this compiler.
   */
  const processor: {
    name: string
    processedTrack?: MediaStreamTrack
    init(opts: { track: MediaStreamTrack; audioContext: AudioContext }): Promise<void>
    restart(opts: { track: MediaStreamTrack; audioContext: AudioContext }): Promise<void>
    destroy(): Promise<void>
  } = {
    name: 'rnnoise',

    async init(opts: { track: MediaStreamTrack; audioContext: AudioContext }) {
      const ctx = opts.audioContext
      /*
       * The wrong sample rate is not a smaller improvement, it is a network
       * being fed something it has never heard - so this stands aside rather
       * than processing badly. Rare on a desktop, where 48k is the default.
       */
      if (ctx.sampleRate !== WANTS_HZ) {
        throw new Error(`rnnoise wants ${WANTS_HZ}Hz, this context is ${ctx.sampleRate}Hz`)
      }

      if (!binary) binary = await loadRnnoise({ url: wasmUrl, simdUrl })
      /* Registered per context, not per call: adding the same module twice
         to one context throws, and a context outlives a call. */
      if (addedModule !== ctx) {
        await ctx.audioWorklet.addModule(workletUrl)
        addedModule = ctx
      }

      source = ctx.createMediaStreamSource(new MediaStream([opts.track]))
      node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary })
      sink = ctx.createMediaStreamDestination()
      source.connect(node).connect(sink)

      const out = sink.stream.getAudioTracks()[0]
      if (!out) throw new Error('rnnoise produced no track')
      processor.processedTrack = out
    },

    async restart(opts: { track: MediaStreamTrack; audioContext: AudioContext }) {
      await processor.destroy()
      await processor.init(opts)
    },

    async destroy() {
      /* Each on its own, because one of them having already gone is not a
         reason to leave the others connected. */
      try { source?.disconnect() } catch { /* already gone */ }
      try { node?.disconnect() } catch { /* already gone */ }
      try { node?.destroy() } catch { /* already gone */ }
      try { sink?.disconnect() } catch { /* already gone */ }
      source = null; node = null; sink = null
      delete processor.processedTrack
    },
  }

  return processor
}
