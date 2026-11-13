"""Music specs. id -> (prompt, ms, loop). Instrumental only."""
BASE = "instrumental, no vocals, midnight title-fight broadcast vibe: smoky late-night boxing broadcast crossed with a cartoon brawler, warm, punchy, brassy, vinyl texture, not EDM, not orchestral"
MUSIC = {
 "lobby_loop": (BASE + ". Late-night boom-bap hip hop groove at 88 BPM, laid-back drums with a dusty snare, muted trumpet melody, upright bass, warm Rhodes chords, vinyl crackle. Steady loopable groove with no big intro or fade.", 80000, True),
 "fight_loop": (BASE + ". High-energy brass funk breakbeat at 128 BPM, driving funky drums, slapping bass guitar, punchy horn stabs, wah guitar, cartoon fight energy, relentless. Steady loopable groove with no intro or fade.", 80000, True),
 "forge_loop": (BASE + ". Mechanical industrial percussion like anvils and press machinery with a rising brass swell, forging and crafting tension, steady pulse, 100 BPM, loopable.", 24000, True),
 "final_minutes_loop": (BASE + ". Ticking tension underscore: clock-like ticks, deep pulsing bass, muted brass stabs, urgent final-minutes countdown feel, 110 BPM, loopable, no resolution.", 40000, True),
 "victory_sting": (BASE + ". Short triumphant brass fanfare sting with a snare roll, bold trumpets, ends on a big held final chord and stops cleanly.", 6500, False),
 "defeat_sting": (BASE + ". Short stylish deflated brass sting: descending 'wah wah wah' muted trombone slide, sad and comical, ends on a low note and stops cleanly.", 5000, False),
 "bell_cinematic": (BASE + ". Cinematic build: rolling timpani and drums with brass swelling in tension, climbing to one huge hit at the end, then silence.", 16000, False),
}
