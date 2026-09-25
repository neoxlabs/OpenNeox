// @ts-nocheck
import {useEffect} from 'react';
import parseKeypress, {nonAlphanumericKeys} from '../parse-keypress.js';
import reconciler from '../reconciler.js';
import useStdin from './use-stdin.js';
import {debugLog} from '@neoxlabs/core/platform/cliLogger.js';

/**
Handy information about a key that was pressed.
*/
export type Key = {
	/**
	Up arrow key was pressed.
	*/
	upArrow: boolean;

	/**
	Down arrow key was pressed.
	*/
	downArrow: boolean;

	/**
	Left arrow key was pressed.
	*/
	leftArrow: boolean;

	/**
	Right arrow key was pressed.
	*/
	rightArrow: boolean;

	/**
	Page Down key was pressed.
	*/
	pageDown: boolean;

	/**
	Page Up key was pressed.
	*/
	pageUp: boolean;

	/**
	Home key was pressed.
	*/
	home: boolean;

	/**
	End key was pressed.
	*/
	end: boolean;

	/**
	Return (Enter) key was pressed.
	*/
	return: boolean;

	/**
	Escape key was pressed.
	*/
	escape: boolean;

	/**
	Ctrl key was pressed.
	*/
	ctrl: boolean;

	/**
	Shift key was pressed.
	*/
	shift: boolean;

	/**
	Tab key was pressed.
	*/
	tab: boolean;

	/**
	Backspace key was pressed.
	*/
	backspace: boolean;

	/**
	Delete key was pressed.
	*/
	delete: boolean;

	/**
	[Meta key](https://en.wikipedia.org/wiki/Meta_key) was pressed.
	*/
	meta: boolean;

	paste?: boolean;
};

type Handler = (input: string, key: Key) => void;

type Options = {
	/**
	Enable or disable capturing of user input. Useful when there are multiple `useInput` hooks used at once to avoid handling the same input several times.

	@default true
	*/
	isActive?: boolean;
};

