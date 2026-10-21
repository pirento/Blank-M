/**
 * Writes one administrator action to the audit log (Admin panel → Audit log). Never pass secrets
 * in `details`.
 */
import { AdminAuditLog } from '../../models/index.js';

export function recordAdminAction(admin, action, target, details = null) {
  return AdminAuditLog.create({
    actorId: admin.user.id,
    actorEmail: admin.user.email ?? '',
    action,
    target: String(target ?? '').slice(0, 320),
    details,
  });
}
