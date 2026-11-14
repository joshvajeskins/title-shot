//! Stored records (borsh). JSON views live in `views.rs`.
use crate::tx::TxParams;
use near_sdk::{near, AccountId};

pub type Hash = [u8; 32];
pub type Addr = [u8; 20];

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ForgeMode {
    Outlayer,
    Relayer,
}

impl ForgeMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "outlayer" => Some(Self::Outlayer),
            "relayer" => Some(Self::Relayer),
            _ => None,
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Outlayer => "outlayer",
            Self::Relayer => "relayer",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Belt {
    pub name: String,
    pub promoter: AccountId,
    pub toll: u128,
    pub forge_fee: u128,
    pub purse_chain_id: u64,
    /// Latest season id (0 = none yet). Season ids are per belt and start at 1.
    pub season: u32,
    /// Fighter hash of the reigning champion.
    pub champion: Option<Hash>,
    pub reign_since: u64,
    pub defences: u32,
    pub fight_count: u64,
    pub media: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SeasonState {
    /// Opener sentence is being forged.
    Opening,
    Open,
    Closed,
    /// Opener forge failed; the promoter may open a new season.
    Aborted,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Season {
    pub state: SeasonState,
    pub duration_ns: u64,
    pub opens_at: u64,
    pub closes_at: u64,
    /// `None` = sealed until the first bout.
    pub rule: Option<u8>,
    pub side_pot: u128,
    /// Resolved bouts.
    pub bouts: u32,
    /// All challenges created (any outcome).
    pub challenges: u32,
    /// Challenges still `Forging`.
    pub pending: u32,
    pub purse_wei: u128,
    pub purse_address: Option<Addr>,
    pub purse_next_nonce: u64,
    /// (defender, successful defences), capped at `MAX_DEFENDERS` distinct accounts.
    pub defenders: Vec<(AccountId, u32)>,
    pub payouts: Vec<u64>,
    pub final_holder: Option<AccountId>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Record {
    pub wins: u32,
    pub losses: u32,
    pub draws: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Fighter {
    pub sentence: String,
    /// Canonical `bout_sim::Spec` JSON (re-validated on every load).
    pub spec_json: String,
    pub writer: AccountId,
    pub forged_at: u64,
    pub signer: Addr,
    pub record: Record,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChallengeKind {
    Challenge,
    Opener,
}

#[near(serializers = [borsh])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Forging,
    /// `fight_id` is `None` for an opener (no fight).
    Resolved { fight_id: Option<u64> },
    Rejected { code: String, detail: String },
    Refunded { code: String },
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Challenge {
    pub id: u64,
    pub belt_id: u32,
    pub season_id: u32,
    pub challenger: AccountId,
    pub sentence: String,
    pub hash: Hash,
    pub status: Status,
    pub created_at: u64,
    pub need_compile: bool,
    pub kind: ChallengeKind,
    pub toll: u128,
    pub fee: u128,
    /// Created while forge_mode was `relayer` (resolved by `submit_forge`).
    pub relayer: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub struct SplitRec {
    pub champion: u128,
    pub promoter: u128,
    pub side_pot: u128,
    pub protocol: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Fight {
    pub id: u64,
    pub challenge_id: u64,
    pub belt_id: u32,
    pub season_id: u32,
    pub champion_hash: Hash,
    pub challenger_hash: Hash,
    /// Belt holder when the bout resolved (paid the champion share).
    pub holder: AccountId,
    pub challenger: AccountId,
    pub seed: Hash,
    pub seed_source: SeedSource,
    pub rule: u8,
    /// bout_sim::Winner code: 0 champion, 1 challenger, 2 draw.
    pub winner: u8,
    pub state_hash: Hash,
    pub split: SplitRec,
    pub at: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SeedSource {
    Vrf,
    Block,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SignedTx {
    pub params: TxParams,
    pub raw_tx: Vec<u8>,
    pub attempt: u32,
    /// Signed with the payee's own gas parameters (a stranger's tx is clamped and the payee may replace it freely).
    pub by_payee: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Payout {
    pub id: u64,
    pub belt_id: u32,
    pub season_id: u32,
    pub payee: AccountId,
    pub amount_wei: u128,
    pub to: Option<Addr>,
    pub nonce: Option<u64>,
    pub signed: Option<SignedTx>,
    /// A signing request is in flight: (params, started_at_ns).
    pub signing: Option<(TxParams, u64)>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Stats {
    pub deposits: u128,
    pub withdrawn: u128,
    pub tolls: u128,
    pub fees_spent: u128,
    pub refunded: u128,
    pub protocol: u128,
    /// Protocol share the owner has already paid out (`withdraw_protocol`).
    pub protocol_withdrawn: u128,
    pub challenges: u64,
    pub bouts: u64,
    pub forged: u64,
    pub rejected: u64,
    pub refunds: u64,
}
