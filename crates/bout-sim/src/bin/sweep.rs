//! Balance sweep. `cargo run --release --bin sweep [-- --quick] [-- --write] [-- --climb | --climb-only | --no-climb] [-- --restarts N --steps N --salt N]`
//! Gates G1..G9 are fixed; tune src/tune.rs and src/moves.rs until all pass. Exit code 1 on any failure.
//! G9 (adversarial hill-climb) runs in a full sweep, with `--climb` in any mode, alone with `--climb-only`.

#[path = "sweep/climb.rs"]
mod climb;
#[path = "sweep/parts.rs"]
mod parts;
#[path = "sweep/stats.rs"]
mod stats;

use bout_sim::moves::{LIBRARY, LIB_LEN};
use bout_sim::rng::Rng;
use bout_sim::spec::{normalize, Raw, Spec};
use bout_sim::testgen::random_spec;
use bout_sim::types::{School, Style};
use parts::*;
use serde::Deserialize;
use std::fmt::Write;
use stats::par_map;

#[derive(Deserialize)]
struct Arch {
    sentence: String,
    raw: Raw,
}

pub fn pm(x: u64, d: u64) -> String {
    let v = if d == 0 { 0 } else { (x * 1000 + d / 2) / d };
    format!("{}.{}%", v / 10, v % 10)
}

