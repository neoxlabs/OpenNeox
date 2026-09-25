// @ts-nocheck
import process from 'node:process';
import {platform} from 'node:os';
import React, {type ReactNode} from 'react';
import {throttle} from 'es-toolkit/compat';
import isInCi from 'is-in-ci';
import autoBind from 'auto-bind';
import {onExit} from 'signal-exit';
import patchConsole from 'patch-console';
import {LegacyRoot} from 'react-reconciler/constants.js';
import {type FiberRoot} from 'react-reconciler';
import Yoga from 'yoga-layout';
import reconciler from './reconciler.js';
import render from './renderer.js';
import * as dom from './dom.js';
import instances from './instances.js';
import App from './components/App.js';
import {accessibilityContext as AccessibilityContext} from './components/AccessibilityContext.js';
import {getFrameScheduler, RenderPriority} from './FrameScheduler.js';
import {getInputManager} from './InputManager.js';
import {
	TerminalAdapter,
	getTerminalAdapter,
	resetTerminalAdapter,
	ANSI,
	AltScreenRenderer,
	InlineRenderer,
	createAltScreenRenderer,
	createInlineRenderer,
	type TerminalSize,
} from './terminal/index.js';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { cliLogger } from '@neoxlabs/core/platform/cliLogger.js';

const noop = () => {};
const INK_RENDER_DEBUG = process.env.INK_RENDER_DEBUG === '1' || process.env.CLI_DEBUG === '1';
const INK_RENDER_LOG_SAMPLE = Math.max(1, Number.parseInt(process.env.INK_RENDER_LOG_SAMPLE ?? '1', 10) || 1);

/**
Performance metrics for a render operation.
*/
export type RenderMetrics = {
	/**
	Time spent rendering in milliseconds.
	*/
	renderTime: number;
};

export type Options = {
	stdout: NodeJS.WriteStream;
	stdin: NodeJS.ReadStream;
	stderr: NodeJS.WriteStream;
	debug: boolean;
	exitOnCtrlC: boolean;
	patchConsole: boolean;
	onRender?: (metrics: RenderMetrics) => void;
	isScreenReaderEnabled?: boolean;
	waitUntilExit?: () => Promise<void>;
	maxFps?: number;
	incrementalRendering?: boolean;
	useAltScreen?: boolean;
};

export default class Ink {
	private readonly options: Options;
	private readonly isScreenReaderEnabled: boolean;

	// 渲染器：默认 inline，可选 alt-screen
	private readonly renderer: AltScreenRenderer | InlineRenderer;
	private readonly useAltScreen: boolean;

	// Ignore last render after unmounting a tree to prevent empty output before exit
	private isUnmounted: boolean;
	private lastOutput: string;
	private lastOutputHeight: number;
	// Each container has its own fiber tree → independent reconciliation
	private readonly container: FiberRoot;       // Static zone (Header + committed entries)
	private readonly containerDynamic: FiberRoot; // Dynamic zone (pending/streaming entries)
	private readonly containerBottom: FiberRoot;  // Bottom zone (StatusLine + InputLine)
	private readonly rootNode: dom.DOMElement;
	private readonly staticSlot: dom.DOMElement;
	private readonly dynamicSlot: dom.DOMElement;
	private readonly bottomSlot: dom.DOMElement;
	private exitPromise?: Promise<void>;
	private restoreConsole?: () => void;
	private readonly unsubscribeResize?: () => void;

	private readonly terminalAdapter: TerminalAdapter;
	private unsubscribeTerminalResize?: () => void;

	private _accumulatedStatic = '';
	/* Inline 模式 live 区变矮的兜底 (见 onRender): 已写进滚动区的行数 / 上一帧 live 行数 / 屏幕是否已满过 */
	private _writtenStaticRows = 0;
	private _lastLiveRows = 0;
	private _pinned = false;
	/** 屏满后 live 区缩掉的行, 补在 live 顶部的空行数 (见 onRender) */
	private _shrinkPad = 0;
	private _lastFullOutput = '';
	private _renderDebugCounter = 0;

	// TTY 断开标记：write EIO 后停止所有渲染，避免死循环
	private _ttyBroken = false;

