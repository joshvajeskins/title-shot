//! Local diagnostic (not deployed as the project): prints one JSON object of about N bytes, to test OutLayer's >1 KB output path.
fn main() {
    let mut raw = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw);
    let n: usize = raw.trim().trim_matches(|c| c == '{' || c == '}').split(':').nth(1).and_then(|v| v.trim().parse().ok()).unwrap_or(2000);
    print!("{{\"ok\":true,\"pad\":\"{}\"}}", "x".repeat(n.min(8000)));
}
