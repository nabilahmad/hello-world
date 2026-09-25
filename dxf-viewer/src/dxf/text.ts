/** Decoding of DXF text values: unicode escapes, %% control codes and MTEXT formatting. */

const MBCS: Record<string, string> = {
  '1': 'shift_jis',
  '2': 'big5',
  '3': 'euc-kr',
  '5': 'gbk',
};

let mbcsDecoders: Record<string, TextDecoder> | null = null;

function decodeMbcs(n: string, hex: string): string {
  mbcsDecoders ??= {};
  const label = MBCS[n];
  if (!label) return '?';
  try {
    const d = (mbcsDecoders[label] ??= new TextDecoder(label));
    return d.decode(new Uint8Array([parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16)]));
  } catch {
    return '?';
  }
}

/** Replaces \U+XXXX (and legacy \M+NXXXX) escapes with the characters they encode. */
export function decodeEscapes(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_, n: string, h: string) => decodeMbcs(n, h));
}

/** %%d → °, %%p → ±, %%c → ⌀, %%nnn → character; drops %%u/%%o/%%k toggles. */
function percentCodes(s: string): string {
  if (s.indexOf('%%') >= 0) {
    s = s.replace(/%%(\d{3}|.)/g, (_, c: string) => {
      if (c.length === 3) return String.fromCharCode(parseInt(c, 10));
      switch (c.toLowerCase()) {
        case 'd':
          return '°';
        case 'p':
          return '±';
        case 'c':
          return '⌀';
        case '%':
          return '%';
        default:
          return ''; // %%u, %%o, %%k: underline/overline/strike toggles
      }
    });
  }
  return s;
}

/** TEXT/ATTRIB value → display string. */
export function plainText(raw: string): string {
  let s = percentCodes(decodeEscapes(raw));
  if (s.indexOf('^') >= 0) s = s.replace(/\^(.)/g, (_, c: string) => (c === 'I' ? '\t' : c === ' ' ? '^' : ''));
  return s;
}

/** MTEXT value → paragraphs of plain text with inline formatting removed. */
export function mtextParagraphs(raw: string): string[] {
  const s = decodeEscapes(raw);
  const lines: string[] = [];
  let out = '';
  let i = 0;
  const n = s.length;
  const skipTo = (ch: string) => {
    const e = s.indexOf(ch, i);
    i = e < 0 ? n : e + 1;
  };
  while (i < n) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n) {
      const code = s[i + 1];
      i += 2;
      switch (code) {
        case 'P':
        case 'X':
        case 'N':
          lines.push(out);
          out = '';
          break;
        case '~':
          out += ' ';
          break;
        case '\\':
        case '{':
        case '}':
          out += code;
          break;
        case 'L':
        case 'l':
        case 'O':
        case 'o':
        case 'K':
        case 'k':
          break;
        case 'S': {
          const e = s.indexOf(';', i);
          const body = s.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          out += body.replace(/[#^]/, '/');
          break;
        }
        case 'A':
        case 'C':
        case 'c':
        case 'F':
        case 'f':
        case 'H':
        case 'Q':
        case 'T':
        case 'W':
        case 'p':
          skipTo(';');
          break;
        default:
          out += code;
      }
    } else if (ch === '{' || ch === '}') {
      i++;
    } else if (ch === '^' && i + 1 < n) {
      const c = s[i + 1];
      i += 2;
      if (c === 'I') out += '\t';
      else if (c === 'J') {
        lines.push(out);
        out = '';
      } else if (c === ' ') out += '^';
    } else {
      out += ch;
      i++;
    }
  }
  lines.push(out);
  return lines.map(percentCodes);
}
