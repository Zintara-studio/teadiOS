// The event feed is read in a browser. That makes it an egress path out of a
// machine that holds database credentials, an R2 key and an API key — so
// everything a child process prints goes through here first.

const MAX_LINE = 2_000;

// Built from char codes rather than escapes so no control byte ever appears
// literally in this file.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f]', 'g');

const PATTERNS: Array<[RegExp, string]> = [
  // Provider keys with recognisable shapes.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***'],
  // Anything carrying a password.
  [/\b(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s]+@/gi, '$1***@'],
  [/\b(https?:\/\/[^:@\s/]+:)[^@\s]+@/gi, '$1***@'],
  // Bearer tokens and JWTs.
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***jwt***'],
  // Long unbroken base64 is a file, not prose. Whole frames get pasted into
  // logs this way, and it is what turns a live feed into a data leak.
  [/[A-Za-z0-9+/]{160,}={0,2}/g, '***base64 elided***'],
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The literal values of our own secrets, whatever shape they happen to be.
 * Pattern matching only catches credentials that look like credentials; this
 * catches a self-hosted database password that looks like an English word.
 *
 * Callers pass the secrets they actually hold rather than leaving this to guess
 * from environment variable names — a worker configured from anywhere but
 * process.env would otherwise scan an empty set and redact nothing.
 */
function collect(known: string[], env: NodeJS.ProcessEnv): RegExp[] {
  const values = new Set<string>();

  const add = (value: string | undefined): void => {
    if (!value || value.length < 8) return;
    values.add(value);
    // A connection string also leaks in pieces, so redact its password alone.
    const pw = /^[a-z+]+:\/\/[^:@/\s]+:([^@\s]+)@/i.exec(value);
    if (pw?.[1] && pw[1].length >= 6) values.add(pw[1]);
  };

  for (const value of known) add(value);

  // Belt and braces: anything else in the environment that names itself a
  // secret, for self-hosters who add their own.
  const interesting = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|CONNECTION/i;
  for (const [name, value] of Object.entries(env)) {
    if (interesting.test(name)) add(value);
  }

  // Longest first, so a whole connection string is redacted before the bare
  // password inside it turns the line into confetti.
  return [...values]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escape(v), 'g'));
}

export function makeSanitizer(
  known: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): (line: string) => string {
  const secrets = collect(known, env);

  return (line: string): string => {
    // Strip colour and control characters first: a build tool's progress bar is
    // unreadable in a browser, and a stray carriage return rewrites the line.
    let out = line.replace(ANSI, '').replace(CONTROL, '').trimEnd();

    for (const re of secrets) out = out.replace(re, '***redacted***');
    for (const [re, to] of PATTERNS) out = out.replace(re, to);

    if (out.length > MAX_LINE) out = out.slice(0, MAX_LINE) + ` … (${out.length} chars)`;
    return out;
  };
}
