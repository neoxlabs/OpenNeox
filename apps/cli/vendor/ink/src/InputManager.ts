
import {debugLog} from '@neoxlabs/core/platform/cliLogger.js';
import {shouldEnableAggressiveInputCompat} from './terminal/TerminalAdapter.js';

export type MouseWheelCallback = (direction: 'up' | 'down') => void;

export class InputManager {
	private stdin: NodeJS.ReadStream & {setRawMode(mode: boolean): void};
	private stdinListener: ((data: string) => void) | null = null;
	private dataListenerAttached = false;
	private errorListenerAttached = false;
	private closeListenerAttached = false;
	private healthCheckInterval: NodeJS.Timeout | null = null;
	private rawModeForcedAt = 0;
	private rawModeRecoverAt = 0;
	private lastHealthLogAt = 0;
	private lastInputAt = Date.now();
	private pausedStreak = 0;
	private lastHardRecoverAt = 0;
	private aggressiveCompat = shouldEnableAggressiveInputCompat();

	private mouseWheelCallback: MouseWheelCallback | null = null;
	private stdinBroken = false;

	// These receive the same input data as the primary listener
	private secondaryListeners: Set<(data: string) => void> = new Set();

	constructor(
		stdin: NodeJS.ReadStream & {setRawMode(mode: boolean): void},
	) {
		this.stdin = stdin;
	}

	setMouseWheelCallback(callback: MouseWheelCallback | null): void {
		this.mouseWheelCallback = callback;
		debugLog('INPUT_MANAGER', `🖱️ Mouse wheel callback ${callback ? 'set' : 'cleared'}`);
	}

	addSecondaryListener(listener: (data: string) => void): void {
		this.secondaryListeners.add(listener);
	}

	removeSecondaryListener(listener: (data: string) => void): void {
		this.secondaryListeners.delete(listener);
	}

	enablePermanent(listener: (data: string) => void): void {
		this.stdinListener = listener;
		this.stdinBroken = false;

		if (this.stdin.destroyed || this.stdin.readable === false) {
			debugLog('INPUT_MANAGER', '❌ stdin unavailable, skip enablePermanent', {
				destroyed: this.stdin.destroyed,
				readable: this.stdin.readable,
			});
			return;
		}

		try {
			this.stdin.setRawMode(true);
			this.stdin.setEncoding('utf8');
		} catch (error) {
			debugLog('INPUT_MANAGER', `❌ setRawMode failed: ${error}`);
			throw error;
		}

		if (this.dataListenerAttached) {
			this.stdin.off('data', this.handleStdinData);
		}
		this.stdin.on('data', this.handleStdinData);
		this.dataListenerAttached = true;

		if (!this.errorListenerAttached) {
			this.stdin.on('error', this.handleStdinError as any);
			this.errorListenerAttached = true;
		}

		if (!this.closeListenerAttached) {
			this.stdin.on('close', this.handleStdinClose as any);
			this.closeListenerAttached = true;
		}

		if (this.stdin.isPaused?.()) {
			this.stdin.resume();
			debugLog('INPUT_MANAGER', '🔄 Stdin was paused, resumed');
		}

		this.healthCheckInterval = setInterval(() => {
			if (this.stdinBroken || this.stdin.destroyed || this.stdin.readable === false) {
				if (this.healthCheckInterval) {
					clearInterval(this.healthCheckInterval);
					this.healthCheckInterval = null;
				}
				if (process.env.CLI_DEBUG === '1') {
					debugLog('INPUT_MANAGER', '🛑 health check stopped: stdin unavailable', {
						destroyed: this.stdin.destroyed,
						readable: this.stdin.readable,
						stdinBroken: this.stdinBroken,
					});
				}
				return;
			}

			const isPaused = this.stdin.isPaused?.() ?? false;
			if (isPaused) {
				this.pausedStreak++;
				debugLog('INPUT_MANAGER', '⚠️  Stdin was paused, resuming...');
				try {
					this.stdin.resume();
				} catch (error) {
					debugLog('INPUT_MANAGER', `❌ stdin.resume() failed: ${error}`);
				}

				const now = Date.now();
				if (this.pausedStreak >= 20 && (now - this.lastHardRecoverAt > 2000)) {
					this.lastHardRecoverAt = now;
					try {
						if (this.dataListenerAttached) {
							this.stdin.off('data', this.handleStdinData);
						}
						this.stdin.on('data', this.handleStdinData);
						this.dataListenerAttached = true;

						this.stdin.setRawMode(false);
						this.stdin.setRawMode(true);
						this.stdin.setEncoding('utf8');
						this.stdin.resume();

						debugLog('INPUT_MANAGER', '✅ Hard recovered stdin pipeline', {
							pausedStreak: this.pausedStreak,
							dataListeners: this.stdin.listenerCount?.('data'),
						});
					} catch (error) {
						debugLog('INPUT_MANAGER', `❌ hard recovery failed: ${error}`);
					}
				}
			} else {
				this.pausedStreak = 0;
			}

			// aggressive 模式即时恢复；普通模式节流恢复，避免过度抖动
			const isRaw = (this.stdin as NodeJS.ReadStream & {isRaw?: boolean}).isRaw;

			if (process.env.CLI_DEBUG === '1') {
				const now = Date.now();
				if (now - this.lastHealthLogAt > 5000) {
					this.lastHealthLogAt = now;
					debugLog('INPUT_HEALTH', 'stdin health snapshot', {
						paused: isPaused,
						isRaw,
						destroyed: this.stdin.destroyed,
						readable: this.stdin.readable,
						dataListeners: this.stdin.listenerCount?.('data'),
						pausedStreak: this.pausedStreak,
						idleMs: now - this.lastInputAt,
					});
				}
			}

			if (isRaw === false) {
				const now = Date.now();
				const shouldRecover = this.aggressiveCompat || (now - this.rawModeRecoverAt > 3000);
				if (!shouldRecover) {
					return;
				}

				try {
					this.stdin.setRawMode(true);
					this.stdin.setEncoding('utf8');
					this.stdin.resume();
					this.rawModeRecoverAt = now;

					// 限流日志，避免刷屏
					if (now - this.rawModeForcedAt > 1000) {
						debugLog('INPUT_MANAGER', '⚠️  Raw mode lost, force-restored');
						this.rawModeForcedAt = now;
					}
				} catch (error) {
					debugLog('INPUT_MANAGER', `❌ force setRawMode(true) failed: ${error}`);
				}
			}
		}, 100);

		debugLog('INPUT_MANAGER', '✅ Enabled permanently');
	}

