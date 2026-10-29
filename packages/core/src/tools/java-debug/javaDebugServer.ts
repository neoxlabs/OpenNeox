/**
 * Java Debug Server - Manages the lifecycle of the Java Debug Server process
 *
 * This class handles starting and stopping the Microsoft Java Debug Server,
 * which acts as a bridge between DAP clients and the JVM via JDI.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface JavaDebugServerConfig {
  /** Path to java-debug JAR file */
  jarPath: string;
  /** Path to JDK home (optional, uses JAVA_HOME if not provided) */
  javaHome?: string;
  /** Server port (0 = random port) */
  port?: number;
  /** Timeout for server startup (ms) */
  startupTimeout?: number;
}

export class JavaDebugServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number = 0;
  private isRunning = false;
  private config: JavaDebugServerConfig;

  constructor(config: JavaDebugServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the Java Debug Server
   * @returns The port number the server is listening on
   */
  async start(): Promise<number> {
    if (this.isRunning) {
      throw new Error('Java Debug Server is already running');
    }

    // Validate JAR path
    try {
      await fs.access(this.config.jarPath);
    } catch (error) {
      throw new Error(
        `Java Debug JAR not found at: ${this.config.jarPath}\n` +
          `Please download it from https://github.com/microsoft/java-debug/releases`
      );
    }

    // Determine Java command
    const javaCommand = this.getJavaCommand();

    // Start Java Debug Server as a Language Server
    // The server uses STDIO for communication with the language server client,
    // and listens on a random port for DAP connections
    return new Promise((resolve, reject) => {
      const startupTimeout = this.config.startupTimeout || 10000;
      let serverOutput = '';

      const timeoutTimer = setTimeout(() => {
        if (!this.isRunning) {
          this.stop();
          reject(
            new Error(
              `Java Debug Server startup timeout (${startupTimeout}ms)\n` +
                `Output so far:\n${serverOutput}`
            )
          );
        }
      }, startupTimeout);

      // Spawn Java Debug Server process
      this.process = spawn(javaCommand, ['-jar', this.config.jarPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Capture stdout for parsing port number
      this.process.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        serverOutput += text;
        this.emit('stdout', text);

        // Look for server port in output
        // Java Debug Server outputs: "Listening for transport dt_socket at address: PORT"
        const portMatch = text.match(/Listening.*?address:\s*(\d+)/i);
        if (portMatch) {
          this.port = parseInt(portMatch[1], 10);
          this.isRunning = true;
          clearTimeout(timeoutTimer);
          this.emit('started', this.port);
          resolve(this.port);
        }

        // Alternative format: "Debug server listening on port PORT"
        const altPortMatch = text.match(/listening.*?port\s*(\d+)/i);
        if (altPortMatch) {
          this.port = parseInt(altPortMatch[1], 10);
          this.isRunning = true;
          clearTimeout(timeoutTimer);
          this.emit('started', this.port);
          resolve(this.port);
        }
      });

      // Capture stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        serverOutput += text;
        this.emit('stderr', text);

        // Check for errors
        if (text.toLowerCase().includes('error')) {
          this.emit('error', new Error(text));
        }
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        this.isRunning = false;
        this.emit('exit', { code, signal });

        if (code !== 0 && code !== null) {
          reject(new Error(`Java Debug Server exited with code ${code}\n${serverOutput}`));
        }
      });

      // Handle process errors
      this.process.on('error', (error) => {
        clearTimeout(timeoutTimer);
        this.isRunning = false;
        this.emit('error', error);
        reject(error);
      });
    });
  }

  /**
   * Stop the Java Debug Server
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.isRunning = false;
    this.port = 0;
    this.emit('stopped');
  }

  /**
   * Get the port number the server is listening on
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Check if server is running
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get the Java command to use
   */
  private getJavaCommand(): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    // Priority: config.javaHome > JAVA_HOME > "java" in PATH
    if (this.config.javaHome) {
      return path.join(this.config.javaHome, 'bin', `java${ext}`);
    }

    if (process.env.JAVA_HOME) {
      return path.join(process.env.JAVA_HOME, 'bin', `java${ext}`);
    }

    return 'java'; // Rely on PATH
  }

  /**
   * Send initialization request to Language Server
   * This is needed to start the DAP server
   */
  async initialize(): Promise<void> {
    if (!this.process || !this.isRunning) {
      throw new Error('Server is not running');
    }

    // Send LSP initialize request
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        capabilities: {},
      },
    };

    this.sendLSPMessage(initializeRequest);

    // Send initialized notification
    const initializedNotification = {
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    };

    this.sendLSPMessage(initializedNotification);
  }

  /**
   * Send LSP message to the server
   */
  private sendLSPMessage(message: any): void {
    if (!this.process?.stdin) {
      throw new Error('Server stdin is not available');
    }

    const json = JSON.stringify(message);
    const contentLength = Buffer.byteLength(json, 'utf8');
    const header = `Content-Length: ${contentLength}\r\n\r\n`;
    const data = header + json;

    this.process.stdin.write(data);
  }

  /**
   * Request DAP server info from Language Server
   * Returns the port where the DAP server is listening
   */
  async startDAPServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for DAP server to start'));
      }, 5000);

      // Listen for DAP server port in output
      const listener = (text: string) => {
        const match = text.match(/DAP.*?port\s*(\d+)/i);
        if (match) {
          const port = parseInt(match[1], 10);
          clearTimeout(timeout);
          this.removeListener('stdout', listener);
          resolve(port);
        }
      };

      this.on('stdout', listener);

      // Send request to start DAP server
      const request = {
        jsonrpc: '2.0',
        id: 2,
        method: 'vscode.java.startDebugSession',
        params: {},
      };

      this.sendLSPMessage(request);
    });
  }
}
