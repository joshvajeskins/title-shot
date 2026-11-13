//! Stable reject codes shared by the normalizer and the stored-spec loader.

use serde::Serialize;

/// Stable reject codes. `code()` strings are part of the contract ABI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reject {
    BadJson,
    Refused,
    EmptyField(&'static str),
    BadChar(&'static str),
    BadSchool,
    BadStyle,
    MoveCount,
    UnknownMove,
    DupMove,
    BadStats,
    BadSentence,
}

pub const ALL_CODES: [&str; 11] = [
    "E_BAD_JSON",
    "E_REFUSED",
    "E_EMPTY_FIELD",
    "E_BAD_CHAR",
    "E_BAD_SCHOOL",
    "E_BAD_STYLE",
    "E_MOVE_COUNT",
    "E_UNKNOWN_MOVE",
    "E_DUP_MOVE",
    "E_BAD_STATS",
    "E_BAD_SENTENCE",
];

impl Reject {
    pub fn code(&self) -> &'static str {
        match self {
            Reject::BadJson => ALL_CODES[0],
            Reject::Refused => ALL_CODES[1],
            Reject::EmptyField(_) => ALL_CODES[2],
            Reject::BadChar(_) => ALL_CODES[3],
            Reject::BadSchool => ALL_CODES[4],
            Reject::BadStyle => ALL_CODES[5],
            Reject::MoveCount => ALL_CODES[6],
            Reject::UnknownMove => ALL_CODES[7],
            Reject::DupMove => ALL_CODES[8],
            Reject::BadStats => ALL_CODES[9],
            Reject::BadSentence => ALL_CODES[10],
        }
    }
    pub fn field(&self) -> Option<&'static str> {
        match self {
            Reject::EmptyField(f) | Reject::BadChar(f) => Some(f),
            _ => None,
        }
    }
}

impl core::fmt::Display for Reject {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self.field() {
            Some(field) => write!(f, "{} ({})", self.code(), field),
            None => write!(f, "{}", self.code()),
        }
    }
}

impl Serialize for Reject {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Reject", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("field", &self.field())?;
        st.end()
    }
}
