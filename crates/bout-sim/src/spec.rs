//! Raw AI output -> normalized `Spec`. Pure, integer-only, deterministic.
//!
//! Reject precedence (first failure wins): parse -> verdict -> name,title,look,cry (char, empty)
//! -> school -> style -> move count -> move ids (unknown, duplicate) -> move labels -> done.

use crate::moves::{self, Kind, LIBRARY};
use crate::types::{School, Stats, Style, BUDGET, STAT_MAX, STAT_MIN};
pub use crate::alloc::allocate;
pub use crate::reject::{Reject, ALL_CODES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CAP_NAME: usize = 24;
pub const CAP_TITLE: usize = 40;
pub const CAP_LOOK: usize = 160;
pub const CAP_CRY: usize = 60;
pub const CAP_LABEL: usize = 24;
pub const SENTENCE_MIN: usize = 3;
pub const SENTENCE_MAX: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawMove {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawWeights {
    pub power: i64,
    pub guard: i64,
    pub speed: i64,
    pub grit: i64,
}

/// What the model returns (strict JSON schema).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raw {
    pub verdict: String,
    pub name: String,
    pub title: String,
    pub look: String,
    pub cry: String,
    pub school: String,
    pub style: String,
    pub moves: Vec<RawMove>,
    pub weights: RawWeights,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecMove {
    /// Library index (see `moves::LIBRARY`).
    pub id: u8,
    pub label: String,
}

/// Normalized fighter. Only `normalize` / `from_json` construct one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "SpecJson", try_from = "SpecJson")]
pub struct Spec {
    pub name: String,
    pub title: String,
    pub look: String,
    pub cry: String,
    pub school: School,
    pub style: Style,
    pub moves: [SpecMove; 3],
    pub stats: Stats,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpecJson {
    pub name: String,
    pub title: String,
    pub look: String,
    pub cry: String,
    pub school: School,
    pub style: Style,
    pub moves: Vec<RawMove>,
    pub stats: Stats,
}

impl From<Spec> for SpecJson {
    fn from(s: Spec) -> SpecJson {
        SpecJson {
            moves: s
                .moves
                .iter()
                .map(|m| RawMove { id: LIBRARY[m.id as usize].id.into(), label: m.label.clone() })
                .collect(),
            name: s.name,
            title: s.title,
            look: s.look,
            cry: s.cry,
            school: s.school,
            style: s.style,
            stats: s.stats,
        }
    }
}

impl TryFrom<SpecJson> for Spec {
    type Error = Reject;
    fn try_from(j: SpecJson) -> Result<Spec, Reject> {
        let (moves, ids) = clean_moves(&j.moves)?;
        let spec = Spec {
            name: clean("name", &j.name, CAP_NAME)?,
            title: clean("title", &j.title, CAP_TITLE)?,
            look: clean("look", &j.look, CAP_LOOK)?,
            cry: clean("cry", &j.cry, CAP_CRY)?,
            school: j.school,
            style: j.style,
            moves,
            stats: j.stats,
        };
        let pool = BUDGET - ids_cost(&ids);
        let st = spec.stats.as_array();
        let has_attack = ids.iter().any(|&i| LIBRARY[i as usize].kind == Kind::Strike);
        let ok = has_attack && spec.stats.sum() == pool && st.iter().all(|&x| (STAT_MIN..=STAT_MAX).contains(&x));
        if !ok || spec.name != j.name || spec.title != j.title || spec.look != j.look || spec.cry != j.cry {
            return Err(Reject::BadStats);
        }
        Ok(spec)
    }
}

fn is_bad_char(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0x200B | 0x200E | 0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xFEFF)
}

/// Whitespace controls become spaces; other control/invisible/bidi characters reject.
/// Trim, cap at `cap` chars, reject empty.
fn clean(field: &'static str, s: &str, cap: usize) -> Result<String, Reject> {
    let mut out = String::new();
    for c in s.chars() {
        if matches!(c, '\n' | '\t' | '\r') {
            out.push(' ');
        } else if is_bad_char(c) {
            return Err(Reject::BadChar(field));
        } else {
            out.push(c);
        }
    }
    let capped: String = out.trim().chars().take(cap).collect();
    let t = capped.trim_end();
    if t.is_empty() {
        return Err(Reject::EmptyField(field));
    }
    Ok(t.into())
}

fn ids_cost(ids: &[u8; 3]) -> u32 {
    ids.iter().map(|&i| LIBRARY[i as usize].cost as u32).sum()
}

/// Every fighter needs a way to deal damage: with no Strike among the three moves, the third move
/// becomes the cheapest Strike of the fighter's school (its label is kept).
fn ensure_attack(ids: &mut [u8; 3], school: School) -> bool {
    if ids.iter().any(|&i| LIBRARY[i as usize].kind == Kind::Strike) {
        return false;
    }
    let pick = LIBRARY
        .iter()
        .enumerate()
        .filter(|(_, m)| m.kind == Kind::Strike && m.school == school)
        .min_by_key(|(i, m)| (m.cost, *i))
        .map(|(i, _)| i as u8)
        .unwrap_or(0);
    ids[2] = pick;
    true
}

fn clean_moves(raw: &[RawMove]) -> Result<([SpecMove; 3], [u8; 3]), Reject> {
    if raw.len() != 3 {
        return Err(Reject::MoveCount);
    }
    let mut ids = [0u8; 3];
    for (i, m) in raw.iter().enumerate() {
        ids[i] = moves::find(m.id.trim()).ok_or(Reject::UnknownMove)?;
    }
    if ids[0] == ids[1] || ids[0] == ids[2] || ids[1] == ids[2] {
        return Err(Reject::DupMove);
    }
    let mk = |i: usize| -> Result<SpecMove, Reject> {
        Ok(SpecMove { id: ids[i], label: clean("label", &raw[i].label, CAP_LABEL)? })
    };
    Ok(([mk(0)?, mk(1)?, mk(2)?], ids))
}

pub fn normalize(raw: &Raw) -> Result<Spec, Reject> {
    if raw.verdict == "refused" {
        return Err(Reject::Refused);
    }
    if raw.verdict != "ok" {
        return Err(Reject::BadJson);
    }
    let name = clean("name", &raw.name, CAP_NAME)?;
    let title = clean("title", &raw.title, CAP_TITLE)?;
    let look = clean("look", &raw.look, CAP_LOOK)?;
    let cry = clean("cry", &raw.cry, CAP_CRY)?;
    let school = School::from_name(raw.school.trim()).ok_or(Reject::BadSchool)?;
    let style = Style::from_name(raw.style.trim()).ok_or(Reject::BadStyle)?;
    let (mut moves, mut ids) = clean_moves(&raw.moves)?;
    if ensure_attack(&mut ids, school) {
        moves[2].id = ids[2];
    }
    let w = |x: i64| x.clamp(1, 10) as u32;
    let weights = [w(raw.weights.power), w(raw.weights.guard), w(raw.weights.speed), w(raw.weights.grit)];
    let a = allocate(BUDGET - ids_cost(&ids), weights);
    let stats = Stats { power: a[0], guard: a[1], speed: a[2], grit: a[3] };
    Ok(Spec { name, title, look, cry, school, style, moves, stats })
}

/// Parse raw model JSON and normalize.
pub fn normalize_str(json: &str) -> Result<Spec, Reject> {
    let raw: Raw = serde_json::from_str(json).map_err(|_| Reject::BadJson)?;
    normalize(&raw)
}

/// Check a player sentence the same way everywhere: 3..=120 chars, no control/bidi characters.
pub fn check_sentence(s: &str) -> Result<(), Reject> {
    let n = s.chars().count();
    if !(SENTENCE_MIN..=SENTENCE_MAX).contains(&n) || s.trim().is_empty() || s.chars().any(is_bad_char) {
        return Err(Reject::BadSentence);
    }
    Ok(())
}

impl Spec {
    /// Load a stored spec (the shape `Serialize` produces) and re-validate every invariant.
    pub fn from_json(json: &str) -> Result<Spec, Reject> {
        let j: SpecJson = serde_json::from_str(json).map_err(|_| Reject::BadJson)?;
        Spec::try_from(j)
    }

    pub fn move_costs(&self) -> u32 {
        self.moves.iter().map(|m| LIBRARY[m.id as usize].cost as u32).sum()
    }

    /// Deterministic byte encoding (length-prefixed strings, raw ids) for hashing.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(256);
        for s in [&self.name, &self.title, &self.look, &self.cry] {
            o.extend_from_slice(&(s.len() as u16).to_le_bytes());
            o.extend_from_slice(s.as_bytes());
        }
        o.push(self.school as u8);
        o.push(self.style as u8);
        for m in &self.moves {
            o.push(m.id);
            o.extend_from_slice(&(m.label.len() as u16).to_le_bytes());
            o.extend_from_slice(m.label.as_bytes());
        }
        o.extend_from_slice(&self.stats.as_array());
        o
    }

    pub fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.canonical_bytes()).into()
    }
}
