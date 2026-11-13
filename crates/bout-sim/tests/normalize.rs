mod common;
use bout_sim::moves::{Kind, LIBRARY};
use bout_sim::rng::Rng;
use bout_sim::spec::*;
use bout_sim::testgen::random_raw;
use bout_sim::types::*;
use bout_sim::{normalize, normalize_str};
use common::*;

fn stats_ok(s: &Spec) {
    let st = s.stats.as_array();
    assert!(st.iter().all(|&x| (STAT_MIN..=STAT_MAX).contains(&x)), "{:?}", st);
    assert_eq!(s.stats.sum() + s.move_costs(), BUDGET, "budget must be exactly 100");
    assert!(s.moves.iter().any(|m| LIBRARY[m.id as usize].kind == Kind::Strike));
}

#[test]
fn budget_is_exactly_100_for_random_specs() {
    let mut rng = Rng::from_u64(1);
    for i in 0..5000 {
        let spec = normalize(&random_raw(&mut rng, i % 2 == 0)).unwrap();
        stats_ok(&spec);
    }
}

#[test]
fn extreme_weights_clamp_into_range() {
    for w in [[10, 1, 1, 1], [1, 10, 1, 1], [1, 1, 10, 1], [1, 1, 1, 10], [10, 10, 10, 10], [1, 1, 1, 1], [-5, 0, 99, 1_000_000]] {
        let mut r = base_raw();
        r.weights = RawWeights { power: w[0], guard: w[1], speed: w[2], grit: w[3] };
        stats_ok(&normalize(&r).unwrap());
    }
    // out-of-range weights behave exactly like the nearest legal weight
    let mut a = base_raw();
    a.weights = RawWeights { power: -5, guard: 0, speed: 99, grit: 1_000_000 };
    let mut b = base_raw();
    b.weights = RawWeights { power: 1, guard: 1, speed: 10, grit: 10 };
    assert_eq!(normalize(&a).unwrap(), normalize(&b).unwrap());
}

#[test]
fn allocate_always_sums_to_pool_and_respects_caps() {
    let mut rng = Rng::from_u64(2);
    for _ in 0..20_000 {
        let pool = 22 + rng.below(61); // 22..=82 covers every reachable pool
        let w = [rng.below(10) + 1, rng.below(10) + 1, rng.below(10) + 1, rng.below(10) + 1];
        let a = allocate(pool, w);
        assert_eq!(a.iter().map(|&x| x as u32).sum::<u32>(), pool, "{pool} {w:?}");
        assert!(a.iter().all(|&x| (5..=45).contains(&x)), "{a:?}");
        // monotone in weights: a strictly larger weight never gets fewer points
        for i in 0..4 {
            for j in 0..4 {
                if w[i] > w[j] {
                    assert!(a[i] >= a[j], "{pool} {w:?} {a:?}");
                }
            }
        }
    }
    assert_eq!(allocate(60, [1, 1, 1, 1]), [15, 15, 15, 15]);
}

#[test]
fn every_move_triple_has_a_feasible_pool() {
    let max = LIBRARY.iter().map(|m| m.cost as u32).max().unwrap();
    assert!(BUDGET - 3 * max >= 4 * STAT_MIN as u32, "stats must always fit the minimum");
}

