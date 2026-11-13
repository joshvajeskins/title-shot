//! Deterministic move-choice policy per style. All integer "expected HP" points.

use crate::fighter::Fighter;
use crate::moves::{Effect, Move, BASIC};
use crate::rng::Rng;
use crate::types::{matchup, Style};
use crate::tune::*;

/// Style weights in tenths: (damage, foe status, defence, setup).
fn weights(s: Style) -> (i32, i32, i32, i32) {
    match s {
        Style::Brawler => (11, 5, 6, 6),
        Style::Tactician => (9, 9, 8, 8),
        Style::Counterpuncher => (9, 6, 10, 6),
        Style::Showboat => (10, 5, 5, 12),
    }
}

/// Expected damage of a landed use, before shields.
fn expected_damage(me: &Fighter, foe: &Fighter, m: &Move, aware: bool) -> i32 {
    if m.power == 0 {
        return 0;
    }
    let acc = if me.charged {
        100
    } else {
        (m.accuracy as i32 + (me.s - foe.s) / 4).clamp(30, 100)
    };
    let pierce = m.has(|e| matches!(e, Effect::Pierce));
    let g = if pierce { foe.g / 2 } else { foe.g };
    let mut v = m.power as i32 * m.hits() * acc / 100;
    v = v * (ATK_BASE + 2 * me.p) / (ATK_BASE + 2 * g);
    if m.school == me.spec.school {
        v = v * STAB_NUM / STAB_DEN;
    }
    v = match matchup(m.school, foe.spec.school) {
        1 => v * ADV_NUM / ADV_DEN,
        -1 => v * DIS_NUM / DIS_DEN,
        _ => v,
    };
    if me.charged {
        v *= 2;
    }
    if me.weaken_t > 0 {
        v = v * WEAKEN_NUM / WEAKEN_DEN;
    }
    if aware {
        if foe.shield > 0 && !pierce {
            v = v * 2 / 3;
        }
        if foe.counter_t > 0 {
            v /= 2;
        }
    }
    if v >= foe.hp {
        v += 20;
    }
    v
}

fn score(me: &Fighter, foe: &Fighter, m: &Move) -> i32 {
    let style = me.spec.style;
    let (wd, ws, wf, wu) = weights(style);
    let aware = matches!(style, Style::Tactician | Style::Counterpuncher);
    let dmg = expected_damage(me, foe, m, aware);
    let (mut st, mut df, mut up, mut ls) = (0, 0, 0, 0);
    for e in m.effects {
        match *e {
            Effect::Burn(c) if foe.burn_t == 0 => st += c as i32 * 22 / 100,
            Effect::Stun(c) if !foe.stunned && foe.stun_imm == 0 => {
                st += c as i32 * (100 - foe.grit) / 100 * 30 / 100
            }
            Effect::Weaken(c) if foe.weaken_t == 0 => st += c as i32 * 16 / 100,
            Effect::Shield(n) if me.shield == 0 => df += (n as i32 + me.g / 2) * 2 / 3,
            Effect::Counter if me.counter_t == 0 => df += 18,
            Effect::Heal(p) => df += (me.max_hp - me.hp).min(me.max_hp * p as i32 / 100) * 8 / 10,
            Effect::Cleanse => {
                if me.burn_t > 0 {
                    df += 10;
                }
                if me.weaken_t > 0 {
                    df += 8;
                }
            }
            Effect::Lifesteal(p) => ls = dmg * p as i32 / 100 * (me.max_hp - me.hp).min(30) / 30,
            Effect::Charge if !me.charged => up += 20,
            Effect::Haste if me.haste_t == 0 => up += 12,
            _ => {}
        }
    }
    let wf = if me.pct_hp() < 40 { wf * 3 / 2 } else { wf };
    (wd * (dmg + ls) + ws * st + wf * df + wu * up) / 10
}

/// Pick slot 0..=2, or 3 for the basic move when nothing else scores better.
pub fn choose(me: &Fighter, foe: &Fighter, rng: &mut Rng) -> u8 {
    let showboat = me.spec.style == Style::Showboat;
    let mut best = score(me, foe, &BASIC);
    let mut best_slot = 3u8;
    for slot in 0..3u8 {
        if me.cd[slot as usize] > 0 {
            continue;
        }
        let (m, _) = me.mv(slot);
        let mut sc = score(me, foe, m);
        if showboat {
            sc += rng.below(9) as i32;
        }
        if sc > best || (best_slot == 3 && sc == best) {
            best = sc;
            best_slot = slot;
        }
    }
    best_slot
}
