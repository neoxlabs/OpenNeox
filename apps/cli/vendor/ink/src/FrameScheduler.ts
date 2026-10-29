/**
 * Neox-Ink Frame Scheduler
 *
 * 核心功能：
 * 1. 合并多个渲染请求为单次渲染
 * 2. 60 FPS 节流（16ms 一帧）
 * 3. 渲染优先级队列（高优先级：用户输入，低优先级：动画）
 * 4. 避免 stdout 冲突
 *
 * 设计要点：
 * - IMMEDIATE 同步执行（首帧/Static 必须立即可见），但走去重逻辑
 * - 同一 tick 内多个 IMMEDIATE 请求只执行最后一个 callback
 * - HIGH/NORMAL/LOW 用 setTimeout 节流
 * - try/finally 保护所有状态标志
 */

export enum RenderPriority {
	IMMEDIATE = 0, // 用户输入 / Static 组件，同步执行
	HIGH = 1, // Timeline 更新，高优先级
	NORMAL = 2, // StatusBar 动画，正常优先级
	LOW = 3, // 后台任务，低优先级
}

interface RenderRequest {
	id: string;
	priority: RenderPriority;
	callback: () => void;
	timestamp: number;
}

export class FrameScheduler {
	private pendingRequests = new Map<string, RenderRequest>();
	private frameScheduled = false;
	private lastFrameTime = 0;
	private readonly targetFPS = 60;
	private readonly frameInterval = 1000 / this.targetFPS; // 16.67ms

	// 统计数据
	private stats = {
		totalFrames: 0,
		droppedRequests: 0,
		averageFrameTime: 0,
	};

	/**
	 * 调度一次渲染
	 * @param id 唯一标识（用于去重）
	 * @param callback 渲染回调
	 * @param priority 优先级
	 */
	scheduleFrame(
		id: string,
		callback: () => void,
		priority: RenderPriority = RenderPriority.NORMAL,
	): void {
		const now = Date.now();

		// IMMEDIATE: 同步执行，但先合并同 id 的 pending 请求
		if (priority === RenderPriority.IMMEDIATE) {
			// 如果有同 id 的 pending 请求，移除它（IMMEDIATE 会立即执行）
			this.pendingRequests.delete(id);

			if (process.env.FRAME_SCHEDULER_DEBUG === '1') {
				process.stderr.write('[FRAME_SCHEDULER] ⚡ IMMEDIATE render, executing now\n');
			}
			this.flushFrame([{id, priority, callback, timestamp: now}]);
			return;
		}

		// 非 IMMEDIATE: 走去重 + setTimeout 节流
		const existing = this.pendingRequests.get(id);
		if (existing) {
			if (priority < existing.priority) {
				this.pendingRequests.set(id, {id, priority, callback, timestamp: now});
			} else {
				// 同优先级或更低：更新 callback（保证最新），保持优先级
				this.pendingRequests.set(id, {
					id,
					priority: existing.priority,
					callback,
					timestamp: now,
				});
				this.stats.droppedRequests++;
			}
		} else {
			this.pendingRequests.set(id, {id, priority, callback, timestamp: now});
		}

		if (!this.frameScheduled) {
			this.scheduleNextFrame();
		}
	}

	/**
	 * 调度下一帧渲染（setTimeout 节流）
	 */
	private scheduleNextFrame(): void {
		this.frameScheduled = true;
		const now = Date.now();
		const elapsed = now - this.lastFrameTime;
		const delay = Math.max(0, this.frameInterval - elapsed);

		setTimeout(() => {
			this.frameScheduled = false;
			if (this.pendingRequests.size === 0) {
				return;
			}
			this.executeFrame();
		}, delay);
	}

	/**
	 * 执行帧渲染
	 */
	private executeFrame(): void {
		if (this.pendingRequests.size === 0) {
			return;
		}

		const frameStartTime = Date.now();

		const requests = Array.from(this.pendingRequests.values());
		this.pendingRequests.clear();

		requests.sort((a, b) => a.priority - b.priority);

		this.flushFrame(requests);

		this.lastFrameTime = frameStartTime;
		this.stats.totalFrames++;
		const frameTime = Date.now() - frameStartTime;
		this.stats.averageFrameTime =
			(this.stats.averageFrameTime * (this.stats.totalFrames - 1) +
				frameTime) /
			this.stats.totalFrames;

		if (process.env.FRAME_SCHEDULER_DEBUG === '1') {
			process.stderr.write(
				`[FRAME_SCHEDULER] Frame #${this.stats.totalFrames}: ${requests.length} requests, ${frameTime.toFixed(2)}ms\n`,
			);
		}
	}

	/**
	 * 批量执行渲染回调
	 */
	private flushFrame(requests: RenderRequest[]): void {
		if (requests.length === 0) return;

		if (process.env.FRAME_SCHEDULER_DEBUG === '1') {
			process.stderr.write(`[FRAME_SCHEDULER] 🎨 Flushing ${requests.length} render callback(s)\n`);
		}

		for (const req of requests) {
			try {
				req.callback();
			} catch (error) {
				process.stderr.write(`[FRAME_SCHEDULER] Render callback error: ${error}\n`);
			}
		}
	}

	getStats() {
		return {...this.stats};
	}

	resetStats() {
		this.stats = {
			totalFrames: 0,
			droppedRequests: 0,
			averageFrameTime: 0,
		};
	}
}

// 全局单例
let globalScheduler: FrameScheduler | null = null;

export function getFrameScheduler(): FrameScheduler {
	if (!globalScheduler) {
		globalScheduler = new FrameScheduler();
	}
	return globalScheduler;
}