#[test]
fn every_reject_code_is_reachable() {
    let mut seen: Vec<&'static str> = Vec::new();
    let mut check = |e: Reject, code: &str| {
        assert_eq!(e.code(), code);
        seen.push(e.code());
    };
    check(normalize_str("not json").unwrap_err(), "E_BAD_JSON");
    check(normalize_str("{\"name\":1}").unwrap_err(), "E_BAD_JSON");
    let mut r = base_raw();
    r.verdict = "refused".into();
    check(normalize(&r).unwrap_err(), "E_REFUSED");
    r = base_raw();
    r.verdict = "maybe".into();
    check(normalize(&r).unwrap_err(), "E_BAD_JSON");
    for field in ["name", "title", "look", "cry"] {
        r = base_raw();
        match field {
            "name" => r.name = "   \t".into(),
            "title" => r.title = "".into(),
            "look" => r.look = "\n\n".into(),
            _ => r.cry = " ".into(),
        }
        let e = normalize(&r).unwrap_err();
        assert_eq!(e.field(), Some(field));
        check(e, "E_EMPTY_FIELD");
    }
    r = base_raw();
    r.moves[1].label = "  ".into();
    let e = normalize(&r).unwrap_err();
    assert_eq!(e.field(), Some("label"));
    check(e, "E_EMPTY_FIELD");
    r = base_raw();
    r.name = "Bad\u{0007}Name".into();
    check(normalize(&r).unwrap_err(), "E_BAD_CHAR");
    r = base_raw();
    r.cry = "hello\u{202E}dlrow".into();
    check(normalize(&r).unwrap_err(), "E_BAD_CHAR");
    r = base_raw();
    r.school = "FIRE".into();
    check(normalize(&r).unwrap_err(), "E_BAD_SCHOOL");
    r = base_raw();
    r.school = "blaze".into();
    check(normalize(&r).unwrap_err(), "E_BAD_SCHOOL");
    r = base_raw();
    r.style = "NINJA".into();
    check(normalize(&r).unwrap_err(), "E_BAD_STYLE");
    r = base_raw();
    r.moves.pop();
    check(normalize(&r).unwrap_err(), "E_MOVE_COUNT");
    r = base_raw();
    r.moves.push(r.moves[0].clone());
    check(normalize(&r).unwrap_err(), "E_MOVE_COUNT");
    r = base_raw();
    r.moves[2].id = "shadow_realm".into();
    check(normalize(&r).unwrap_err(), "E_UNKNOWN_MOVE");
    r = base_raw();
    r.moves[2] = r.moves[0].clone();
    check(normalize(&r).unwrap_err(), "E_DUP_MOVE");
    // stored spec tampered: stats no longer match the budget
    let good = serde_json::to_value(normalize(&base_raw()).unwrap()).unwrap();
    let mut bad = good.clone();
    bad["stats"]["power"] = serde_json::json!(44);
    check(Spec::from_json(&bad.to_string()).unwrap_err(), "E_BAD_STATS");
    check(check_sentence("hi").unwrap_err(), "E_BAD_SENTENCE");
    for c in ALL_CODES {
        assert!(seen.contains(&c), "code {c} never produced");
    }
}

#[test]
fn reject_precedence_is_stable() {
    // verdict beats everything, fields beat school, school beats style, style beats moves
    let mut r = base_raw();
    r.verdict = "refused".into();
    r.name = "".into();
    assert_eq!(normalize(&r).unwrap_err(), Reject::Refused);
    r = base_raw();
    r.name = "".into();
    r.school = "x".into();
    assert_eq!(normalize(&r).unwrap_err().code(), "E_EMPTY_FIELD");
    r = base_raw();
    r.school = "x".into();
    r.style = "y".into();
    assert_eq!(normalize(&r).unwrap_err(), Reject::BadSchool);
    r = base_raw();
    r.style = "y".into();
    r.moves.clear();
    assert_eq!(normalize(&r).unwrap_err(), Reject::BadStyle);
}

#[test]
fn strings_are_trimmed_capped_and_cleaned() {
    let mut r = base_raw();
    r.name = format!("  {}  ", "Z".repeat(40));
    r.title = "line one\nline two\ttabbed".into();
    r.look = "😀".repeat(200);
    r.cry = "é".repeat(100);
    r.moves[0].label = format!("{}   ", "L".repeat(23)) + "Mx";
    let s = normalize(&r).unwrap();
    assert_eq!(s.name.chars().count(), CAP_NAME);
    assert_eq!(s.title, "line one line two tabbed");
    assert_eq!(s.look.chars().count(), CAP_LOOK);
    assert_eq!(s.cry.chars().count(), CAP_CRY);
    assert!(s.moves[0].label.chars().count() <= CAP_LABEL && !s.moves[0].label.ends_with(' '));
    assert!(s.look.is_char_boundary(s.look.len()));
    // emoji (including ZWJ sequences) are fine; zero-width space and bidi marks are not
    r = base_raw();
    r.cry = "👩\u{200D}⚖️ objection!".into();
    assert!(normalize(&r).is_ok());
    for bad in ["\u{200B}", "\u{200E}", "\u{2066}", "\u{FEFF}", "\u{0000}", "\u{007F}", "\u{0085}"] {
        r = base_raw();
        r.name = format!("a{bad}b");
        assert_eq!(normalize(&r).unwrap_err().code(), "E_BAD_CHAR", "{bad:?}");
    }
}

