// @ts-nocheck
import {EventEmitter} from 'node:events';
import process from 'node:process';
import React, {PureComponent, type ReactNode} from 'react';
import cliCursor from 'cli-cursor';
import AppContext from './AppContext.js';
import StdinContext from './StdinContext.js';
import StdoutContext from './StdoutContext.js';
import StderrContext from './StderrContext.js';
import FocusContext from './FocusContext.js';
import {getInputManager} from '../InputManager.js';
import {getFrameScheduler} from '../FrameScheduler.js';
import {PasteParser} from '../PasteParser.js';
import {debugLog} from '@neoxlabs/core/platform/cliLogger.js';
import ErrorOverview from './ErrorOverview.js';

const tab = '\t';
const shiftTab = '\u001B[Z';
const escape = '\u001B';

type Props = {
	readonly children: ReactNode;
	readonly stdin: NodeJS.ReadStream;
	readonly stdout: NodeJS.WriteStream;
	readonly stderr: NodeJS.WriteStream;
	readonly writeToStdout: (data: string) => void;
	readonly writeToStderr: (data: string) => void;
	readonly exitOnCtrlC: boolean;
	readonly onExit: (error?: Error) => void;
	readonly onResize?: () => void;
	readonly skipInit?: boolean;
};

type State = {
	readonly isFocusEnabled: boolean;
	readonly activeFocusId?: string;
	readonly focusables: Focusable[];
	readonly error?: Error;
	readonly terminalColumns: number;
	readonly terminalRows: number;
};

type Focusable = {
	readonly id: string;
	readonly isActive: boolean;
};

// Root component for all Ink apps
// It renders stdin and stdout contexts, so that children can access them if needed
// It also handles Ctrl+C exiting and cursor visibility
export default class App extends PureComponent<Props, State> {
	static displayName = 'InternalApp';

	static getDerivedStateFromError(error: Error) {
		return {error};
	}

	override state = {
		isFocusEnabled: true,
		activeFocusId: undefined,
		focusables: [],
		error: undefined,
		terminalColumns: process.stdout.columns || 80,
		terminalRows: process.stdout.rows || 24,
	};

	// This counter is no longer needed
	// eslint-disable-next-line @typescript-eslint/naming-convention
	internal_eventEmitter = new EventEmitter();
	private pasteParser: PasteParser | null = null;
	private _secondaryInputHandler: ((data: string) => void) | null = null;

	// Determines if TTY is supported on the provided stdin
	isRawModeSupported(): boolean {
		return this.props.stdin.isTTY;
	}

	override render() {
		return (
			<AppContext.Provider
				// eslint-disable-next-line react/jsx-no-constructed-context-values
				value={{
					exit: this.handleExit,
				}}
			>
				<StdinContext.Provider
					// eslint-disable-next-line react/jsx-no-constructed-context-values
					value={{
						stdin: this.props.stdin,
						setRawMode: this.handleSetRawMode,
						isRawModeSupported: this.isRawModeSupported(),
						// eslint-disable-next-line @typescript-eslint/naming-convention
						internal_exitOnCtrlC: this.props.exitOnCtrlC,
						// eslint-disable-next-line @typescript-eslint/naming-convention
						internal_eventEmitter: this.internal_eventEmitter,
					}}
				>
					<StdoutContext.Provider
						// eslint-disable-next-line react/jsx-no-constructed-context-values
						value={{
							stdout: this.props.stdout,
							write: this.props.writeToStdout,
							columns: this.state.terminalColumns,
							rows: this.state.terminalRows,
						}}
					>
						<StderrContext.Provider
							// eslint-disable-next-line react/jsx-no-constructed-context-values
							value={{
								stderr: this.props.stderr,
								write: this.props.writeToStderr,
							}}
						>
							<FocusContext.Provider
								// eslint-disable-next-line react/jsx-no-constructed-context-values
								value={{
									activeId: this.state.activeFocusId,
									add: this.addFocusable,
									remove: this.removeFocusable,
									activate: this.activateFocusable,
									deactivate: this.deactivateFocusable,
									enableFocus: this.enableFocus,
									disableFocus: this.disableFocus,
									focusNext: this.focusNext,
									focusPrevious: this.focusPrevious,
									focus: this.focus,
								}}
							>
								{this.state.error ? (
									<ErrorOverview error={this.state.error as Error} />
								) : (
									this.props.children
								)}
							</FocusContext.Provider>
						</StderrContext.Provider>
					</StdoutContext.Provider>
				</StdinContext.Provider>
			</AppContext.Provider>
		);
	}

