//! Standard-alphabet base64 (RFC 4648, `=` padding) for the two request byte strings of `new` and `set_request`.
//! Hand written because `near_sdk::json_types::Base64VecU8` pulls the whole `base64` engine (~7 KB of wasm) for two
//! one-off admin arguments. Strict: wrong length, foreign characters, padding anywhere but the end are refused.
use near_sdk::serde::de::{Deserialize, Deserializer, Error};

/// Decoded bytes of a JSON base64 string.
pub struct B64(pub Vec<u8>);

pub fn decode(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let groups = b.len() / 4;
    for (i, g) in b.chunks(4).enumerate() {
        let (mut n, mut pad) = (0u32, 0usize);
        for &c in g {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' if i + 1 == groups => {
                    pad += 1;
                    0
                }
                _ => return None,
            };
            if pad > 0 && c != b'=' {
                return None;
            }
            n = (n << 6) | v as u32;
        }
        if pad > 2 || (pad > 0 && g[4 - pad..].iter().any(|c| *c != b'=')) {
            return None;
        }
        out.extend_from_slice(&n.to_be_bytes()[1..4 - pad]);
    }
    Some(out)
}

impl<'de> Deserialize<'de> for B64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        decode(&s).map(B64).ok_or_else(|| D::Error::custom("bad base64"))
    }
}

pub fn encode(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

impl near_sdk::serde::Serialize for B64 {
    fn serialize<S: near_sdk::serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&encode(&self.0))
    }
}
