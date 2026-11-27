import {
  DECK_PANEL_COMMENTS_CAPABILITY,
  DECK_PANEL_READ_MAX_REPLY_BYTES,
  DECK_PANEL_READ_PROBE_TIMEOUT_MS,
  DECK_PANEL_READ_TIMEOUT_MS,
  deckPanelCommentsParamsSchema,
  deckPanelCommentsReplySchema,
  type DeckPanelCommentsParams,
  type DeckPanelCommentsReply,
  type DeckPanelReadFailure,
} from '@dsh-remote/protocol'
import type { DeckPanelReadSessionAuthority } from './deck-panel-read.js'

export interface DeckPanelCommentsServiceLike {
  readonly feature: unknown
  available(): unknown
  list(params: DeckPanelCommentsParams): unknown
}

const messages = {
  'bad-request': 'The deck comments request is invalid.',
  'unavailable': 'Deck comments are not available on this Host.',
  'session': 'The session is not available on this Host.',
  'timeout': 'The deck comments read did not finish in time.',
  'read-failed': 'The deck comments read failed.',
  'bad-reply': 'The deck comments read returned an invalid reply.',
  'oversized': 'The deck comments reply is too large for this channel.',
}

function failure(kind: keyof typeof messages): DeckPanelReadFailure {
  return { ok: false, error: { kind, message: messages[kind] } }
}

/** No generic dispatch: the only reachable operation is a bounded, session-scoped comment list. */
export class DeckPanelCommentsHost {
  constructor(
    private readonly resolveService: () => DeckPanelCommentsServiceLike | undefined,
    private readonly resolveSession: DeckPanelReadSessionAuthority,
  ) {}

  async available(): Promise<boolean> {
    try {
      return await deadline(DECK_PANEL_READ_PROBE_TIMEOUT_MS, false, async () => {
        const answer = await this.service()?.available()
        return typeof answer === 'object' && answer !== null && 'available' in answer && answer.available === true
      })
    } catch {
      return false
    }
  }

  async list(input: unknown): Promise<DeckPanelCommentsReply> {
    const request = deckPanelCommentsParamsSchema.safeParse(input)
    if (!request.success) return failure('bad-request')
    const service = this.service()
    if (service === undefined) return failure('unavailable')
    const { sessionId, key } = request.data
    return deadline<DeckPanelCommentsReply>(DECK_PANEL_READ_TIMEOUT_MS, failure('timeout'), async signal => {
      try {
        const workspace = await this.resolveSession(sessionId.trim(), signal)
        if (typeof workspace !== 'string' || workspace === '') return failure('session')
      } catch {
        return failure('session')
      }
      if (signal.aborted) return failure('timeout')
      let text: string | undefined
      try {
        const reply = await service.list(request.data)
        try { text = JSON.stringify(reply) } catch { return failure('bad-reply') }
      } catch {
        return failure('read-failed')
      }
      if (text === undefined) return failure('bad-reply')
      if (Buffer.byteLength(text, 'utf8') > DECK_PANEL_READ_MAX_REPLY_BYTES) return failure('oversized')
      const result = deckPanelCommentsReplySchema.safeParse(JSON.parse(text))
      if (!result.success) return failure('bad-reply')
      if (result.data.ok === true) {
        return result.data.sessionId === sessionId.trim() && result.data.key === key ? result.data : failure('bad-reply')
      }
      const { kind } = result.data.error
      // Backend messages may contain paths or credentials. Preserve only the safe machine code.
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(kind)) return failure('read-failed')
      return { ok: false, error: { kind, message: messages['read-failed'] } }
    })
  }

  private service(): DeckPanelCommentsServiceLike | undefined {
    try {
      const service = this.resolveService()
      if (service?.feature === DECK_PANEL_COMMENTS_CAPABILITY && typeof service.list === 'function' && typeof service.available === 'function') return service
    } catch { /* Optional service lookup can fail during startup/shutdown. */ }
    return undefined
  }
}

async function deadline<T>(ms: number, expired: T, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>(resolve => { timer = setTimeout(() => resolve(expired), ms) })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}
