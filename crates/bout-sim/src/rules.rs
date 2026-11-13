//! Arena rules: one public season modifier per belt, `rule_id: u8` in 0..8.
//! An id >= 8 means "no modifier" so the simulator never panics on any u8.

use crate::types::School;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Rule {
    pub id: u8,
    pub name: &'static str,
    pub desc: &'static str,
}

pub const RULE_COUNT: u8 = 8;

pub static RULES: [Rule; 8] = [
    Rule { id: 0, name: "Furnace Night", desc: "BLAZE moves deal x3/2 damage." },
    Rule { id: 1, name: "Storm Front", desc: "VOLT moves deal x3/2 damage." },
    Rule { id: 2, name: "Padded Ring", desc: "Stun chances are halved." },
    Rule { id: 3, name: "No Medics", desc: "Heals and lifesteal are switched off." },
    Rule { id: 4, name: "Glass Jaws", desc: "Critical hits deal x2 instead of x3/2." },
    Rule { id: 5, name: "Iron Curtain", desc: "Shields absorb twice as much." },
    Rule { id: 6, name: "Slow Burn", desc: "Burn ticks deal double damage." },
    Rule { id: 7, name: "Grudge Match", desc: "School edges hit x3/2, disadvantages x2/3." },
];

pub fn is_valid(rule_id: u8) -> bool {
    rule_id < RULE_COUNT
}

/// Numeric modifiers the simulator reads (no branching on rule ids elsewhere).
#[derive(Clone, Copy, Debug)]
pub struct Mods {
    pub boosted: Option<School>,
    pub stun_half: bool,
    pub heals_off: bool,
    pub crit_num: i32,
    pub crit_den: i32,
    pub shield_x2: bool,
    pub burn_x2: bool,
    pub grudge: bool,
}

impl Mods {
    pub fn from_rule(id: u8) -> Mods {
        let mut m = Mods {
            boosted: None,
            stun_half: false,
            heals_off: false,
            crit_num: 3,
            crit_den: 2,
            shield_x2: false,
            burn_x2: false,
            grudge: false,
        };
        match id {
            0 => m.boosted = Some(School::Blaze),
            1 => m.boosted = Some(School::Volt),
            2 => m.stun_half = true,
            3 => m.heals_off = true,
            4 => {
                m.crit_num = 2;
                m.crit_den = 1;
            }
            5 => m.shield_x2 = true,
            6 => m.burn_x2 = true,
            7 => m.grudge = true,
            _ => {}
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rule_table() {
        for (i, r) in RULES.iter().enumerate() {
            assert_eq!(r.id as usize, i);
            assert!(r.desc.chars().count() <= 60, "{}", r.name);
        }
        assert!(is_valid(7) && !is_valid(8));
    }
}
