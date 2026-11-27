import { DECK_PANEL_READ_TIMEOUT_MS } from '@dsh-remote/protocol'
import { describe, expect, it, vi } from 'vitest'
import { DeckPanelCommentsHost } from '../src/deck-panel-comments.js'

const request = { sessionId: 'sess-1', key: 42 }
const success = { ok: true, ...request, comments: [] }

function commentsHost(list: () => unknown, authority = async (_sessionId: string, _signal: AbortSignal): Promise<string | undefined> => '/repo') {
  return new DeckPanelCommentsHost(() => ({ feature: 'deck.panel.comments.v1', available: () => ({ available: true }), list }), authority)
}

describe('deck panel comments service boundary', () => {
  it.each([
    ['different session', { ...success, sessionId: 'sess-2' }, 'bad-reply'],
    ['different key type', { ...success, key: '42' }, 'bad-reply'],
    ['truncation with more pages', { ...success, nextCursor: 'token', truncated: true }, 'bad-reply'],
    ['missing comments', { ok: true, ...request }, 'bad-reply'],
    ['unexpected fields', { ...success, comments: [{ body: 'Text', path: '/host/repo' }] }, 'bad-reply'],
    ['more than 50 rows', { ...success, comments: Array.from({ length: 51 }, () => ({ body: 'Text' })) }, 'bad-reply'],
    ['reply over the byte limit', { ...success, comments: [{ body: 'é'.repeat(300_000) }] }, 'oversized'],
  ])('fails closed on %s', async (_name, reply, kind) => {
    expect(await commentsHost(() => reply).list(request)).toMatchObject({ ok: false, error: { kind } })
  })

  it('keeps an explicit empty list and does not disclose backend errors', async () => {
    expect(await commentsHost(() => success).list(request)).toStrictEqual(success)
    const reply = { ok: false, error: { kind: 'invalid-cursor', message: 'Bad cursor for /host/private/repo' } }
    expect(await commentsHost(() => reply).list(request)).toStrictEqual({ ok: false, error: { kind: 'invalid-cursor', message: 'The deck comments read failed.' } })
  })

  it('never starts a deck read after the session authority misses the deadline', async () => {
    vi.useFakeTimers()
    try {
      const list = vi.fn(() => success)
      let finish: ((value: string) => void) | undefined
      const host = commentsHost(list, () => new Promise(resolve => { finish = resolve }))
      const result = host.list(request)
      await vi.advanceTimersByTimeAsync(DECK_PANEL_READ_TIMEOUT_MS)
      expect(await result).toMatchObject({ ok: false, error: { kind: 'timeout' } })
      finish?.('/repo')
      await Promise.resolve()
      expect(list).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
