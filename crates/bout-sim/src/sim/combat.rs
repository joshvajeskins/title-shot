//! Action resolution and end-of-exchange upkeep.

use super::Match;
use crate::events::*;
use crate::fighter::hp16;
use crate::moves::{Effect, Move};
use crate::policy;
use crate::tune::*;
use crate::types::{matchup, Style};

impl<S: Sink> Match<'_, '_, S> {
    fn hit_damage(&self, mv: &Move, a: usize, pierce: bool, charged: bool, crit: bool, roll: u32) -> i32 {
        let (me, foe) = (&self.f[a], &self.f[1 - a]);
        let m = &self.mods;
        let g = if pierce { foe.g / 2 } else { foe.g };
        let mut v = mv.power as i32 * (ATK_BASE + 2 * me.p) / (ATK_BASE + 2 * g);
        if mv.school == me.spec.school {
            v = v * STAB_NUM / STAB_DEN;
        }
        v = match (matchup(mv.school, foe.spec.school), m.grudge) {
            (1, false) => v * ADV_NUM / ADV_DEN,
            (-1, false) => v * DIS_NUM / DIS_DEN,
            (1, true) => v * GRUDGE_ADV_NUM / GRUDGE_ADV_DEN,
            (-1, true) => v * GRUDGE_DIS_NUM / GRUDGE_DIS_DEN,
            _ => v,
        };
        v = v * roll as i32 / 100;
        v = v * me.form / 100;
        if m.boosted == Some(mv.school) {
            v = v * 3 / 2;
        }
        if me.spec.style == Style::Brawler {
            v = v * BRAWLER_DMG_NUM / BRAWLER_DMG_DEN;
        }
        if foe.spec.style == Style::Counterpuncher {
            v = v * COUNTERPUNCHER_TAKEN_NUM / COUNTERPUNCHER_TAKEN_DEN;
        }
        if me.weaken_t > 0 {
            v = v * WEAKEN_NUM / WEAKEN_DEN;
        }
        if charged {
            v *= 2;
        }
        if crit {
            v = v * m.crit_num / m.crit_den;
        }
        v.max(1)
    }

