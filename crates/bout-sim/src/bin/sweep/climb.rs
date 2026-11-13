//! Gate G9: adversarial hill-climb. An adversary who can write any sentence searches the whole
//! spec space (school, style, three moves, four weights) one mutation at a time against the pool,
//! then the best climbed specs are re-measured on fresh seeds and fresh opponent samples under
//! G1's definition. Pass: every re-measured spec <= 65% and each has a pool counter >= 55% (G2).

use crate::stats::{fight, par_map, seed_for};
use crate::{pm, Cfg};
use bout_sim::alloc::allocate;
use bout_sim::moves::{Kind, LIBRARY, LIB_LEN};
use bout_sim::rng::Rng;
use bout_sim::spec::{Spec, SpecMove};
use bout_sim::types::{School, Stats, Style, BUDGET};
use std::fmt::Write;

#[derive(Clone, Copy)]
pub struct ClimbCfg {
    pub restarts: usize,
    pub steps: usize,
    /// Opponents per fitness sample (x 8 rules x 1 seed); the sample is redrawn every `epoch` steps.
    pub sample: usize,
    pub epoch: usize,
    /// Changes every restart's rng stream (independent re-runs of the same search).
    pub salt: u64,
}

pub const FULL: ClimbCfg = ClimbCfg { restarts: 24, steps: 1200, sample: 128, epoch: 60, salt: 0 };
pub const SMALL: ClimbCfg = ClimbCfg { restarts: 16, steps: 1200, sample: 64, epoch: 60, salt: 0 };

#[derive(Clone, PartialEq, Eq)]
pub struct Genome {
    school: u8,
    style: u8,
    ids: [u8; 3],
    w: [u8; 4],
}

impl Genome {
    fn valid(&self) -> bool {
        let [a, b, c] = self.ids;
        a != b && a != c && b != c && self.ids.iter().any(|&i| LIBRARY[i as usize].kind == Kind::Strike)
    }

    pub fn spec(&self) -> Spec {
        let cost: u32 = self.ids.iter().map(|&i| LIBRARY[i as usize].cost as u32).sum();
        let w = self.w.map(|x| x as u32);
        let a = allocate(BUDGET - cost, w);
        let mv = |i: u8| SpecMove { id: i, label: "x".into() };
        Spec {
            name: "Climber".into(),
            title: "Climbed".into(),
            look: "x".into(),
            cry: "x".into(),
            school: School::ALL[self.school as usize],
            style: Style::ALL[self.style as usize],
            moves: [mv(self.ids[0]), mv(self.ids[1]), mv(self.ids[2])],
            stats: Stats { power: a[0], guard: a[1], speed: a[2], grit: a[3] },
        }
    }

    fn random(rng: &mut Rng) -> Genome {
        loop {
            let g = Genome {
                school: rng.below(6) as u8,
                style: rng.below(4) as u8,
                ids: [rng.below(LIB_LEN as u32) as u8, rng.below(LIB_LEN as u32) as u8, rng.below(LIB_LEN as u32) as u8],
                w: [1 + rng.below(10) as u8, 1 + rng.below(10) as u8, 1 + rng.below(10) as u8, 1 + rng.below(10) as u8],
            };
            if g.valid() {
                return g;
            }
        }
    }

    fn from_spec(s: &Spec) -> Genome {
        let st = s.stats.as_array();
        Genome {
            school: s.school.idx() as u8,
            style: s.style as u8,
            ids: [s.moves[0].id, s.moves[1].id, s.moves[2].id],
            w: st.map(|x| ((x as u32 * 10 + 22) / 45).clamp(1, 10) as u8),
        }
    }

    /// One mutation: a move, a weight, the school or the style.
    fn mutate(&self, rng: &mut Rng) -> Genome {
        loop {
            let mut g = self.clone();
            match rng.below(100) {
                0..=34 => g.ids[rng.below(3) as usize] = rng.below(LIB_LEN as u32) as u8,
                35..=79 => {
                    let k = rng.below(4) as usize;
                    g.w[k] = if rng.below(3) == 0 { 1 + rng.below(10) as u8 } else { (g.w[k] as i32 + rng.below(5) as i32 - 2).clamp(1, 10) as u8 };
                }
                80..=89 => g.school = rng.below(6) as u8,
                _ => g.style = rng.below(4) as u8,
            }
            if g != *self && g.valid() {
                return g;
            }
        }
    }

