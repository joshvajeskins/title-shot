//! Independent EIP-1559 helpers (own RLP, own recovery): what the contract's `sign_payout` must produce.
//! Nothing here shares code with the contract (which hand-writes its RLP), so agreement is evidence.
use crate::fixtures::keccak;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut o = header(0x80, b.len());
    o.extend_from_slice(b);
    o
}
fn header(base: u8, len: usize) -> Vec<u8> {
    if len < 56 {
        vec![base + len as u8]
    } else {
        let l = len.to_be_bytes();
        let l: Vec<u8> = l.iter().copied().skip_while(|x| *x == 0).collect();
        let mut o = vec![base + 55 + l.len() as u8];
        o.extend(l);
        o
    }
}
pub fn rlp_uint(v: u128) -> Vec<u8> {
    let b = v.to_be_bytes();
    let t: Vec<u8> = b.iter().copied().skip_while(|x| *x == 0).collect();
    rlp_bytes(&t)
}
pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut o = header(0xc0, body.len());
    o.extend(body);
    o
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
}

impl Tx {
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas),
            rlp_uint(self.max_fee_per_gas),
            rlp_uint(self.gas_limit as u128),
            rlp_bytes(&self.to),
            rlp_uint(self.value),
            rlp_bytes(&[]),
            rlp_list(&[]),
        ]
    }
    /// keccak256(0x02 || rlp(fields)): the digest handed to the signer.
    pub fn digest(&self) -> [u8; 32] {
        let mut m = vec![2u8];
        m.extend(rlp_list(&self.fields()));
        keccak(&m)
    }
    /// Reference raw tx for a (r, s, parity) signature (leading zeros trimmed: RLP integers).
    pub fn raw(&self, parity: u8, r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
        let trim = |x: &[u8; 32]| -> Vec<u8> { x.iter().copied().skip_while(|b| *b == 0).collect() };
        let mut f = self.fields();
        f.push(rlp_uint(parity as u128));
        f.push(rlp_bytes(&trim(r)));
        f.push(rlp_bytes(&trim(s)));
        let mut o = vec![2u8];
        o.extend(rlp_list(&f));
        o
    }
}

/// Decoded view of a signed type-2 transaction.
pub struct Decoded {
    pub tx: Tx,
    pub parity: u8,
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub sender: [u8; 20],
}

fn item(b: &[u8]) -> (&[u8], &[u8], bool) {
    // returns (payload, rest, is_list)
    let p = b[0];
    match p {
        0..=0x7f => (&b[..1], &b[1..], false),
        0x80..=0xb7 => {
            let l = (p - 0x80) as usize;
            (&b[1..1 + l], &b[1 + l..], false)
        }
        0xb8..=0xbf => {
            let n = (p - 0xb7) as usize;
            let l = be(&b[1..1 + n]) as usize;
            (&b[1 + n..1 + n + l], &b[1 + n + l..], false)
        }
        0xc0..=0xf7 => {
            let l = (p - 0xc0) as usize;
            (&b[1..1 + l], &b[1 + l..], true)
        }
        _ => {
            let n = (p - 0xf7) as usize;
            let l = be(&b[1..1 + n]) as usize;
            (&b[1 + n..1 + n + l], &b[1 + n + l..], true)
        }
    }
}
fn be(b: &[u8]) -> u128 {
    b.iter().fold(0u128, |a, x| (a << 8) | *x as u128)
}
fn pad32(b: &[u8]) -> [u8; 32] {
    let mut o = [0u8; 32];
    o[32 - b.len()..].copy_from_slice(b);
    o
}

pub fn decode(raw_hex: &str) -> Decoded {
    let raw = hex::decode(raw_hex.strip_prefix("0x").unwrap_or(raw_hex)).expect("raw tx hex");
    assert_eq!(raw[0], 2, "not an EIP-1559 (type 2) transaction");
    let (list, rest, is_list) = item(&raw[1..]);
    assert!(is_list && rest.is_empty(), "malformed rlp list");
    let mut items: Vec<(&[u8], bool)> = vec![];
    let mut cur = list;
    while !cur.is_empty() {
        let (p, r, l) = item(cur);
        items.push((p, l));
        cur = r;
    }
    assert_eq!(items.len(), 12, "type 2 tx has 12 fields");
    assert!(items[8].1 && items[8].0.is_empty(), "access list must be empty");
    assert!(items[7].0.is_empty(), "data must be empty (plain ETH transfer)");
    let mut to = [0u8; 20];
    assert_eq!(items[5].0.len(), 20, "to must be 20 bytes");
    to.copy_from_slice(items[5].0);
    let tx = Tx {
        chain_id: be(items[0].0) as u64,
        nonce: be(items[1].0) as u64,
        max_priority_fee_per_gas: be(items[2].0),
        max_fee_per_gas: be(items[3].0),
        gas_limit: be(items[4].0) as u64,
        to,
        value: be(items[6].0),
    };
    // RLP integers carry no leading zeros: a leading zero byte in r or s would be an invalid transaction
    for (n, i) in [(10, items[10].0), (11, items[11].0)] {
        assert!(i.is_empty() || i[0] != 0, "field {n} has a leading zero byte (invalid RLP integer)");
        assert!(i.len() <= 32);
    }
    let parity = be(items[9].0) as u8;
    let (r, s) = (pad32(items[10].0), pad32(items[11].0));
    let digest = tx.digest();
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&r);
    rs[32..].copy_from_slice(&s);
    let sig = Signature::from_slice(&rs).expect("r,s");
    let vk = VerifyingKey::recover_from_prehash(&digest, &sig, RecoveryId::from_byte(parity).expect("parity")).expect("recover");
    let pt = vk.to_encoded_point(false);
    let mut sender = [0u8; 20];
    sender.copy_from_slice(&keccak(&pt.as_bytes()[1..])[12..]);
    Decoded { tx, parity, r, s, sender }
}

/// `secp256k1:<base58(X||Y)>` (the signer's derived_public_key) -> 0x-address.
pub fn address_from_derived_key(k: &str) -> String {
    let b = bs58::decode(k.strip_prefix("secp256k1:").expect("secp256k1: prefix")).into_vec().expect("base58");
    assert_eq!(b.len(), 64);
    format!("0x{}", hex::encode(&keccak(&b)[12..]))
}

pub fn addr_bytes(a: &str) -> [u8; 20] {
    let mut o = [0u8; 20];
    hex::decode_to_slice(a.strip_prefix("0x").unwrap_or(a), &mut o).expect("address hex");
    o
}
