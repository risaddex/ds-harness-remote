import { z } from 'zod'

/**
 * Wire contract of the read-only deck panel channel (spec #70 of risaddex/dsh-skills-deck).
 *
 * The Host forwards exactly two reads of the DSH skills deck on behalf of a phone:
 * the tree read and the ticket read. The Host does not interpret the data the deck
 * returns; it only authenticates, scopes by session, bounds size and time, and
 * announces the capability while the deck can serve both reads.
 */
export const DECK_PANEL_READ_CAPABILITY = 'deck.panel.read.v1' as const

/** One RPC method carries both reads; the `operation` field selects which one. */
export const DECK_PANEL_READ_METHODS = ['deck.panel.read'] as const

export const DECK_PANEL_READ_OPERATIONS = ['tree', 'ticket'] as const
export type DeckPanelReadOperation = typeof DECK_PANEL_READ_OPERATIONS[number]

export const DECK_PANEL_READ_MAX_SESSION_ID_CHARS = 512
export const DECK_PANEL_READ_MAX_TICKET_KEY_CHARS = 200
/** The deck bounds its own projection at 256 KiB; the Host bounds the whole reply again at twice that. */
export const DECK_PANEL_READ_MAX_REPLY_BYTES = 512 * 1024
/** Matches the deck's own single "one step wait", so the Host never gives up before a slow tracker answers. */
export const DECK_PANEL_READ_TIMEOUT_MS = 30_000
/** Feature negotiation must not stall behind a deck that cannot answer its availability probe. */
export const DECK_PANEL_READ_PROBE_TIMEOUT_MS = 5_000

/** Failure kinds this Host produces itself; the deck's own short kinds (for example `not-found`) pass through as well. */
export const DECK_PANEL_READ_HOST_FAILURE_KINDS = [
  'operation-not-allowed',
  'bad-request',
  'unavailable',
  'session',
  'timeout',
  'read-failed',
  'bad-reply',
  'oversized',
] as const
export type DeckPanelReadHostFailureKind = typeof DECK_PANEL_READ_HOST_FAILURE_KINDS[number]

const sessionIdSchema = z.string().max(DECK_PANEL_READ_MAX_SESSION_ID_CHARS)
  .refine(value => value.trim() !== '', 'sessionId must not be blank')

/** A ticket key is a short string (Linear, local Markdown) or a positive safe integer (GitHub, GitLab). */
const ticketKeySchema = z.union([
  z.string().max(DECK_PANEL_READ_MAX_TICKET_KEY_CHARS).refine(value => value.trim() !== '', 'key must not be blank'),
  z.number().refine(value => Number.isSafeInteger(value) && value > 0, 'key must be a positive safe integer'),
])

/**
 * Both reads are scoped by `sessionId` only. The Host resolves the workspace from the
 * session; a Client never supplies a working directory or a path, and any extra key is refused.
 */
export const deckPanelReadParamsSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('tree'), sessionId: sessionIdSchema }).strict(),
  z.object({ operation: z.literal('ticket'), sessionId: sessionIdSchema, key: ticketKeySchema }).strict(),
])
export type DeckPanelReadParams = z.infer<typeof deckPanelReadParamsSchema>

/** Every failure has this one shape and never carries data. `message` is a fixed sentence, never host error text. */
export const deckPanelReadFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ kind: z.string().min(1).max(40), message: z.string().min(1).max(200) }).strict(),
}).strict()
export type DeckPanelReadFailure = z.infer<typeof deckPanelReadFailureSchema>

/** A success reply is the deck's own reply: it names the session it read and carries the deck's payload untouched. */
export type DeckPanelReadSuccess = { ok: true; sessionId: string } & Record<string, unknown>
export type DeckPanelReadReply = DeckPanelReadSuccess | DeckPanelReadFailure
