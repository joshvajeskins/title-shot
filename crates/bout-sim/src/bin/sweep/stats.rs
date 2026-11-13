//! Fight statistics sink and a tiny scoped-thread parallel map.

use bout_sim::events::{Event, Sink};
use bout_sim::rng::Rng;
use bout_sim::sim::run;
use bout_sim::spec::Spec;
use bout_sim::types::Winner;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default, Clone, Copy)]
pub struct FightStats {
    pub winner: u8, // 0 champion, 1 challenger, 2 draw
    pub events: u32,
    pub exchanges: u32,
    pub rounds: u32,
    pub skips: [u32; 2],
    pub acts: [u32; 2],
    pub rounds_won: [u8; 2],
}

#[derive(Default)]
struct Counter(FightStats);

impl Sink for Counter {
    fn push(&mut self, e: Event) {
        self.0.events += 1;
        match e {
            Event::Exchange { .. } => self.0.exchanges += 1,
            Event::RoundEnd { .. } => self.0.rounds += 1,
            Event::Skip { actor } => self.0.skips[actor as usize] += 1,
            Event::Act { actor, .. } => self.0.acts[actor as usize] += 1,
            _ => {}
        }
    }
}

pub fn fight(champ: &Spec, chall: &Spec, seed: &[u8; 32], rule: u8) -> FightStats {
    let mut c = Counter::default();
    let (o, _, _) = run(champ, chall, seed, rule, &mut c);
    let mut s = c.0;
    s.winner = match o.winner {
        Winner::Champion => 0,
        Winner::Challenger => 1,
        Winner::Draw => 2,
    };
    s.rounds_won = o.rounds_won;
    s
}

pub fn seed_for(a: usize, b: usize, k: usize, salt: u64) -> [u8; 32] {
    Rng::from_u64(salt ^ ((a as u64) << 40) ^ ((b as u64) << 16) ^ k as u64).seed32()
}

/// Map `0..n` over all cores, returning results in index order.
pub fn par_map<R: Send, F: Fn(usize) -> R + Sync>(n: usize, f: F) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|x| x.get()).unwrap_or(4);
    let mut parts: Vec<Vec<(usize, R)>> = Vec::new();
    std::thread::scope(|s| {
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= n {
                            break;
                        }
                        out.push((i, f(i)));
                    }
                    out
                })
            })
            .collect();
        for h in hs {
            parts.push(h.join().expect("worker panicked"));
        }
    });
    let mut all: Vec<(usize, R)> = parts.into_iter().flatten().collect();
    all.sort_by_key(|x| x.0);
    all.into_iter().map(|x| x.1).collect()
}
