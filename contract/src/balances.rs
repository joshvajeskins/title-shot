//! Player balances. `deposit` is payable; `withdraw` needs 1 yocto so a function-call key can never take money out.
use crate::codes::*;
use crate::events::emit;
use crate::util::*;
use crate::verify;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{assert_one_yocto, env, near, AccountId, Gas, NearToken, Promise, PromiseError};

const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(10);

impl Contract {
    /// Credit a deposit to `who`. The first deposit of an account keeps `ACCOUNT_STORAGE` (not credited).
    fn take_deposit(&mut self, who: &AccountId) -> u128 {
        let attached = env::attached_deposit().as_yoctonear();
        let registered = self.balances.contains_key(who);
        let credited = if registered {
            check(attached > 0, E_AMOUNT);
            attached
        } else {
            check(attached >= ACCOUNT_STORAGE, E_STORAGE);
            attached - ACCOUNT_STORAGE
        };
        self.credit(who, credited);
        self.stats.deposits += credited;
        emit("deposit", json!({ "account": who, "amount": U128(credited), "balance": U128(self.balance(who)), "payer": env::predecessor_account_id() }));
        credited
    }
}

#[near]
impl Contract {
    /// Credit the caller.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let who = env::predecessor_account_id();
        U128(self.take_deposit(&who))
    }

    /// A sponsor funds a guest account (same first-deposit storage rule).
    #[payable]
    pub fn deposit_for(&mut self, account: AccountId) -> U128 {
        U128(self.take_deposit(&account))
    }

    /// Withdraw `amount` (default: everything). 1 yocto, so a function-call key can never call it.
    #[payable]
    pub fn withdraw(&mut self, amount: Option<U128>) -> U128 {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let bal = self.balance(&who);
        let amt = amount.map(|a| a.0).unwrap_or(bal);
        check(amt > 0 && amt <= bal, E_BALANCE);
        self.debit(&who, amt);
        self.stats.withdrawn += amt;
        emit("withdraw", json!({ "account": who, "amount": U128(amt), "balance": U128(bal - amt) }));
        Promise::new(who.clone())
            .transfer(NearToken::from_yoctonear(amt))
            .then(Self::ext(env::current_account_id()).with_static_gas(WITHDRAW_CALLBACK_GAS).on_withdrawn(who, U128(amt)));
        U128(amt)
    }

    /// If the transfer failed (for example the account was deleted) the amount goes back to its balance.
    #[private]
    pub fn on_withdrawn(&mut self, account: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.credit(&account, amount.0);
            self.stats.withdrawn -= amount.0;
            emit("withdraw_failed", json!({ "account": account, "amount": amount }));
        }
    }

    /// Register the Base/EVM address that receives this account's purse payouts.
    #[payable]
    pub fn set_evm_address(&mut self, addr: String) {
        assert_one_yocto();
        let a = parse_addr(&addr);
        self.evm_addrs.insert(env::predecessor_account_id(), a);
        emit("evm_address", json!({ "account": env::predecessor_account_id(), "address": verify::addr_hex(&a) }));
    }
}
