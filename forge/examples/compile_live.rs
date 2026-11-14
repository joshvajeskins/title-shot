//! Local diagnostic (not deployed): runs the forge's real wasm network path for one compile, without OutLayer's VRF host.
//!   wasmtime run -S http -S inherit-env ... target/wasm32-wasip2/release/examples/compile_live.wasm <model> <sentence>
#[path = "../src/net.rs"]
mod net;
#[path = "../src/wasi_post.rs"]
mod wasi_post;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let model = args.get(1).cloned().unwrap_or_else(|| "z-ai/glm-5.3-flash".into());
    let sentence = args.get(2).cloned().unwrap_or_else(|| "a cactus that went to law school".into());
    let key = std::env::var("NEARAI_API_KEY").unwrap_or_default();
    let start = std::time::Instant::now();
    eprintln!("compile start (key set: {})", !key.is_empty());
    match titleshot_forge::compile::compile(&net::Net { start }, &key, &model, &sentence) {
        Ok(s) => {
            let out = titleshot_forge::output::ok_json(Some(s), None, None);
            eprintln!("ok after {} ms, output {} bytes", start.elapsed().as_millis(), out.len());
            println!("{}", &out[..out.len().min(300)]);
        }
        Err(f) => eprintln!("FAIL after {} ms: {} {}", start.elapsed().as_millis(), f.code, f.detail),
    }
}