#[test]
fn move_ids_are_trimmed_but_case_sensitive() {
    let mut r = base_raw();
    r.moves[0].id = format!(" {} ", r.moves[0].id);
    assert!(normalize(&r).is_ok());
    r = base_raw();
    r.moves[0].id = r.moves[0].id.to_uppercase();
    assert_eq!(normalize(&r).unwrap_err(), Reject::UnknownMove);
}

#[test]
fn spec_without_a_strike_gets_one_and_keeps_labels() {
    let mut r = base_raw();
    r.school = "TIDE".into();
    r.moves = vec![
        RawMove { id: "tidal_wall".into(), label: "Hold Hands".into() },
        RawMove { id: "healing_rain".into(), label: "Group Hug".into() },
        RawMove { id: "hex_gaze".into(), label: "Disappointed Look".into() },
    ];
    let s = normalize(&r).unwrap();
    stats_ok(&s);
    assert_eq!(s.moves[2].label, "Disappointed Look");
    let m = &LIBRARY[s.moves[2].id as usize];
    assert!(m.kind == Kind::Strike && m.school == School::Tide);
    assert!(LIBRARY.iter().filter(|x| x.kind == Kind::Strike && x.school == School::Tide).all(|x| x.cost >= m.cost));
}

#[test]
fn spec_json_round_trips_and_hash_is_stable() {
    for s in arch_specs() {
        let j = serde_json::to_string(&s).unwrap();
        let back = Spec::from_json(&j).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.hash(), s.hash());
    }
    let a = arch_specs();
    assert_ne!(a[0].hash(), a[1].hash());
}

#[test]
fn archetypes_normalize_without_truncation() {
    let list = archetypes();
    assert!(list.len() >= 40, "need ~40 archetypes");
    let mut seen_sentences = std::collections::BTreeSet::new();
    for a in &list {
        assert!(seen_sentences.insert(a.sentence.clone()), "dup sentence {}", a.sentence);
        check_sentence(&a.sentence).unwrap();
        let s = normalize(&a.raw).unwrap();
        assert_eq!(s.name, a.raw.name.trim(), "name truncated: {}", a.raw.name);
        assert_eq!(s.title, a.raw.title);
        assert_eq!(s.look, a.raw.look, "look truncated for {}", a.raw.name);
        assert_eq!(s.cry, a.raw.cry);
        for (m, rm) in s.moves.iter().zip(&a.raw.moves) {
            assert_eq!(m.label, rm.label, "label truncated for {}", a.raw.name);
            assert_eq!(LIBRARY[m.id as usize].id, rm.id, "ensure_attack rewrote an archetype: {}", a.raw.name);
        }
        stats_ok(&s);
    }
}

#[test]
fn sentence_check() {
    assert!(check_sentence("a pigeon with a law degree").is_ok());
    assert!(check_sentence("abc").is_ok());
    assert!(check_sentence("ab").is_err());
    assert!(check_sentence("   ").is_err());
    assert!(check_sentence(&"x".repeat(120)).is_ok());
    assert!(check_sentence(&"x".repeat(121)).is_err());
    assert!(check_sentence(&"😀".repeat(120)).is_ok());
    assert!(check_sentence("tab\there").is_err());
    assert!(check_sentence("rtl\u{202E}trick").is_err());
}
