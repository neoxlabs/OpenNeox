// @ts-nocheck
import process from 'node:process';
import {createContext} from 'react';

export type Props = {
	/**
	Stdout stream passed to `render()` in `options.stdout` or `process.stdout` by default.
	*/
	readonly stdout: NodeJS.WriteStream;

	/**
	Write any string to stdout while preserving Ink's output. It's useful when you want to display external information outside of Ink's rendering and ensure there's no conflict between the two. It's similar to `<Static>`, except it can't accept components; it only works with strings.
	*/
	readonly write: (data: string) => void;

	/**
	 * 🔥 Terminal width in columns. Updates automatically on resize.
	 */
	readonly columns: number;

	/**
	 * 🔥 Terminal height in rows. Updates automatically on resize.
	 */
	readonly rows: number;
};

/**
`StdoutContext` is a React context that exposes the stdout stream where Ink renders your app.
*/
// eslint-disable-next-line @typescript-eslint/naming-convention
const StdoutContext = createContext<Props>({
	stdout: process.stdout,
	write() {},
	columns: process.stdout.columns || 80,
	rows: process.stdout.rows || 24,
});

StdoutContext.displayName = 'InternalStdoutContext';

export default StdoutContext;
