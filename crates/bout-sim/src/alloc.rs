//! Largest-remainder stat allocation.

use crate::types::{STAT_MAX, STAT_MIN};

/// Distribute `pool` points over 4 stats (each in [5,45]) proportionally to `w`
/// by largest remainder, redistributing overflow of capped stats. Sum is always `pool`.
pub fn allocate(pool: u32, w: [u32; 4]) -> [u8; 4] {
    const ROOM: u32 = (STAT_MAX - STAT_MIN) as u32;
    let mut extra = [0u32; 4];
    let mut open = [true; 4];
    let mut remaining = pool.saturating_sub(4 * STAT_MIN as u32);
    while remaining > 0 {
        let tw: u32 = (0..4).filter(|&i| open[i]).map(|i| w[i]).sum();
        if tw == 0 {
            break;
        }
        let mut share = [0u32; 4];
        let mut rem = [0u32; 4];
        let mut given = 0;
        for i in (0..4).filter(|&i| open[i]) {
            let num = remaining * w[i];
            share[i] = num / tw;
            rem[i] = num % tw;
            given += share[i];
        }
        let mut chosen = [false; 4];
        for _ in 0..(remaining - given) {
            let mut best: Option<usize> = None;
            for i in (0..4).filter(|&i| open[i] && !chosen[i]) {
                if best.is_none_or(|b| rem[i] > rem[b]) {
                    best = Some(i);
                }
            }
            if let Some(b) = best {
                share[b] += 1;
                chosen[b] = true;
            }
        }
        remaining = 0;
        let was_open = open;
        for i in (0..4).filter(|&i| was_open[i]) {
            let room = ROOM - extra[i];
            if share[i] >= room {
                remaining += share[i] - room;
                extra[i] = ROOM;
                open[i] = false;
            } else {
                extra[i] += share[i];
            }
        }
    }
    let mut out = [STAT_MIN; 4];
    for i in 0..4 {
        out[i] = STAT_MIN + extra[i] as u8;
    }
    out
}
