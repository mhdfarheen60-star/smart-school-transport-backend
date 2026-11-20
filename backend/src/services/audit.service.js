import { AuditLog } from '../models/index.js';

export async function audit(
  req,
  action,
  entity,
  entityId,
  meta
) {
  try {
    await AuditLog.create({
      actor: req.user?.id,
      actorRole: req.user?.role,
      action,
      entity,
      entityId: entityId ? String(entityId) : undefined,
      meta,
      ip: req.ip,
    });
  } catch (e) {
    console.error('Audit log failed', e);
  }
}
