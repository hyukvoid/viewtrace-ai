/** Fixed v1 sanitization. No raw copy is retained for hash corroboration. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[=:]\s*["']?)[^\s&"'<>]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export const SECRET_FIELDS = new Set([
  'apikey',
  'api_key',
  'api-key',
  'access_token',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'credentials',
  'token',
]);
