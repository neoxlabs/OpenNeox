/**
 * CLI Type Definitions
 * Shared types for the Neox CLI
 */

export interface SelectionChoice {
  label: string;
  value: string;
  description?: string;
  /** Currently applied selection — keep a distinct color while the cursor moves elsewhere */
  isCurrent?: boolean;
}

export interface TextPromptOptions {
  defaultValue?: string;
  allowEmpty?: boolean;
  hint?: string;
  password?: boolean; //  mask typed value (API keys / secrets)
}

export type InteractionMode = 'agent' | 'ask';

/**
 * Attachment data sent with user messages
 */
export interface HostAttachmentData {
  type: 'image' | 'file';
  data: string;
  path?: string;
  name?: string;
}

/**
 * Web search result item
 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  description?: string;
  hostname?: string;
}

/**
 * Search match result
 */
export interface GrepMatchItem {
  lineNumber: number;
  content: string;
  isMatch: boolean;
}