	override componentDidMount() {
		// They don't initialize InputManager, cursor, paste mode, etc.
		if (this.props.skipInit) {
			// Subscribe to InputManager events so useInput works in this container
			if (this.props.stdin.isTTY) {
				try {
					const inputManager = getInputManager();
					this.pasteParser = new PasteParser();
					this._secondaryInputHandler = (data: string) => {
						this.pasteParser?.parse(data, (text: string, isPaste: boolean) => {
							if (isPaste) {
								void this.handlePaste(text);
							} else {
								this.handleInput(text);
								this.internal_eventEmitter.emit('input', text);
							}
						});
					};
					inputManager.addSecondaryListener(this._secondaryInputHandler);
				} catch {
					// InputManager may not be initialized yet
				}
			}
			return;
		}

		cliCursor.hide(this.props.stdout);

		if (this.props.stdin.isTTY) {
			this.props.stdout.write('\x1b[?2004h');

			debugLog('INK_APP', '✅ Bracketed Paste Mode enabled');

			this.pasteParser = new PasteParser();

			const inputManager = getInputManager(this.props.stdin as any);
			inputManager.enablePermanent((data: string) => {
				this.pasteParser!.parse(data, (text: string, isPaste: boolean) => {
					if (isPaste) {
						this.handlePaste(text);
					} else {
						this.handleInput(text);
					}
					this.internal_eventEmitter.emit('input', text);
				});
			});

			debugLog('INK_APP', '✅ InputManager and PasteParser initialized');

			if (process.env.FRAME_SCHEDULER_DEBUG === '1') {
				setInterval(() => {
					const stats = getFrameScheduler().getStats();
					debugLog('FRAME_SCHEDULER', 'Stats', stats);
				}, 5000);
			}
		}

		// This allows users to select and copy text even in raw mode
		// CSI ? 1000 h - Enable mouse tracking (for clicks)
		// CSI ? 1002 h - Enable mouse motion tracking
		// CSI ? 1006 h - Enable SGR mouse mode (better compatibility)
		// 滚轮事件需要 SGR 模式才能工作

		// This triggers React re-render so components using StdoutContext get new dimensions
		this.props.stdout.on('resize', this.handleResize);
	}

	// 注意：清除逻辑由 Ink 类通过 TerminalAdapter 统一处理
	// 这里只负责更新 React state
	handleResize = () => {
		const newColumns = this.props.stdout.columns || 80;
		const newRows = this.props.stdout.rows || 24;

		if (process.env.NEOX_INK_DEBUG === '1') {
			process.stderr.write(
				`[APP_RESIZE] 📐 Resize detected: ${this.state.terminalColumns}x${this.state.terminalRows} → ${newColumns}x${newRows}\n`
			);
		}

		// this.props.onResize?.();

		// 只更新 React state 触发重新渲染
		this.setState({
			terminalColumns: newColumns,
			terminalRows: newRows,
		});
	};

	override componentWillUnmount() {
		if (this.props.skipInit) {
			if (this._secondaryInputHandler) {
				try {
					getInputManager().removeSecondaryListener(this._secondaryInputHandler);
				} catch {
					// InputManager may not exist
				}
				this._secondaryInputHandler = null;
			}
			this.pasteParser?.dispose();
			this.pasteParser = null;
			return;
		}

		cliCursor.show(this.props.stdout);

		this.props.stdout.off('resize', this.handleResize);

		if (this.isRawModeSupported()) {
			this.props.stdout.write('\x1b[?2004l');

			this.pasteParser?.dispose();
			this.pasteParser = null;

			try {
				getInputManager().disable();
			} catch (e) {
				// InputManager 可能未初始化
			}

			debugLog('INK_APP', '🔻 Bracketed Paste Mode disabled and resources cleaned up');
		}
	}

	override componentDidCatch(error: Error) {
		this.handleExit(error);
	}

	handleSetRawMode = (isEnabled: boolean): void => {
		if (!this.isRawModeSupported()) {
			throw new Error(
				'Raw mode is not supported on the current stdin.\nRead about how to prevent this error on https://github.com/vadimdemedes/ink/#israwmodesupported',
			);
		}

		// This method is kept for StdinContext API compatibility but doesn't need to do anything
		// Raw mode is enabled once on mount and disabled once on unmount
	};

	handleInput = (input: string): void => {
		// Exit on Ctrl+C
		// eslint-disable-next-line unicorn/no-hex-escape
		if (input === '\x03' && this.props.exitOnCtrlC) {
			this.handleExit();
		}

		// Reset focus when there's an active focused component on Esc
		if (input === escape && this.state.activeFocusId) {
			this.setState({
				activeFocusId: undefined,
			});
		}

		if (this.state.isFocusEnabled && this.state.focusables.length > 0) {
			if (input === tab) {
				this.focusNext();
			}

			if (input === shiftTab) {
				this.focusPrevious();
			}
		}
	};

