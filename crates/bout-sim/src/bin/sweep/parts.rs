//! The measurement passes: A (pool win rates), B (random-pair matchups), counter search.

use crate::stats::{fight, par_map, seed_for};
use crate::Cfg;
use bout_sim::rng::Rng;
use bout_sim::spec::Spec;

pub struct AResult {
    pub wins: u32,
    pub fights: u32,
    pub rule_wins: [u32; 8],
    pub rule_fights: [u32; 8],
    pub max_events: u32,
}

pub fn part_a(pool: &[Spec], i: usize, cfg: &Cfg) -> AResult {
    let n = pool.len();
    let mut rng = Rng::from_u64(0xA000_0000 ^ i as u64);
    let mut idx: Vec<u32> = (0..n as u32).filter(|&x| x as usize != i).collect();
    let k = cfg.opponents.min(idx.len());
    for t in 0..k {
        let r = t + rng.below((idx.len() - t) as u32) as usize;
        idx.swap(t, r);
    }
    let mut res = AResult { wins: 0, fights: 0, rule_wins: [0; 8], rule_fights: [0; 8], max_events: 0 };
    for &j in &idx[..k] {
        let j = j as usize;
        for s in 0..cfg.seeds {
            for rule in 0..8usize {
                let me_champ = (s + rule) % 2 == 0;
                let seed = seed_for(i, j, s * 8 + rule, 0xAAAA);
                let (f, side) = if me_champ {
                    (fight(&pool[i], &pool[j], &seed, rule as u8), 0)
                } else {
                    (fight(&pool[j], &pool[i], &seed, rule as u8), 1)
                };
                res.fights += 1;
                res.rule_fights[rule] += 1;
                if f.winner == side {
                    res.wins += 1;
                    res.rule_wins[rule] += 1;
                }
                res.max_events = res.max_events.max(f.events);
            }
        }
    }
    res
}

#[derive(Default, Clone, Copy)]
struct PairRes {
    score_pm: u32,
    fights: u64,
    draws: u64,
    champ_wins: u64,
    exchanges: u64,
    rounds: u64,
    stun_pm: u32,
    ex_pm: u32,
    max_events: u32,
}

fn pair_fights(pool: &[Spec], a: usize, b: usize, seeds: usize, salt: u64) -> PairRes {
    let mut r = PairRes::default();
    let (mut wins_a, mut skips, mut turns) = (0u64, [0u64; 2], [0u64; 2]);
    for s in 0..seeds {
        for rule in 0..8usize {
            let a_champ = (s + rule) % 2 == 0;
            let seed = seed_for(a, b, s * 8 + rule, salt);
            let f = if a_champ { fight(&pool[a], &pool[b], &seed, rule as u8) } else { fight(&pool[b], &pool[a], &seed, rule as u8) };
            let a_side = if a_champ { 0 } else { 1 };
            r.fights += 1;
            if f.winner == 2 {
                r.draws += 1;
            } else if f.winner == a_side {
                wins_a += 1;
            }
            if f.winner == 0 {
                r.champ_wins += 1;
            }
            r.exchanges += f.exchanges as u64;
            r.rounds += f.rounds as u64;
            for side in 0..2 {
                // map to "a" = 0, "b" = 1
                let who = if side == a_side as usize { 0 } else { 1 };
                skips[who] += f.skips[side] as u64;
                turns[who] += (f.skips[side] + f.acts[side]) as u64;
            }
            r.max_events = r.max_events.max(f.events);
        }
    }
    r.score_pm = ((2 * wins_a + r.draws) * 500 / r.fights) as u32;
    r.stun_pm = (0..2).map(|w| (skips[w] * 1000 / turns[w].max(1)) as u32).max().unwrap_or(0);
    r.ex_pm = (r.exchanges * 1000 / r.rounds.max(1)) as u32;
    r
}

pub struct BResult {
    pairs: usize,
    dev_sum: u64,
    pub null_dev_pm: u32,
    pub fights: u64,
    pub draws: u64,
    pub champ_wins: u64,
    exchanges: u64,
    rounds: u64,
    pub max_stun_pm: u32,
    pub min_ex_pm: u32,
    pub max_ex_pm: u32,
    pub max_events: u32,
}

impl BResult {
    pub fn mean_dev_pm(&self) -> u32 {
        (self.dev_sum / self.pairs.max(1) as u64) as u32
    }
    pub fn draw_pm(&self) -> u32 {
        (self.draws * 1000 / self.fights.max(1)) as u32
    }
    pub fn mean_exchanges_x1000(&self) -> u32 {
        (self.exchanges * 1000 / self.rounds.max(1)) as u32
    }
}

pub fn part_b(pool: &[Spec], cfg: &Cfg) -> BResult {
    let n = pool.len();
    let res = par_map(cfg.pairs, |p| {
        let mut rng = Rng::from_u64(0xB000_0000 ^ p as u64);
        let a = rng.below(n as u32) as usize;
        let mut b = rng.below(n as u32 - 1) as usize;
        if b >= a {
            b += 1;
        }
        pair_fights(pool, a, b, cfg.pair_seeds, 0xBBBB)
    });
    let nfights = (cfg.pair_seeds * 8) as u32;
    let mut rng = Rng::from_u64(0xC0FFEE);
    let mut null_sum = 0u64;
    for _ in 0..cfg.pairs {
        let heads = (0..nfights).filter(|_| rng.below(2) == 1).count() as u64;
        null_sum += (heads * 1000 / nfights as u64).abs_diff(500);
    }
    let mut b = BResult {
        pairs: cfg.pairs,
        dev_sum: 0,
        null_dev_pm: (null_sum / cfg.pairs as u64) as u32,
        fights: 0,
        draws: 0,
        champ_wins: 0,
        exchanges: 0,
        rounds: 0,
        max_stun_pm: 0,
        min_ex_pm: u32::MAX,
        max_ex_pm: 0,
        max_events: 0,
    };
    for r in &res {
        b.dev_sum += (r.score_pm as u64).abs_diff(500);
        b.fights += r.fights;
        b.draws += r.draws;
        b.champ_wins += r.champ_wins;
        b.exchanges += r.exchanges;
        b.rounds += r.rounds;
        b.max_stun_pm = b.max_stun_pm.max(r.stun_pm);
        b.min_ex_pm = b.min_ex_pm.min(r.ex_pm);
        b.max_ex_pm = b.max_ex_pm.max(r.ex_pm);
        b.max_events = b.max_events.max(r.max_events);
    }
    b
}

/// First pool spec that beats `target` in >= 55% of fights (decisive wins), else the best found.
pub fn best_counter(pool: &[Spec], target: usize, cfg: &Cfg) -> (usize, u32) {
    let total = (cfg.pair_seeds * 8) as u32;
    let mut best = (target, 0u32);
    for j in 0..pool.len() {
        if j == target {
            continue;
        }
        let mut wins = 0u32;
        for s in 0..cfg.pair_seeds {
            for rule in 0..8usize {
                let j_champ = (s + rule) % 2 == 0;
                let seed = seed_for(j, target, s * 8 + rule, 0xCCCC);
                let (f, side) = if j_champ {
                    (fight(&pool[j], &pool[target], &seed, rule as u8), 0)
                } else {
                    (fight(&pool[target], &pool[j], &seed, rule as u8), 1)
                };
                if f.winner == side {
                    wins += 1;
                }
            }
        }
        let pm = wins * 1000 / total;
        if pm > best.1 {
            best = (j, pm);
        }
        if pm >= 550 {
            return (j, pm);
        }
    }
    best
}