/**
This hook is used for handling user input. It's a more convenient alternative to using `StdinContext` and listening for `data` events. The callback you pass to `useInput` is called for each character when the user enters any input. However, if the user pastes text and it's more than one character, the callback will be called only once, and the whole string will be passed as `input`.

```
import {useInput} from 'ink';

const UserInput = () => {
  useInput((input, key) => {
    if (input === 'q') {
      // Exit program
    }

    if (key.leftArrow) {
      // Left arrow key pressed
    }
  });

  return …
};
```
*/
const useInput = (inputHandler: Handler, options: Options = {}) => {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	const {stdin, setRawMode, internal_exitOnCtrlC, internal_eventEmitter} =
		useStdin();

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		// Input Manager 已经在 App.tsx 中管理 raw mode
		// setRawMode(true);

		return () => {
			// Cleanup: 不再需要
			// setRawMode(false);
		};
	}, [options.isActive, setRawMode]);

	useEffect(() => {
		if (options.isActive === false) {
			return;
		}

		// \x1b[200~ ... \x1b[201~。慢终端/大粘贴会分多个 data chunk, 缓冲到 END 再处理。
		// 空内容 = 图片/截图粘贴 (终端只发空标记) → 打 key.paste=true 让上层去读剪贴板。
		const PASTE_START = '\x1b[200~';
		const PASTE_END = '\x1b[201~';
		let pasteActive = false;
		let pasteBuf = '';
		const makePasteKey = (): Key => ({
			upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
			pageDown: false, pageUp: false, home: false, end: false, return: false,
			escape: false, ctrl: false, shift: false, tab: false, backspace: false,
			delete: false, meta: false, paste: true,
		});

		const handleData = (data: string) => {
			const t0 = Date.now();
			debugLog('INPUT', `>>> handleData START, data.length=${data.length}`);

			// 直接剥离标记, 把粘贴内容 + key.paste=true 交给上层。
			if (pasteActive || data.includes(PASTE_START)) {
				pasteActive = true;
				pasteBuf += data;
				const endIdx = pasteBuf.indexOf(PASTE_END);
				if (endIdx < 0) return; // 还没收到 END, 继续缓冲后续 chunk
				const startIdx = pasteBuf.indexOf(PASTE_START) + PASTE_START.length;
				const content = pasteBuf.slice(startIdx, endIdx);
				const trailing = pasteBuf.slice(endIdx + PASTE_END.length); // END 后紧跟的字节(如随后的按键)
				pasteActive = false;
				pasteBuf = '';
				debugLog('INPUT', `>>> bracketed paste, content.length=${content.length}`);
				reconciler.batchedUpdates(() => {
					inputHandler(content, makePasteKey());
				});
				if (trailing) handleData(trailing);
				return;
			}

			// 粘贴条件：长度 > 1 且包含换行符（排除单独的回车键）
			// 单独的 \r 或 \n 是回车键，不是粘贴
			const isSingleReturn = data === '\r' || data === '\n' || data === '\r\n';
			const isPaste = data.length > 1 && (data.includes('\n') || data.includes('\r')) && !isSingleReturn;

			if (isPaste && !data.startsWith('\x1b')) {
				debugLog('INPUT', `>>> Paste detected, length=${data.length}, hasNewline=${data.includes('\n')}`);

				// 将 \r\n 和 \r 统一转换为 \n
				const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

				const key = {
					upArrow: false,
					downArrow: false,
					leftArrow: false,
					rightArrow: false,
					pageDown: false,
					pageUp: false,
					home: false,
					end: false,
					return: false,
					escape: false,
					ctrl: false,
					shift: false,
					tab: false,
					backspace: false,
					delete: false,
					meta: false,
				};

				// @ts-expect-error TypeScript types for `batchedUpdates` require an argument, but React's codebase doesn't provide it and it works without it as expected.
				reconciler.batchedUpdates(() => {
					inputHandler(normalizedData, key);
				});

				const t2 = Date.now();
				debugLog('INPUT', `<<< Paste handled, duration=${t2 - t0}ms`);
				return;
			}

			const keypress = parseKeypress(data);

			const key = {
				upArrow: keypress.name === 'up',
				downArrow: keypress.name === 'down',
				leftArrow: keypress.name === 'left',
				rightArrow: keypress.name === 'right',
				pageDown: keypress.name === 'pagedown',
				pageUp: keypress.name === 'pageup',
				home: keypress.name === 'home',
				end: keypress.name === 'end',
				return: keypress.name === 'return',
				escape: keypress.name === 'escape',
				ctrl: keypress.ctrl,
				shift: keypress.shift,
				tab: keypress.name === 'tab',
				backspace: keypress.name === 'backspace',
				delete: keypress.name === 'delete',
				// `parseKeypress` parses \u001B\u001B[A (meta + up arrow) as meta = false
				// but with option = true, so we need to take this into account here
				// to avoid breaking changes in Ink.
				// TODO(vadimdemedes): consider removing this in the next major version.
				meta: keypress.meta || keypress.name === 'escape' || keypress.option,
			};

			let input = keypress.ctrl ? keypress.name : keypress.sequence;

			if (nonAlphanumericKeys.includes(keypress.name)) {
				input = '';
			}

			// Strip meta if it's still remaining after `parseKeypress`
			// TODO(vadimdemedes): remove this in the next major version.
			if (input.startsWith('\u001B')) {
				input = input.slice(1);
			}

			if (
				input.length === 1 &&
				typeof input[0] === 'string' &&
				/[A-Z]/.test(input[0])
			) {
				key.shift = true;
			}

			// If app is not supposed to exit on Ctrl+C, then let input listener handle it
			if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
				const t1 = Date.now();
				debugLog('INPUT', `>>> Before batchedUpdates, elapsed=${t1 - t0}ms`);

				// @ts-expect-error TypeScript types for `batchedUpdates` require an argument, but React's codebase doesn't provide it and it works without it as expected.
				reconciler.batchedUpdates(() => {
					inputHandler(input, key);
				});

				const t2 = Date.now();
				debugLog('INPUT', `<<< After batchedUpdates, duration=${t2 - t1}ms, total=${t2 - t0}ms`);
			}
		};

		internal_eventEmitter?.on('input', handleData);

		return () => {
			internal_eventEmitter?.removeListener('input', handleData);
		};
	}, [options.isActive, stdin, internal_exitOnCtrlC, inputHandler]);
};

export default useInput;
