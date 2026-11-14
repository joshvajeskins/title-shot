//! A write-through key/value map on contract storage. It replaces `near_sdk::store::LookupMap`, whose per-type cache
//! machinery cost about 3 KB of wasm per map (this contract has eleven) and whose lazy writes hid the storage
//! growth of a call: here every `insert` hits storage at once, so `env::storage_usage()` is always exact (the
//! storage component of a bout is measured with it). Values are owned (no references into a cache).
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::{env, IntoStorageKey};
use std::marker::PhantomData;

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Map<K, V> {
    prefix: Vec<u8>,
    #[borsh(skip)]
    _kv: PhantomData<(K, V)>,
}

fn full_key(prefix: &[u8], key: &[u8]) -> Vec<u8> {
    let mut k = Vec::with_capacity(prefix.len() + key.len());
    k.extend_from_slice(prefix);
    k.extend_from_slice(key);
    k
}

impl<K: BorshSerialize, V: BorshSerialize + BorshDeserialize> Map<K, V> {
    pub fn new(prefix: impl IntoStorageKey) -> Self {
        Self { prefix: prefix.into_storage_key(), _kv: PhantomData }
    }

    fn key(&self, k: &K) -> Vec<u8> {
        full_key(&self.prefix, &borsh::to_vec(k).unwrap_or_default())
    }

    pub fn get(&self, k: &K) -> Option<V> {
        let bytes = env::storage_read(&self.key(k))?;
        V::try_from_slice(&bytes).ok()
    }

    pub fn contains_key(&self, k: &K) -> bool {
        env::storage_has_key(&self.key(k))
    }

    pub fn insert(&mut self, k: K, v: V) {
        env::storage_write(&self.key(&k), &borsh::to_vec(&v).unwrap_or_default());
    }

    pub fn remove(&mut self, k: &K) {
        env::storage_remove(&self.key(k));
    }
}
