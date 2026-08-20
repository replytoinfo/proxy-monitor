export const MAX_ERROR_LEN = 200;

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout/i.test(msg)) return "Timeout";
    if (/ECONNREFUSED/i.test(msg)) return "Connection refused";
    if (/ECONNRESET/i.test(msg)) return "Connection reset";
    if (/ENOTFOUND/i.test(msg)) return "DNS not found";
    if (/EHOSTUNREACH/i.test(msg)) return "Host unreachable";
    return msg.slice(0, MAX_ERROR_LEN);
  }
  return "Unknown error";
}
