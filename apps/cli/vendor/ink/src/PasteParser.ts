/**
 * Neox-Ink Paste Parser
 *
 * 核心功能：
 * 1. 检测 Bracketed Paste Mode 序列 (\x1b[200~ ... \x1b[201~)
 * 2. 区分 ESC 键和 ESC 序列（超时机制）
 * 3. 处理所有终端输入（方向键、功能键等）
 * 4. 完整保留粘贴内容（多行、Unicode、格式）
 */

import {debugLog} from '@neoxlabs/core/platform/cliLogger.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const ESC_TIMEOUT = 50; // ms - ESC 键超时检测
const PASTE_TIMEOUT = 1200; // ms - 粘贴开始后超时未结束则强制恢复
const MAX_UNTERMINATED_PASTE_BUFFER = 8192; // bytes - 防止异常状态无限吞输入

export type PasteHandler = (text: string, isPaste: boolean) => void;

export class PasteParser {
	private buffer = '';
	private inPaste = false;
	private escapeTimeout: NodeJS.Timeout | null = null;
	private pasteTimeout: NodeJS.Timeout | null = null;
	private lastPasteDataAt = 0;

	private armPasteTimeout(handler: PasteHandler): void {
		if (this.pasteTimeout) {
			clearTimeout(this.pasteTimeout);
		}

		this.pasteTimeout = setTimeout(() => {
			if (!this.inPaste) {
				return;
			}

			const idleMs = Date.now() - this.lastPasteDataAt;
			if (idleMs < PASTE_TIMEOUT - 10) {
				this.armPasteTimeout(handler);
				return;
			}

			const fallback = this.buffer;
			this.buffer = '';
			this.inPaste = false;

			debugLog('PASTE_PARSER', `⚠️ Unterminated paste recovered by timeout (${idleMs}ms)`);
			if (fallback.length > 0) {
				handler(fallback, false);
			}
		}, PASTE_TIMEOUT);
	}

