export type BrowserConsoleType = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface BrowserConsoleMessage {
  type: BrowserConsoleType;
  timestamp: string;
  message: string;
  args?: string[];
  stack_trace?: string;
}

export interface BrowserRuntimeError {
  type: string;
  message: string;
  stack?: string;
  file?: string;
  line?: number;
  column?: number;
  timestamp: string;
}

export interface BrowserNetworkRequest {
  url: string;
  method: string;
  status?: number;
  status_text?: string;
  request_headers?: Record<string, string>;
  response_headers?: Record<string, string>;
  request_body?: string;
  response_body?: string;
  timing?: {
    start: number;
    end?: number;
    duration?: number;
  };
  resource_type?: string;
  failed?: boolean;
  failure_text?: string;
}

export interface BrowserPerformanceMetrics {
  dom_content_loaded?: number;
  load_event?: number;
  first_paint?: number;
  first_contentful_paint?: number;
  largest_contentful_paint?: number;
  time_to_interactive?: number;
}

export interface BrowserDebugResult {
  success: boolean;
  url: string;
  final_url?: string;
  load_time?: number;
  console_logs: BrowserConsoleMessage[];
  errors: BrowserRuntimeError[];
  network_requests: BrowserNetworkRequest[];
  performance?: BrowserPerformanceMetrics;
  screenshot?: string;
  error?: string;
}

export interface ChromeInstallation {
  path: string;
  version?: string;
  available: boolean;
}

export interface BrowserStatus {
  chromeInstalled: boolean;
  chromePath?: string;
  chromeVersion?: string;
  puppeteerAvailable: boolean;
  lastDebugUrl?: string;
  lastDebugTime?: number;
}
