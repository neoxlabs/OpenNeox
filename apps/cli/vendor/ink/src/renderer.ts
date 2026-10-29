// @ts-nocheck
import renderNodeToOutput, {
	renderNodeToScreenReaderOutput,
} from './render-node-to-output.js';
import Output from './output.js';
import {type DOMElement} from './dom.js';

type Result = {
	output: string;
	outputHeight: number;
	staticOutput: string;
};

const renderer = (node: DOMElement, isScreenReaderEnabled: boolean): Result => {
	if (node.yogaNode) {
		if (isScreenReaderEnabled) {
			const output = renderNodeToScreenReaderOutput(node, {
				skipStaticElements: true,
			});

			const outputHeight = output === '' ? 0 : output.split('\n').length;

			let staticOutput = '';

			if (node.staticNode) {
				staticOutput = renderNodeToScreenReaderOutput(node.staticNode, {
					skipStaticElements: false,
				});
			}

			return {
				output,
				outputHeight,
				staticOutput: staticOutput ? `${staticOutput}\n` : '',
			};
		}

		const output = new Output({
			width: node.yogaNode.getComputedWidth(),
			height: node.yogaNode.getComputedHeight(),
		});

		renderNodeToOutput(node, output, {
			skipStaticElements: true,
		});

		let staticOutput;

		// 🔥 FIX: Only render staticNode if it has children to render
		// Static component uses items.slice(index) so it only has NEW items as children
		// If no children, skip the expensive Output creation entirely
		if (node.staticNode?.yogaNode) {
			const hasChildren = node.staticNode.childNodes && node.staticNode.childNodes.length > 0;

			if (hasChildren) {
				const width = node.staticNode.yogaNode.getComputedWidth();
				const height = node.staticNode.yogaNode.getComputedHeight();

				staticOutput = new Output({
					width,
					height,
				});

				renderNodeToOutput(node.staticNode, staticOutput, {
					skipStaticElements: false,
				});
			}
		}

		const {output: generatedOutput, height: outputHeight} = output.get();

		return {
			output: generatedOutput,
			outputHeight,
			// Newline at the end is needed, because static output doesn't have one, so
			// interactive output will override last line of static output
			staticOutput: staticOutput ? `${staticOutput.get().output}\n` : '',
		};
	}

	return {
		output: '',
		outputHeight: 0,
		staticOutput: '',
	};
};

export default renderer;