	/**
	 * 解析 stdin 数据，检测粘贴和特殊键
	 * @param data 从 stdin 接收的原始数据
	 * @param handler 处理解析后的数据
	 */
	parse(data: string, handler: PasteHandler): void {
		debugLog('PASTE_PARSER', `Received ${data.length} bytes: ${JSON.stringify(data)}`);

		// 将 data 一次性添加到 buffer，然后统一处理
		this.buffer += data;

		while (this.buffer.length > 0) {
			if (this.inPaste) {
				this.lastPasteDataAt = Date.now();
				const endIndex = this.buffer.indexOf(PASTE_END);
				if (endIndex >= 0) {
					// 提取粘贴内容（不包括 PASTE_END）
					const pasted = this.buffer.slice(0, endIndex);
					this.buffer = this.buffer.slice(endIndex + PASTE_END.length);

					debugLog('PASTE_PARSER', `📋 Paste detected: ${pasted.length} chars`);

					handler(pasted, true);
					this.inPaste = false;
					if (this.pasteTimeout) {
						clearTimeout(this.pasteTimeout);
						this.pasteTimeout = null;
					}
					continue;
				} else {
					if (this.buffer.length > MAX_UNTERMINATED_PASTE_BUFFER) {
						const fallback = this.buffer;
						this.buffer = '';
						this.inPaste = false;
						if (this.pasteTimeout) {
							clearTimeout(this.pasteTimeout);
							this.pasteTimeout = null;
						}
						debugLog('PASTE_PARSER', `⚠️ Unterminated paste recovered by max buffer (${fallback.length} bytes)`);
						handler(fallback, false);
						continue;
					}

					this.armPasteTimeout(handler);
					// 还没有收到 PASTE_END，等待更多数据
					break;
				}
			}

			const pasteStartIndex = this.buffer.indexOf(PASTE_START);
			if (pasteStartIndex === 0) {
				if (this.escapeTimeout) clearTimeout(this.escapeTimeout);

				debugLog('PASTE_PARSER', '📥 Paste start detected');

				this.inPaste = true;
				this.lastPasteDataAt = Date.now();
				this.buffer = this.buffer.slice(PASTE_START.length);
				this.armPasteTimeout(handler);
				continue;
			}

			if (this.buffer.startsWith('\x1b')) {
				if (this.escapeTimeout) clearTimeout(this.escapeTimeout);

				if (this.buffer.length === 1) {
					this.escapeTimeout = setTimeout(() => {
						if (this.buffer === '\x1b') {
							debugLog('PASTE_PARSER', '⌨️  ESC key detected');
							handler('\x1b', false);
							this.buffer = '';
						}
					}, ESC_TIMEOUT);
					break; // 等待超时或更多数据
				}

				const seqLen = this.leadingEscapeSequenceLength(this.buffer);
				if (seqLen > 0) {
					const seq = this.buffer.slice(0, seqLen);
					debugLog('PASTE_PARSER', `⌨️  ESC sequence: ${JSON.stringify(seq)}`);
					handler(seq, false);
					this.buffer = this.buffer.slice(seqLen);
					continue;
				}

				// 但设置一个最大长度限制，避免无限等待
				if (this.buffer.length > 20) {
					// 太长了，可能不是有效的 ESC 序列，当作普通文本处理
					debugLog('PASTE_PARSER', `⚠️  Invalid ESC sequence (too long): ${JSON.stringify(this.buffer)}`);
					handler(this.buffer, false);
					this.buffer = '';
					continue;
				}

				// 等待更多数据来完成 ESC 序列
				break;
			}

			let nextSpecialIndex = this.buffer.length;

			// 查找下一个 ESC 或 PASTE_START
			const nextEscIndex = this.buffer.indexOf('\x1b');
			const nextPasteIndex = this.buffer.indexOf(PASTE_START);

			if (nextEscIndex > 0) {
				nextSpecialIndex = Math.min(nextSpecialIndex, nextEscIndex);
			}
			if (nextPasteIndex > 0) {
				nextSpecialIndex = Math.min(nextSpecialIndex, nextPasteIndex);
			}

			const normalText = this.buffer.slice(0, nextSpecialIndex);
			this.buffer = this.buffer.slice(nextSpecialIndex);

			if (normalText.length > 0) {
				debugLog('PASTE_PARSER', `⌨️  Text: ${JSON.stringify(normalText)} (${normalText.length} chars)`);
				handler(normalText, false);
			}

			// 如果没有提取到任何内容，说明需要等待更多数据
			if (normalText.length === 0 && this.buffer.length > 0) {
				break;
			}
		}
	}

	/** buffer 开头那个 ESC 序列的长度; 0 = 还不完整 (等更多数据) */
	private leadingEscapeSequenceLength(buf: string): number {
		if (buf.length < 2) return 0;
		/* ESC ESC … = Meta + 后面那个键 (部分终端的 Option+方向键) */
		if (buf[1] === '\x1b') {
			const inner = this.leadingEscapeSequenceLength(buf.slice(1));
			return inner > 0 ? 1 + inner : 0;
		}
		if (buf[1] === '[') {
			const m = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(buf);
			if (m) return m[0].length;
			return /^\x1b\[[0-?]*[ -/]*$/.test(buf) ? 0 : 2; /* 不像 CSI 的就只吃 "ESC [" 两个字 */
		}
		if (buf[1] === 'O') return buf.length >= 3 ? 3 : 0;
		if (buf[1] === ']') {
			const m = /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.exec(buf);
			return m ? m[0].length : 0;
		}
		return 2; /* Meta + 单个字符 */
	}

	/**
	 * 清理资源
	 */
	dispose(): void {
		if (this.escapeTimeout) {
			clearTimeout(this.escapeTimeout);
			this.escapeTimeout = null;
		}
		if (this.pasteTimeout) {
			clearTimeout(this.pasteTimeout);
			this.pasteTimeout = null;
		}
		this.buffer = '';
		this.inPaste = false;

		debugLog('PASTE_PARSER', '🗑️  Disposed');
	}
}
