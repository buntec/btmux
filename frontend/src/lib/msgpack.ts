// Minimal msgpack codec for the Neovim RPC stream.

export interface MsgpackExt {
  type: number;
  data: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encode(value: unknown): Uint8Array {
  const out: number[] = [];
  const u8 = (n: number) => out.push(n & 0xff);
  const u16 = (n: number) => out.push((n >> 8) & 0xff, n & 0xff);
  const u32 = (n: number) => out.push((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  const bytes = (b: Uint8Array) => {
    for (const x of b) out.push(x);
  };
  const write = (v: unknown): void => {
    if (v === null || v === undefined) u8(0xc0);
    else if (v === false) u8(0xc2);
    else if (v === true) u8(0xc3);
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) {
        if (v < 0x80) u8(v);
        else if (v < 0x100) {
          u8(0xcc);
          u8(v);
        } else if (v < 0x10000) {
          u8(0xcd);
          u16(v);
        } else {
          u8(0xce);
          u32(v);
        }
      } else if (Number.isInteger(v) && v < 0 && v >= -0x80000000) {
        if (v >= -32) u8(v);
        else if (v >= -0x80) {
          u8(0xd0);
          u8(v);
        } else if (v >= -0x8000) {
          u8(0xd1);
          u16(v);
        } else {
          u8(0xd2);
          u32(v);
        }
      } else {
        const buf = new DataView(new ArrayBuffer(8));
        buf.setFloat64(0, v);
        u8(0xcb);
        bytes(new Uint8Array(buf.buffer));
      }
    } else if (typeof v === 'string') {
      const b = textEncoder.encode(v);
      if (b.length < 32) u8(0xa0 | b.length);
      else if (b.length < 0x100) {
        u8(0xd9);
        u8(b.length);
      } else if (b.length < 0x10000) {
        u8(0xda);
        u16(b.length);
      } else {
        u8(0xdb);
        u32(b.length);
      }
      bytes(b);
    } else if (v instanceof Uint8Array) {
      if (v.length < 0x100) {
        u8(0xc4);
        u8(v.length);
      } else if (v.length < 0x10000) {
        u8(0xc5);
        u16(v.length);
      } else {
        u8(0xc6);
        u32(v.length);
      }
      bytes(v);
    } else if (Array.isArray(v)) {
      if (v.length < 16) u8(0x90 | v.length);
      else if (v.length < 0x10000) {
        u8(0xdc);
        u16(v.length);
      } else {
        u8(0xdd);
        u32(v.length);
      }
      v.forEach(write);
    } else if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length < 16) u8(0x80 | entries.length);
      else if (entries.length < 0x10000) {
        u8(0xde);
        u16(entries.length);
      } else {
        u8(0xdf);
        u32(entries.length);
      }
      for (const [k, x] of entries) {
        write(k);
        write(x);
      }
    } else {
      throw new Error(`msgpack: cannot encode ${typeof v}`);
    }
  };
  write(value);
  return new Uint8Array(out);
}

class Incomplete extends Error {}

/** Incremental decoder: feed arbitrary chunks, get back complete messages. */
export class MsgpackStream {
  // Buffered bytes are buf[start, len). Headers before `scan` are known to be
  // complete, and the message starting at `start` still needs `pending` items,
  // so each byte is scanned once and each message decoded once.
  private buf = new Uint8Array(0);
  private len = 0;
  private start = 0;
  private scan = 0;
  private pending = 1;

  push(chunk: Uint8Array): unknown[] {
    this.append(chunk);
    const messages: unknown[] = [];
    while (this.complete()) {
      messages.push(new Reader(this.buf.subarray(0, this.scan), this.start).read());
      this.start = this.scan;
      this.pending = 1;
    }
    if (this.start === this.len) this.start = this.scan = this.len = 0;
    return messages;
  }

