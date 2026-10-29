// @ts-nocheck
import { useState, useEffect, useContext } from 'react';
import StdoutContext from '../components/StdoutContext.js';

export type TerminalSize = {
	/**
	 * Terminal width in columns
	 */
	columns: number;
	/**
	 * Terminal height in rows
	 */
	rows: number;
};

/**
 * `useTerminalSize` is a React hook that returns the current terminal dimensions
 * and automatically updates when the terminal is resized.
 *
 * This hook is useful for components that need to adapt their layout based on
 * terminal size, such as separators, progress bars, or responsive layouts.
 *
 * @example
 * ```tsx
 * function Separator() {
 *   const { columns } = useTerminalSize();
 *   return <Text>{'─'.repeat(columns)}</Text>;
 * }
 * ```
 */
const useTerminalSize = (): TerminalSize => {
	const { stdout } = useContext(StdoutContext);

	const [size, setSize] = useState<TerminalSize>(() => ({
		columns: stdout.columns || 80,
		rows: stdout.rows || 24,
	}));

	useEffect(() => {
		const handleResize = () => {
			setSize({
				columns: stdout.columns || 80,
				rows: stdout.rows || 24,
			});
		};

		// Listen for resize events
		stdout.on('resize', handleResize);

		// Also update immediately in case size changed since initial render
		handleResize();

		return () => {
			stdout.off('resize', handleResize);
		};
	}, [stdout]);

	return size;
};

export default useTerminalSize;
