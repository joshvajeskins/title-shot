//! Ledger snapshots: internal balances, season side-pot and protocol counters, compared to the yocto.
use crate::expect::Split;
use crate::util::*;
use crate::world::World;
use anyhow::Result;
use near_workspaces::Account;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct Snap {
    pub bal: BTreeMap<String, u128>,
    pub side_pot: u128,
    pub protocol: u128,
    pub fees_spent: u128,
    pub tolls: u128,
    pub refunded: u128,
}

pub async fn snap(w: &World, belt: u32, accts: &[&Account]) -> Result<Snap> {
    let mut s = Snap::default();
    for a in accts {
        s.bal.insert(a.id().to_string(), w.bal(a).await?);
    }
    let b = w.view("get_belt", serde_json::json!({"id": belt})).await?;
    s.side_pot = if b["season"].is_null() { 0 } else { u(&b["season"]["side_pot"]) };
    let st = w.stats().await?;
    s.protocol = u(&st["protocol_total"]);
    s.fees_spent = u(&st["fees_spent"]);
    s.tolls = u(&st["tolls"]);
    s.refunded = u(&st["refunded"]);
    Ok(s)
}

impl Snap {
    pub fn b(&self, a: &Account) -> u128 {
        self.bal[a.id().as_str()]
    }
}

/// A resolved bout moves exactly `toll` out of the challenger and `fee` out of the ledger; the rest is the split.
#[allow(clippy::too_many_arguments)]
pub fn assert_bout_money(before: &Snap, after: &Snap, sp: &Split, toll: u128, fee: u128, challenger: &Account, holder: &Account, promoter: &Account) {
    let mut exp = before.bal.clone();
    *exp.get_mut(challenger.id().as_str()).unwrap() -= toll;
    *exp.get_mut(holder.id().as_str()).unwrap() += sp.champion;
    *exp.get_mut(promoter.id().as_str()).unwrap() += sp.promoter;
    assert_eq!(after.bal, exp, "internal balances after the bout (to the yocto)");
    assert_eq!(after.side_pot, before.side_pot + sp.side_pot, "season side-pot");
    assert_eq!(after.protocol, before.protocol + sp.protocol, "protocol share");
    assert_eq!(after.fees_spent, before.fees_spent + fee, "forge fee spent");
    assert_eq!(after.tolls, before.tolls + toll, "tolls collected");
    // conservation: toll = champion + promoter + side-pot + protocol + fee
    assert_eq!(sp.champion + sp.promoter + sp.side_pot + sp.protocol + fee, toll, "split + fee must equal the toll");
}

/// Relayer mode: the forge fee is not paid to OutLayer, it is credited to the protocol at request time, so a refund
/// still returns toll minus fee to the challenger and the fee shows up as protocol revenue.
pub fn assert_refund_minus_fee_relayer(before: &Snap, after: &Snap, fee: u128, challenger: &Account) {
    let mut exp = before.bal.clone();
    *exp.get_mut(challenger.id().as_str()).unwrap() -= fee;
    assert_eq!(after.bal, exp, "challenger gets toll - fee back; every other balance is untouched");
    assert_eq!(after.protocol, before.protocol + fee, "the relayer-mode fee is protocol revenue");
    assert_eq!(after.side_pot, before.side_pot, "no side-pot credit on a refund");
}

/// A refused/failed forge returns the toll minus the fee (the fee paid OutLayer): nobody else is paid.
pub fn assert_refund_minus_fee(before: &Snap, after: &Snap, toll: u128, fee: u128, challenger: &Account) {
    let mut exp = before.bal.clone();
    *exp.get_mut(challenger.id().as_str()).unwrap() -= fee;
    assert_eq!(after.bal, exp, "challenger gets toll - fee back; every other balance is untouched");
    assert_eq!(after.side_pot, before.side_pot, "no side-pot credit on a refund");
    assert_eq!(after.protocol, before.protocol, "no protocol credit on a refund");
    assert_eq!(after.fees_spent, before.fees_spent + fee, "the fee is spent");
    let _ = toll;
}
