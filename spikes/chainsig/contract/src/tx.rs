//! Pure EIP-1559 helpers (no near-sdk state): build the unsigned payload, hash it, attach (r, s, y-parity).
use omni_transaction::evm::types::Signature;
use omni_transaction::evm::EVMTransaction;
use omni_transaction::{TransactionBuilder, TxBuilder, EVM};
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

impl TxParams {
    pub fn to_tx(&self) -> EVMTransaction {
        TransactionBuilder::new::<EVM>()
            .chain_id(self.chain_id)
            .nonce(self.nonce)
            .to(self.to)
            .value(self.value)
            .input(vec![])
            .gas_limit(self.gas_limit as u128)
            .max_fee_per_gas(self.max_fee_per_gas)
            .max_priority_fee_per_gas(self.max_priority_fee_per_gas)
            .build()
    }
}

/// 0x02 || rlp([chain_id, nonce, prio, max_fee, gas, to, value, data, access_list]).
pub fn unsigned_bytes(p: &TxParams) -> Vec<u8> {
    p.to_tx().build_for_signing()
}

/// RLP integers have no leading zero bytes; r and s from the signer are fixed 32-byte values.
fn trim_leading_zeros(b: &[u8]) -> Vec<u8> {
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

pub fn signed_bytes(p: &TxParams, r: &[u8; 32], s: &[u8; 32], y_parity: u8) -> Vec<u8> {
    let sig = Signature { v: y_parity as u64, r: trim_leading_zeros(r), s: trim_leading_zeros(s) };
    p.to_tx().build_with_signature(&sig)
}

pub fn parse_address(s: &str) -> Result<[u8; 20], &'static str> {
    let h = s.strip_prefix("0x").ok_or("address must start with 0x")?;
    if h.len() != 40 {
        return Err("address must be 20 bytes");
    }
    let mut out = [0u8; 20];
    hex::decode_to_slice(h, &mut out).map_err(|_| "address is not hex")?;
    Ok(out)
}
