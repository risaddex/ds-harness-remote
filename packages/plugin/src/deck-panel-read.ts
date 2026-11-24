import {
  DECK_PANEL_READ_CAPABILITY,
  DECK_PANEL_READ_MAX_REPLY_BYTES,
  DECK_PANEL_READ_OPERATIONS,
  DECK_PANEL_READ_PROBE_TIMEOUT_MS,
  DECK_PANEL_READ_TIMEOUT_MS,
  deckPanelReadParamsSchema,
  type DeckPanelReadFailure,
  type DeckPanelReadHostFailureKind,
  type DeckPanelReadOperation,
  type DeckPanelReadParams,
  type DeckPanelReadReply,
} from '@dsh-remote/protocol'
import type { SafeLogger } from './logging.js'

/**
 * The one Cordis service the DSH skills deck publishes for this Host (`deckPanelRead`).
 * The deck publishes it shortly after start-up, so it is looked up on demand and may be
 * absent, older, or replaced between two calls.
 */
export interface DeckPanelReadServiceLike {
  readonly feature?: unknown
  available(): unknown
  call(operation: DeckPanelReadOperation, params: Record<string, unknown>): unknown
}

/**
 * The relay's own session authority (the one `workspace.git.*` uses): it answers only for sessions this
 * authenticated peer may see. Here it is a gate; the workspace it returns is discarded and never reaches
 * the deck or the phone.
 */
export type DeckPanelReadSessionAuthority = (sessionId: string, signal: AbortSignal) => Promise<string | undefined>

export interface DeckPanelReadHostOptions {
  timeoutMs?: number
  probeTimeoutMs?: number
  maxReplyBytes?: number
}

/** Fixed sentences: the Host never forwards the text of a thrown error, which can hold paths or repository names. */
const HOST_FAILURE_MESSAGES: Record<DeckPanelReadHostFailureKind, string> = {
  'operation-not-allowed': 'Only the deck tree read and the deck ticket read are available over this channel.',
  'bad-request': 'The request does not have the shape this read takes.',
  unavailable: 'The deck read channel is not available on this host.',
  session: 'The session is not available on this host.',
  timeout: 'The deck read did not finish in time.',
  'read-failed': 'The deck read failed.',
  'bad-reply': 'The deck read returned a reply that could not be understood.',
  oversized: 'The deck read reply is too large for this channel.',
}

