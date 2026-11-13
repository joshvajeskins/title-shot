mod common;
use bout_sim::normalize;
use bout_sim::spec::*;
use common::*;

/// Every character that renders as nothing: ranges from the rulebook plus single code points.
fn invisibles() -> Vec<char> {
    let mut v: Vec<u32> = vec![0x061C, 0x00AD, 0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800, 0xFEFF];
    v.extend(0x200B..=0x200F);
    v.extend(0x2060..=0x2064);
    v.extend(0xE0000..=0xE007F);
    v.into_iter().map(|c| char::from_u32(c).unwrap()).collect()
}

#[test]
fn invisible_only_or_padded_strings_are_rejected() {
    let inv = invisibles();
    assert!(inv.len() > 100);
    for &c in &inv {
        let (one, many) = (c.to_string(), c.to_string().repeat(5));
        for only in [one.clone(), many.clone(), format!(" {c} \t{c}")] {
            for field in 0..8 {
                let mut r = base_raw();
                match field {
                    0 => r.name = only.clone(),
                    1 => r.title = only.clone(),
                    2 => r.look = only.clone(),
                    3 => r.cry = only.clone(),
                    4 => r.moves[0].label = only.clone(),
                    5 => r.moves[1].label = only.clone(),
                    6 => r.moves[2].label = only.clone(),
                    _ => r.name = format!("\u{3000}{only}\u{00A0}"),
                }
                let e = normalize(&r).unwrap_err();
                assert_eq!(e.code(), "E_EMPTY_FIELD", "U+{:04X} in field {field}", c as u32);
                assert!(e.field().is_some());
            }
            assert_eq!(check_sentence(&format!("ab{only}")).unwrap_err().code(), "E_BAD_SENTENCE");
        }
        // padded: visible text plus the character in any position is E_BAD_CHAR, and a sentence is rejected
        for padded in [format!("{c}Ducky"), format!("Ducky{c}"), format!("Du{c}cky"), format!("{c}{c}Ducky{c}")] {
            let mut r = base_raw();
            r.title = padded.clone();
            assert_eq!(normalize(&r).unwrap_err().code(), "E_BAD_CHAR", "U+{:04X}", c as u32);
            assert!(check_sentence(&padded).is_err(), "U+{:04X}", c as u32);
        }
    }
    // a sentence that is nothing but invisible characters and spaces
    assert!(check_sentence(&"\u{2800}".repeat(10)).is_err());
    assert!(check_sentence(&"\u{200B} ".repeat(10)).is_err());
    assert!(check_sentence("a \u{3164}\u{3164}\u{3164}").is_err());
    // stored specs are re-validated with the same set
    let ok = normalize(&base_raw()).unwrap();
    let mut j: serde_json::Value = serde_json::to_value(&ok).unwrap();
    j["name"] = "\u{3164}".into();
    assert!(Spec::from_json(&j.to_string()).is_err());
    // a name made of visible characters next to a normal space is untouched
    let mut r = base_raw();
    r.name = "Ducky  Poseidon".into();
    assert_eq!(normalize(&r).unwrap().name, "Ducky  Poseidon");
}