    pub fn describe(&self) -> String {
        let s = self.spec();
        let ms: Vec<&str> = self.ids.iter().map(|&i| LIBRARY[i as usize].id).collect();
        format!("{} {} {:?} stats {:?}", s.school.name(), s.style.name(), ms, s.stats.as_array())
    }
}

/// Wins over `opps` x `seeds` x 8 rules (seats alternate). Seeds depend on (tag, opponent, rule, salt) only.
fn eval(pool: &[Spec], spec: &Spec, opps: &[usize], seeds: usize, tag: usize, salt: u64) -> (u32, u32) {
    let (mut wins, mut fights) = (0, 0);
    for (k, &j) in opps.iter().enumerate() {
        for s in 0..seeds {
            for rule in 0..8usize {
                let me_champ = (s + rule + k) % 2 == 0;
                let seed = seed_for(tag, j, s * 8 + rule, salt);
                let (f, side) = if me_champ { (fight(spec, &pool[j], &seed, rule as u8), 0) } else { (fight(&pool[j], spec, &seed, rule as u8), 1) };
                fights += 1;
                wins += (f.winner == side) as u32;
            }
        }
    }
    (wins, fights)
}

fn sample(rng: &mut Rng, n: usize, k: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..n).collect();
    let k = k.min(n);
    for t in 0..k {
        let r = t + rng.below((n - t) as u32) as usize;
        idx.swap(t, r);
    }
    idx.truncate(k);
    idx
}

/// Win count and fights of `spec` against a fresh random opponent sample.
fn measure(pool: &[Spec], spec: &Spec, opponents: usize, seeds: usize, tag: usize, salt: u64) -> (u32, u32) {
    let mut rng = Rng::from_u64(salt ^ 0x5A5A_0000 ^ tag as u64);
    let opps = sample(&mut rng, pool.len(), opponents);
    eval(pool, spec, &opps, seeds, tag, salt)
}

fn climb(pool: &[Spec], top: &[Spec], r: usize, c: &ClimbCfg) -> Genome {
    let mut rng = Rng::from_u64(0xC11B_0000 ^ r as u64 ^ (c.salt << 24));
    let mut cur = if r.is_multiple_of(2) { Genome::random(&mut rng) } else { Genome::from_spec(&top[(r / 2) % top.len()]) };
    let mut spec = cur.spec();
    let (mut opps, mut base) = (Vec::new(), 0u32);
    for step in 0..c.steps {
        if step % c.epoch == 0 {
            opps = sample(&mut rng, pool.len(), c.sample);
            base = eval(pool, &spec, &opps, 1, r * 1000 + step / c.epoch, 0xC11B).0;
        }
        let cand = cur.mutate(&mut rng);
        let cs = cand.spec();
        let w = eval(pool, &cs, &opps, 1, r * 1000 + step / c.epoch, 0xC11B).0;
        if w >= base {
            cur = cand;
            spec = cs;
            base = w;
        }
    }
    cur
}

pub struct Climbed {
    pub gate_ok: bool,
    pub max_top5_pm: u64,
    pub max_all_pm: u64,
    pub counters_ok: usize,
    pub report: String,
    pub secs: u64,
}

