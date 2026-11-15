//! The four calls the proof page's "Try it yourself" panel lets any player send (web/src/game/cheats.ts), with the exact
//! argument shapes it uses: each one is refused with the code the panel expects, and nothing moves.
use super::season_tests::{msg, play, PURSE};
use super::*;

const MAX: u128 = u128::MAX;

#[test]
fn every_cheat_the_panel_sends_is_refused_and_moves_nothing() {
    let mut e = Env::new("relayer");
    e.open_season("Opener of the cheat season", 86_400, PURSE);
    e.at("vance.testnet", 1);
    e.c.set_purse_address(1, 1, format!("0x{}", hex::encode(eth_addr(&signing_key(21)))));
    play(&mut e, 6);
    let holder = e.holder();
    e.deposit("mallory.testnet", 1);
    let bal = e.bal("mallory.testnet");
    assert!(holder != "mallory.testnet");

    // 1. Deliver my own fighter: only a listed relayer may call submit_forge, whatever it carries.
    e.at("mallory.testnet", 0);
    let cid = e.c.next_challenge - 1;
    let forged = r#"{"ok":true,"response":"{\"power\":10,\"speed\":10,\"guard\":10}","signature":"0x00"}"#;
    assert!(msg(|| e.c.submit_forge(cid, forged.into())).contains("E_NOT_RELAYER"));

    // 2. Take a belt I don't hold: nft_transfer to myself, 1 yocto. A non-holder is refused; so is the holder (E_SELF).
    e.at("mallory.testnet", 1);
    assert!(msg(|| e.c.nft_transfer(acct("mallory.testnet"), "belt-1".into(), None, None)).contains("E_NOT_HOLDER"));
    e.at(&holder, 1);
    assert!(msg(|| e.c.nft_transfer(acct(&holder), "belt-1".into(), None, None)).contains("E_SELF"));
    assert_eq!(e.holder(), holder, "the belt did not move");

    // 3. Withdraw more than my balance: u128::MAX yocto (more NEAR than exists), 1 yocto attached.
    e.at("mallory.testnet", 1);
    assert!(msg(|| e.c.withdraw(Some(U128(MAX)))).contains("E_BALANCE"));
    assert_eq!(e.bal("mallory.testnet"), bal, "balance unchanged");

    // 4. Claim someone else's purse share: claim_payout on a payout whose payee is another account.
    e.advance(86_400);
    e.at("anyone.testnet", 0);
    let ids = e.c.close_season(1);
    let theirs = *ids.iter().find(|i| e.c.payouts.get(i).unwrap().payee.as_str() != "mallory.testnet").unwrap();
    let before = e.c.payouts.get(&theirs).unwrap().to;
    e.at("mallory.testnet", 1);
    assert!(msg(|| e.c.claim_payout(theirs, "0x000000000000000000000000000000000000dEaD".into())).contains("E_NOT_PAYEE"));
    assert_eq!(e.c.payouts.get(&theirs).unwrap().to, before, "the payout address did not change");
}
