//! Pure EIP-1559 helpers (no near-sdk state): build the unsigned payload, hash it, attach (r, s, y-parity).
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};

/// Everything that goes into the transaction except the signature. Stored per payout.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq, Eq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
pub struct TxParams {
    pub chain_id: u64,
    pub to: [u8; 20],
    pub value: u128,
    pub nonce: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub gas_limit: u64,
}

/// RLP header for a payload of `len` bytes (`base` is 0x80 for strings, 0xc0 for lists).
fn header(out: &mut Vec<u8>, base: u8, len: usize) {
    if len <= 55 {
        out.push(base + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let t = trim_leading_zeros(&be);
        out.push(base + 55 + t.len() as u8);
        out.extend_from_slice(t);
    }
}

fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        header(out, 0x80, b.len());
        out.extend_from_slice(b);
    }
}

/// RLP integers are big-endian with no leading zero byte (zero is the empty string).
fn put_uint(out: &mut Vec<u8>, v: u128) {
    put_bytes(out, trim_leading_zeros(&v.to_be_bytes()));
}

fn trim_leading_zeros(b: &[u8]) -> &[u8] {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    &b[i..]
}

/// `0x02 || rlp([chain_id, nonce, prio, max_fee, gas, to, value, data, access_list (, y_parity, r, s)])`, hand written
/// (a plain value transfer: empty data, empty access list) so the contract does not carry a transaction library.
fn encode(p: &TxParams, sig: Option<(u8, &[u8; 32], &[u8; 32])>) -> Vec<u8> {
    let mut body = Vec::with_capacity(160);
    put_uint(&mut body, p.chain_id as u128);
    put_uint(&mut body, p.nonce as u128);
    put_uint(&mut body, p.max_priority_fee_per_gas);
    put_uint(&mut body, p.max_fee_per_gas);
    put_uint(&mut body, p.gas_limit as u128);
    put_bytes(&mut body, &p.to);
    put_uint(&mut body, p.value);
    put_bytes(&mut body, &[]);
    body.push(0xc0);
    if let Some((v, r, s)) = sig {
        put_uint(&mut body, v as u128);
        put_bytes(&mut body, trim_leading_zeros(r));
        put_bytes(&mut body, trim_leading_zeros(s));
    }
    let mut out = Vec::with_capacity(body.len() + 4);
    out.push(0x02);
    header(&mut out, 0xc0, body.len());
    out.extend_from_slice(&body);
    out
}

/// The bytes the purse key signs (keccak256 of this is the digest).
pub fn unsigned_bytes(p: &TxParams) -> Vec<u8> {
    encode(p, None)
}

/// The broadcastable transaction: r and s from the signer are fixed 32-byte values, trimmed of leading zeros here.
pub fn signed_bytes(p: &TxParams, r: &[u8; 32], s: &[u8; 32], y_parity: u8) -> Vec<u8> {
    encode(p, Some((y_parity, r, s)))
}

pub fn parse_address(s: &str) -> Result<[u8; 20], &'static str> {
    let h = s.strip_prefix("0x").ok_or("address must start with 0x")?;
    if h.len() != 40 {
        return Err("address must be 20 bytes");
    }
    let mut out = [0u8; 20];
    crate::hex::decode_to_slice(h, &mut out).map_err(|_| "address is not hex")?;
    Ok(out)
}
