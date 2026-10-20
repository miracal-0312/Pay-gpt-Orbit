'use strict';

const SECRET_KEY = /^(?:access_?token|refresh_?token|session(?:_json|_payload)?|cookies?|cookieHeader|authorization|api[_-]?key|api[_-]?secret|secret|password|card_number|card_cvc|cvv|cvc|captcha|signature)$/i;

function redactLine(value) {
    let text = String(value ?? '');
    // Complete structured Session payloads are never log messages.
    if (/"(?:accessToken|access_token|session_json|cookieHeader)"\s*:/.test(text)) {
        return '[REDACTED_SESSION_PAYLOAD]';
    }
    text = text
        .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
        .replace(/((?:api[_-]?(?:key|secret)|access[_-]?token|refresh[_-]?token|password|secret|cvc|cvv|captcha[_-]?token|signature|client_secret)\s*[:=]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@')
        .replace(/\b(?:\d[ -]?){13,19}\b/g, value => `****${value.replace(/\D/g, '').slice(-4)}`);
    return text;
}

function redactText(value) {
    return String(value ?? '').split('\n').map(redactLine).join('\n');
}

function sanitize(value, key = '', depth = 0) {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (depth > 8) return '[DEPTH_LIMIT]';
    if (typeof value === 'string') return redactText(value);
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map(item => sanitize(item, '', depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
        .map(([name, item]) => [name, sanitize(item, name, depth + 1)]));
    return String(value);
}

module.exports = { redactText, sanitize };
