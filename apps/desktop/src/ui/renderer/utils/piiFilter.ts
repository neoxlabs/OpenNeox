interface SanitizeResult {
  output: string;
  redactions: string[];
}

type Replacer = (...args: any[]) => string;

interface PiiRule {
  label: string;
  regex: RegExp;
  replacer: Replacer;
}

const REDACTED = '<REDACTED>';

const PII_RULES: PiiRule[] = [
  {
    label: 'DB password env',
    regex: /(DB_PASSWORD\s*=\s*)([^\s]+)/gi,
    replacer: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    label: 'Generic secret env',
    regex: /([A-Z0-9_]*(?:SECRET|TOKEN|KEY)\s*=\s*)([^\s]+)/g,
    replacer: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    label: 'Connection password',
    regex: /(password=)([^&\s]+)/gi,
    replacer: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    label: 'Bearer token',
    regex: /(Bearer\s+)[A-Za-z0-9\-\._]+/gi,
    replacer: (_match, prefix) => `${prefix}${REDACTED}`,
  },
  {
    label: 'sk-* API key',
    regex: /(sk-[A-Za-z0-9][A-Za-z0-9_-]{11,})/gi,
    replacer: () => `sk-${REDACTED}`,
  },
  {
    label: 'Credential literal',
    regex: /((?:["']?)(?:[A-Za-z0-9]+[_-])*(password|passwd|pwd|secret|token|api[_-]?key)\b(?:["']?)\s*[:=]\s*)(["']?)([^"'\r\n]+)(\3?)/gi,
    replacer: (_match, prefix, _key, quote, _value, closing) => {
      const safeQuote = quote || '';
      const trailing = closing || '';
      return `${prefix}${safeQuote}${REDACTED}${trailing}`;
    },
  },
];

export function sanitizePrompt(input: string): SanitizeResult {
  let output = input;
  const redactions = new Set<string>();

  for (const rule of PII_RULES) {
    if (!rule.regex.test(output)) {
      rule.regex.lastIndex = 0;
      continue;
    }
    rule.regex.lastIndex = 0;
    output = output.replace(rule.regex, (...args) => {
      redactions.add(rule.label);
      return rule.replacer(...args);
    });
  }

  return {
    output,
    redactions: Array.from(redactions),
  };
}
