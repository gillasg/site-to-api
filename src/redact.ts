import type { Overrides } from "./types.js";

// Redaction for everything that leaves the machine or goes into a shareable file: reports,
// exported specs, samples and curl examples. The local site model keeps real values so calls work.

const SECRET_HEADERS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|x-amz-security-token)$|token|secret|session|password|signature|x-.*-key$/i;
const SECRET_KEYS =
  /^(password|passwd|pwd|pass|secret|client_secret|token|access_?token|refresh_?token|id_?token|api_?key|apikey|authorization|auth|session(_?id)?|sid|ssn|card_?number|cc_?number|cvv|cvc|otp|pin|private_?key|csrf(_?token)?|xsrf(_?token)?|authenticity_token)$/i;
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<![\w/.-])\+?\d[\d\s().-]{8,}\d(?![\w/.-])/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

export interface Redactor {
  header(name: string, value: string): string;
  text(value: string): string;
  json<T>(value: T): T;
  headers(headers: Record<string, string>): Record<string, string>;
  body(body: string | undefined): string | undefined;
}

export function createRedactor(rules: Overrides["redact"] = {}): Redactor {
  const extraHeaders = (rules.headers ?? []).map((h) => h.toLowerCase());
  const extraKeys = new Set((rules.keys ?? []).map((k) => k.toLowerCase()));
  const patterns = (rules.patterns ?? []).map((pattern) => new RegExp(pattern, "g"));
  const text = (value: string): string => {
    let out = value.replace(JWT, "<jwt>").replace(EMAIL, "<email>");
    out = out.replace(CARD, (match) => (luhn(match.replace(/\D/g, "")) ? "<card>" : match));
    out = out.replace(PHONE, (match) =>
      match.replace(/\D/g, "").length >= 10 && !/^\d{13}$/.test(match) && !/^\d{10}$/.test(match)
        ? "<phone>"
        : match,
    );
    for (const pattern of patterns) out = out.replace(pattern, "<redacted>");
    return out;
  };
  const json = <T>(value: T): T =>
    redactJson(
      value,
      text,
      (key) => SECRET_KEYS.test(key) || extraKeys.has(key.toLowerCase()),
    ) as T;
  const header = (name: string, value: string) =>
    SECRET_HEADERS.test(name) || extraHeaders.includes(name.toLowerCase())
      ? "<redacted>"
      : text(value);
  return {
    header,
    text,
    json,
    headers: (headers) =>
      Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, header(name, value)]),
      ),
    body: (body) => {
      if (body === undefined) return undefined;
      try {
        return JSON.stringify(json(JSON.parse(body)));
      } catch {
        if (/^[\w%.~+-]+=[^&]*(&[\w%.~+-]+=[^&]*)*$/.test(body)) {
          const params = new URLSearchParams(body);
          for (const key of [...params.keys()])
            if (SECRET_KEYS.test(key) || extraKeys.has(key.toLowerCase()))
              params.set(key, "<redacted>");
          return text(params.toString());
        }
        return text(body);
      }
    },
  };
}

function redactJson(
  value: unknown,
  text: (value: string) => string,
  secret: (key: string) => boolean,
): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, text, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secret(key) && item !== null && typeof item !== "object"
          ? "<redacted>"
          : redactJson(item, text, secret),
      ]),
    );
  return typeof value === "string" ? text(value) : value;
}

function luhn(digits: string): boolean {
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function redactUrl(url: string, redactor: Redactor): string {
  try {
    const parsed = new URL(url);
    for (const [key, value] of [...parsed.searchParams])
      parsed.searchParams.set(
        key,
        SECRET_KEYS.test(key) || /key|token|sig/i.test(key) ? "<redacted>" : redactor.text(value),
      );
    return redactor.text(parsed.pathname) === parsed.pathname
      ? parsed.href.replace(/%3Credacted%3E/g, "<redacted>")
      : parsed.origin + redactor.text(parsed.pathname) + parsed.search;
  } catch {
    return redactor.text(url);
  }
}
