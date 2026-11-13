//! The move library: 38 moves over 6 schools. The AI picks 3 per fighter by `id`.
//!
//! Numbers are tuned by `cargo run --release --bin sweep` (see SWEEP.md). Do not edit a number
//! without re-running the sweep: costs buy stat points out of the 100-point budget.

use crate::types::School::{self, *};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Deals damage to the foe (may carry status effects).
    Strike,
    /// Light damage plus statuses on the foe.
    Hex,
    /// Light damage plus a defensive stance on yourself.
    Guard,
    /// Light damage (or none) plus a buff or heal on yourself.
    Boost,
}

/// Effect parameters are integers: chances and percentages are 0..=100.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Chance to set the foe on a 3-exchange damage-over-time (fire, venom, rust: flavour only).
    Burn(u8),
    /// Chance to make the foe skip its next action (stun immunity follows).
    Stun(u8),
    /// Self shield worth `n + guard/2` points for 3 exchanges.
    Shield(u8),
    /// Ignores shields and half the foe's guard.
    Pierce,
    /// Heal `pct`% of damage dealt.
    Lifesteal(u8),
    /// The move hits `n` times (power is per hit).
    Multihit(u8),
    /// Your next damaging move is doubled and cannot miss.
    Charge,
    /// Chance to weaken the foe (x3/4 damage for 3 exchanges).
    Weaken(u8),
    /// Act first for 3 exchanges.
    Haste,
    /// Next damaging hit taken is half deflected back at the attacker.
    Counter,
    /// Remove your own burn and weaken.
    Cleanse,
    /// Heal `pct`% of max HP.
    Heal(u8),
}