	private shouldLogRenderDebug = (): boolean => {
		if (!INK_RENDER_DEBUG) {
			return false;
		}

		this._renderDebugCounter += 1;
		return this._renderDebugCounter % INK_RENDER_LOG_SAMPLE === 0;
	};

	scrollUp = (lines = 3) => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.scrollUp(lines)) {
			this.onRender();
		}
	};

	scrollDown = (lines = 3) => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.scrollDown(lines)) {
			this.onRender();
		}
	};

	pageUp = () => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.pageUp()) {
			this.onRender();
		}
	};

	pageDown = () => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.pageDown()) {
			this.onRender();
		}
	};

	scrollToTop = () => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.scrollToTop()) {
			this.onRender();
		}
	};

	scrollToBottom = () => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return;
		}

		if (this.renderer.scrollToBottom()) {
			this.onRender();
		}
	};

	canScroll = () => {
		if (!this.useAltScreen || !(this.renderer instanceof AltScreenRenderer)) {
			return {up: false, down: false};
		}

		return this.renderer.canScroll();
	};

	private setupMouseWheelHandler() {
		try {
			const inputManager = getInputManager();

			inputManager.setMouseWheelCallback((direction) => {
				if (direction === 'up') {
					this.scrollUp(3);
				} else {
					this.scrollDown(3);
				}
			});

			if (process.env.NEOX_INK_DEBUG === '1') {
				process.stderr.write('[INK] 🖱️ Mouse wheel handler installed via InputManager\n');
			}
		} catch (err) {
			// InputManager 可能还没初始化，延迟重试
			if (process.env.NEOX_INK_DEBUG === '1') {
				process.stderr.write(`[INK] ⚠️ InputManager not ready, will retry: ${err}\n`);
			}
			setTimeout(() => this.setupMouseWheelHandler(), 100);
		}
	}

	constructor(options: Options) {
		autoBind(this);

		this.options = options;
		this.rootNode = dom.createNode('ink-root');
		this.rootNode.onComputeLayout = this.calculateLayout;

		// Each slot is an ink-box that serves as mount point for an independent React container
		this.staticSlot = dom.createNode('ink-box');
		this.dynamicSlot = dom.createNode('ink-box');
		this.bottomSlot = dom.createNode('ink-box');
		dom.appendChildNode(this.rootNode, this.staticSlot);
		dom.appendChildNode(this.rootNode, this.dynamicSlot);
		dom.appendChildNode(this.rootNode, this.bottomSlot);

		// Slot nodes delegate layout/render to rootNode
		const slotOnComputeLayout = this.calculateLayout;
		const slotOnRender = () => {
			if (typeof this.rootNode.onRender === 'function') {
				this.rootNode.onRender();
			}
		};
		const slotOnImmediateRender = () => {
			if (typeof this.rootNode.onImmediateRender === 'function') {
				this.rootNode.onImmediateRender();
			}
		};
		for (const slot of [this.staticSlot, this.dynamicSlot, this.bottomSlot]) {
			slot.onComputeLayout = slotOnComputeLayout;
			slot.onRender = slotOnRender;
			slot.onImmediateRender = slotOnImmediateRender;
		}

		// The renderer looks for rootNode.staticNode, but reconciler sets it on the container root (staticSlot)
		const rootNode = this.rootNode;
		const originalStaticSlot = this.staticSlot;
		Object.defineProperty(originalStaticSlot, 'staticNode', {
			get() { return rootNode.staticNode; },
			set(value) { rootNode.staticNode = value; },
			configurable: true,
		});
		Object.defineProperty(originalStaticSlot, 'isStaticDirty', {
			get() { return rootNode.isStaticDirty; },
			set(value) { rootNode.isStaticDirty = value; },
			configurable: true,
		});

		this.isScreenReaderEnabled =
			options.isScreenReaderEnabled ??
			process.env['INK_SCREEN_READER'] === 'true';

		// This provides: resize polling (Win/WSL), synchronized update, alternate screen
		this.terminalAdapter = getTerminalAdapter({
			stdout: options.stdout,
			stdin: options.stdin,
			// Poll resize every 500ms on Windows/WSL (SIGWINCH is unreliable)
			resizePollInterval: undefined, // auto-detect based on platform
		});

		// Log terminal capabilities in debug mode
		if (process.env.NEOX_INK_DEBUG === '1') {
			const caps = this.terminalAdapter.capabilities;
			process.stderr.write(
				`[INK] 🖥️ Terminal: ${caps.terminalType}, ` +
				`syncUpdate=${caps.synchronizedUpdate}, ` +
				`altScreen=${caps.alternateScreen}, ` +
				`trueColor=${caps.trueColor}\n`
			);
		}

		const unthrottled = options.debug || this.isScreenReaderEnabled;
		const maxFps = options.maxFps ?? 30;
		const renderThrottleMs =
			maxFps > 0 ? Math.max(1, Math.ceil(1000 / maxFps)) : 0;

		this.useAltScreen = options.useAltScreen ?? false;

		// Frame Scheduler 提供：优先级队列、去重、统计
		const frameScheduler = getFrameScheduler();

		// Debug 模式使用 IMMEDIATE 优先级，确保立即渲染但仍然经过调度
		this.rootNode.onRender = () => {
			const priority = unthrottled
				? RenderPriority.IMMEDIATE
				: RenderPriority.NORMAL;

			frameScheduler.scheduleFrame('ink-root-render', this.onRender, priority);

			if (process.env.NEOX_INK_DEBUG === '1') {
				const priorityName = unthrottled ? 'IMMEDIATE' : 'NORMAL';
				process.stderr.write(
					`[INK] 📅 Render scheduled with ${priorityName} priority\n`,
				);
			}
		};

		this.rootNode.onImmediateRender = () => {
			frameScheduler.scheduleFrame(
				'ink-root-immediate',
				this.onRender,
				RenderPriority.IMMEDIATE,
			);
			if (process.env.NEOX_INK_DEBUG === '1') {
				process.stderr.write('[INK] 🚀 Render scheduled with IMMEDIATE priority\n');
			}
		};

		if (this.useAltScreen) {
			this.renderer = createAltScreenRenderer();
			this.renderer.start();

			this.setupMouseWheelHandler();
		} else {
			this.renderer = createInlineRenderer({
				incremental: options.incrementalRendering !== false,
			});
		}

		// Ignore last render after unmounting a tree to prevent empty output before exit
		this.isUnmounted = false;

		// Store last output to only rerender when needed
		this.lastOutput = '';
		this.lastOutputHeight = 0;

		// TTY 断开保护：监听 stdout/stderr 的 error 事件
		// write EIO 通过 stream error 事件异步抛出，try-catch 抓不住
		// 必须用 listener 捕获，设置 _ttyBroken 停止所有后续渲染
		const markTtyBroken = (err: Error) => {
			const code = (err as any)?.code;
			if (code === 'EIO' || err.message?.includes('EIO')) {
				this._ttyBroken = true;
			}
		};
		options.stdout.on('error', markTtyBroken);
		options.stderr?.on('error', markTtyBroken);


		// Each container has its own fiber tree → setState in one never triggers reconciliation in others
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.container = reconciler.createContainer(
			this.staticSlot,
			LegacyRoot,
			null,
			false,
			null,
			'static',
			() => {},
			() => {},
			() => {},
			() => {},
			null,
		);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.containerDynamic = reconciler.createContainer(
			this.dynamicSlot,
			LegacyRoot,
			null,
			false,
			null,
			'dynamic',
			() => {},
			() => {},
			() => {},
			() => {},
			null,
		);

		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		this.containerBottom = reconciler.createContainer(
			this.bottomSlot,
			LegacyRoot,
			null,
			false,
			null,
			'bottom',
			() => {},
			() => {},
			() => {},
			() => {},
			null,
		);

		// Unmount when process exits
		this.unsubscribeExit = onExit(this.unmount, {alwaysLast: false});

		if (process.env['DEV'] === 'true') {
			reconciler.injectIntoDevTools({
				bundleType: 0,
				// Reporting React DOM's version, not Ink's
				// See https://github.com/facebook/react/issues/16666#issuecomment-532639905
				version: '16.13.1',
				rendererPackageName: 'ink',
			});
		}

		if (options.patchConsole) {
			this.patchConsole();
		}

		if (!isInCi) {
			// This works reliably on Windows/WSL (uses polling) and Unix (uses SIGWINCH)
			this.terminalAdapter.on('resize', this.handleTerminalResize);
			this.unsubscribeTerminalResize = () => {
				this.terminalAdapter.off('resize', this.handleTerminalResize);
			};
		}
	}

	handleTerminalResize = (newSize: TerminalSize, oldSize: TerminalSize) => {
		if (process.env.NEOX_INK_DEBUG === '1') {
			process.stderr.write(
				`[INK] 📐 Resize: ${oldSize.columns}x${oldSize.rows} → ${newSize.columns}x${newSize.rows}\n`
			);
		}

		if (!this.useAltScreen && this.renderer instanceof InlineRenderer) {
			this.renderer.handleResize(newSize.columns);
		}

		this.handleResizeFromApp();
	};

	getTerminalWidth = () => {
		// The 'columns' property can be undefined or 0 when not using a TTY.
		// In that case we fall back to 80.
		return this.options.stdout.columns || 80;
	};

	resized = () => {
		// React's App.handleResize() will setState() which triggers re-render
		// If we render here too, we get duplicate output
		if (!this.options.debug) {
			this.renderer.clear();
		}
		/* 改尺寸后折行全变了, 行数账作废 */
		this._lastLiveRows = 0;
		this._shrinkPad = 0;

		this.calculateLayout();
	};

	// AltScreen 模式：直接重新计算布局并渲染
	handleResizeFromApp = () => {
		if (process.env.NEOX_INK_DEBUG === '1') {
			process.stderr.write(
				`[INK_RESIZE] 📐 handleResizeFromApp called, lastOutput=${this.lastOutput.length} chars, lastOutputHeight=${this.lastOutputHeight}\n`
			);
		}

		this.calculateLayout();

		// Inline/Alt 都在这里统一触发渲染
		this.onRender();
	};

	resolveExitPromise: () => void = () => {};
	rejectExitPromise: (reason?: Error) => void = () => {};
	unsubscribeExit: () => void = () => {};

	calculateLayout = () => {
		const terminalWidth = this.getTerminalWidth();

		this.rootNode.yogaNode!.setWidth(terminalWidth);

		this.rootNode.yogaNode!.calculateLayout(
			undefined,
			undefined,
			Yoga.DIRECTION_LTR,
		);
	};

	onRender: () => void = () => {
		if (this.isUnmounted || this._ttyBroken) {
			return;
		}


		const traceRender = this.shouldLogRenderDebug();
		if (traceRender) {
			cliLogger.debug('INK_RENDER', 'onRender called');
		}

		const startTime = performance.now();
		// eslint-disable-next-line prefer-const
		let {output, outputHeight, staticOutput} = render(
			this.rootNode,
			this.isScreenReaderEnabled,
		);
		const renderTime = performance.now() - startTime;

		if (traceRender) {
			cliLogger.debug('INK_RENDER', `output=${output.length} chars, outputHeight=${outputHeight}, staticOutput=${staticOutput?.length || 0} chars, lastOutput=${this.lastOutput.length} chars`);
		}

		if (process.env.CLI_DEBUG === '1' && renderTime > 100) {
			cliLogger.warn('INK_RENDER', `Slow render: ${renderTime.toFixed(1)}ms, outputHeight=${outputHeight}`);
		}

		this.options.onRender?.({renderTime});

		// If <Static> output isn't empty, it means new children have been added to it
		const hasStaticOutput = staticOutput && staticOutput !== '\n';

		try {

		if (this.options.debug) {
			// In debug mode, write static output once (don't accumulate)
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}
			// Only write dynamic output if changed
			if (output !== this.lastOutput) {
				this.options.stdout.write(output);
				this.lastOutput = output;
				this.lastOutputHeight = outputHeight;
			}
			return;
		}

		if (isInCi) {
			if (hasStaticOutput) {
				this.options.stdout.write(staticOutput);
			}

			this.lastOutput = output;
			this.lastOutputHeight = outputHeight;
			return;
		}

		if (this.isScreenReaderEnabled) {
			if (hasStaticOutput) {
				// 使用自研 ANSI 清除
				const erase =
					this.lastOutputHeight > 0
						? ANSI.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + staticOutput);
				this.lastOutputHeight = 0;
			}

			if (output === this.lastOutput && !hasStaticOutput) {
				return;
			}

			const terminalWidth = this.options.stdout.columns || 80;

			const wrappedOutput = this.wrapText(output, terminalWidth);

			if (hasStaticOutput) {
				this.options.stdout.write(wrappedOutput);
			} else {
				const erase =
					this.lastOutputHeight > 0
						? ANSI.eraseLines(this.lastOutputHeight)
						: '';
				this.options.stdout.write(erase + wrappedOutput);
			}

			this.lastOutput = output;
			this.lastOutputHeight =
				wrappedOutput === '' ? 0 : wrappedOutput.split('\n').length;
			return;
		}

		if (this.useAltScreen) {
			const useSyncUpdate = this.terminalAdapter.capabilities.synchronizedUpdate;

			if (hasStaticOutput) {
				this._accumulatedStatic += staticOutput;
			}

			const fullOutput = this._accumulatedStatic + output;

			if (fullOutput !== this._lastFullOutput) {
				if (useSyncUpdate) {
					this.terminalAdapter.beginSyncUpdate();
				}
				try {
					this.renderer.render(fullOutput);
				} finally {
					if (useSyncUpdate) {
						this.terminalAdapter.endSyncUpdate();
					}
				}

				this._lastFullOutput = fullOutput;
			}
		} else {
			const rows = this.options.stdout.rows || 24;
			const s = hasStaticOutput ? Math.max(0, staticOutput.split('\n').length - 1) : 0;
			this._writtenStaticRows += s;
			this._shrinkPad = Math.max(0, this._shrinkPad - s);
			const liveRows = output === '' ? 0 : output.split('\n').length;
			this._pinned = this._pinned || this._writtenStaticRows - s + this._lastLiveRows >= rows;
			if (this._pinned && this._lastLiveRows > 0 && liveRows + this._shrinkPad < this._lastLiveRows - s) {
				this._shrinkPad = Math.min(this._lastLiveRows - s - liveRows, Math.floor(rows / 2));
			} else if (liveRows + this._shrinkPad > this._lastLiveRows) {
				/* live 长高: 先用掉顶部补的空行, 不必把屏幕往上推 */
				this._shrinkPad = Math.max(0, this._lastLiveRows - s - liveRows);
			}
			this._lastLiveRows = liveRows + this._shrinkPad;
			if (this._shrinkPad > 0) output = '\n'.repeat(this._shrinkPad) + output;

			// Inline 模式：先清动态区，再写 static，最后重绘动态区
			if (hasStaticOutput) {
				if (traceRender) {
					const staticLines = staticOutput.split('\n');
					const stripped = staticOutput.replace(/\x1b\[[^m]*m/g, '');
					const blankLineCount = stripped.split('\n').filter(l => l.trim() === '').length;
					cliLogger.debug('INK_RENDER',
						`STATIC output: ${staticLines.length} lines, ${staticOutput.length} chars, ` +
						`endsWithNewline=${staticOutput.endsWith('\n')}, blankLines=${blankLineCount}, ` +
						`first80="${stripped.slice(0, 80).replace(/\n/g, '\\n')}"`
					);
				}
				const useSyncUpdate = this.terminalAdapter.capabilities.synchronizedUpdate;
				if (useSyncUpdate) this.terminalAdapter.beginSyncUpdate();
				try {
					this.renderer.clear();
					this.options.stdout.write(staticOutput);
					this.renderer.render(output);
				} finally {
					if (useSyncUpdate) this.terminalAdapter.endSyncUpdate();
				}
			} else if (output !== this.lastOutput) {
				if (traceRender) {
					cliLogger.debug('INK_RENDER',
						`DYNAMIC only: output changed, ${output.length} chars, ` +
						`outputLines=${output.split('\n').length}, endsWithNewline=${output.endsWith('\n')}`
					);
				}
				this.renderer.render(output);
			} else if (traceRender) {
				cliLogger.debug('INK_RENDER', 'SKIP: output unchanged');
			}
		}

		this.lastOutput = output;
		this.lastOutputHeight = outputHeight;

		} catch (writeError: any) {
			// TTY 断开后 write 会抛 EIO，标记后停止所有后续渲染
			if (writeError?.code === 'EIO' || writeError?.message?.includes('EIO')) {
				this._ttyBroken = true;
				cliLogger.warn('INK_RENDER', 'TTY broken (write EIO), rendering disabled');
				return;
			}
			throw writeError;
		}

		if (traceRender) {
			cliLogger.debug('INK_RENDER', 'onRender completed');
		}
	};

	render(node: ReactNode): void {
		const tree = (
			<AccessibilityContext.Provider
				value={{isScreenReaderEnabled: this.isScreenReaderEnabled}}
			>
				<App
					stdin={this.options.stdin}
					stdout={this.options.stdout}
					stderr={this.options.stderr}
					writeToStdout={this.writeToStdout}
					writeToStderr={this.writeToStderr}
					exitOnCtrlC={this.options.exitOnCtrlC}
					onExit={this.unmount}
					onResize={this.handleResizeFromApp}
				>
					{node}
				</App>
			</AccessibilityContext.Provider>
		);

		// @ts-expect-error the types for `react-reconciler` are not up to date with the library.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		reconciler.updateContainerSync(tree, this.container, null, noop);
		// @ts-expect-error the types for `react-reconciler` are not up to date with the library.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		reconciler.flushSyncWork();
	}

	renderDynamic(node: ReactNode): void {
		const tree = (
			<AccessibilityContext.Provider
				value={{isScreenReaderEnabled: this.isScreenReaderEnabled}}
			>
				<App
					stdin={this.options.stdin}
					stdout={this.options.stdout}
					stderr={this.options.stderr}
					writeToStdout={this.writeToStdout}
					writeToStderr={this.writeToStderr}
					exitOnCtrlC={false}
					onExit={noop}
					onResize={this.handleResizeFromApp}
					skipInit
				>
					{node}
				</App>
			</AccessibilityContext.Provider>
		);

		// @ts-expect-error
		reconciler.updateContainerSync(tree, this.containerDynamic, null, noop);
		// @ts-expect-error
		reconciler.flushSyncWork();
	}

	renderBottom(node: ReactNode): void {
		const tree = (
			<AccessibilityContext.Provider
				value={{isScreenReaderEnabled: this.isScreenReaderEnabled}}
			>
				<App
					stdin={this.options.stdin}
					stdout={this.options.stdout}
					stderr={this.options.stderr}
					writeToStdout={this.writeToStdout}
					writeToStderr={this.writeToStderr}
					exitOnCtrlC={false}
					onExit={noop}
					onResize={this.handleResizeFromApp}
					skipInit
				>
					{node}
				</App>
			</AccessibilityContext.Provider>
		);

		// @ts-expect-error
		reconciler.updateContainerSync(tree, this.containerBottom, null, noop);
		// @ts-expect-error
		reconciler.flushSyncWork();
	}

	writeToStdout(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		if (this.options.debug) {
			this.options.stdout.write(data + this.lastOutput);
			return;
		}

		if (isInCi) {
			this.options.stdout.write(data);
			return;
		}

		this.renderer.clear();
		this.options.stdout.write(data);
		this.renderer.render(this.lastOutput);
	}

	writeToStderr(data: string): void {
		if (this.isUnmounted) {
			return;
		}

		if (this.options.debug) {
			this.options.stderr.write(data);
			this.options.stdout.write(this.lastOutput);
			return;
		}

		if (isInCi) {
			this.options.stderr.write(data);
			return;
		}

		this.renderer.clear();
		this.options.stderr.write(data);
		this.renderer.render(this.lastOutput);
	}

	// eslint-disable-next-line @typescript-eslint/ban-types
	unmount(error?: Error | number | null): void {
		if (this.isUnmounted) {
			return;
		}

		this.calculateLayout();
		this.onRender();
		this.unsubscribeExit();

		if (typeof this.restoreConsole === 'function') {
			this.restoreConsole();
		}

		if (typeof this.unsubscribeResize === 'function') {
			this.unsubscribeResize();
		}

		try {
			const inputManager = getInputManager();
			inputManager.setMouseWheelCallback(null);
		} catch {
			// InputManager may not be initialized
		}

		if (typeof this.unsubscribeTerminalResize === 'function') {
			this.unsubscribeTerminalResize();
		}

		this.terminalAdapter.reset();

		// CIs don't handle erasing ansi escapes well, so it's better to
		// only render last frame of non-static output
		if (isInCi) {
			this.options.stdout.write(this.lastOutput + '\n');
		} else if (!this.options.debug && !this.useAltScreen) {
			// Alt screen content is discarded on leave, skip renderer.done()
			this.renderer.done();
		}

		// Ensure shell prompt starts on a clean line after leaving alt screen
		if (this.useAltScreen) {
			this.options.stdout.write('\n');
		}

		this.isUnmounted = true;

		// @ts-expect-error the types for `react-reconciler` are not up to date with the library.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		reconciler.updateContainerSync(null, this.container, null, noop);
		// @ts-expect-error
		reconciler.updateContainerSync(null, this.containerDynamic, null, noop);
		// @ts-expect-error
		reconciler.updateContainerSync(null, this.containerBottom, null, noop);
		// @ts-expect-error the types for `react-reconciler` are not up to date with the library.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		reconciler.flushSyncWork();
		instances.delete(this.options.stdout);

		if (error instanceof Error) {
			this.rejectExitPromise(error);
		} else {
			this.resolveExitPromise();
		}
	}

	async waitUntilExit(): Promise<void> {
		this.exitPromise ||= new Promise((resolve, reject) => {
			this.resolveExitPromise = resolve;
			this.rejectExitPromise = reject;
		});

		return this.exitPromise;
	}

	clear(): void {
		if (!isInCi && !this.options.debug) {
			this.renderer.clear();
		}
	}

	resetForFullRedraw = (): void => {
		if (isInCi || this.options.debug || this.useAltScreen) return;
		this.options.stdout.write('\x1b[2J\x1b[3J\x1b[H');
		(this.renderer as {resetState?: () => void}).resetState?.();
		this.lastOutput = '';
		this.lastOutputHeight = 0;
		this._writtenStaticRows = 0;
		this._lastLiveRows = 0;
		this._pinned = false;
		this._shrinkPad = 0;
	};

	wrapText(text: string, width: number): string {
		if (width <= 0) return text;

		const lines = text.split('\n');
		const result: string[] = [];

		for (const line of lines) {
			const wrapped = this.wrapLine(line, width);
			result.push(...wrapped);
		}

		return result.join('\n');
	}

	// 单行换行处理（保留 ANSI 序列）
	private wrapLine(line: string, width: number): string[] {
		const visualWidth = stringWidth(stripAnsi(line));
		if (visualWidth <= width) return [line];

		const result: string[] = [];
		let currentLine = '';
		let currentWidth = 0;
		let inAnsi = false;
		let ansiBuffer = '';

		for (let i = 0; i < line.length; i++) {
			const char = line[i]!;

			if (char === '\x1b') {
				inAnsi = true;
				ansiBuffer = char;
				continue;
			}

			if (inAnsi) {
				ansiBuffer += char;
				if (char === 'm') {
					inAnsi = false;
					currentLine += ansiBuffer;
					ansiBuffer = '';
				}
				continue;
			}

			const charWidth = stringWidth(char);

			if (currentWidth + charWidth > width) {
				result.push(currentLine);
				currentLine = char;
				currentWidth = charWidth;
			} else {
				currentLine += char;
				currentWidth += charWidth;
			}
		}

		if (currentLine) {
			result.push(currentLine);
		}

		return result;
	}

	patchConsole(): void {
		if (this.options.debug) {
			return;
		}

		this.restoreConsole = patchConsole((stream, data) => {
			if (stream === 'stdout') {
				this.writeToStdout(data);
			}

			if (stream === 'stderr') {
				const isReactMessage = data.startsWith('The above error occurred');

				if (!isReactMessage) {
					this.writeToStderr(data);
				}
			}
		});
	}
}
