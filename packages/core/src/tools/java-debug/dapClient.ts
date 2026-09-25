/**
 * DAP Client - Debug Adapter Protocol Client Implementation
 *
 * This class handles low-level communication with the Java Debug Server
 * using the Debug Adapter Protocol (DAP) over TCP sockets.
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import type {
  DAPRequest,
  DAPResponse,
  DAPEvent,
  InitializeRequestArguments,
  LaunchRequestArguments,
  AttachRequestArguments,
  SetBreakpointsArguments,
  StackTraceArguments,
  ScopesArguments,
  VariablesArguments,
  EvaluateArguments,
  ContinueArguments,
  NextArguments,
  StepInArguments,
  StepOutArguments,
  DisconnectArguments,
  ThreadsResponse,
  ExceptionInfoArguments,
} from './types.js';

export class DAPClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private sequenceNumber = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (response: DAPResponse) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private buffer = '';
  private connected = false;

  private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds

  /**
   * Connect to DAP server
   */
  async connect(host: string, port: number, timeout: number = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const timeoutTimer = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`Connection timeout after ${timeout}ms`));
      }, timeout);

      this.socket.connect(port, host, () => {
        clearTimeout(timeoutTimer);
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeoutTimer);
        this.emit('error', error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reject all pending requests
        this.pendingRequests.forEach(({ reject, timeout }) => {
          clearTimeout(timeout);
          reject(new Error('Connection closed'));
        });
        this.pendingRequests.clear();
      });
    });
  }

  /**
   * Disconnect from DAP server
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    this.connected = false;
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a DAP request and wait for response
   */
  private async sendRequest(
    command: string,
    args?: any,
    timeout: number = this.DEFAULT_TIMEOUT
  ): Promise<DAPResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to debug server');
    }

    const seq = this.sequenceNumber++;
    const request: DAPRequest = {
      seq,
      type: 'request',
      command,
      arguments: args,
    };

    return new Promise((resolve, reject) => {
      // Set timeout for this request
      const timeoutTimer = setTimeout(() => {
        this.pendingRequests.delete(seq);
        reject(new Error(`Request timeout: ${command} (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(seq, {
        resolve,
        reject,
        timeout: timeoutTimer,
      });

      this.send(request);
    });
  }

  /**
   * Send a DAP message (low-level)
   */
  private send(message: DAPRequest): void {
    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, 'utf8');
    const header = `Content-Length: ${contentLength}\r\n\r\n`;
    const data = Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(json, 'utf8')]);

    this.socket?.write(data);
  }

  /**
   * Handle incoming data from socket
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf8');

    while (true) {
      // Look for Content-Length header
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1], 10);
      const headerLength = headerMatch[0].length;
      const messageStart = headerMatch.index! + headerLength;
      const messageEnd = messageStart + contentLength;

      // Check if we have the full message
      if (this.buffer.length < messageEnd) break;

      // Extract and parse message
      const messageText = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageText);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse DAP message:', error);
      }
    }
  }

  /**
   * Handle parsed DAP message
   */
  private handleMessage(message: DAPResponse | DAPEvent): void {
    if (message.type === 'response') {
      // Handle response
      const response = message as DAPResponse;
      const pending = this.pendingRequests.get(response.request_seq);

      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.request_seq);

        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.message || 'Request failed'));
        }
      }
    } else if (message.type === 'event') {
      // Handle event
      const event = message as DAPEvent;
      this.emit('event', event);
      this.emit(`event:${event.event}`, event.body);
    }
  }

  // ========= DAP Protocol Methods =========

  /**
   * Initialize debug session
   */
  async initialize(args: InitializeRequestArguments): Promise<DAPResponse> {
    return await this.sendRequest('initialize', args);
  }

  /**
   * Launch a program
   */
  async launch(args: LaunchRequestArguments): Promise<DAPResponse> {
    return await this.sendRequest('launch', args);
  }

  /**
   * Attach to a running process
   */
  async attach(args: AttachRequestArguments): Promise<DAPResponse> {
    return await this.sendRequest('attach', args);
  }

  /**
   * Set breakpoints
   */
  async setBreakpoints(args: SetBreakpointsArguments): Promise<DAPResponse> {
    return await this.sendRequest('setBreakpoints', args);
  }

  /**
   * Configuration done (after initialization)
   */
  async configurationDone(): Promise<DAPResponse> {
    return await this.sendRequest('configurationDone');
  }

  /**
   * Continue execution
   */
  async continue(args: ContinueArguments): Promise<DAPResponse> {
    return await this.sendRequest('continue', args);
  }

  /**
   * Step over
   */
  async next(args: NextArguments): Promise<DAPResponse> {
    return await this.sendRequest('next', args);
  }

  /**
   * Step into
   */
  async stepIn(args: StepInArguments): Promise<DAPResponse> {
    return await this.sendRequest('stepIn', args);
  }

  /**
   * Step out
   */
  async stepOut(args: StepOutArguments): Promise<DAPResponse> {
    return await this.sendRequest('stepOut', args);
  }

  /**
   * Pause execution
   */
  async pause(threadId: number): Promise<DAPResponse> {
    return await this.sendRequest('pause', { threadId });
  }

  /**
   * Get stack trace
   */
  async stackTrace(args: StackTraceArguments): Promise<DAPResponse> {
    return await this.sendRequest('stackTrace', args);
  }

  /**
   * Get scopes for a stack frame
   */
  async scopes(args: ScopesArguments): Promise<DAPResponse> {
    return await this.sendRequest('scopes', args);
  }

  /**
   * Get variables
   */
  async variables(args: VariablesArguments): Promise<DAPResponse> {
    return await this.sendRequest('variables', args);
  }

  /**
   * Evaluate expression
   */
  async evaluate(args: EvaluateArguments): Promise<DAPResponse> {
    return await this.sendRequest('evaluate', args);
  }

  /**
   * Get threads
   */
  async threads(): Promise<DAPResponse> {
    return await this.sendRequest('threads');
  }

  /**
   * Get exception info
   */
  async exceptionInfo(args: ExceptionInfoArguments): Promise<DAPResponse> {
    return await this.sendRequest('exceptionInfo', args);
  }

  /**
   * Disconnect from debuggee
   */
  async disconnectRequest(args: DisconnectArguments = {}): Promise<DAPResponse> {
    return await this.sendRequest('disconnect', args);
  }

  /**
   * Restart debugging session
   */
  async restart(): Promise<DAPResponse> {
    return await this.sendRequest('restart');
  }

  /**
   * Terminate debuggee
   */
  async terminate(): Promise<DAPResponse> {
    return await this.sendRequest('terminate');
  }
}
