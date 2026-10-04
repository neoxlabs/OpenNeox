/**
 * Error formatting utilities for better UI display
 */

/**
 * Extract error code from HTML error page
 */
function extractHTMLErrorCode(html: string): string | null {
  // Match: Error code 522, Error 522, etc.
  const codeMatch = html.match(/Error\s+(?:code\s+)?(\d{3})/i);
  if (codeMatch) {
    return codeMatch[1];
  }

  // Match: 522: Connection timed out
  const titleMatch = html.match(/(\d{3}):\s*([^<\n]+)/);
  if (titleMatch) {
    return titleMatch[1];
  }

  return null;
}

/**
 * Extract error message from HTML error page
 */
function extractHTMLErrorMessage(html: string): string | null {
  // Match: <title>domain.com | 522: Connection timed out</title>
  const titleMatch = html.match(/<title>[^|]*\|\s*\d{3}:\s*([^<]+)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].trim();
  }

  // Match: <h1>Connection timed out</h1>
  const h1Match = html.match(/<h1[^>]*>(?:<[^>]+>)*([^<]+?(?:\s+\d{3})?)<\/(?:[^>]+>)*<\/h1>/i);
  if (h1Match) {
    return h1Match[1].replace(/Error code\s+\d{3}/i, '').trim();
  }

  // Match: Error code 522
  const errorCodeMatch = html.match(/Error\s+code\s+(\d{3})/i);
  if (errorCodeMatch) {
    const code = errorCodeMatch[1];
    const knownErrors: Record<string, string> = {
      '502': 'Bad gateway',
      '503': 'Service unavailable',
      '504': 'Gateway timeout',
      '520': 'Unknown error',
      '521': 'Web server is down',
      '522': 'Connection timed out',
      '523': 'Origin is unreachable',
      '524': 'A timeout occurred',
    };
    return knownErrors[code] || 'Server error';
  }

  // Match: <span class="inline-block">Bad gateway</span>
  const inlineMatch = html.match(/<span[^>]*class="inline-block"[^>]*>([^<]+)<\/span>/i);
  if (inlineMatch) {
    return inlineMatch[1].trim();
  }

  return null;
}

/**
 * Extract host from HTML error page
 */
