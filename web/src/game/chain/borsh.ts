// Minimal borsh writer: only what NEAR transactions need.
import { concat, utf8 } from './bytes'

export class BorshWriter {
  private parts: Uint8Array[] = []

  u8(v: number): this {
    this.parts.push(Uint8Array.of(v & 0xff))
    return this
  }
  u32(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error('u32 out of range')
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v, true)
    this.parts.push(b)
    return this
  }
  u64(v: bigint | number): this {
    const n = BigInt(v)
    if (n < 0n || n >= 1n << 64n) throw new Error('u64 out of range')
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, n, true)
    this.parts.push(b)
    return this
  }
  u128(v: bigint | number | string): this {
    let n = BigInt(v)
    if (n < 0n || n >= 1n << 128n) throw new Error('u128 out of range')
    const b = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      b[i] = Number(n & 0xffn)
      n >>= 8n
    }
    this.parts.push(b)
    return this
  }
  bytes(b: Uint8Array): this {
    this.parts.push(b)
    return this
  }
  vecU8(b: Uint8Array): this {
    this.u32(b.length)
    this.parts.push(b)
    return this
  }
  string(s: string): this {
    return this.vecU8(utf8(s))
  }
  option<T>(v: T | null | undefined, write: (v: T) => void): this {
    if (v === null || v === undefined) return this.u8(0)
    this.u8(1)
    write(v)
    return this
  }
  vec<T>(items: T[], write: (v: T) => void): this {
    this.u32(items.length)
    for (const it of items) write(it)
    return this
  }
  done(): Uint8Array {
    return concat(...this.parts)
  }
}
