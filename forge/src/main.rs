//! OutLayer WASI entry: stdin JSON in, one compact JSON object out (stdout). Failures exit 0 with
//! `{ok:false,code,detail}` so the contract callback always receives a parseable answer.
use titleshot_forge::input::{parse, Failure, Input};
use titleshot_forge::output::{fail_json, ok_json};

#[cfg(target_arch = "wasm32")]
mod net;
#[cfg(target_arch = "wasm32")]
mod ops;
#[cfg(target_arch = "wasm32")]
mod wasi_post;

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
fn run(raw: &str) -> Result<String, Failure> {
    let start = std::time::Instant::now();
    match parse(raw)? {
        Input::Ping => Ok(ok_json(None, None, Some(ops::ping()?))),
        Input::Probe { path } => Ok(ok_json(None, None, Some(ops::probe(&path)?))),
        Input::Forge { sentence, need_compile, challenge_id, model_id } => {
            let vrf = ops::draw_vrf(challenge_id)?;
            let signed =
                if need_compile { Some(ops::forge_compile(&model_id, &sentence, start)?) } else { None };
            Ok(ok_json(signed, Some(vrf), None))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn run(raw: &str) -> Result<String, Failure> {
    parse(raw)?;
    Err(Failure::new("E_HOST", "build for wasm32-wasip2"))
}

fn main() {
    let mut raw = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw);
    match run(&raw) {
        Ok(out) => print!("{out}"),
        Err(f) => print!("{}", fail_json(f.code, &f.detail)),
    }
}
