import { TOKEN_LIKE } from "./config.js";

/**
 * Removes anything credential-shaped from text that is about to leave this
 * process — a tool result, an error, a log line. The configured token is
 * removed by value; anything else that looks like a token or a bearer header
 * is removed by shape, so a token echoed back in some other form (a proxy
 * error page, a stack trace) is caught too.
 */
export function redact(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join("[redacted]");
  out = out.replace(TOKEN_LIKE, "[redacted]");
  out = out.replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]");
  return out;
}
