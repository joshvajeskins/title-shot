//! Hex without the `hex` crate (its generic iterators cost about 1 KB of wasm across the contract's 18 call sites).
//! Lower-case output; input may be either case. Strict lengths: `decode_to_slice` needs exactly `2 * out.len()` digits.

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub fn encode(b: impl AsRef<[u8]>) -> String {
    let b = b.as_ref();
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(DIGITS[(x >> 4) as usize] as char);
        s.push(DIGITS[(x & 15) as usize] as char);
    }
    s
}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub fn decode_to_slice(s: &str, out: &mut [u8]) -> Result<(), ()> {
    let b = s.as_bytes();
    if b.len() != out.len() * 2 {
        return Err(());
    }
    for (o, p) in out.iter_mut().zip(b.chunks(2)) {
        *o = nibble(p[0]).ok_or(())? << 4 | nibble(p[1]).ok_or(())?;
    }
    Ok(())
}

pub fn decode(s: &str) -> Result<Vec<u8>, ()> {
    let mut out = vec![0u8; s.len() / 2];
    decode_to_slice(s, &mut out)?;
    Ok(out)
}
