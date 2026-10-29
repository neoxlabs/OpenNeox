import type { CompletionProfile } from '../profiles/index.js';

export function isLeakedToolEnvelopeText(
  text: string,
  completionProfile: CompletionProfile,
  toolNames: string[],
): boolean {
  if (completionProfile.detectToolEnvelopeLeak === false) {
    return false;
  }
  if (!text || !text.trim()) {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed.length < 24) {
    return false;
  }

  const strongPatterns = [
    /^\s*assistant\s+to\s*=\s*[a-z0-9_.-]+/im,
    /multi_tool_use\.parallel/i,
    /recipient_name\s*[:=]\s*['"]functions\./i,
    /tool_uses?\s*[:=]/i,
    /to\s*=\s*functions\.?[a-z_]*/i,
  ];
  const weakPatterns = [
    /^\s*●\s*assistant\s+to\s*=/im,
    /^\s*մեկնաբանություն\b/im,
    /\bfunctions\.(readfile|read|search|search_files|list_directory|execute_shell|edit|edit_file|write_file|show_tree|git_status|git_diff|web_fetch|web_search|explore)\b/i,
  ];

  const strongHits = strongPatterns.filter(pattern => pattern.test(trimmed)).length;
  if (strongHits >= 1) {
    return true;
  }

  const weakHits = weakPatterns.filter(pattern => pattern.test(trimmed)).length;
  if (weakHits >= 2) {
    return true;
  }

  const extraPatterns = completionProfile.extraEnvelopePatterns ?? [];
  for (const pat of extraPatterns) {
    try {
      if (new RegExp(pat, 'i').test(trimmed)) {
        return true;
      }
    } catch {
      // ignore invalid regex
    }
  }

  const filteredToolNames = toolNames.filter(n => n.length > 2);
  if (filteredToolNames.length > 0) {
    const toolCallLikePattern = new RegExp(
      `(?:to=|calling|invoke|use|run)\\s*(?:functions?\\.)?(?:${filteredToolNames.join('|')})`,
      'i',
    );
    if (toolCallLikePattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}
