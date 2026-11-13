//! Per-round mutable fighter state.

use crate::events::fx;
use crate::moves::{Move, BASIC, BASIC_ID, LIBRARY};
use crate::spec::Spec;
use crate::tune::*;

#[derive(Clone)]
pub struct Fighter<'a> {
    pub spec: &'a Spec,
    pub p: i32,
    pub g: i32,
    pub s: i32,
    pub grit: i32,
    pub max_hp: i32,
    pub hp: i32,
    pub shield: i32,
    pub shield_t: u8,
    pub burn_t: u8,
    pub weaken_t: u8,
    pub haste_t: u8,
    pub counter_t: u8,
    pub stun_imm: u8,
    pub charged: bool,
    pub stunned: bool,
    pub cd: [u8; 3],
    /// Round form, percent damage multiplier.
    pub form: i32,
}

impl<'a> Fighter<'a> {
    pub fn new(spec: &'a Spec) -> Fighter<'a> {
        let max_hp = HP_BASE + HP_PER_GRIT * spec.stats.grit as i32;
        Fighter {
            spec,
            p: spec.stats.power as i32,
            g: spec.stats.guard as i32,
            s: spec.stats.speed as i32,
            grit: spec.stats.grit as i32,
            max_hp,
            hp: max_hp,
            shield: 0,
            shield_t: 0,
            burn_t: 0,
            weaken_t: 0,
            haste_t: 0,
            counter_t: 0,
            stun_imm: 0,
            charged: false,
            stunned: false,
            cd: [0; 3],
            form: 100,
        }
    }

    /// Fresh HP, no statuses, no cooldowns (each round starts clean).
    pub fn reset(&mut self) {
        *self = Fighter::new(self.spec);
    }

    pub fn alive(&self) -> bool {
        self.hp > 0
    }

    pub fn pct_hp(&self) -> i32 {
        self.hp * 100 / self.max_hp
    }

    pub fn heal(&mut self, amount: i32) -> i32 {
        let h = amount.min(self.max_hp - self.hp).max(0);
        self.hp += h;
        h
    }

    /// (move, library id) for slot 0..=2, or the basic move for slot 3.
    pub fn mv(&self, slot: u8) -> (&'static Move, u8) {
        if slot >= 3 {
            (&BASIC, BASIC_ID)
        } else {
            let id = self.spec.moves[slot as usize].id;
            (&LIBRARY[id as usize], id)
        }
    }

    pub fn status_mask(&self) -> u8 {
        let mut m = 0;
        if self.burn_t > 0 {
            m |= fx::BURN;
        }
        if self.stunned {
            m |= fx::STUN;
        }
        if self.shield > 0 {
            m |= fx::SHIELD;
        }
        if self.weaken_t > 0 {
            m |= fx::WEAKEN;
        }
        if self.haste_t > 0 {
            m |= fx::HASTE;
        }
        if self.counter_t > 0 {
            m |= fx::COUNTER;
        }
        if self.charged {
            m |= fx::CHARGE;
        }
        m
    }
}

pub fn hp16(x: i32) -> u16 {
    x.clamp(0, u16::MAX as i32) as u16
}
