//! Core enums shared by the normalizer, the library and the simulator.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum School {
    #[serde(rename = "BLAZE")]
    Blaze = 0,
    #[serde(rename = "TIDE")]
    Tide = 1,
    #[serde(rename = "VOLT")]
    Volt = 2,
    #[serde(rename = "IRON")]
    Iron = 3,
    #[serde(rename = "MIND")]
    Mind = 4,
    #[serde(rename = "WILD")]
    Wild = 5,
}

impl School {
    pub const ALL: [School; 6] = [
        School::Blaze,
        School::Tide,
        School::Volt,
        School::Iron,
        School::Mind,
        School::Wild,
    ];
    pub const NAMES: [&'static str; 6] = ["BLAZE", "TIDE", "VOLT", "IRON", "MIND", "WILD"];

    pub fn name(self) -> &'static str {
        Self::NAMES[self as usize]
    }
    pub fn from_name(s: &str) -> Option<School> {
        Self::ALL.iter().copied().find(|x| x.name() == s)
    }
    pub fn from_u8(i: u8) -> Option<School> {
        Self::ALL.get(i as usize).copied()
    }
    pub fn idx(self) -> usize {
        self as usize
    }
}

/// Position of each school on the 6-cycle `BLAZE > WILD > IRON > TIDE > MIND > VOLT > BLAZE`
/// (indexed by `School as usize`). A school beats the next two on the cycle, loses to the
/// previous two, and is neutral against the opposite school (and itself).
const CYCLE_POS: [u8; 6] = [0, 3, 5, 2, 4, 1];

/// +1 if `att` has the advantage over `def`, -1 if at a disadvantage, 0 if neutral.
pub fn matchup(att: School, def: School) -> i8 {
    let d = (CYCLE_POS[def as usize] + 6 - CYCLE_POS[att as usize]) % 6;
    match d {
        1 | 2 => 1,
        4 | 5 => -1,
        _ => 0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Style {
    #[serde(rename = "BRAWLER")]
    Brawler = 0,
    #[serde(rename = "TACTICIAN")]
    Tactician = 1,
    #[serde(rename = "COUNTERPUNCHER")]
    Counterpuncher = 2,
    #[serde(rename = "SHOWBOAT")]
    Showboat = 3,
}

impl Style {
    pub const ALL: [Style; 4] = [
        Style::Brawler,
        Style::Tactician,
        Style::Counterpuncher,
        Style::Showboat,
    ];
    pub const NAMES: [&'static str; 4] = ["BRAWLER", "TACTICIAN", "COUNTERPUNCHER", "SHOWBOAT"];

    pub fn name(self) -> &'static str {
        Self::NAMES[self as usize]
    }
    pub fn from_name(s: &str) -> Option<Style> {
        Self::ALL.iter().copied().find(|x| x.name() == s)
    }
    pub fn from_u8(i: u8) -> Option<Style> {
        Self::ALL.get(i as usize).copied()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stats {
    pub power: u8,
    pub guard: u8,
    pub speed: u8,
    pub grit: u8,
}

impl Stats {
    pub fn sum(&self) -> u32 {
        self.power as u32 + self.guard as u32 + self.speed as u32 + self.grit as u32
    }
    pub fn as_array(&self) -> [u8; 4] {
        [self.power, self.guard, self.speed, self.grit]
    }
}

pub const STAT_MIN: u8 = 5;
pub const STAT_MAX: u8 = 45;
pub const BUDGET: u32 = 100;

/// Fight sides. Champion is the belt holder, challenger is the paying player.
pub const CHAMPION: u8 = 0;
pub const CHALLENGER: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Winner {
    Champion,
    Challenger,
    Draw,
}

impl Winner {
    pub fn code(self) -> u8 {
        match self {
            Winner::Champion => 0,
            Winner::Challenger => 1,
            Winner::Draw => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matchup_shape() {
        for a in School::ALL {
            let adv = School::ALL.iter().filter(|&&d| matchup(a, d) == 1).count();
            let dis = School::ALL.iter().filter(|&&d| matchup(a, d) == -1).count();
            let neu = School::ALL.iter().filter(|&&d| d != a && matchup(a, d) == 0).count();
            assert_eq!((adv, dis, neu), (2, 2, 1), "{:?}", a);
            assert_eq!(matchup(a, a), 0);
            for d in School::ALL {
                assert_eq!(matchup(a, d), -matchup(d, a));
            }
        }
    }
}
