/** Browser build: all documents are tabs of the current page. */
import type { DocRef, DragStart, Host, HostEvents } from './host';

export class WebHost implements Host {
  readonly kind = 'web';
  readonly multiWindow = false;
  private events: HostEvents | null = null;
  private readonly blobs = new Map<string, Blob>();
  private nextId = 1;
  private input: HTMLInputElement | null = null;

  async init(events: HostEvents): Promise<DocRef[]> {
    this.events = events;
    // ?open=<url> (repeatable) loads drawings on start, e.g. ?open=samples/plate-mm.dxf
    const urls = new URL(location.href).searchParams.getAll('open');
    const docs: DocRef[] = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        docs.push(this.register(await res.blob(), decodeURIComponent(url.split('/').pop() || url)));
      } catch (err) {
        console.error(`Could not open ${url}`, err);
      }
    }
    return docs;
  }

  private register(blob: Blob, name: string): DocRef {
    const id = `web-${this.nextId++}`;
    this.blobs.set(id, blob);
    return { id, name };
  }

  async read(doc: DocRef): Promise<ArrayBuffer> {
    const blob = this.blobs.get(doc.id);
    if (!blob) throw new Error('Document is no longer available');
    return blob.arrayBuffer();
  }

  async openDialog(): Promise<void> {
    if (!this.input) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.dxf,.DXF';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        if (input.files) this.dropFiles([...input.files]);
        input.value = '';
      });
      document.body.append(input);
      this.input = input;
    }
    this.input.click();
  }

  dropFiles(files: File[]): void {
    const docs = files.filter((f) => /\.dxf$/i.test(f.name) || files.length === 1).map((f) => this.register(f, f.name));
    if (docs.length) this.events?.adopt(docs, null);
  }

  closeDoc(id: string): void {
    this.blobs.delete(id);
  }

  setTitle(title: string): void {
    document.title = title;
  }

  reportLayout(): void {}
  reorder(): void {}

  async dragBegin(_d: DragStart): Promise<boolean> {
    return false;
  }
  async dragMove(): Promise<void> {}
  async dragEnd(): Promise<void> {}
  async dragCancel(): Promise<void> {}
  async moveToNewWindow(): Promise<void> {}
  async mergeAllWindows(): Promise<void> {}
}