	forceRecover(): void {
		if (this.stdinBroken || this.stdin.destroyed || this.stdin.readable === false) {
			debugLog('INPUT_MANAGER', '⚠️ forceRecover skipped: stdin unavailable');
			return;
		}

		try {
			const isPaused = this.stdin.isPaused?.() ?? false;
			const isRaw = (this.stdin as NodeJS.ReadStream & {isRaw?: boolean}).isRaw;

			if (isPaused) {
				this.stdin.resume();
			}
			if (isRaw === false) {
				this.stdin.setRawMode(true);
				this.stdin.setEncoding('utf8');
			}

			debugLog('INPUT_MANAGER', '✅ forceRecover completed', { wasPaused: isPaused, wasRaw: isRaw });
		} catch (error) {
			debugLog('INPUT_MANAGER', `❌ forceRecover failed: ${error}`);
		}
	}

	/**
	 * 禁用输入管理
	 */
	disable(): void {
		// 清理健康检查定时器
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}

		// 移除 stdin 监听器
		if (this.dataListenerAttached) {
			this.stdin.off('data', this.handleStdinData);
			this.dataListenerAttached = false;
		}

		if (this.errorListenerAttached) {
			this.stdin.off('error', this.handleStdinError as any);
			this.errorListenerAttached = false;
		}

		if (this.closeListenerAttached) {
			this.stdin.off('close', this.handleStdinClose as any);
			this.closeListenerAttached = false;
		}

		// 恢复 line mode
		try {
			if (!this.stdin.destroyed && this.stdin.readable !== false) {
				this.stdin.setRawMode(false);
			}
		} catch (error) {
			debugLog('INPUT_MANAGER', `❌ setRawMode(false) failed: ${error}`);
		}

		this.stdinListener = null;

		debugLog('INPUT_MANAGER', '🔻 Disabled');
	}

	private handleStdinData = (data: Buffer | string): void => {
		if (this.stdinBroken || !this.stdinListener) {
			return;
		}
		this.lastInputAt = Date.now();
		const input = data.toString();

		if (input.includes('\x1b[<')) {
			const sgrRegex = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
			let match;
			let remainingInput = input;

			while ((match = sgrRegex.exec(input)) !== null) {
				const button = parseInt(match[1], 10);
				const eventType = match[4];

				if (eventType === 'M' && this.mouseWheelCallback) {
					if (button === 64) {
						this.mouseWheelCallback('up');
					} else if (button === 65) {
						this.mouseWheelCallback('down');
					}
				}

				remainingInput = remainingInput.replace(match[0], '');
			}

			if (remainingInput.trim() === '') {
				return;
			}

			if (remainingInput.length > 0) {
				this.stdinListener?.(remainingInput);
				for (const listener of this.secondaryListeners) {
					listener(remainingInput);
				}
				return;
			}
		}

		this.stdinListener?.(input);
		for (const listener of this.secondaryListeners) {
			listener(input);
		}
	};

	private handleStdinError = (error: Error & {code?: string}): void => {
		const code = error?.code || '';
		const message = error?.message || '';
		const isReadEio = code === 'EIO' || message.includes('read EIO');

		if (isReadEio) {
			this.stdinBroken = true;
			debugLog('INPUT_MANAGER', '⚠️ stdin read EIO detected, entering degraded mode', {
				code,
				message,
				destroyed: this.stdin.destroyed,
				readable: this.stdin.readable,
			});
			return;
		}

		debugLog('INPUT_MANAGER', `❌ stdin error: ${message}`, {code});
	};

	private handleStdinClose = (): void => {
		this.stdinBroken = true;
		debugLog('INPUT_MANAGER', '⚠️ stdin closed, input manager degraded', {
			destroyed: this.stdin.destroyed,
			readable: this.stdin.readable,
		});
	};
}

// 全局单例
let globalInputManager: InputManager | null = null;

export function getInputManager(
	stdin?: NodeJS.ReadStream & {setRawMode(mode: boolean): void},
): InputManager {
	if (!globalInputManager && stdin) {
		globalInputManager = new InputManager(stdin);
	}

	if (!globalInputManager) {
		throw new Error('InputManager not initialized');
	}

	return globalInputManager;
}
