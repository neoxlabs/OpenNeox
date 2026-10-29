export function validatePassword(pw) {
  if (typeof pw !== 'string') return { ok: false, reason: 'type' };
  if (pw.length < 8) return { ok: false, reason: 'length' };
  if (!/[A-Z]/.test(pw)) return { ok: false, reason: 'upper' };
  if (!/[0-9]/.test(pw)) return { ok: false, reason: 'digit' };
  return { ok: true };
}
