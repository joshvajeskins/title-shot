//! Every balance number in one place. Changing any of these changes every state_hash:
//! re-run the sweep, regenerate fixtures/golden.json (`cargo run --release --bin golden`),
//! and bump `rulebook::RULEBOOK_VERSION`.

pub const MAX_ROUNDS: u8 = 3;
pub const MAX_EXCHANGES: u8 = 10;
/// Round at the limit is a draw when HP permille differ by less than this.
pub const DRAW_MARGIN_PM: i32 = 100;

pub const HP_BASE: i32 = 140;
pub const HP_PER_GRIT: i32 = 2;

/// damage = power * (ATK_BASE + 2*power_stat) / (ATK_BASE + 2*guard_stat)
pub const ATK_BASE: i32 = 320;

/// School edge multipliers (move school vs the defender's school).
pub const ADV_NUM: i32 = 5;
pub const ADV_DEN: i32 = 4;
pub const DIS_NUM: i32 = 4;
pub const DIS_DEN: i32 = 5;
/// Same, under the Grudge Match rule.
pub const GRUDGE_ADV_NUM: i32 = 3;
pub const GRUDGE_ADV_DEN: i32 = 2;
pub const GRUDGE_DIS_NUM: i32 = 2;
pub const GRUDGE_DIS_DEN: i32 = 3;

/// Damage roll per hit: (VAR_MIN + below(VAR_SPAN))%.
pub const VAR_MIN: u32 = 85;
pub const VAR_SPAN: u32 = 31;
/// Round form: each fighter rolls a damage multiplier (FORM_MIN + below(FORM_SPAN))% per round.
pub const FORM_MIN: u32 = 30;
pub const FORM_SPAN: u32 = 141;

pub const STAB_NUM: i32 = 9;
pub const STAB_DEN: i32 = 8;

pub const CRIT_BASE: i32 = 10;
/// crit chance = CRIT_BASE + speed / CRIT_SPEED_DIV (+ showboat bonus)
pub const CRIT_SPEED_DIV: i32 = 2;
pub const SHOWBOAT_CRIT: i32 = 10;

/// initiative = speed * INIT_SPEED_K + haste bonus + rng(0..INIT_NOISE)
pub const INIT_SPEED_K: i32 = 2;
pub const INIT_NOISE: u32 = 120;
pub const HASTE_INIT: i32 = 60;

pub const BURN_TURNS: u8 = 3;
pub const WEAKEN_TURNS: u8 = 3;
pub const HASTE_TURNS: u8 = 3;
pub const SHIELD_TURNS: u8 = 3;
pub const COUNTER_TURNS: u8 = 2;
/// Exchanges a fighter cannot be stunned again after losing a turn to a stun.
pub const STUN_IMMUNE: u8 = 3;

/// burn tick = max(BURN_MIN, max_hp / BURN_HP_DIV)
pub const BURN_MIN: i32 = 3;
pub const BURN_HP_DIV: i32 = 16;

pub const TACTICIAN_STATUS_BONUS: i32 = 5;
pub const BRAWLER_DMG_NUM: i32 = 21;
pub const BRAWLER_DMG_DEN: i32 = 20;
pub const COUNTERPUNCHER_TAKEN_NUM: i32 = 1;
pub const COUNTERPUNCHER_TAKEN_DEN: i32 = 1;

/// Damage multiplier of a weakened attacker.
pub const WEAKEN_NUM: i32 = 2;
pub const WEAKEN_DEN: i32 = 3;
/// Share (percent) of an attack's damage that still lands through a counter stance; the rest is reflected.
pub const COUNTER_TAKEN_PCT: i32 = 66;