impl Effect {
    pub fn key(&self) -> &'static str {
        match self {
            Effect::Burn(_) => "burn",
            Effect::Stun(_) => "stun",
            Effect::Shield(_) => "shield",
            Effect::Pierce => "pierce",
            Effect::Lifesteal(_) => "lifesteal",
            Effect::Multihit(_) => "multihit",
            Effect::Charge => "charge",
            Effect::Weaken(_) => "weaken",
            Effect::Haste => "haste",
            Effect::Counter => "counter",
            Effect::Cleanse => "cleanse",
            Effect::Heal(_) => "heal",
        }
    }
    pub fn value(&self) -> u8 {
        match *self {
            Effect::Burn(v)
            | Effect::Stun(v)
            | Effect::Shield(v)
            | Effect::Lifesteal(v)
            | Effect::Multihit(v)
            | Effect::Weaken(v)
            | Effect::Heal(v) => v,
            _ => 0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Move {
    pub id: &'static str,
    pub name: &'static str,
    pub school: School,
    pub kind: Kind,
    pub power: u8,
    pub accuracy: u8,
    pub cooldown: u8,
    pub cost: u8,
    pub effects: &'static [Effect],
    pub desc: &'static str,
}

use Effect::*;
use Kind::*;

macro_rules! mv {
    ($id:expr, $name:expr, $sc:expr, $k:expr, $p:expr, $a:expr, $cd:expr, $c:expr, $fx:expr, $d:expr) => {
        Move {
            id: $id,
            name: $name,
            school: $sc,
            kind: $k,
            power: $p,
            accuracy: $a,
            cooldown: $cd,
            cost: $c,
            effects: $fx,
            desc: $d,
        }
    };
}

/// Move id reported for the always-available fallback attack.
pub const BASIC_ID: u8 = 255;

/// Used when every chosen move is on cooldown. Not selectable by the AI.
pub static BASIC: Move = mv!("scrap", "Scrap", Wild, Strike, 18, 95, 0, 0, &[], "Plain scuffle when nothing else is ready.");

pub const LIB_LEN: usize = 38;

pub static LIBRARY: [Move; LIB_LEN] = [
    // ---- BLAZE
    mv!("ember_jab", "Ember Jab", Blaze, Strike, 27, 95, 0, 6, &[], "Quick hot jab. Reliable."),
    mv!("flame_lash", "Flame Lash", Blaze, Strike, 22, 90, 0, 8, &[Burn(35)], "Whip of flame. 35% to set the foe burning."),
    mv!("fire_whirl", "Fire Whirl", Blaze, Strike, 12, 88, 1, 9, &[Multihit(3)], "Three spinning licks of fire."),
    mv!("inferno", "Inferno", Blaze, Strike, 30, 72, 2, 12, &[Burn(60)], "Huge, risky blast. 60% to burn."),
    mv!("smolder", "Smolder", Blaze, Hex, 8, 95, 2, 7, &[Burn(100)], "Light singe, but the foe surely starts burning."),
    mv!("battle_roar", "Battle Roar", Blaze, Boost, 8, 100, 3, 8, &[Charge], "Weak hit. Your next attack hits double and cannot miss."),
    mv!("melt_through", "Melt Through", Blaze, Strike, 30, 82, 1, 10, &[Pierce], "Ignores shields and half the foe's guard."),
    // ---- TIDE
    mv!("wave_slap", "Wave Slap", Tide, Strike, 28, 95, 0, 6, &[], "Wet, quick slap. Reliable."),
    mv!("undertow", "Undertow", Tide, Strike, 26, 90, 1, 8, &[Weaken(45)], "Drags the foe down. 45% to weaken."),
    mv!("riptide", "Riptide", Tide, Strike, 27, 85, 1, 10, &[Lifesteal(50)], "Heals you for half the damage dealt."),
    mv!("tidal_wall", "Tidal Wall", Tide, Guard, 8, 100, 3, 7, &[Shield(24)], "Light splash and a water shield that soaks damage."),
    mv!("healing_rain", "Healing Rain", Tide, Boost, 0, 100, 3, 8, &[Heal(25)], "Heal 25% of your max HP."),
    mv!("salt_spray", "Salt Spray", Tide, Hex, 14, 95, 2, 7, &[Weaken(100), Cleanse], "Light spray: sure weaken on the foe, you shed ailments."),
    // ---- VOLT
    mv!("spark", "Spark", Volt, Strike, 24, 95, 0, 6, &[Stun(15)], "Quick zap. 15% to stun."),
    mv!("arc_bolt", "Arc Bolt", Volt, Strike, 28, 88, 1, 9, &[Stun(25)], "Crackling bolt. 25% to stun."),
    mv!("chain_shock", "Chain Shock", Volt, Strike, 10, 86, 2, 10, &[Multihit(4)], "Lightning jumps four times."),
    mv!("overclock", "Overclock", Volt, Boost, 10, 100, 4, 12, &[Haste, Charge], "Weak jolt. Act first for 3 exchanges, charge next hit."),
    mv!("thunderclap", "Thunderclap", Volt, Strike, 34, 76, 2, 11, &[Stun(40)], "Booming slam. 40% to stun."),
    mv!("static_field", "Static Field", Volt, Hex, 20, 90, 2, 7, &[Stun(77)], "Light shock. 77% to pin the foe in place."),
    // ---- IRON
    mv!("iron_fist", "Iron Fist", Iron, Strike, 29, 90, 0, 8, &[], "Heavy, honest punch."),
    mv!("bulwark", "Bulwark", Iron, Guard, 8, 100, 3, 7, &[Shield(25)], "Light shove and a thick plate shield."),
    mv!("riposte", "Riposte", Iron, Guard, 16, 100, 2, 8, &[Counter], "Light jab. Next hit you take is half thrown back."),
    mv!("wrecking_swing", "Wrecking Swing", Iron, Strike, 39, 74, 2, 12, &[Pierce], "Slow, brutal. Pierces shields and guard."),
    mv!("armor_up", "Armor Up", Iron, Boost, 8, 100, 3, 7, &[Shield(22), Haste], "Weak hit, small shield, first strike for 3 exchanges."),
    mv!("rivet_barrage", "Rivet Barrage", Iron, Strike, 12, 80, 1, 10, &[Multihit(3), Pierce], "Three piercing rivets."),
    mv!("dent", "Dent", Iron, Strike, 24, 95, 0, 8, &[Weaken(40)], "Crumples their offence. 40% to weaken."),
    // ---- MIND
    mv!("mind_spike", "Mind Spike", Mind, Strike, 26, 100, 0, 8, &[], "A thought that cannot be dodged."),
    mv!("hex_gaze", "Hex Gaze", Mind, Hex, 18, 95, 2, 6, &[Weaken(100)], "Light psychic jab. Sure weaken on the foe."),
    mv!("foresight", "Foresight", Mind, Guard, 15, 100, 3, 5, &[Counter, Haste], "Predict the next hit: counter and act first."),
    mv!("brain_freeze", "Brain Freeze", Mind, Strike, 29, 92, 2, 9, &[Stun(40)], "Sudden headache. 40% to stun."),
    mv!("focus", "Focus", Mind, Boost, 8, 100, 3, 10, &[Charge, Cleanse], "Charge your next attack and clear your head."),
    mv!("psy_siphon", "Psy Siphon", Mind, Strike, 24, 90, 1, 10, &[Lifesteal(40), Weaken(25)], "Drains vigor: heals you, 25% to weaken."),
    // ---- WILD
    mv!("claw_swipe", "Claw Swipe", Wild, Strike, 27, 92, 0, 7, &[], "Fast, nasty swipe."),
    mv!("venom_bite", "Venom Bite", Wild, Strike, 20, 92, 1, 8, &[Burn(45)], "Toxic bite. 45% to poison (damage over time)."),
    mv!("pounce", "Pounce", Wild, Strike, 31, 88, 1, 9, &[Haste], "Leap in hard; you act first for three exchanges."),
    mv!("regrowth", "Regrowth", Wild, Boost, 0, 100, 4, 9, &[Heal(25), Cleanse], "Heal 25% max HP and shake off ailments."),
    mv!("thorn_wall", "Thorn Wall", Wild, Guard, 8, 100, 4, 9, &[Shield(8), Counter], "Small shield plus a counter stance."),
    mv!("stampede", "Stampede", Wild, Strike, 13, 84, 2, 11, &[Multihit(3), Stun(15)], "Three trampling hits, each can stun."),
];

/// Library index for an id.
pub fn find(id: &str) -> Option<u8> {
    LIBRARY.iter().position(|m| m.id == id).map(|i| i as u8)
}

/// Move by library index or `BASIC_ID`.
pub fn get(id: u8) -> Option<&'static Move> {
    if id == BASIC_ID {
        Some(&BASIC)
    } else {
        LIBRARY.get(id as usize)
    }
}

impl Move {
    pub fn has(&self, f: impl Fn(&Effect) -> bool) -> bool {
        self.effects.iter().any(f)
    }
    /// Hits per use.
    pub fn hits(&self) -> i32 {
        for e in self.effects {
            if let Effect::Multihit(n) = e {
                return *n as i32;
            }
        }
        1
    }
    /// Does the move do anything to the foe (needs an accuracy roll)?
    pub fn targets_foe(&self) -> bool {
        self.power > 0
            || self
                .effects
                .iter()
                .any(|e| matches!(e, Burn(_) | Stun(_) | Weaken(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_invariants() {
        assert_eq!(LIBRARY.len(), LIB_LEN);
        for (i, m) in LIBRARY.iter().enumerate() {
            assert!(m.desc.chars().count() <= 60, "{} desc too long", m.id);
            assert!(m.name.chars().count() <= 24, "{}", m.id);
            assert!(m.cost >= 5 && m.cost <= 14, "{} cost", m.id);
            assert!(m.accuracy >= 50 && m.accuracy <= 100);
            assert_eq!(find(m.id), Some(i as u8), "dup id {}", m.id);
            assert!(m.id.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'));
            assert!(m.kind == Strike || m.power <= 20, "{}", m.id);
        }
        for s in School::ALL {
            let n = LIBRARY.iter().filter(|m| m.school == s).count();
            assert!((6..=7).contains(&n), "{:?} has {}", s, n);
        }
        assert!(find("nope").is_none());
    }

    #[test]
    fn percentages_in_descriptions_match_the_numbers() {
        for m in LIBRARY.iter() {
            let d = m.desc;
            for (i, _) in d.match_indices('%') {
                let digits: String = d[..i].chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
                let n: u8 = digits.parse().unwrap_or_else(|_| panic!("{}: '%' without a number", m.id));
                assert!(m.effects.iter().any(|e| e.value() == n), "{} desc says {}% but effects are {:?}", m.id, n, m.effects);
            }
        }
    }
}
