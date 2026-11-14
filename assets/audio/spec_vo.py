"""Voice specs: announcer + promoter lines, designed voices, fighter palette."""

# (id, text, takes) ; takes=2 for starred lines
ANNOUNCER = [
 ("intro_1", "Ladies and gentlemen... welcome to the main event!", 2),
 ("intro_2", "Tonight, one sentence takes the belt.", 1),
 ("corner_champ", "In this corner... the reigning champion!", 1),
 ("corner_challenger", "And in this corner... the challenger!", 1),
 ("base_challenger", "And in this corner... a challenger... from Base!", 2),  # title shot bought on Base over x402 (eleven_v4)
 ("forge_1", "The forge is lit. Let's see what your words are made of.", 1),
 ("forge_2", "Hot off the press!", 1),
 ("round_1", "Round one!", 1),
 ("round_2", "Round two!", 1),
 ("round_3", "Final round!", 1),
 ("fight", "Fight!", 2),
 ("ko", "Knockout!", 2),
 ("new_champ", "And the new... champion... of the belt!", 2),
 ("holds", "The champion holds the belt!", 1),
 ("draw", "It's a draw! The belt stays right where it is.", 1),
 ("crit_1", "What a shot!", 1),
 ("crit_2", "Right on the button!", 1),
 ("crit_3", "Oh, that one landed!", 1),
 ("vo_stun", "They're seeing stars!", 1),
 ("vo_burn", "That's gonna leave a mark!", 1),
 ("comeback", "Off the canvas! Unbelievable!", 1),
 ("close", "It's close, folks! Anybody's fight!", 1),
 ("bell_season", "That's the bell! The season is over!", 2),
 ("purse", "The purse goes to the champion!", 1),
 ("new_season", "A new season begins! Fresh belt, fresh blood!", 1),
 ("rule_reveal", "Tonight's sealed rule is...", 1),
 ("toll", "The toll goes to the champ's corner.", 1),
 ("rematch", "Back for more? I like it.", 1),
 ("welcome", "Welcome back to the ring.", 1),
 ("odds_long", "Long odds, kid. Long odds.", 1),
 ("odds_good", "Now that's a contender.", 1),
]

VANCE = [
 ("vance_1", "Velvet Vance here, and I've got a fighter you'll never beat."),
 ("vance_2", "Season's open, kids. Bring me your best sentence."),
 ("vance_3", "The purse is funded. Step right up."),
 ("vance_4", "Another challenger falls. Tolls, tolls, tolls."),
 ("vance_5", "Somebody finally took my belt? Ha. Run it back next season."),
]

# Optional audio-tag prefixes for eleven_v3 (kept small; tags are stripped from QA comparison)
TAGS = {
 "intro_1": "[booming] ", "intro_2": "[low, dramatic] ", "corner_champ": "[booming] ",
 "corner_challenger": "[booming] ", "base_challenger": "[booming] ", "forge_1": "[dramatic] ", "forge_2": "[shouting] ",
 "round_1": "[booming] ", "round_2": "[booming] ", "round_3": "[booming] ", "fight": "[shouting] ",
 "ko": "[shouting] ", "new_champ": "[booming] ", "holds": "[booming] ", "draw": "[booming] ",
 "crit_1": "[excited] ", "crit_2": "[excited] ", "crit_3": "[excited] ", "vo_stun": "[excited] ",
 "vo_burn": "[excited] ", "comeback": "[shouting] ", "close": "[excited] ", "bell_season": "[shouting] ",
 "purse": "[booming] ", "new_season": "[excited] ", "rule_reveal": "[low, dramatic] ",
 "toll": "[booming] ", "rematch": "[amused] ", "welcome": "[warm] ", "odds_long": "[wry] ",
 "odds_good": "[impressed] ",
 "vance_1": "[smooth, confident] ", "vance_2": "[smooth] ", "vance_3": "[smooth] ",
 "vance_4": "[amused] ", "vance_5": "[laughs] ",
}

DESIGNED = {
 "announcer": dict(
  name="TitleShot Announcer",
  desc="Male, 50s-60s, theatrical booming ring announcer: deep gravelly baritone, big chest resonance, "
       "long drawn-out vowels, grand showman delivery with dramatic pauses, warm vintage arena PA presence, "
       "American, original character, commanding and playful.",
  text="Ladies and gentlemen... welcome to the main event! Tonight, one sentence takes the belt. The forge is lit, and the crowd is on its feet."),
 "vance": dict(
  name="TitleShot Velvet Vance",
  desc="Male, 40s, slick fight promoter and hustler: warm smooth late-night radio baritone, charming, "
       "relaxed and silky with a grin in the voice, confident salesman rhythm, American, original character.",
  text="Velvet Vance here, and I've got a fighter you'll never beat. Season's open, kids. Bring me your best sentence."),
}

SAMPLE = "You picked the wrong sentence to fight!"

# fighter voice palette: id -> (descriptor, design prompt, recommended v3 settings)
FIGHTERS = {
 "gruff_veteran": ("Gruff veteran", "Male, 60s, grizzled retired boxing veteran: gravelly rough rasp, low, tired but tough, American, blunt and growly."),
 "squeaky_tiny": ("Squeaky tiny", "Adult comedic cartoon critter voice: extremely high-pitched squeaky helium-like voice of a tiny woodland creature, fast, excitable and bubbly."),
 "regal_grand": ("Regal grand", "Female, 40s, regal grand queen: rich resonant mezzo, noble, slow and majestic, British accent, commanding and elegant."),
 "deadpan_robot": ("Deadpan robotic", "Deadpan robotic machine voice: flat monotone, slightly synthetic and metallic, emotionless, precise, android."),
 "sweet_elderly": ("Sweet elderly", "Female, 80s, sweet elderly grandmother: gentle warm quavering voice, kindly, soft and cheerful, American."),
 "hyper_teen": ("Hyper teen", "Male, early 20s, hyper energetic cocky streamer-type young adult: very fast, loud, bright, voice cracking with excitement, American, trash-talking."),
 "theatrical_villain": ("Theatrical villain", "Male, 50s, theatrical cartoon villain: silky menacing baritone, over-the-top dramatic, sneering, British stage actor style, evil laugh energy."),
 "calm_monk": ("Calm monk", "Male, 60s, calm serene monk: soft slow deep voice, hushed, peaceful, meditative, unhurried, breathy."),
}
FIGHTER_SETTINGS = {  # eleven_v3 stability (0 creative / 0.5 natural / 1 robust), similarity
 "gruff_veteran": (0.5, 0.8), "squeaky_tiny": (0.0, 0.8), "regal_grand": (0.5, 0.8),
 "deadpan_robot": (1.0, 0.8), "sweet_elderly": (0.5, 0.8), "hyper_teen": (0.0, 0.8),
 "theatrical_villain": (0.0, 0.8), "calm_monk": (1.0, 0.8),
}
