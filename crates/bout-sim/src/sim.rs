//! The referee: best-of-3 rounds, each at most 10 exchanges. Integer only, no floats, no maps.

use crate::events::*;
use crate::fighter::{hp16, Fighter};
use crate::rng::Rng;
use crate::rules::Mods;
use crate::spec::Spec;
use crate::tune::*;
use crate::types::Winner;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RoundSummary {
    /// 0 champion, 1 challenger, 2 draw.
    pub winner: u8,
    pub reason: Reason,
    pub exchanges: u8,
    pub hp: [u16; 2],
}

#[derive(Clone, Debug, Serialize)]
pub struct Fight {
    pub rounds: Vec<RoundSummary>,
    pub events: Vec<Event>,
    pub winner: Winner,
    pub rounds_won: [u8; 2],
    /// sha256 over the canonical encoding of `events`.
    pub state_hash: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome3 {
    pub winner: Winner,
    pub rounds_won: [u8; 2],
}

struct Match<'a, 'b, S: Sink> {
    f: [Fighter<'a>; 2],
    rng: Rng,
    mods: Mods,
    sink: &'b mut S,
    summaries: [RoundSummary; 3],
    n_rounds: usize,
}

mod combat;

impl<'a, 'b, S: Sink> Match<'a, 'b, S> {
    fn hps(&self) -> [u16; 2] {
        [hp16(self.f[0].hp), hp16(self.f[1].hp)]
    }
    fn shields(&self) -> [u16; 2] {
        [hp16(self.f[0].shield), hp16(self.f[1].shield)]
    }
    fn over(&self) -> bool {
        !self.f[0].alive() || !self.f[1].alive()
    }

    fn play_round(&mut self, round: u8) -> RoundSummary {
        self.f[0].reset();
        self.f[1].reset();
        for i in 0..2 {
            self.f[i].form = (FORM_MIN + self.rng.below(FORM_SPAN)) as i32;
        }
        let form = [self.f[0].form as u8, self.f[1].form as u8];
        self.sink.push(Event::RoundStart { round, form });
        let mut exchanges = 0u8;
        for n in 1..=MAX_EXCHANGES {
            exchanges = n;
            for fi in self.f.iter_mut() {
                for c in fi.cd.iter_mut() {
                    *c = c.saturating_sub(1);
                }
            }
            let i0 = self.f[0].s * INIT_SPEED_K
                + if self.f[0].haste_t > 0 { HASTE_INIT } else { 0 }
                + self.rng.below(INIT_NOISE) as i32;
            let i1 = self.f[1].s * INIT_SPEED_K
                + if self.f[1].haste_t > 0 { HASTE_INIT } else { 0 }
                + self.rng.below(INIT_NOISE) as i32;
            let first = if i0 > i1 {
                0
            } else if i1 > i0 {
                1
            } else {
                self.rng.below(2) as usize
            };
            self.sink.push(Event::Exchange { round, n, first: first as u8 });
            self.act(first);
            if !self.over() {
                self.act(1 - first);
            }
            if !self.over() {
                self.upkeep(0);
                self.upkeep(1);
            }
            if self.over() {
                break;
            }
        }
        let (w0, w1) = (self.f[0].alive(), self.f[1].alive());
        let (winner, reason) = if !w0 || !w1 {
            (if w0 { 0 } else if w1 { 1 } else { 2 }, Reason::Ko)
        } else {
            let p0 = self.f[0].hp * 1000 / self.f[0].max_hp;
            let p1 = self.f[1].hp * 1000 / self.f[1].max_hp;
            let w = if (p0 - p1).abs() < DRAW_MARGIN_PM {
                2
            } else if p0 > p1 {
                0
            } else {
                1
            };
            (w, Reason::Limit)
        };
        let hp = self.hps();
        self.sink.push(Event::RoundEnd { round, winner, reason, hp });
        RoundSummary { winner, reason, exchanges, hp }
    }
}

/// Run a match, pushing every event into `sink`.
pub fn run<S: Sink>(champ: &Spec, chall: &Spec, seed: &[u8; 32], rule: u8, sink: &mut S) -> (Outcome3, [RoundSummary; 3], usize) {
    let f = [Fighter::new(champ), Fighter::new(chall)];
    let max_hp = [hp16(f[0].max_hp), hp16(f[1].max_hp)];
    let blank = RoundSummary { winner: 2, reason: Reason::Limit, exchanges: 0, hp: [0, 0] };
    let mut m = Match { f, rng: Rng::from_seed(seed), mods: Mods::from_rule(rule), sink, summaries: [blank; 3], n_rounds: 0 };
    m.sink.push(Event::MatchStart { rule, max_hp });
    let mut won = [0u8; 2];
    for round in 1..=MAX_ROUNDS {
        let s = m.play_round(round);
        m.summaries[m.n_rounds] = s;
        m.n_rounds += 1;
        if s.winner < 2 {
            won[s.winner as usize] += 1;
        }
        if won[0] >= 2 || won[1] >= 2 {
            break;
        }
    }
    let winner = if won[0] > won[1] {
        Winner::Champion
    } else if won[1] > won[0] {
        Winner::Challenger
    } else {
        Winner::Draw
    };
    m.sink.push(Event::MatchEnd { winner: winner.code(), rounds: won });
    (Outcome3 { winner, rounds_won: won }, m.summaries, m.n_rounds)
}

/// Full fight with events and `state_hash`.
pub fn simulate(champ: &Spec, chall: &Spec, seed: [u8; 32], rule: u8) -> Fight {
    let mut sink = VecSink::default();
    let (o, sums, n) = run(champ, chall, &seed, rule, &mut sink);
    let rounds = sums[..n].to_vec();
    let state_hash = hash_events(&sink.0);
    Fight { rounds, events: sink.0, winner: o.winner, rounds_won: o.rounds_won, state_hash }
}

/// Winner and `state_hash` without keeping events (what the contract needs).
pub fn simulate_lite(champ: &Spec, chall: &Spec, seed: [u8; 32], rule: u8) -> (Winner, [u8; 32]) {
    let mut sink = HashSink::new();
    let (o, _, _) = run(champ, chall, &seed, rule, &mut sink);
    (o.winner, sink.finish())
}

/// Winner only (odds, sweeps).
pub fn winner_only(champ: &Spec, chall: &Spec, seed: &[u8; 32], rule: u8) -> Outcome3 {
    run(champ, chall, seed, rule, &mut NullSink).0
}