pub struct Cfg {
    pub n_random: usize,
    pub opponents: usize,
    pub seeds: usize,
    pub pairs: usize,
    pub pair_seeds: usize,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let quick = args.iter().any(|a| a == "--quick");
    let write_md = args.iter().any(|a| a == "--write");
    let tune = args.iter().any(|a| a == "--tune");
    let climb_only = args.iter().any(|a| a == "--climb-only");
    let climb_on = climb_only || args.iter().any(|a| a == "--climb") || (!quick && !tune && !args.iter().any(|a| a == "--no-climb"));
    let mut ccfg = if quick || tune { climb::SMALL } else { climb::FULL };
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|p| args.get(p + 1)).and_then(|v| v.parse::<u64>().ok());
    ccfg.restarts = opt("--restarts").map_or(ccfg.restarts, |v| v as usize);
    ccfg.steps = opt("--steps").map_or(ccfg.steps, |v| v as usize);
    ccfg.salt = opt("--salt").unwrap_or(ccfg.salt);
    let cfg = if tune {
        Cfg { n_random: 1500, opponents: 80, seeds: 5, pairs: 200, pair_seeds: 10 }
    } else if quick {
        Cfg { n_random: 400, opponents: 60, seeds: 5, pairs: 300, pair_seeds: 10 }
    } else {
        Cfg { n_random: 2000, opponents: 300, seeds: 5, pairs: 1000, pair_seeds: 25 }
    };
    let arch: Vec<Arch> = serde_json::from_str(include_str!("../../fixtures/archetypes.json")).expect("archetypes.json");
    let mut pool: Vec<Spec> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    for a in &arch {
        pool.push(normalize(&a.raw).expect("archetype must normalize"));
        labels.push(a.raw.name.clone());
    }
    let n_arch = pool.len();
    let mut rng = Rng::from_u64(0x7171_5EED);
    for i in 0..cfg.n_random {
        pool.push(random_spec(&mut rng, i % 2 == 1));
        labels.push(format!("rand{}", i));
    }
    let n = pool.len();
    if climb_only {
        let top: Vec<Spec> = pool[..n_arch].to_vec();
        let r = climb::run(&pool, &top, &cfg, &ccfg);
        print!("{}", r.report);
        println!("elapsed {}s", r.secs);
        std::process::exit(if r.gate_ok { 0 } else { 1 });
    }
    let t0 = std::time::Instant::now();
    let a_res = par_map(n, |i| part_a(&pool, i, &cfg));
    let t_a = t0.elapsed().as_secs();
    let b_res = part_b(&pool, &cfg);
    let t_b = t0.elapsed().as_secs() - t_a;

    // ranking by win rate (permille)
    let wr = |r: &AResult| (r.wins as u64 * 1000) / r.fights.max(1) as u64;
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| wr(&a_res[y]).cmp(&wr(&a_res[x])).then(x.cmp(&y)));
    let top50: Vec<usize> = order.iter().copied().take(50).collect();
    let counters = par_map(top50.len(), |k| best_counter(&pool, top50[k], &cfg));
    let t_c = t0.elapsed().as_secs() - t_a - t_b;
    let climbed = if climb_on {
        let top: Vec<Spec> = order.iter().take(30).map(|&i| pool[i].clone()).collect();
        Some(climb::run(&pool, &top, &cfg, &ccfg))
    } else {
        None
    };

    let mut out = String::new();
    let o = &mut out;
    let _ = writeln!(o, "# bout-sim balance sweep\n");
    let _ = writeln!(o, "pool = {} archetypes + {} random valid specs (half uniform, half school-themed) = {}", n_arch, cfg.n_random, n);
    let _ = writeln!(o, "part A: each spec vs {} opponents x {} seeds x 8 rules = {} fights/spec", cfg.opponents, cfg.seeds, cfg.opponents * cfg.seeds * 8);
    let _ = writeln!(o, "part B: {} random pairs x {} seeds x 8 rules = {} fights/pair; counters: top-50 vs whole pool at the same depth", cfg.pairs, cfg.pair_seeds, cfg.pair_seeds * 8);
    let _ = writeln!(o, "mode: {}  elapsed: A {}s, B {}s, counters {}s, G9 climb {}\n", if quick { "QUICK (not valid for SWEEP.md)" } else { "FULL" }, t_a, t_b, t_c, climbed.as_ref().map_or("not run".to_string(), |c| format!("{}s", c.secs)));

    let _ = writeln!(o, "definitions: win rate = decisive wins / fights (draws count as non-wins), seats alternate; G2 counter = a pool spec with >=55% decisive wins against the target at the part-B depth (first one found); G4 p = (wins + draws/2)/fights per pair, pairs drawn at random from the pool, noise floor shown as the pure-dice null; G6 stun loss = skipped turns / (skipped + acted turns) per fighter per matchup, max over matchups; G7 top 25% = best quarter of the pool by win rate.\n");
    // ---- gates
    let max_wr = order.iter().map(|&i| wr(&a_res[i])).max().unwrap_or(0);
    let g2_ok = counters.iter().filter(|c| c.1 >= 550).count();
    let arch_wr: Vec<u64> = (0..n_arch).map(|i| wr(&a_res[i])).collect();
    let (amin, amax) = (arch_wr.iter().min().copied().unwrap_or(0), arch_wr.iter().max().copied().unwrap_or(0));
    let g4 = b_res.mean_dev_pm();
    let draw_pm = b_res.draw_pm();
    let ex_pm = b_res.mean_exchanges_x1000();
    let stun_max = b_res.max_stun_pm;
    let maxev = b_res.max_events.max(a_res.iter().map(|r| r.max_events).max().unwrap_or(0));

    let top_cut = n / 4;
    let (mut mv_seen, mut sc_seen, mut st_seen) = ([false; LIB_LEN], [false; 6], [false; 4]);
    let mut mv_top = [0u32; LIB_LEN];
    for &i in order.iter().take(top_cut) {
        for m in &pool[i].moves {
            mv_seen[m.id as usize] = true;
            mv_top[m.id as usize] += 1;
        }
        sc_seen[pool[i].school.idx()] = true;
        st_seen[pool[i].style as usize] = true;
    }
    let mv_n = mv_seen.iter().filter(|&&x| x).count();
    let sc_n = sc_seen.iter().filter(|&&x| x).count();
    let st_n = st_seen.iter().filter(|&&x| x).count();

    let gates: Vec<(&str, &str, String, bool)> = vec![
        ("G1", "no spec > 65% win rate vs pool", format!("max {}", pm(max_wr, 1000)), max_wr <= 650),
        ("G2", "every top-50 spec has a counter >= 55%", format!("{}/50 found", g2_ok), g2_ok == 50),
        ("G3", "every archetype within 30-70%", format!("{} .. {}", pm(amin, 1000), pm(amax, 1000)), amin >= 300 && amax <= 700),
        ("G4", "mean |p-0.5| over random pairs >= 0.12", format!("{} (pure-dice null {})", fmt3(g4), fmt3(b_res.null_dev_pm)), g4 >= 120),
        ("G5", "match draw rate 3-12%", pm(draw_pm as u64, 1000), (30..=120).contains(&draw_pm)),
        ("G6", "mean exchanges/round 5-10, max stun-turn loss <= 40%", format!("{}.{:02} ex/round, max stun loss {}", ex_pm / 1000, (ex_pm % 1000) / 10, pm(stun_max as u64, 1000)), (5000..=10000).contains(&ex_pm) && stun_max <= 400),
        ("G7", "top-25% has >=80% of moves, all schools, all styles", format!("{}/{} moves, {}/6 schools, {}/4 styles", mv_n, LIB_LEN, sc_n, st_n), mv_n * 100 >= LIB_LEN * 80 && sc_n == 6 && st_n == 4),
        ("G8", "events per fight <= 200", format!("max {}", maxev), maxev <= 200),
    ];
    let mut gates = gates;
    if let Some(c) = &climbed {
        gates.push(("G9", "climbed specs re-measured <= 65%, each has a counter >= 55%", format!("top-5 max {} (all finals {}), {}/5 have a counter", pm(c.max_top5_pm, 1000), pm(c.max_all_pm, 1000), c.counters_ok), c.gate_ok));
    }
    let _ = writeln!(o, "## Gates\n\n| gate | requirement | measured | result |\n|---|---|---|---|");
    for (g, req, got, ok) in &gates {
        let _ = writeln!(o, "| {} | {} | {} | {} |", g, req, got, if *ok { "PASS" } else { "FAIL" });
    }
    let all = gates.iter().all(|g| g.3);
    if climbed.is_none() {
        let _ = writeln!(o, "| G9 | adversarial hill-climb | NOT RUN (pass --climb) | NOT RUN |");
    }
    let _ = writeln!(o, "\n**{}**\n", if !all { "GATES FAILING" } else if climbed.is_none() { "G1-G8 PASS, G9 NOT RUN" } else { "ALL GATES PASS" });
    if let Some(c) = &climbed {
        let _ = writeln!(o, "{}", c.report);
    }

    // ---- diagnostics
    let _ = writeln!(o, "## Diagnostics\n");
    let avg = |idx: &[usize]| -> u64 { if idx.is_empty() { 0 } else { idx.iter().map(|&i| wr(&a_res[i])).sum::<u64>() / idx.len() as u64 } };
    let _ = writeln!(o, "win rate by school (mean over specs):");
    for s in School::ALL {
        let ix: Vec<usize> = (0..n).filter(|&i| pool[i].school == s).collect();
        let _ = writeln!(o, "- {}: {} ({} specs)", s.name(), pm(avg(&ix), 1000), ix.len());
    }
    let _ = writeln!(o, "\nwin rate by number of Strike moves:");
    for k in 1..=3 {
        let ix: Vec<usize> = (0..n).filter(|&i| pool[i].moves.iter().filter(|m| LIBRARY[m.id as usize].kind == bout_sim::moves::Kind::Strike).count() == k).collect();
        let _ = writeln!(o, "- {} strikes: {} ({} specs)", k, pm(avg(&ix), 1000), ix.len());
    }
    let _ = writeln!(o, "\nwin rate by style:");
    for s in Style::ALL {
        let ix: Vec<usize> = (0..n).filter(|&i| pool[i].style == s).collect();
        let _ = writeln!(o, "- {}: {} ({} specs)", s.name(), pm(avg(&ix), 1000), ix.len());
    }
    let _ = writeln!(o, "\nwin rate by arena rule (mean spread over specs; fights per rule equal):");
    for r in 0..8 {
        let w: u64 = a_res.iter().map(|x| x.rule_wins[r] as u64).sum();
        let f: u64 = a_res.iter().map(|x| x.rule_fights[r] as u64).sum();
        let _ = writeln!(o, "- rule {} : decisive wins {}", r, pm(w, f));
    }
    let _ = writeln!(o, "\nmoves: win rate of specs containing the move, and appearances in the top 25%:");
    for (k, m) in LIBRARY.iter().enumerate() {
        let ix: Vec<usize> = (0..n).filter(|&i| pool[i].moves.iter().any(|x| x.id as usize == k)).collect();
        let _ = writeln!(o, "- {:<15} {:<5} cost {:>2}  mean WR {}  top25 {}", m.id, m.school.name(), m.cost, pm(avg(&ix), 1000), mv_top[k]);
    }
    let _ = writeln!(o, "\nwin-rate quantiles (specs): min {} p10 {} p50 {} p90 {} max {}", pm(wr(&a_res[order[n - 1]]), 1000), pm(wr(&a_res[order[n * 9 / 10]]), 1000), pm(wr(&a_res[order[n / 2]]), 1000), pm(wr(&a_res[order[n / 10]]), 1000), pm(max_wr, 1000));
    let _ = writeln!(o, "champion-seat win share over part B fights: {}  (side bias check; draws {} )", pm(b_res.champ_wins, b_res.fights), pm(b_res.draws, b_res.fights));
    let _ = writeln!(o, "per-matchup mean exchanges/round: min {} max {}", fmt3(b_res.min_ex_pm), fmt3(b_res.max_ex_pm));
    let _ = writeln!(o, "\narchetypes (win rate vs pool, decisive wins only):");
    let mut ar: Vec<usize> = (0..n_arch).collect();
    ar.sort_by_key(|&i| std::cmp::Reverse(wr(&a_res[i])));
    for i in ar {
        let _ = writeln!(o, "- {:<24} {:<5} {:<14} {}  | {}", labels[i], pool[i].school.name(), pool[i].style.name(), pm(wr(&a_res[i]), 1000), arch[i].sentence);
    }
    let _ = writeln!(o, "\ntop 10 specs:");
    for &i in order.iter().take(10) {
        let ms: Vec<&str> = pool[i].moves.iter().map(|m| LIBRARY[m.id as usize].id).collect();
        let _ = writeln!(o, "- {:<10} {} {} {:?} stats {:?} WR {}", labels[i], pool[i].school.name(), pool[i].style.name(), ms, pool[i].stats.as_array(), pm(wr(&a_res[i]), 1000));
    }
    let _ = writeln!(o, "\nbottom 5 specs:");
    for &i in order.iter().rev().take(5) {
        let ms: Vec<&str> = pool[i].moves.iter().map(|m| LIBRARY[m.id as usize].id).collect();
        let _ = writeln!(o, "- {:<10} {} {} {:?} stats {:?} WR {}", labels[i], pool[i].school.name(), pool[i].style.name(), ms, pool[i].stats.as_array(), pm(wr(&a_res[i]), 1000));
    }
    if let Some(pos) = args.iter().position(|a| a == "--csv") {
        let mut csv = String::from("wr,p,g,s,gr,school,style");
        for m in LIBRARY.iter() {
            csv.push(',');
            csv.push_str(m.id);
        }
        csv.push('\n');
        for i in 0..n {
            let st = pool[i].stats;
            let _ = write!(csv, "{},{},{},{},{},{},{}", wr(&a_res[i]), st.power, st.guard, st.speed, st.grit, pool[i].school.idx(), pool[i].style as u8);
            for k in 0..LIB_LEN {
                let _ = write!(csv, ",{}", pool[i].moves.iter().any(|m| m.id as usize == k) as u8);
            }
            csv.push('\n');
        }
        std::fs::write(&args[pos + 1], csv).expect("csv");
    }
    print!("{}", out);
    if write_md && !quick && climbed.is_some() {
        std::fs::write("SWEEP.md", &out).expect("write SWEEP.md");
    }
    if !all {
        std::process::exit(1);
    }
}

pub fn fmt3(pm: u32) -> String {
    format!("{}.{:03}", pm / 1000, pm % 1000)
}