function extractHTMLHost(html: string): string | null {
  // Match: <span class="md:block w-full truncate">dapi.micosoft.icu</span>
  const hostMatch = html.match(/truncate[^>]*>([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})<\/span>/);
  if (hostMatch) {
    return hostMatch[1];
  }

  // Match: <title>domain.com | ...
  const titleMatch = html.match(/<title>([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (titleMatch) {
    return titleMatch[1];
  }

  return null;
}

/**
 * Check if string is HTML content
 */
export function isHTMLContent(text: string): boolean {
  return text.trim().startsWith('<!DOCTYPE html') ||
         text.trim().startsWith('<html') ||
         /<html[^>]*>/i.test(text);
}

/**
 * Extract JSON from SSE data format (e.g., "data: {...}")
 */
function extractSSEData(text: string): string | null {
  // Match: data: {...}
  const match = text.match(/^data:\s*(\{.*\})/m);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Format error message for UI display
 * - Extracts key information from HTML error pages
 * - Parses SSE error responses
 * - Shortens overly verbose messages
 * - Preserves important details
 */
export function formatErrorForUI(errorMessage: string, statusCode?: number): {
  code: string;
  message: string;
  detail?: string;
} {
  // Check if this is SSE format (e.g., "data: {"error":...}")
  const sseData = extractSSEData(errorMessage);
  if (sseData) {
    try {
      const parsed = JSON.parse(sseData);
      if (parsed.error) {
        const err = parsed.error;
        const code = err.type || err.code || (statusCode ? `HTTP_${statusCode}` : 'API_ERROR');
        const message = err.message || 'API error';
        let detail: string | undefined;

        // Handle specific error types
        if (err.type === 'usage_limit_reached') {
          const resetsAt = err.resets_at ? new Date(err.resets_at * 1000).toLocaleString() : undefined;
          const resetsIn = err.resets_in_seconds;
          if (resetsIn) {
            const hours = Math.floor(resetsIn / 3600);
            const minutes = Math.floor((resetsIn % 3600) / 60);
            detail = `Usage limit reached (${err.plan_type || 'unknown'} plan). Resets in ${hours}h ${minutes}m.`;
          } else if (resetsAt) {
            detail = `Usage limit reached (${err.plan_type || 'unknown'} plan). Resets at ${resetsAt}.`;
          }
        }

        return { code, message, detail };
      }
    } catch {
      // Not valid JSON, continue with other checks
    }
  }

  // Try to parse as plain JSON error
  if (errorMessage.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(errorMessage);
      if (parsed.error) {
        const err = parsed.error;
        return {
          code: err.type || err.code || (statusCode ? `HTTP_${statusCode}` : 'API_ERROR'),
          message: err.message || 'API error',
        };
      }
    } catch {
      // Not valid JSON
    }
  }

  // Check if this is an HTML error page
  if (isHTMLContent(errorMessage)) {
    const code = extractHTMLErrorCode(errorMessage) || String(statusCode || 'UNKNOWN');
    const message = extractHTMLErrorMessage(errorMessage) || 'Server error';
    const host = extractHTMLHost(errorMessage);

    let detail: string | undefined;
    if (host) {
      // Extract provider info
      if (host.includes('cloudflare')) {
        detail = `The server (${host}) is protected by Cloudflare but is not responding.`;
      } else {
        detail = `The API server (${host}) is not responding. This may be a temporary issue with your API provider.`;
      }
    }

    return {
      code: `HTTP_${code}`,
      message,
      detail,
    };
  }

  // Handle common error patterns

  // OpenAI API errors: "OpenAI Responses API error: 522 - <html>..."
  const openAIMatch = errorMessage.match(/OpenAI.*error:\s*(\d+)\s*-\s*(.*)/i);
  if (openAIMatch) {
    const code = openAIMatch[1];
    let message = openAIMatch[2];

    // If the message part is HTML, extract info from it
    if (isHTMLContent(message)) {
      const extracted = formatErrorForUI(message, parseInt(code, 10));
      return {
        code: extracted.code,
        message: extracted.message,
        detail: extracted.detail,
      };
    }

    // Clean up the message
    message = message.trim();
    if (message.length > 200) {
      message = message.slice(0, 200) + '...';
    }

    return {
      code: `HTTP_${code}`,
      message,
    };
  }

  // Anthropic API errors
  const anthropicMatch = errorMessage.match(/Anthropic.*error:\s*(\d+)\s*-\s*(.*)/i);
  if (anthropicMatch) {
    const code = anthropicMatch[1];
    let message = anthropicMatch[2].trim();

    if (message.length > 200) {
      message = message.slice(0, 200) + '...';
    }

    return {
      code: `HTTP_${code}`,
      message,
    };
  }

  // Network errors
  if (errorMessage.includes('ECONNREFUSED')) {
    return {
      code: 'NETWORK_ERROR',
      message: 'Connection refused',
      detail: 'Unable to connect to the API server. Please check your network connection.',
    };
  }

  if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout')) {
    return {
      code: 'TIMEOUT',
      message: 'Connection timeout',
      detail: 'The request took too long to complete. Please try again.',
    };
  }

  if (errorMessage.includes('ENOTFOUND')) {
    return {
      code: 'DNS_ERROR',
      message: 'Server not found',
      detail: 'Could not resolve the API server address. Please check your API base URL.',
    };
  }

  // Context window errors
  if (/context.*window.*exceeded/i.test(errorMessage) ||
      /maximum.*context.*length/i.test(errorMessage)) {
    return {
      code: 'CONTEXT_EXCEEDED',
      message: 'Context window exceeded',
      detail: 'The conversation is too long. Please start a new session or use /compact.',
    };
  }

  // Rate limit errors
  if (/rate.*limit/i.test(errorMessage) || errorMessage.includes('429')) {
    return {
      code: 'RATE_LIMIT',
      message: 'Rate limit exceeded',
      detail: 'Too many requests. Please wait a moment before trying again.',
    };
  }

  // Auth errors
  if (errorMessage.includes('401') || /unauthorized/i.test(errorMessage)) {
    return {
      code: 'AUTH_ERROR',
      message: 'Authentication failed',
      detail: 'Please check your API key in settings.',
    };
  }

  if (errorMessage.includes('403') || /forbidden/i.test(errorMessage)) {
    return {
      code: 'FORBIDDEN',
      message: 'Access denied',
      detail: 'Your API key does not have permission for this operation.',
    };
  }

  // Default: clean up long messages
  let cleanMessage = errorMessage;

  // Remove error prefixes
  cleanMessage = cleanMessage.replace(/^Error:\s*/i, '');
  cleanMessage = cleanMessage.replace(/^Request failed with status code\s+\d+:\s*/i, '');

  // Truncate if too long
  if (cleanMessage.length > 300) {
    cleanMessage = cleanMessage.slice(0, 300) + '...';
  }

  return {
    code: statusCode ? `HTTP_${statusCode}` : 'UNKNOWN',
    message: cleanMessage,
  };
}

/**
 * Safely stringify an object, handling circular references
 */
function safeStringify(obj: any, maxLength = 1000): string {
  const seen = new WeakSet();
  try {
    const result = JSON.stringify(obj, (key, value) => {
      // Skip problematic properties that often cause circular refs
      if (key === 'req' || key === 'res' || key === 'socket' || key === '_httpMessage') {
        return '[Circular]';
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
    return result.length > maxLength ? result.slice(0, maxLength) + '...' : result;
  } catch {
    return '[Could not stringify object]';
  }
}

/**
 * Check if object is a stream (has 'on' method typical of Node streams)
 */
function isStream(obj: any): boolean {
  return obj && typeof obj === 'object' && typeof obj.on === 'function';
}

/**
 * Format full error for logging (preserves all details)
 */
export function formatErrorForLog(error: any): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    const parts: string[] = [];
    parts.push(`Message: ${error.message}`);

    if ('response' in error && error.response) {
      const resp = error.response as { data?: unknown; status?: number };
      if (resp.status) {
        parts.push(`Status: ${resp.status}`);
      }
      if (resp.data) {
        // Limit HTML output in logs too
        let dataStr: string;

        // Skip stream objects - they contain circular refs and can't be serialized
        if (isStream(resp.data)) {
          dataStr = '[Stream response - data not captured]';
        } else if (typeof resp.data === 'string') {
          dataStr = resp.data;
        } else {
          // Use safe stringify to handle circular references
          dataStr = safeStringify(resp.data);
        }

        if (isHTMLContent(dataStr)) {
          const formatted = formatErrorForUI(dataStr, resp.status);
          dataStr = `[HTML Error Page] Code: ${formatted.code}, Message: ${formatted.message}`;
          if (formatted.detail) {
            dataStr += `\nDetail: ${formatted.detail}`;
          }
        } else if (dataStr.length > 1000) {
          dataStr = dataStr.slice(0, 1000) + '...';
        }

        parts.push(`Data: ${dataStr}`);
      }
    }

    if (error.stack && process.env.CLI_DEBUG_CONSOLE === '1') {
      parts.push(`Stack: ${error.stack}`);
    }

    return parts.join('\n');
  }

  return String(error);
}

/**
 * Get user-friendly suggestion based on error
 */
export function getErrorSuggestion(code: string): string {
  const suggestions: Record<string, string> = {
    'HTTP_502': '💡 API 代理服务暂时无法连接后端。系统将自动重试，请稍候...',
    'HTTP_503': '💡 API 服务暂时不可用。系统将自动重试，请稍候...',
    'HTTP_504': '💡 API 网关超时。系统将自动重试，请稍候...',
    'HTTP_522': '💡 The API server is not responding. This is usually temporary. Please try again in a few moments.',
    'HTTP_521': '💡 The API server is down. Please try again later or contact your API provider.',
    'HTTP_523': '💡 The API server is unreachable. Please check your API base URL in settings.',
    'HTTP_524': '💡 The request timed out. Try reducing the conversation length or using a different model.',
    'HTTP_429': '💡 You\'ve hit the rate limit. Please wait before sending more requests.',
    'HTTP_401': '💡 Please check your API key in Settings → API Configuration.',
    'HTTP_403': '💡 Your API key doesn\'t have access. Please check your permissions.',
    'HTTP_400': '💡 Invalid request. Please try rephrasing your message.',
    'CONTEXT_EXCEEDED': '💡 Use /compact to summarize history, or start a new session.',
    'RATE_LIMIT': '💡 Please wait a few seconds before trying again.',
    'NETWORK_ERROR': '💡 Check your internet connection and firewall settings.',
    'TIMEOUT': '💡 The server is slow. Try again or use a different API provider.',
    'DNS_ERROR': '💡 Check your API base URL in Settings → API Configuration.',
  };

  return suggestions[code] || '💡 Please try again. If the problem persists, check your API settings.';
}
