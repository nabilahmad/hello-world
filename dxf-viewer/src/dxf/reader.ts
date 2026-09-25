/**
 * Low-level DXF tag readers. A DXF file is a flat stream of (group code, value)
 * pairs; ASCII files store them on alternating lines, binary files as typed
 * little-endian values. Both readers expose the same streaming interface so
 * the parser never has to materialise the whole tag list in memory.
 */

export interface TagReader {
  /** Group code of the current tag, -1 once the input is exhausted. */
  code: number;
  /** Value of the current tag (numbers from binary files are stringified). */
  value: string;
  /** Advances to the next tag. Returns false at end of input. */
  next(): boolean;
  /** Makes the next call to next() return the current tag again. */
  pushBack(): void;
}

const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

export function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  for (let i = 0; i < 22; i++) if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

export class AsciiTagReader implements TagReader {
  code = -1;
  value = '';
  private pos: number;
  private pushed = false;

  constructor(private readonly text: string) {
    this.pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  }

  private line(): string | null {
    const t = this.text;
    if (this.pos >= t.length) return null;
    let end = t.indexOf('\n', this.pos);
    if (end < 0) end = t.length;
    let e = end;
    if (e > this.pos && t.charCodeAt(e - 1) === 13) e--;
    const s = t.substring(this.pos, e);
    this.pos = end + 1;
    return s;
  }

  next(): boolean {
    if (this.pushed) {
      this.pushed = false;
      return this.code >= 0;
    }
    for (;;) {
      const c = this.line();
      if (c === null) break;
      const code = parseInt(c, 10);
      if (Number.isNaN(code)) {
        // Tolerate stray blank lines (common at the end of files).
        if (c.trim() === '') continue;
        break;
      }
      const v = this.line();
      if (v === null) break;
      this.code = code;
      this.value = v;
      return true;
    }
    this.code = -1;
    this.value = '';
    return false;
  }

  pushBack(): void {
    this.pushed = true;
  }
}

// Value encodings of binary DXF group codes.
const STR = 0;
const F64 = 1;
const I16 = 2;
const I32 = 3;
const I64 = 4;
const BOOL = 5;
const CHUNK = 6;

/** Value encoding of a group code in binary DXF (per the DXF reference ranges). */
function binaryType(code: number): number {
  if (code < 10) return STR;
  if (code < 60) return F64;
  if (code < 80) return I16;
  if (code >= 90 && code < 100) return I32;
  if (code >= 110 && code < 150) return F64;
  if (code >= 160 && code < 170) return I64;
  if (code >= 170 && code < 180) return I16;
  if (code >= 210 && code < 240) return F64;
  if (code >= 270 && code < 290) return I16;
  if (code >= 290 && code < 300) return BOOL;
  if (code >= 310 && code < 320) return CHUNK;
  if (code >= 370 && code < 390) return I16;
  if (code >= 400 && code < 410) return I16;
  if (code >= 420 && code < 430) return I32;
  if (code >= 440 && code < 460) return I32;
  if (code >= 460 && code < 470) return F64;
  if (code === 1004) return CHUNK;
  if (code >= 1010 && code < 1060) return F64;
  if (code >= 1060 && code < 1071) return I16;
  if (code === 1071) return I32;
  return STR;
}

