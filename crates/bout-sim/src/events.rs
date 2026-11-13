//! Event log schema. See EVENTS.md. `encode` is the canonical byte form that `state_hash` covers.

use serde::Serialize;
use sha2::{Digest, Sha256};

/// Status bit flags for `fx_self`, `fx_foe` and `expired`.
pub mod fx {
    pub const BURN: u8 = 1;
    pub const STUN: u8 = 2;
    pub const SHIELD: u8 = 4;
    pub const WEAKEN: u8 = 8;
    pub const HASTE: u8 = 16;
    pub const COUNTER: u8 = 32;
    pub const CHARGE: u8 = 64;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Damaging move landed.
    Hit,
    /// Damaging move landed as a critical hit.
    Crit,
    /// Accuracy roll failed.
    Miss,
    /// A shield soaked all of the damage.
    Blocked,
    /// Foe's counter stance deflected half of the damage back at the actor.
    Countered,
    /// Non-damaging move resolved (stance, buff, heal, hex that landed).
    Used,
}

impl Outcome {
    pub fn code(self) -> u8 {
        match self {
            Outcome::Hit => 0,
            Outcome::Crit => 1,
            Outcome::Miss => 2,
            Outcome::Blocked => 3,
            Outcome::Countered => 4,
            Outcome::Used => 5,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Ko,
    Limit,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Event {
    /// First event. `max_hp` = [champion, challenger].
    MatchStart { rule: u8, max_hp: [u16; 2] },
    /// `form` = each side's damage multiplier in percent for this round (30..=170).
    RoundStart { round: u8, form: [u8; 2] },
    /// `first` = side that acts first this exchange (0 champion, 1 challenger).
    Exchange { round: u8, n: u8, first: u8 },
    Act {
        actor: u8,
        /// 0..=2 = the actor's move slot, 3 = fallback basic move.
        slot: u8,
        /// Library index, or 255 for the basic move.
        move_id: u8,
        outcome: Outcome,
        /// Landed hits (multihit), 0 for non-damaging or missed moves.
        hits: u8,
        /// HP removed from the target (after shield, counter halving).
        dmg: u16,
        /// Damage soaked by the target's shield.
        absorbed: u16,
        /// HP the actor regained (lifesteal / heal moves).
        heal: u16,
        /// HP the actor lost to a counter.
        recoil: u16,
        /// HP of [champion, challenger] after this action.
        hp: [u16; 2],
        /// Remaining shield of [champion, challenger] after this action.
        shield: [u16; 2],
        /// Status flags put on the actor.
        fx_self: u8,
        /// Status flags put on the foe.
        fx_foe: u8,
    },
    /// Actor lost its action to a stun.
    Skip { actor: u8 },
    /// End-of-exchange upkeep for one side: burn damage and expired statuses.
    Upkeep { side: u8, burn: u16, hp: [u16; 2], expired: u8 },
    /// `winner`: 0 champion, 1 challenger, 2 draw.
    RoundEnd { round: u8, winner: u8, reason: Reason, hp: [u16; 2] },
    /// `winner`: 0 champion, 1 challenger, 2 draw. `rounds` = round wins [champion, challenger].
    MatchEnd { winner: u8, rounds: [u8; 2] },
}

fn p16(o: &mut Vec<u8>, v: u16) {
    o.extend_from_slice(&v.to_le_bytes());
}

impl Event {
    /// Canonical encoding: tag byte then fixed-width little-endian fields in declaration order.
    pub fn encode(&self, o: &mut Vec<u8>) {
        match *self {
            Event::MatchStart { rule, max_hp } => {
                o.extend_from_slice(&[1, rule]);
                p16(o, max_hp[0]);
                p16(o, max_hp[1]);
            }
            Event::RoundStart { round, form } => o.extend_from_slice(&[2, round, form[0], form[1]]),
            Event::Exchange { round, n, first } => o.extend_from_slice(&[3, round, n, first]),
            Event::Act {
                actor, slot, move_id, outcome, hits, dmg, absorbed, heal, recoil, hp, shield, fx_self, fx_foe,
            } => {
                o.extend_from_slice(&[4, actor, slot, move_id, outcome.code(), hits]);
                for v in [dmg, absorbed, heal, recoil, hp[0], hp[1], shield[0], shield[1]] {
                    p16(o, v);
                }
                o.extend_from_slice(&[fx_self, fx_foe]);
            }
            Event::Skip { actor } => o.extend_from_slice(&[5, actor]),
            Event::Upkeep { side, burn, hp, expired } => {
                o.extend_from_slice(&[6, side]);
                p16(o, burn);
                p16(o, hp[0]);
                p16(o, hp[1]);
                o.push(expired);
            }
            Event::RoundEnd { round, winner, reason, hp } => {
                o.extend_from_slice(&[7, round, winner, reason as u8]);
                p16(o, hp[0]);
                p16(o, hp[1]);
            }
            Event::MatchEnd { winner, rounds } => o.extend_from_slice(&[8, winner, rounds[0], rounds[1]]),
        }
    }
}

/// Receives events as the simulator produces them.
pub trait Sink {
    fn push(&mut self, e: Event);
}

/// Keeps every event.
#[derive(Default)]
pub struct VecSink(pub Vec<Event>);

impl Sink for VecSink {
    fn push(&mut self, e: Event) {
        self.0.push(e);
    }
}

/// Streams events into sha256 without storing them (the contract path).
pub struct HashSink {
    hasher: Sha256,
    buf: Vec<u8>,
    pub count: u32,
}

impl HashSink {
    pub fn new() -> HashSink {
        HashSink { hasher: Sha256::new(), buf: Vec::with_capacity(48), count: 0 }
    }
    pub fn finish(self) -> [u8; 32] {
        self.hasher.finalize().into()
    }
}

impl Default for HashSink {
    fn default() -> Self {
        Self::new()
    }
}

impl Sink for HashSink {
    fn push(&mut self, e: Event) {
        self.buf.clear();
        e.encode(&mut self.buf);
        self.hasher.update(&self.buf);
        self.count += 1;
    }
}

/// Discards events (odds / win-rate sweeps).
pub struct NullSink;

impl Sink for NullSink {
    fn push(&mut self, _e: Event) {}
}

/// Hash of an event list: sha256 over the concatenated canonical encodings.
pub fn hash_events(events: &[Event]) -> [u8; 32] {
    let mut s = HashSink::new();
    for e in events {
        s.push(e.clone());
    }
    s.finish()
}
