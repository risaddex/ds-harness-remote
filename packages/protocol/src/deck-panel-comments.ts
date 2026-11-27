import { z } from 'zod'
import { deckPanelReadFailureSchema, deckPanelSessionIdSchema, deckPanelTicketKeySchema } from './deck-panel-read.js'

export const DECK_PANEL_COMMENTS_CAPABILITY = 'deck.panel.comments.v1' as const
export const DECK_PANEL_COMMENTS_METHODS = ['deck.panel.comments'] as const
export const DECK_PANEL_COMMENTS_MAX_PAGE = 50

const cursorSchema = z.string().max(200).refine(value => value.trim() !== '', 'cursor must not be blank')

export const deckPanelCommentsParamsSchema = z.object({
  sessionId: deckPanelSessionIdSchema,
  key: deckPanelTicketKeySchema,
  cursor: cursorSchema.optional(),
}).strict()
export type DeckPanelCommentsParams = z.infer<typeof deckPanelCommentsParamsSchema>

export const deckPanelCommentSchema = z.object({
  body: z.string(),
  author: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict()
export type DeckPanelComment = z.infer<typeof deckPanelCommentSchema>

export const deckPanelCommentsSuccessSchema = z.object({
  ok: z.literal(true),
  sessionId: deckPanelSessionIdSchema,
  key: deckPanelTicketKeySchema,
  comments: z.array(deckPanelCommentSchema).max(DECK_PANEL_COMMENTS_MAX_PAGE),
  nextCursor: cursorSchema.optional(),
  truncated: z.boolean().optional(),
}).strict().refine(page => page.truncated !== true || page.nextCursor === undefined, 'a truncated page must be terminal')

export const deckPanelCommentsReplySchema = z.discriminatedUnion('ok', [deckPanelCommentsSuccessSchema, deckPanelReadFailureSchema])
export type DeckPanelCommentsReply = z.infer<typeof deckPanelCommentsReplySchema>
