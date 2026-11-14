use bout_sim::types::Winner;
use titleshot_it::simx::*;
fn main() {
    let a = archetypes();
    let specs: Vec<_> = a.iter().map(|(_, r)| spec(r)).collect();
    // for a handful of pairs, how often does each outcome appear over 300 seeds, per rule
    for (i, j) in [(0usize, 1usize), (2, 3), (5, 5), (10, 11), (20, 21)] {
        let mut c = [0u32; 3];
        for n in 0..300 {
            let (w, _, _) = outcome(&specs[i], &specs[j], &vrf_from(n), 1, None);
            c[match w { Winner::Champion => 0, Winner::Challenger => 1, Winner::Draw => 2 }] += 1;
        }
        println!("{} vs {}: champ {} chall {} draw {}", a[i].0, a[j].0, c[0], c[1], c[2]);
    }
}
