/**
 * Zod schemas for private invitation links, shared by server and browser.
 */
import { z } from 'zod';

export const manualInvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['member', 'admin']),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(['pending', 'processing', 'accepted', 'revoked', 'expired', 'needs_review']),
  consumedAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
});

export const manualInvitationCreatedSchema = z.object({
  invitation: manualInvitationSchema,
  url: z.string().url(),
  emailSent: z.literal(false),
});
