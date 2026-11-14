//! A tiny JSON writer for events, view results and the OutLayer request. It replaces `serde_json::Value`
//! (and `json!`), whose number type drags float parsing and formatting into the wasm: this contract has no
//! floating point anywhere. Output is plain JSON; keys keep their insertion order.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Serialize, Serializer};
use near_sdk::{serde_json, AccountId};

/// Already-serialized JSON. As a view result it is written to the response verbatim (serde_json `raw_value`).
pub struct Raw(pub String);

impl Serialize for Raw {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use near_sdk::serde::ser::SerializeStruct;
        const TOKEN: &str = "$serde_json::private::RawValue";
        let mut st = s.serialize_struct(TOKEN, 1)?;
        st.serialize_field(TOKEN, &self.0)?;
        st.end()
    }
}

/// JSON `null`.
pub struct Null;

pub trait ToJson {
    fn write(&self, out: &mut String);
}

pub fn quote(s: &str, out: &mut String) {
    // serde_json's escaper, integer-only; a `String` always serializes.
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()));
}

impl ToJson for str {
    fn write(&self, out: &mut String) {
        quote(self, out)
    }
}
impl ToJson for String {
    fn write(&self, out: &mut String) {
        quote(self, out)
    }
}
impl ToJson for AccountId {
    fn write(&self, out: &mut String) {
        quote(self.as_str(), out)
    }
}
impl ToJson for U128 {
    fn write(&self, out: &mut String) {
        out.push('"');
        out.push_str(&self.0.to_string());
        out.push('"');
    }
}
impl ToJson for U64 {
    fn write(&self, out: &mut String) {
        out.push('"');
        out.push_str(&self.0.to_string());
        out.push('"');
    }
}
impl ToJson for bool {
    fn write(&self, out: &mut String) {
        out.push_str(if *self { "true" } else { "false" });
    }
}
impl ToJson for Null {
    fn write(&self, out: &mut String) {
        out.push_str("null");
    }
}
impl ToJson for Raw {
    fn write(&self, out: &mut String) {
        out.push_str(&self.0);
    }
}
macro_rules! num {
    ($($t:ty),*) => {$(impl ToJson for $t { fn write(&self, out: &mut String) { out.push_str(&self.to_string()); } })*};
}
num!(u8, u16, u32, u64, usize, i32, i64);

impl<T: ToJson + ?Sized> ToJson for &T {
    fn write(&self, out: &mut String) {
        (**self).write(out)
    }
}
impl<T: ToJson> ToJson for Option<T> {
    fn write(&self, out: &mut String) {
        match self {
            Some(v) => v.write(out),
            None => out.push_str("null"),
        }
    }
}
impl<T: ToJson> ToJson for [T] {
    fn write(&self, out: &mut String) {
        out.push('[');
        for (i, v) in self.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            v.write(out);
        }
        out.push(']');
    }
}
impl<T: ToJson> ToJson for Vec<T> {
    fn write(&self, out: &mut String) {
        self.as_slice().write(out)
    }
}

/// Object builder: `Obj::new().put("k", &v).done()`.
pub struct Obj(String);

impl Obj {
    pub fn new() -> Self {
        Obj(String::from("{"))
    }
    /// `key` must be a plain identifier (every key in this crate is a string literal): it is written without escaping.
    #[inline(never)]
    pub fn put<T: ToJson + ?Sized>(mut self, key: &str, v: &T) -> Self {
        if self.0.len() > 1 {
            self.0.push(',');
        }
        self.0.push('"');
        self.0.push_str(key);
        self.0.push_str("\":");
        v.write(&mut self.0);
        self
    }
    pub fn done(mut self) -> Raw {
        self.0.push('}');
        Raw(self.0)
    }
}

impl Default for Obj {
    fn default() -> Self {
        Self::new()
    }
}

/// `json!({ "key": value, ... })`: every value implements `ToJson`. Returns `Raw`.
macro_rules! json {
    ({ $($k:literal : $v:expr),* $(,)? }) => {{
        #[allow(unused_mut)]
        let mut o = $crate::json::Obj::new();
        $( o = o.put($k, &$v); )*
        o.done()
    }};
}
pub(crate) use json;

/// A JSON array of `items`.
pub fn arr<T: ToJson>(items: impl IntoIterator<Item = T>) -> Raw {
    let mut s = String::from("[");
    for (i, v) in items.into_iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        v.write(&mut s);
    }
    s.push(']');
    Raw(s)
}

/// Native tests read views as `serde_json::Value` (leaked: tests only).
#[cfg(test)]
impl std::ops::Deref for Raw {
    type Target = near_sdk::serde_json::Value;
    fn deref(&self) -> &Self::Target {
        Box::leak(Box::new(serde_json::from_str(&self.0).expect("view is valid json")))
    }
}
