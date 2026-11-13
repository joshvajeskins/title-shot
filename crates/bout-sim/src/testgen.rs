//! Deterministic random raw specs for tests, fuzzing and the balance sweep.
//! Not used by the contract (the linker drops it).

use crate::moves::{LIBRARY, LIB_LEN};
use crate::rng::Rng;
use crate::spec::{normalize, Raw, RawMove, RawWeights, Spec};
use crate::types::{School, Style};

const NOUNS: [&str; 8] = ["Pigeon", "Toaster", "Gran", "Slice", "Moth", "Kettle", "Goblin", "Echo"];
const EPITHETS: [&str; 6] = ["of Doom", "the Unbothered", "Esq.", "of the Back Row", "the Overdue", "Prime"];

fn pick_move(rng: &mut Rng, taken: &[u8], school: Option<School>) -> u8 {
    loop {
        let i = rng.below(LIB_LEN as u32) as u8;
        if taken.contains(&i) {
            continue;
        }
        if let Some(s) = school {
            if LIBRARY[i as usize].school != s {
                continue;
            }
        }
        return i;
    }
}

/// A valid raw spec. `themed`: two moves share the fighter's school (like an LLM would pick).
pub fn random_raw(rng: &mut Rng, themed: bool) -> Raw {
    let school = School::ALL[rng.below(6) as usize];
    let style = Style::ALL[rng.below(4) as usize];
    let mut ids: Vec<u8> = Vec::new();
    if themed {
        ids.push(pick_move(rng, &ids, Some(school)));
        ids.push(pick_move(rng, &ids, Some(school)));
        ids.push(pick_move(rng, &ids, None));
    } else {
        for _ in 0..3 {
            let m = pick_move(rng, &ids, None);
            ids.push(m);
        }
    }
    let n = rng.below(1000);
    let moves = ids
        .iter()
        .enumerate()
        .map(|(k, &i)| RawMove { id: LIBRARY[i as usize].id.into(), label: format!("{} #{}", LIBRARY[i as usize].name, k) })
        .collect();
    let mut w = || rng.below(10) as i64 + 1;
    let weights = RawWeights { power: w(), guard: w(), speed: w(), grit: w() };
    Raw {
        verdict: "ok".into(),
        name: format!("{} {}", NOUNS[(n % 8) as usize], n),
        title: format!("The {} {}", NOUNS[(n / 8 % 8) as usize], EPITHETS[(n % 6) as usize]),
        look: "A small determined fighter with a silly hat, flat colours, studio light.".into(),
        cry: "Objection!".into(),
        school: school.name().into(),
        style: style.name().into(),
        moves,
        weights,
    }
}

pub fn random_spec(rng: &mut Rng, themed: bool) -> Spec {
    normalize(&random_raw(rng, themed)).expect("generator emits valid raws")
}
