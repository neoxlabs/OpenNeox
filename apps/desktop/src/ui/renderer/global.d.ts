import type { RendererAPI } from '../shared/ipc';

declare global {
  interface Window {
    neox: RendererAPI;
  }
}

export {};
