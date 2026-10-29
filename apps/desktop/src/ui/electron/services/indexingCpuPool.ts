import os from 'os';
import { Worker } from 'worker_threads';
import type {
  IndexingCpuResult,
  IndexingCpuTask,
  WorkerResponse,
} from './indexingCpuTypes.js';

interface PendingJob {
  resolve: (value: IndexingCpuResult) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  busyJobId: number | null;
}

class IndexingCpuPool {
  private readonly size = Math.max(1, Math.min(4, os.cpus().length - 1 || 1));
  private readonly workers: WorkerSlot[] = [];
  private readonly queue: number[] = [];
  private readonly tasks = new Map<number, IndexingCpuTask>();
  private readonly pending = new Map<number, PendingJob>();
  private nextJobId = 1;

  constructor() {
    for (let index = 0; index < this.size; index += 1) {
      this.workers.push(this.createWorkerSlot());
    }
  }

  getConcurrency(): number {
    return this.size;
  }

  run(task: IndexingCpuTask): Promise<IndexingCpuResult> {
    const jobId = this.nextJobId++;
    return new Promise((resolve, reject) => {
      this.tasks.set(jobId, task);
      this.pending.set(jobId, { resolve, reject });
      this.queue.push(jobId);
      this.pump();
    });
  }

  private createWorkerSlot(): WorkerSlot {
    const worker = new Worker(new URL('../workers/indexingCpuWorker.js', import.meta.url));
    const slot: WorkerSlot = { worker, busyJobId: null };
    worker.on('message', (message: WorkerResponse) => this.handleMessage(slot, message));
    worker.on('error', (error) => this.handleWorkerFailure(slot, error));
    worker.on('exit', (code) => {
      if (code !== 0) this.handleWorkerFailure(slot, new Error(`indexing worker exited: ${code}`));
    });
    return slot;
  }

  private handleMessage(slot: WorkerSlot, message: WorkerResponse): void {
    const currentJobId = slot.busyJobId;
    slot.busyJobId = null;
    if (currentJobId === null) return;
    const pending = this.pending.get(currentJobId);
    this.pending.delete(currentJobId);
    this.tasks.delete(currentJobId);
    if (!pending) return;
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
    this.pump();
  }

  private handleWorkerFailure(slot: WorkerSlot, error: Error): void {
    const failedJobId = slot.busyJobId;
    slot.busyJobId = null;
    if (failedJobId !== null) {
      const pending = this.pending.get(failedJobId);
      this.pending.delete(failedJobId);
      this.tasks.delete(failedJobId);
      pending?.reject(error);
    }
    const index = this.workers.indexOf(slot);
    if (index >= 0) this.workers[index] = this.createWorkerSlot();
    this.pump();
  }

  private pump(): void {
    for (const slot of this.workers) {
      if (slot.busyJobId !== null) continue;
      const jobId = this.queue.shift();
      if (jobId === undefined) return;
      const task = this.tasks.get(jobId);
      if (!task) continue;
      slot.busyJobId = jobId;
      slot.worker.postMessage({ jobId, task });
    }
  }
}

let globalPool: IndexingCpuPool | null = null;

export function getIndexingCpuPool(): IndexingCpuPool {
  if (!globalPool) globalPool = new IndexingCpuPool();
  return globalPool;
}