	handlePaste = async (text: string): Promise<void> => {
		debugLog('INPUT_PASTE', `📋 Pasted ${text.length} characters`);

		if (text.length === 0) {
			debugLog('INPUT_PASTE', '🖼️  Empty paste detected - checking clipboard for image...');

			try {
				// 动态导入以避免循环依赖
				const {pasteImageAsBase64} = await import('../../../../cli/utils/clipboardImage.js');
				const imageData = await pasteImageAsBase64();

				if (imageData) {
					debugLog('INPUT_PASTE', `📎 Image detected in clipboard: ${imageData.name} (${Math.round(imageData.data.length / 1024)}KB)`);
					// 触发图片粘贴事件
					this.internal_eventEmitter.emit('image-paste', imageData);
					return; // 不继续处理为文本
				}
			} catch (error) {
				debugLog('INPUT_PASTE', '❌ Failed to check clipboard for image', {error});
			}
		}

		// 触发粘贴事件
		this.internal_eventEmitter.emit('paste', text);

		this.internal_eventEmitter.emit('input', text);

		// 也触发普通 input 事件（保持兼容性）
		this.handleInput(text);
	};

	handleExit = (error?: Error): void => {
		if (this.isRawModeSupported()) {
			this.handleSetRawMode(false);
		}

		this.props.onExit(error);
	};

	enableFocus = (): void => {
		this.setState({
			isFocusEnabled: true,
		});
	};

	disableFocus = (): void => {
		this.setState({
			isFocusEnabled: false,
		});
	};

	focus = (id: string): void => {
		this.setState(previousState => {
			const hasFocusableId = previousState.focusables.some(
				focusable => focusable?.id === id,
			);

			if (!hasFocusableId) {
				return previousState;
			}

			return {activeFocusId: id};
		});
	};

	focusNext = (): void => {
		this.setState(previousState => {
			const firstFocusableId = previousState.focusables.find(
				focusable => focusable.isActive,
			)?.id;
			const nextFocusableId = this.findNextFocusable(previousState);

			return {
				activeFocusId: nextFocusableId ?? firstFocusableId,
			};
		});
	};

	focusPrevious = (): void => {
		this.setState(previousState => {
			const lastFocusableId = previousState.focusables.findLast(
				focusable => focusable.isActive,
			)?.id;
			const previousFocusableId = this.findPreviousFocusable(previousState);

			return {
				activeFocusId: previousFocusableId ?? lastFocusableId,
			};
		});
	};

	addFocusable = (id: string, {autoFocus}: {autoFocus: boolean}): void => {
		this.setState(previousState => {
			let nextFocusId = previousState.activeFocusId;

			if (!nextFocusId && autoFocus) {
				nextFocusId = id;
			}

			return {
				activeFocusId: nextFocusId,
				focusables: [
					...previousState.focusables,
					{
						id,
						isActive: true,
					},
				],
			};
		});
	};

	removeFocusable = (id: string): void => {
		this.setState(previousState => ({
			activeFocusId:
				previousState.activeFocusId === id
					? undefined
					: previousState.activeFocusId,
			focusables: previousState.focusables.filter(focusable => {
				return focusable.id !== id;
			}),
		}));
	};

	activateFocusable = (id: string): void => {
		this.setState(previousState => ({
			focusables: previousState.focusables.map(focusable => {
				if (focusable.id !== id) {
					return focusable;
				}

				return {
					id,
					isActive: true,
				};
			}),
		}));
	};

	deactivateFocusable = (id: string): void => {
		this.setState(previousState => ({
			activeFocusId:
				previousState.activeFocusId === id
					? undefined
					: previousState.activeFocusId,
			focusables: previousState.focusables.map(focusable => {
				if (focusable.id !== id) {
					return focusable;
				}

				return {
					id,
					isActive: false,
				};
			}),
		}));
	};

	findNextFocusable = (state: State): string | undefined => {
		const activeIndex = state.focusables.findIndex(focusable => {
			return focusable.id === state.activeFocusId;
		});

		for (
			let index = activeIndex + 1;
			index < state.focusables.length;
			index++
		) {
			const focusable = state.focusables[index];

			if (focusable?.isActive) {
				return focusable.id;
			}
		}

		return undefined;
	};

	findPreviousFocusable = (state: State): string | undefined => {
		const activeIndex = state.focusables.findIndex(focusable => {
			return focusable.id === state.activeFocusId;
		});

		for (let index = activeIndex - 1; index >= 0; index--) {
			const focusable = state.focusables[index];

			if (focusable?.isActive) {
				return focusable.id;
			}
		}

		return undefined;
	};
}
