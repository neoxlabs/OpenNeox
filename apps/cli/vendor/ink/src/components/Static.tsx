// @ts-nocheck
import React, {useMemo, useState, useLayoutEffect, type ReactNode} from 'react';
import {type Styles} from '../styles.js';

export type Props<T> = {
	/**
	Array of items of any type to render using the function you pass as a component child.
	*/
	readonly items: T[];

	/**
	Styles to apply to a container of child elements. See <Box> for supported properties.
	*/
	readonly style?: Styles;

	/**
	Function that is called to render every item in the `items` array. The first argument is the item itself, and the second argument is the index of that item in the `items` array. Note that a `key` must be assigned to the root component.
	*/
	readonly children: (item: T, index: number) => ReactNode;
};

/**
`<Static>` component permanently renders its output above everything else. It's useful for displaying activity like completed tasks or logs—things that don't change after they're rendered (hence the name "Static").

It's preferred to use `<Static>` for use cases like these when you can't know or control the number of items that need to be rendered.

For example, [Tap](https://github.com/tapjs/node-tap) uses `<Static>` to display a list of completed tests. [Gatsby](https://github.com/gatsbyjs/gatsby) uses it to display a list of generated pages while still displaying a live progress bar.
*/
export default function Static<T>(props: Props<T>) {
	const {items, children: render, style: customStyle} = props;
	const [renderedCount, setRenderedCount] = useState(0);

	// 🔥 FIX: 当 items 被清空后重新添加时，不要重置为 0（会导致 Header 重复打印）
	// 而是跳到当前 items.length，因为已经输出到终端的内容不需要再打印
	const effectiveRenderedCount = items.length < renderedCount ? items.length : renderedCount;

	// 🔥 FIX: Calculate items to render based on what we've already rendered
	// This ensures new items are always rendered before updating the count
	const itemsToRender: T[] = useMemo(() => {
		return items.slice(effectiveRenderedCount);
	}, [effectiveRenderedCount, items]);

	// 🔥 FIX: Only update renderedCount AFTER items have been rendered
	// useLayoutEffect runs synchronously after DOM mutations but before paint
	useLayoutEffect(() => {
		// 🔥 FIX: 当 items 缩小时，同步到当前长度（不重置为 0）
		if (items.length < renderedCount) {
			setRenderedCount(items.length);
		} else if (items.length > renderedCount) {
			setRenderedCount(items.length);
		}
		// 当 items.length === renderedCount 时不做任何操作，避免不必要的重渲染
	}, [items.length, renderedCount]);

	// 🔥 FIX: Use useMemo to prevent recreating children on every render
	const children = useMemo(() => {
		return itemsToRender.map((item, itemIndex) => {
			return render(item, effectiveRenderedCount + itemIndex);
		});
	}, [itemsToRender, render, effectiveRenderedCount]);

	const style: Styles = useMemo(
		() => ({
			position: 'absolute',
			flexDirection: 'column',
			...customStyle,
		}),
		[customStyle],
	);

	return (
		<ink-box internal_static style={style}>
			{children}
		</ink-box>
	);
}