/** The deck's own failure kinds are short lowercase machine codes; anything else is not forwarded. */
const SAFE_DECK_KIND = /^[a-z0-9][a-z0-9-]{0,39}$/
// Plain prose only: path separators and colons are what host paths, URLs and error prefixes are made of.
const SAFE_DECK_MESSAGE = /^[A-Za-z0-9 .,()'-]{1,200}$/
const TIMED_OUT = Symbol('deck-panel-read-timed-out')

type RunOutcome = { reply: DeckPanelReadReply } | { kind: DeckPanelReadHostFailureKind }

/**
 * Per-connection, read-only bridge from the Remote relay to the deck's `deckPanelRead` service.
 *
 * It knows the two operations and the envelope of a reply, nothing about the deck's data. It never
 * calls any other deck method, never forwards a key the Client was not allowed to send, and answers
 * every problem with the same `{ ok: false, error: { kind, message } }` shape and no data.
 */
export class DeckPanelReadHost {
  private readonly timeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly maxReplyBytes: number

  constructor(
    private readonly resolveService: () => DeckPanelReadServiceLike | undefined,
    private readonly resolveSession: DeckPanelReadSessionAuthority,
    private readonly logger?: SafeLogger,
    options: DeckPanelReadHostOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DECK_PANEL_READ_TIMEOUT_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? DECK_PANEL_READ_PROBE_TIMEOUT_MS
    this.maxReplyBytes = options.maxReplyBytes ?? DECK_PANEL_READ_MAX_REPLY_BYTES
  }

  /**
   * True only while the deck answers exactly `{ available: true }`. It is asked on every call: a deck
   * that appears after start-up becomes visible, and one that goes away or fails stops being announced.
   * A missing service, `{ available: false }`, a throw and a slow answer all mean "not announced".
   */
  async available(): Promise<boolean> {
    const outcome = await this.probe()
    // One line per negotiation, debug only: it says why the feature was or was not announced, so a missing
    // service can be told apart from a deck that answered "unavailable". The reason is the deck's own short
    // machine code or one of the fixed words below; nothing from a thrown error is ever logged.
    this.logger?.debug('deck panel read availability', { outcome })
    return outcome === 'available'
  }

  private async probe(): Promise<string> {
    const service = this.service()
    if (service === undefined) return 'service-missing'
    let answer: unknown
    try {
      answer = await withTimeout(Promise.resolve().then(() => service.available()), this.probeTimeoutMs)
    } catch {
      return 'probe-failed'
    }
    if (answer === TIMED_OUT) return 'probe-timeout'
    if (!isRecord(answer)) return 'probe-bad-answer'
    if (answer.available === true) return 'available'
    const reason = answer.reason
    return answer.available === false && typeof reason === 'string' && SAFE_DECK_KIND.test(reason)
      ? `unavailable:${reason}`
      : 'unavailable'
  }

  async call(input: unknown): Promise<DeckPanelReadReply> {
    const operation = requestedOperation(input)
    if (operation === undefined) return this.fail('operation-not-allowed')
    const parsed = deckPanelReadParamsSchema.safeParse(input)
    if (!parsed.success) return this.fail('bad-request', operation)
    const service = this.service()
    if (service === undefined) return this.fail('unavailable', operation)

    // Session authority and deck read share one deadline; the abort cancels the authority's lookup on timeout.
    const controller = new AbortController()
    const startedAt = performance.now()
    let outcome: RunOutcome | typeof TIMED_OUT
    try {
      outcome = await withTimeout(this.run(service, parsed.data, controller.signal), this.timeoutMs)
    } finally {
      controller.abort()
    }
    if (outcome === TIMED_OUT) return this.fail('timeout', operation)
    if ('kind' in outcome) return this.fail(outcome.kind, operation)
    if (outcome.reply.ok === false) {
      this.logger?.warn('deck panel read refused by deck', { operation, kind: outcome.reply.error.kind })
    } else {
      this.logger?.debug('deck panel read ok', { operation, durationMs: Math.round(performance.now() - startedAt) })
    }
    return outcome.reply
  }

  private async run(
    service: DeckPanelReadServiceLike,
    request: DeckPanelReadParams,
    signal: AbortSignal,
  ): Promise<RunOutcome> {
    // The deck trims the session id, so the authority is asked about the same trimmed id.
    try {
      const workspace = await this.resolveSession(request.sessionId.trim(), signal)
      if (typeof workspace !== 'string' || workspace === '') return { kind: 'session' }
    } catch {
      return { kind: 'session' }
    }
    // The deck receives a freshly built object that can only hold the keys its operation takes.
    const params = request.operation === 'tree'
      ? { sessionId: request.sessionId }
      : { sessionId: request.sessionId, key: request.key }
    let reply: unknown
    try {
      reply = await service.call(request.operation, params)
    } catch {
      // The error text is neither logged nor sent: it can contain host paths and repository names.
      return { kind: 'read-failed' }
    }
    return this.check(reply, request.sessionId)
  }

  private service(): DeckPanelReadServiceLike | undefined {
    let service: unknown
    try {
      service = this.resolveService()
    } catch {
      return undefined
    }
    if (!isRecord(service) || service.feature !== DECK_PANEL_READ_CAPABILITY) return undefined
    if (typeof service.available !== 'function' || typeof service.call !== 'function') return undefined
    return service as unknown as DeckPanelReadServiceLike
  }

  /** Accept only a reply the Host can vouch for: plain JSON, within the byte bound, for the requested session. */
  private check(reply: unknown, sessionId: string): RunOutcome {
    let text: string | undefined
    try {
      text = JSON.stringify(reply)
    } catch {
      text = undefined
    }
    if (typeof text !== 'string') return { kind: 'bad-reply' }
    if (Buffer.byteLength(text, 'utf8') > this.maxReplyBytes) return { kind: 'oversized' }
    const copy: unknown = JSON.parse(text)
    if (!isRecord(copy)) return { kind: 'bad-reply' }
    if (copy.ok === false) return { reply: deckFailure(copy) }
    // The deck answers with the trimmed session id; a reply for another session is worse than a failed read.
    if (copy.ok !== true || copy.sessionId !== sessionId.trim()) return { kind: 'bad-reply' }
    return { reply: copy as DeckPanelReadReply }
  }

  private fail(kind: DeckPanelReadHostFailureKind, operation?: DeckPanelReadOperation): DeckPanelReadFailure {
    this.logger?.warn('deck panel read failed', { ...(operation === undefined ? {} : { operation }), kind })
    return { ok: false, error: { kind, message: HOST_FAILURE_MESSAGES[kind] } }
  }
}

/** Only the exact strings `tree` and `ticket` name an operation; no trimming, no case folding. */
function requestedOperation(input: unknown): DeckPanelReadOperation | undefined {
  if (!isRecord(input)) return undefined
  const operation = input.operation
  return (DECK_PANEL_READ_OPERATIONS as readonly unknown[]).includes(operation) ? operation as DeckPanelReadOperation : undefined
}

/** Keep only the deck's failure kind and fixed sentence; the deck's failures carry no data worth forwarding. */
function deckFailure(reply: Record<string, unknown>): DeckPanelReadFailure {
  const error = isRecord(reply.error) ? reply.error : {}
  const kind = typeof error.kind === 'string' && SAFE_DECK_KIND.test(error.kind) ? error.kind : 'read-failed'
  const message = typeof error.message === 'string' && SAFE_DECK_MESSAGE.test(error.message)
    ? error.message
    : `The deck read failed (${kind}).`
  return { ok: false, error: { kind, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const giveUp = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  try {
    return await Promise.race([work, giveUp])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
