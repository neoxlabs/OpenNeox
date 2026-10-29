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

	readonly getRenderedCount?: () => number;

	/** 受控模式下, 渲染完成后回报当前 items 长度 */
	readonly onRendered?: (count: number) => void;

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
	const {items, children: render, style: customStyle, getRenderedCount, onRendered} = props;
	const [internalCount, setInternalCount] = useState(0);
	const isControlled = typeof getRenderedCount === 'function';
	const renderedCount = isControlled ? getRenderedCount() : internalCount;

	const effectiveRenderedCount = Math.min(renderedCount, items.length);

	// 🔥 FIX: Calculate items to render based on what we've already rendered
	// This ensures new items are always rendered before updating the count
	const itemsToRender: T[] = useMemo(() => {
		return items.slice(effectiveRenderedCount);
	}, [effectiveRenderedCount, items]);

	// 🔥 FIX: Only update renderedCount AFTER items have been rendered
	// useLayoutEffect runs synchronously after DOM mutations but before paint
	useLayoutEffect(() => {
		if (isControlled) {
			if (items.length !== renderedCount) {
				onRendered?.(items.length);
				/* 回报完还得让自己立刻重渲一次, 把已打印的子节点清空: renderer.ts 只要 staticNode
				 * 还有子节点就会再输出一遍, 而 onRendered 只改调用方变量、不触发重渲 ——
				 * 下一帧 (任何 live 区刷新) 就把 header 又打一次。内置计数模式靠 setState 天然做到了这点。 */
				setInternalCount(items.length);
			}
			return;
		}
		if (items.length < renderedCount) {
			setInternalCount(items.length);
		} else if (items.length > renderedCount) {
			setInternalCount(items.length);
		}
		// 当 items.length === renderedCount 时不做任何操作，避免不必要的重渲染
	}, [items.length, renderedCount, isControlled, onRendered]);

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
