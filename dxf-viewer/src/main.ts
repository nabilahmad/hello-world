import './styles.css';
import type { Host } from './host/host';
import { WebHost } from './host/web-host';
import { App } from './ui/app';

async function main(): Promise<void> {
  const host: Host =
    '__TAURI_INTERNALS__' in window ? new (await import('./host/tauri-host')).TauriHost() : new WebHost();
  const app = new App(host);
  await app.start();
  (window as unknown as { __dxfApp: App }).__dxfApp = app;
}

main().catch((err) => {
  console.error(err);
  document.body.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