/// Run G9. `top` are the pool's best specs by G1 win rate (half the restarts start there).
pub fn run(pool: &[Spec], top: &[Spec], cfg: &Cfg, c: &ClimbCfg) -> Climbed {
    let t0 = std::time::Instant::now();
    let finals: Vec<Genome> = par_map(c.restarts, |r| climb(pool, top, r, c));
    // rank on a deeper selection sample, then re-measure on fresh seeds and fresh opponents
    let sel = par_map(finals.len(), |i| measure(pool, &finals[i].spec(), 200, 3, 700 + i, 0x5E1E).0);
    let fresh = par_map(finals.len(), |i| measure(pool, &finals[i].spec(), cfg.opponents, cfg.seeds, 900 + i, 0xF2E5));
    let fights = fresh[0].1 as u64;
    let mut order: Vec<usize> = (0..finals.len()).collect();
    order.sort_by(|&a, &b| sel[b].cmp(&sel[a]).then(a.cmp(&b)));
    let mut best: Vec<usize> = Vec::new();
    for &i in &order {
        if best.len() < 5 && !best.iter().any(|&b| finals[b] == finals[i]) {
            best.push(i);
        }
    }
    let counters = par_map(best.len(), |k| confirmed_counter(pool, &finals[best[k]].spec(), cfg, k));
    let known: Vec<(Genome, (u32, u32))> = KNOWN.iter().enumerate().map(|(k, b)| (b.build(), measure(pool, &b.build().spec(), cfg.opponents, cfg.seeds, 1200 + k, 0xF2E5))).collect();
    let wr = |i: usize| fresh[i].0 as u64 * 1000 / fresh[i].1 as u64;
    let max_top5 = best.iter().map(|&i| wr(i)).max().unwrap_or(0);
    let max_known = known.iter().map(|(_, r)| r.0 as u64 * 1000 / r.1 as u64).max().unwrap_or(0);
    let max_all = (0..finals.len()).map(wr).max().unwrap_or(0);
    let counters_ok = counters.iter().filter(|c| c.0 != usize::MAX).count();
    let gate_ok = max_top5 <= 650 && max_known <= 650 && counters_ok == best.len();

    let mut o = String::new();
    let _ = writeln!(o, "## G9 adversarial hill-climb\n");
    let _ = writeln!(o, "{} restarts x {} single-mutation steps (move / weight / school / style), half from random specs and half from the top pool specs; fitness = wins over {} opponents x 8 rules, redrawn every {} steps; acceptance on >=.", c.restarts, c.steps, c.sample, c.epoch);
    let _ = writeln!(o, "Selection: the 5 best distinct finals on a separate 200 opponents x 3 seeds x 8 rules sample. Re-measure: fresh seeds (new salt) and a fresh sample of {} opponents x {} seeds x 8 rules = {} fights each (G1's definition: decisive wins / fights).", cfg.opponents, cfg.seeds, fights);
    let _ = writeln!(o, "Counter: a pool spec with >= 55% decisive wins against the climbed spec at part-B depth ({} fights) that also scores >= 55% at 4x depth on other seeds (first one found).\n", cfg.pair_seeds * 8);
    let _ = writeln!(o, "| # | climbed spec | selection | fresh G1 | pool counter (part-B depth) | same counter at 4x depth |\n|---|---|---|---|---|---|");
    for (k, &i) in best.iter().enumerate() {
        let cn = counters[k];
        let (cname, c4) = if cn.0 == usize::MAX { ("none".to_string(), "-".to_string()) } else { (format!("pool#{} {}", cn.0, pm(cn.1 as u64, 1000)), pm(cn.2 as u64, 1000)) };
        let _ = writeln!(o, "| {} | {} | {} | {} | {} | {} |", k + 1, finals[i].describe(), pm(sel[i] as u64, 200 * 3 * 8), pm(fresh[i].0 as u64, fresh[i].1 as u64), cname, c4);
    }
    let all: Vec<String> = (0..finals.len()).map(|i| pm(fresh[i].0 as u64, fresh[i].1 as u64)).collect();
    let _ = writeln!(o, "\nknown exploits from earlier audits, re-measured on fresh seeds and opponents (gated too):");
    for (g, r) in &known {
        let _ = writeln!(o, "- {} : {}", g.describe(), pm(r.0 as u64, r.1 as u64));
    }
    let _ = writeln!(o, "\nall {} climbed finals, fresh G1 (diagnostic, not gated): max {}  [{}]\n", finals.len(), pm(max_all, 1000), all.join(" "));
    let mut freq = [0usize; LIB_LEN];
    let mut styles = [0usize; 4];
    for g in &finals {
        g.ids.iter().for_each(|&i| freq[i as usize] += 1);
        styles[g.style as usize] += 1;
    }
    let mut fo: Vec<usize> = (0..LIB_LEN).collect();
    fo.sort_by_key(|&i| std::cmp::Reverse(freq[i]));
    let fs: Vec<String> = fo.iter().take(8).map(|&i| format!("{} {}", LIBRARY[i].id, freq[i])).collect();
    let ss: Vec<String> = Style::ALL.iter().map(|s| format!("{} {}", s.name(), styles[*s as usize])).collect();
    let _ = writeln!(o, "most common moves in the climbed finals: {}; styles: {}\n", fs.join(", "), ss.join(", "));
    let _ = writeln!(o, "| gate | requirement | measured | result |\n|---|---|---|---|");
    let _ = writeln!(o, "| G9 | every re-measured climbed spec <= 65% and each has a pool counter >= 55% | top-5 max {}, known exploits max {}, {}/{} have a counter | {} |", pm(max_top5, 1000), pm(max_known, 1000), counters_ok, best.len(), if gate_ok { "PASS" } else { "FAIL" });
    Climbed { gate_ok, max_top5_pm: max_top5, max_all_pm: max_all, counters_ok, report: o, secs: t0.elapsed().as_secs() }
}