export class BinaryTagReader implements TagReader {
  code = -1;
  value = '';
  private pos = 22;
  private pushed = false;
  private readonly view: DataView;
  /** R12 binary files use 1-byte group codes (255 escapes to a 2-byte code). */
  private readonly r12: boolean;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly decoder: TextDecoder,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.r12 = bytes.length > 23 && bytes[23] !== 0;
  }

  next(): boolean {
    if (this.pushed) {
      this.pushed = false;
      return this.code >= 0;
    }
    const b = this.bytes;
    const v = this.view;
    let p = this.pos;
    if (p >= b.length) return this.end();
    let code: number;
    if (this.r12) {
      code = b[p++];
      if (code === 255) {
        if (p + 2 > b.length) return this.end();
        code = v.getUint16(p, true);
        p += 2;
      }
    } else {
      if (p + 2 > b.length) return this.end();
      code = v.getUint16(p, true);
      p += 2;
    }
    let value = '';
    switch (binaryType(code)) {
      case STR: {
        let e = b.indexOf(0, p);
        if (e < 0) e = b.length;
        value = this.decoder.decode(b.subarray(p, e));
        p = e + 1;
        break;
      }
      case F64:
        if (p + 8 > b.length) return this.end();
        value = String(v.getFloat64(p, true));
        p += 8;
        break;
      case I16:
        if (p + 2 > b.length) return this.end();
        value = String(v.getInt16(p, true));
        p += 2;
        break;
      case I32:
        if (p + 4 > b.length) return this.end();
        value = String(v.getInt32(p, true));
        p += 4;
        break;
      case I64:
        if (p + 8 > b.length) return this.end();
        value = String(v.getUint32(p, true) + v.getInt32(p + 4, true) * 4294967296);
        p += 8;
        break;
      case BOOL:
        value = String(b[p]);
        p += 1;
        break;
      case CHUNK: {
        const n = b[p];
        let hex = '';
        for (let i = 0; i < n; i++) hex += b[p + 1 + i].toString(16).padStart(2, '0');
        value = hex;
        p += 1 + n;
        break;
      }
    }
    this.pos = p;
    this.code = code;
    this.value = value;
    return true;
  }

  private end(): boolean {
    this.pos = this.bytes.length;
    this.code = -1;
    this.value = '';
    return false;
  }

  pushBack(): void {
    this.pushed = true;
  }
}

/** $DWGCODEPAGE values → WHATWG encoding labels understood by TextDecoder. */
const CODEPAGES: Record<string, string> = {
  ANSI_874: 'windows-874',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  DOS866: 'ibm866',
};

export function encodingForCodepage(codepage: string | undefined): string {
  if (!codepage) return 'windows-1252';
  return CODEPAGES[codepage.trim().toUpperCase()] ?? 'windows-1252';
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  }
  return s;
}

function headerString(head: string, name: string, code: number, binary: boolean): string | undefined {
  if (binary) {
    // name\0, then a 1- or 2-byte group code, then the value\0.
    const at = head.indexOf(name + '\0');
    if (at < 0) return undefined;
    let p = at + name.length + 1;
    p += head.charCodeAt(p + 1) === 0 ? 2 : 1;
    const end = head.indexOf('\0', p);
    return end < 0 ? undefined : head.substring(p, end).trim();
  }
  const re = new RegExp('\\' + name + '\\s*\\r?\\n\\s*' + code + '\\s*\\r?\\n([^\\r\\n]*)');
  return re.exec(head)?.[1]?.trim();
}

/**
 * Picks the text encoding: DXF R2007+ (AC1021) is UTF-8, older files use the
 * ANSI code page named in $DWGCODEPAGE.
 */
export function detectEncoding(bytes: Uint8Array): string {
  const binary = isBinaryDxf(bytes);
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 1 << 16)));
  const version = headerString(head, '$ACADVER', 1, binary);
  if (version && version >= 'AC1021') return 'utf-8';
  if (version) return encodingForCodepage(headerString(head, '$DWGCODEPAGE', 3, binary));
  if (binary) return 'windows-1252';
  // No header (minimal R12 files): accept UTF-8 when the bytes are valid UTF-8.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

function decoderFor(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export function createTagReader(bytes: Uint8Array): { reader: TagReader; encoding: string; binary: boolean } {
  const encoding = detectEncoding(bytes);
  if (isBinaryDxf(bytes)) {
    return { reader: new BinaryTagReader(bytes, decoderFor(encoding)), encoding, binary: true };
  }
  const text = decoderFor(encoding).decode(bytes);
  return { reader: new AsciiTagReader(text), encoding, binary: false };
}