  private append(chunk: Uint8Array) {
    if (this.len + chunk.length > this.buf.length) {
      const used = this.len - this.start;
      const buf =
        used + chunk.length > this.buf.length
          ? new Uint8Array(Math.max(2 * this.buf.length, used + chunk.length))
          : this.buf;
      buf.set(this.buf.subarray(this.start, this.len));
      this.buf = buf;
      this.len = used;
      this.scan -= this.start;
      this.start = 0;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }

  /** Scan item headers; true once the current message is complete. */
  private complete(): boolean {
    while (this.pending > 0) {
      const item = itemSize(this.buf, this.scan, this.len);
      if (!item) return false;
      this.scan += item[0];
      this.pending += item[1] - 1;
    }
    return true;
  }
}

/** Header plus payload length and child item count of the item at `p`, or null if incomplete. */
function itemSize(b: Uint8Array, p: number, end: number): [number, number] | null {
  if (p >= end) return null;
  const t = b[p];
  const len = (n: number) => {
    let v = 0;
    for (let i = 1; i <= n; i++) v = v * 256 + b[p + i];
    return v;
  };
  let head = 1;
  let body = 0;
  let items = 0;
  if (t < 0x80 || t >= 0xe0) {
    // fixint
  } else if (t < 0x90) items = 2 * (t & 0x0f);
  else if (t < 0xa0) items = t & 0x0f;
  else if (t < 0xc0) body = t & 0x1f;
  else {
    const fixed = FIXED_SIZES[t - 0xc0];
    if (fixed === undefined) throw new Error(`msgpack: bad type byte 0x${t.toString(16)}`);
    head = fixed;
    if (head > 1 && p + head > end) return null;
    switch (t) {
      case 0xc4:
      case 0xd9:
        body = len(1);
        break;
      case 0xc5:
      case 0xda:
        body = len(2);
        break;
      case 0xc6:
      case 0xdb:
        body = len(4);
        break;
      case 0xc7:
        body = len(1);
        break;
      case 0xc8:
        body = len(2);
        break;
      case 0xc9:
        body = len(4);
        break;
      case 0xdc:
        items = len(2);
        break;
      case 0xdd:
        items = len(4);
        break;
      case 0xde:
        items = 2 * len(2);
        break;
      case 0xdf:
        items = 2 * len(4);
        break;
    }
  }
  return p + head + body > end ? null : [head + body, items];
}

/** Header size (with fixed-size payloads) for type bytes 0xc0–0xdf; undefined = invalid. */
// prettier-ignore
const FIXED_SIZES: (number | undefined)[] = [
  1, undefined, 1, 1, 2, 3, 5, 3, 4, 6, 5, 9, 2, 3, 5, 9, // c0–cf
  2, 3, 5, 9, 3, 4, 6, 10, 18, 2, 3, 5, 3, 5, 3, 5, // d0–df
];

class Reader {
  private view: DataView;

  constructor(
    private b: Uint8Array,
    public pos: number,
  ) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  private need(n: number) {
    if (this.pos + n > this.b.length) throw new Incomplete();
  }
  private u8() {
    this.need(1);
    return this.b[this.pos++];
  }
  private u16() {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  private u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  private raw(n: number) {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** A copy: the stream reuses its buffer. */
  private bin(n: number) {
    return this.raw(n).slice();
  }
  private str(n: number) {
    return textDecoder.decode(this.raw(n));
  }
  private array(n: number) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.read();
    return out;
  }
  private map(n: number) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const k = this.read();
      out[String(k)] = this.read();
    }
    return out;
  }
  private ext(n: number): MsgpackExt {
    const type = (this.u8() << 24) >> 24;
    return { type, data: this.bin(n) };
  }

  read(): unknown {
    const t = this.u8();
    if (t < 0x80) return t;
    if (t < 0x90) return this.map(t & 0x0f);
    if (t < 0xa0) return this.array(t & 0x0f);
    if (t < 0xc0) return this.str(t & 0x1f);
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.bin(this.u8());
      case 0xc5:
        return this.bin(this.u16());
      case 0xc6:
        return this.bin(this.u32());
      case 0xc7:
        return this.ext(this.u8());
      case 0xc8:
        return this.ext(this.u16());
      case 0xc9:
        return this.ext(this.u32());
      case 0xca: {
        this.need(4);
        const v = this.view.getFloat32(this.pos);
        this.pos += 4;
        return v;
      }
      case 0xcb: {
        this.need(8);
        const v = this.view.getFloat64(this.pos);
        this.pos += 8;
        return v;
      }
      case 0xcc:
        return this.u8();
      case 0xcd:
        return this.u16();
      case 0xce:
        return this.u32();
      case 0xcf: {
        const hi = this.u32();
        return hi * 2 ** 32 + this.u32();
      }
      case 0xd0:
        return (this.u8() << 24) >> 24;
      case 0xd1:
        return (this.u16() << 16) >> 16;
      case 0xd2:
        return this.u32() | 0;
      case 0xd3: {
        const hi = this.u32() | 0;
        return hi * 2 ** 32 + this.u32();
      }
      case 0xd4:
        return this.ext(1);
      case 0xd5:
        return this.ext(2);
      case 0xd6:
        return this.ext(4);
      case 0xd7:
        return this.ext(8);
      case 0xd8:
        return this.ext(16);
      case 0xd9:
        return this.str(this.u8());
      case 0xda:
        return this.str(this.u16());
      case 0xdb:
        return this.str(this.u32());
      case 0xdc:
        return this.array(this.u16());
      case 0xdd:
        return this.array(this.u32());
      case 0xde:
        return this.map(this.u16());
      case 0xdf:
        return this.map(this.u32());
      default:
        throw new Error(`msgpack: bad type byte 0x${t.toString(16)}`);
    }
  }
}