/// Wins of pool spec `j` against `target` over `seeds` x 8 rules.
fn eval_pair(pool: &[Spec], j: usize, target: &Spec, seeds: usize, tag: usize) -> (u32, u32) {
    let (mut wins, mut n) = (0, 0);
    for s in 0..seeds {
        for rule in 0..8usize {
            let seed = seed_for(tag, j, s * 8 + rule, 0xDDDD);
            let j_champ = (s + rule) % 2 == 0;
            let (f, side) = if j_champ { (fight(&pool[j], target, &seed, rule as u8), 0) } else { (fight(target, &pool[j], &seed, rule as u8), 1) };
            n += 1;
            wins += (f.winner == side) as u32;
        }
    }
    (wins, n)
}

/// First pool spec with >= 55% decisive wins at part-B depth that also holds >= 55% at 4x depth on
/// other seeds. Returns (pool index, part-B pm, 4x pm) or index usize::MAX when none exists.
fn confirmed_counter(pool: &[Spec], target: &Spec, cfg: &Cfg, k: usize) -> (usize, u32, u32) {
    let d1 = cfg.pair_seeds;
    for j in 0..pool.len() {
        let (w, n) = eval_pair(pool, j, target, d1, 0xC0DE + k);
        if w * 1000 / n < 550 {
            continue;
        }
        let (w4, n4) = eval_pair(pool, j, target, 4 * d1, 0xFEED + k);
        let (a, b) = (w * 1000 / n, w4 * 1000 / n4);
        if b >= 550 {
            return (j, a, b);
        }
    }
    (usize::MAX, 0, 0)
}

/// Exploits found by earlier audits (weights chosen to reproduce the audited stat lines).
const KNOWN: [KnownBuild; 5] = [
    KnownBuild { school: "MIND", style: "SHOWBOAT", moves: ["hex_gaze", "smolder", "brain_freeze"], w: [1, 1, 10, 5] },
    KnownBuild { school: "VOLT", style: "SHOWBOAT", moves: ["chain_shock", "overclock", "thunderclap"], w: [1, 1, 10, 3] },
    KnownBuild { school: "IRON", style: "SHOWBOAT", moves: ["rivet_barrage", "focus", "overclock"], w: [1, 1, 1, 10] },
    KnownBuild { school: "BLAZE", style: "SHOWBOAT", moves: ["melt_through", "battle_roar", "rivet_barrage"], w: [4, 2, 6, 1] },
    KnownBuild { school: "MIND", style: "SHOWBOAT", moves: ["foresight", "psy_siphon", "bulwark"], w: [5, 5, 5, 5] },
];

struct KnownBuild {
    school: &'static str,
    style: &'static str,
    moves: [&'static str; 3],
    w: [u8; 4],
}

impl KnownBuild {
    fn build(&self) -> Genome {
        let id = |m: &str| bout_sim::moves::find(m).expect("known move");
        Genome {
            school: School::from_name(self.school).expect("school") as u8,
            style: Style::from_name(self.style).expect("style") as u8,
            ids: [id(self.moves[0]), id(self.moves[1]), id(self.moves[2])],
            w: self.w,
        }
    }
}