    pub(super) fn act(&mut self, a: usize) {
        let d = 1 - a;
        if self.f[a].stunned {
            self.f[a].stunned = false;
            self.f[a].stun_imm = STUN_IMMUNE;
            self.sink.push(Event::Skip { actor: a as u8 });
            return;
        }
        let slot = policy::choose(&self.f[a], &self.f[d], &mut self.rng);
        let (mv, move_id) = self.f[a].mv(slot);
        if slot < 3 {
            self.f[a].cd[slot as usize] = mv.cooldown + 1;
        }
        let mods = self.mods;
        let mut out = if mv.power > 0 { Outcome::Hit } else { Outcome::Used };
        let (mut hits, mut dealt, mut absorbed, mut heal, mut recoil) = (0u8, 0i32, 0i32, 0i32, 0i32);
        let (mut fx_self, mut fx_foe) = (0u8, 0u8);
        // A charge is spent by the first damaging move after the one that set it.
        let charged = self.f[a].charged && mv.power > 0;
        if charged {
            self.f[a].charged = false;
        }

        // Self effects apply on use.
        for e in mv.effects {
            let me = &mut self.f[a];
            match *e {
                Effect::Shield(n) => {
                    let base = n as i32 + me.g / 2;
                    me.shield = if mods.shield_x2 { base * 2 } else { base };
                    me.shield_t = SHIELD_TURNS;
                    fx_self |= fx::SHIELD;
                }
                Effect::Charge => {
                    me.charged = true;
                    fx_self |= fx::CHARGE;
                }
                Effect::Haste => {
                    me.haste_t = HASTE_TURNS;
                    fx_self |= fx::HASTE;
                }
                Effect::Counter => {
                    me.counter_t = COUNTER_TURNS;
                    fx_self |= fx::COUNTER;
                }
                Effect::Cleanse => {
                    me.burn_t = 0;
                    me.weaken_t = 0;
                }
                Effect::Heal(p) if !mods.heals_off => {
                    let amt = me.max_hp * p as i32 / 100;
                    heal += me.heal(amt);
                }
                _ => {}
            }
        }

        if mv.targets_foe() {
            let acc = (mv.accuracy as i32 + (self.f[a].s - self.f[d].s) / 4).clamp(30, 100);
            let landed = self.rng.chance(acc) || charged;
            if !landed {
                out = Outcome::Miss;
            } else {
                if mv.power > 0 {
                    let pierce = mv.has(|e| matches!(e, Effect::Pierce));
                    let n = mv.hits();
                    let cc = CRIT_BASE
                        + self.f[a].s / CRIT_SPEED_DIV
                        + if self.f[a].spec.style == Style::Showboat { SHOWBOAT_CRIT } else { 0 };
                    let (mut total, mut crit_any) = (0, false);
                    for _ in 0..n {
                        let crit = self.rng.chance(cc);
                        let roll = VAR_MIN + self.rng.below(VAR_SPAN);
                        crit_any |= crit;
                        total += self.hit_damage(mv, a, pierce, charged, crit, roll);
                    }
                    hits = n as u8;
                    let mut to_foe = total;
                    let mut countered = false;
                    if self.f[d].counter_t > 0 {
                        to_foe = total * COUNTER_TAKEN_PCT / 100;
                        recoil = total - to_foe;
                        self.f[d].counter_t = 0;
                        countered = true;
                    }
                    if !pierce && self.f[d].shield > 0 {
                        absorbed = to_foe.min(self.f[d].shield);
                        self.f[d].shield -= absorbed;
                        to_foe -= absorbed;
                        if self.f[d].shield == 0 {
                            self.f[d].shield_t = 0;
                        }
                    }
                    out = if countered {
                        Outcome::Countered
                    } else if to_foe == 0 && absorbed > 0 {
                        Outcome::Blocked
                    } else if crit_any {
                        Outcome::Crit
                    } else {
                        Outcome::Hit
                    };
                    dealt = to_foe.min(self.f[d].hp);
                    self.f[d].hp -= dealt;
                    recoil = recoil.min(self.f[a].hp);
                    self.f[a].hp -= recoil;
                    if !mods.heals_off {
                        for e in mv.effects {
                            if let Effect::Lifesteal(p) = *e {
                                heal += self.f[a].heal(dealt * p as i32 / 100);
                            }
                        }
                    }
                } else {
                    out = Outcome::Used;
                }
                if self.f[d].alive() {
                    let bonus = if self.f[a].spec.style == Style::Tactician { TACTICIAN_STATUS_BONUS } else { 0 };
                    for e in mv.effects {
                        match *e {
                            Effect::Burn(c) => {
                                if self.rng.chance(c as i32 + bonus) {
                                    self.f[d].burn_t = BURN_TURNS;
                                    fx_foe |= fx::BURN;
                                }
                            }
                            Effect::Weaken(c) => {
                                if self.rng.chance(c as i32 + bonus) {
                                    self.f[d].weaken_t = WEAKEN_TURNS;
                                    fx_foe |= fx::WEAKEN;
                                }
                            }
                            Effect::Stun(c) => {
                                let mut ch = c as i32 * (100 - self.f[d].grit) / 100;
                                if mods.stun_half {
                                    ch /= 2;
                                }
                                if self.rng.chance(ch + bonus / 2) && !self.f[d].stunned && self.f[d].stun_imm == 0 {
                                    self.f[d].stunned = true;
                                    fx_foe |= fx::STUN;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        let ev = Event::Act {
            actor: a as u8,
            slot,
            move_id,
            outcome: out,
            hits,
            dmg: hp16(dealt),
            absorbed: hp16(absorbed),
            heal: hp16(heal),
            recoil: hp16(recoil),
            hp: self.hps(),
            shield: self.shields(),
            fx_self,
            fx_foe,
        };
        self.sink.push(ev);
    }

    pub(super) fn upkeep(&mut self, side: usize) {
        let f = &mut self.f[side];
        let mut burn = 0;
        if f.burn_t > 0 {
            burn = (f.max_hp / BURN_HP_DIV).max(BURN_MIN);
            if self.mods.burn_x2 {
                burn *= 2;
            }
            burn = burn.min(f.hp);
            f.hp -= burn;
        }
        let mut expired = 0u8;
        for (t, bit) in [
            (&mut f.burn_t, fx::BURN),
            (&mut f.weaken_t, fx::WEAKEN),
            (&mut f.haste_t, fx::HASTE),
            (&mut f.shield_t, fx::SHIELD),
            (&mut f.counter_t, fx::COUNTER),
        ] {
            if *t > 0 {
                *t -= 1;
                if *t == 0 {
                    expired |= bit;
                }
            }
        }
        if expired & fx::SHIELD != 0 {
            f.shield = 0;
        }
        f.stun_imm = f.stun_imm.saturating_sub(1);
        if burn > 0 || expired != 0 {
            let hp = self.hps();
            self.sink.push(Event::Upkeep { side: side as u8, burn: hp16(burn), hp, expired });
        }
    }
}
