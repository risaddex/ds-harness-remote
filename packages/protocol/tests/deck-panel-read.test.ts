import { describe, expect, it } from 'vitest'
import {
  DECK_PANEL_READ_CAPABILITY,
  DECK_PANEL_READ_MAX_SESSION_ID_CHARS,
  DECK_PANEL_READ_MAX_TICKET_KEY_CHARS,
  DECK_PANEL_READ_METHODS,
  DECK_PANEL_READ_OPERATIONS,
  deckPanelReadFailureSchema,
  deckPanelReadParamsSchema,
  rpcMethods,
} from '../src/index.js'

describe('deck panel read protocol contract', () => {
  it('names one feature, one RPC method and exactly two operations', () => {
    expect(DECK_PANEL_READ_CAPABILITY).toBe('deck.panel.read.v1')
    expect(DECK_PANEL_READ_METHODS).toEqual(['deck.panel.read'])
    expect(DECK_PANEL_READ_OPERATIONS).toEqual(['tree', 'ticket'])
    for (const method of DECK_PANEL_READ_METHODS) expect(rpcMethods).toContain(method)
  })

  it('accepts the tree read by session and the ticket read by session and key', () => {
    expect(deckPanelReadParamsSchema.parse({ operation: 'tree', sessionId: 'sess-1' })).toEqual({ operation: 'tree', sessionId: 'sess-1' })
    expect(deckPanelReadParamsSchema.parse({ operation: 'ticket', sessionId: 'sess-1', key: 'OMB-923' })).toEqual({ operation: 'ticket', sessionId: 'sess-1', key: 'OMB-923' })
    expect(deckPanelReadParamsSchema.parse({ operation: 'ticket', sessionId: 'sess-1', key: 83 })).toEqual({ operation: 'ticket', sessionId: 'sess-1', key: 83 })
  })

  it('refuses a working directory, a path or any other extra key, and any other operation', () => {
    const refused: unknown[] = [
      { operation: 'tree', sessionId: 's', cwd: '/tmp' },
      { operation: 'tree', sessionId: 's', path: 'a/b' },
      { operation: 'tree', sessionId: 's', key: 1 },
      { operation: 'ticket', sessionId: 's', key: 1, cwd: '/tmp' },
      { operation: 'ticket', sessionId: 's', key: 1, comments: true },
      { operation: 'comments', sessionId: 's' },
      { operation: 'Tree', sessionId: 's' },
      { operation: ' tree', sessionId: 's' },
      { sessionId: 's' },
      { operation: 'tree' },
      { operation: 'ticket', sessionId: 's' },
    ]
    for (const input of refused) expect(deckPanelReadParamsSchema.safeParse(input).success, JSON.stringify(input)).toBe(false)
  })

  it('bounds the session id and the ticket key', () => {
    const tooLongSession = 's'.repeat(DECK_PANEL_READ_MAX_SESSION_ID_CHARS + 1)
    const tooLongKey = 'k'.repeat(DECK_PANEL_READ_MAX_TICKET_KEY_CHARS + 1)
    const refused: unknown[] = [
      { operation: 'tree', sessionId: '' },
      { operation: 'tree', sessionId: '   ' },
      { operation: 'tree', sessionId: tooLongSession },
      { operation: 'ticket', sessionId: 's', key: '' },
      { operation: 'ticket', sessionId: 's', key: '  ' },
      { operation: 'ticket', sessionId: 's', key: tooLongKey },
      { operation: 'ticket', sessionId: 's', key: 0 },
      { operation: 'ticket', sessionId: 's', key: -3 },
      { operation: 'ticket', sessionId: 's', key: 1.5 },
      { operation: 'ticket', sessionId: 's', key: 2 ** 60 },
      { operation: 'ticket', sessionId: 's', key: { id: 1 } },
    ]
    for (const input of refused) expect(deckPanelReadParamsSchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false)
    expect(deckPanelReadParamsSchema.safeParse({ operation: 'tree', sessionId: 's'.repeat(DECK_PANEL_READ_MAX_SESSION_ID_CHARS) }).success).toBe(true)
  })

  it('describes a failure as a kind and a message and nothing else', () => {
    expect(deckPanelReadFailureSchema.parse({ ok: false, error: { kind: 'timeout', message: 'The deck read did not finish in time.' } })).toBeDefined()
    expect(deckPanelReadFailureSchema.safeParse({ ok: false, error: { kind: 'timeout', message: 'x' }, containers: [] }).success).toBe(false)
    expect(deckPanelReadFailureSchema.safeParse({ ok: false, error: { kind: 'timeout', message: 'x', stack: 'at /home/me' } }).success).toBe(false)
  })
})
