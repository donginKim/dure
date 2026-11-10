import type { DureApi } from '@shared/ipc';

declare global {
  interface Window {
    dure: DureApi;
  }
}
