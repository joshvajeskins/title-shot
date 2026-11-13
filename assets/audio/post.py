"""Process raw/ -> web/public/audio/{vo,sfx,music}/*.mp3 + manifest.json. Usage: post.py [ids...]"""
import sys, glob
from lib import *
from dsp import *
from spec_vo import ANNOUNCER, VANCE, FIGHTERS, FIGHTER_SETTINGS, SAMPLE, DESIGNED
from spec_sfx import SFX
from spec_music import MUSIC

VO_T, MUS_T = -16.0, -18.0
SFX_T = {"ui_tick": -30, "ui_hover": -32, "ui_confirm": -24, "ui_error": -24, "type_key": -24, "type_return": -22, "paper": -22,
         "crowd_ambience": -26, "heartbeat_loop": -24, "press_loop": -24, "crowd": -19, "stamp_slam": -16, "kaching": -20,
         "coins_pour": -22, "bell": -17, "drumroll": -20, "transition_whoosh": -22, "flash_pop": -22, "whoosh": -22, "miss_whiff": -24,
         "heal": -22, "shield": -22, "stun": -20, "psychic": -20}
SFX_DEFAULT = -17.0
# percussive hits are level-matched by peak (dBFS), not LUFS, so light < heavy is audible
PEAK_T = {"punch_light": -4.0, "punch_heavy": -1.8, "block": -5.0, "crit": -1.8, "clang": -2.5, "belt_clank": -3.0,
          "stamp_slam": -2.5, "type_key": -11.0, "ui_tick": -16.0, "ui_hover": -22.0, "kaching": -4.0, "bell_ding": -3.0,
          "flash_pop": -8.0}
LONG_FADE = {"ko_impact": 0.25, "crit": 0.12, "bell_ding": 0.2, "bell_triple": 0.2, "belt_clank": 0.15, "clang": 0.15, "drumroll": 0.1}
MUS_LOOP_X = {"lobby_loop": 1.5, "fight_loop": 1.5, "forge_loop": 1.0, "final_minutes_loop": 1.2}
MUS_LOOP_MIN = {"lobby_loop": 62.0, "fight_loop": 62.0, "forge_loop": 20.0, "final_minutes_loop": 30.0}
MUS_END = {"victory_sting": (7.0, 0.35), "defeat_sting": (5.8, 0.5), "bell_cinematic": (16.0, 0.12)}


def sfx_target(name):
    base = re.sub(r"_\d+$", "", name)
    if base in SFX_T: return SFX_T[base]
    for k, v in SFX_T.items():
        if base.startswith(k): return v
    return SFX_DEFAULT


def entry(id_, kind, f, y, loop, I, tp, **kw):
    e = dict(id=id_, file=f"audio/{kind}/{id_}.mp3", kind=kind, loop=loop, duration_ms=int(round(len(y) / SR * 1000)),
             lufs=round(I, 1), true_peak_dbtp=round(tp, 1),
             peak_dbfs=round(float(20 * np.log10(np.max(np.abs(y)) + 1e-9)), 1),
             rms_dbfs=round(float(20 * np.log10(np.sqrt(np.mean(y.astype(np.float64) ** 2)) + 1e-9)), 1))
    e.update(kw); return e


def run(only):
    man, seams = [], {}
    picks = jload("vo_picks.json", {}); V = jload("voices.json")
    texts = {k: t for k, t, _ in ANNOUNCER}; texts.update({k: t for k, t in VANCE})
    # ---- VO ----
    for key in list(texts) + [f"fighter_{k}" for k in FIGHTERS]:
        if only and key not in only: continue
        f = f"{RAW}/vo/{key}.mp3"
        if not os.path.exists(f): print("MISSING VO", key); continue
        x = fade(trim(decode(f, 1), -48, 0.03, 0.12), 0.004, 0.04)
        y, I, tp = normalize(x, VO_T)
        y, I, tp = encode_verified(y, f"{PUB}/vo/{key}.mp3")
        if key.startswith("fighter_"):
            fk = key[8:]
            e = entry(key, "vo", f, y, False, I, tp, text=SAMPLE, voice=V[fk], descriptor=FIGHTERS[fk][0],
                      settings=dict(model_id="eleven_v3", stability=FIGHTER_SETTINGS[fk][0], similarity_boost=FIGHTER_SETTINGS[fk][1]))
        else:
            who = "vance" if key.startswith("vance") else "announcer"
            e = entry(key, "vo", f, y, False, I, tp, text=texts[key], voice=V[who], speaker=who)
        man.append(e); print("vo", key, e["duration_ms"], e["lufs"], e["true_peak_dbtp"])
    # ---- SFX ----
    for base, (p, d, n, loop) in SFX.items():
        for i in range(n):
            name = base if n == 1 else f"{base}_{i + 1}"
            if only and name not in only: continue
            f = f"{RAW}/sfx/{name}.mp3"
            if not os.path.exists(f): print("MISSING SFX", name); continue
            x = decode(f, 1)
            if loop:
                x = trim(x, -70, 0, 0)
                y0, L, mc = make_loop(x, 0.6, 0.55 * len(x) / SR, quiet=True)
                y, I, tp = normalize(y0, sfx_target(name))
                seams[name] = seam_report(y); seams[name]["loop_point_s"] = round(L, 2); seams[name]["match_cost"] = mc
            else:
                x = fade(trim(x, -50, 0.004, 0.08), 0.002, LONG_FADE.get(base, 0.03))
                if base in PEAK_T: y, I, tp = normalize_peak(x, PEAK_T[base])
                else: y, I, tp = normalize(x, sfx_target(name), -2.0)
            y, I, tp = encode_verified(y, f"{PUB}/sfx/{name}.mp3")
            man.append(entry(name, "sfx", f, y, loop, I, tp, group=base))
            print("sfx", name, man[-1]["duration_ms"], man[-1]["lufs"], man[-1]["true_peak_dbtp"])
    # ---- music ----
    for name, (p, ms, loop) in MUSIC.items():
        if only and name not in only: continue
        f = f"{RAW}/music/{name}.mp3"
        if not os.path.exists(f): print("MISSING MUSIC", name); continue
        x = decode(f, 2)
        if loop:
            y0, L, mc = make_loop(trim(x, -70, 0, 0), MUS_LOOP_X[name], MUS_LOOP_MIN[name])
            y, I, tp = normalize(y0, MUS_T)
            seams[name] = seam_report(y); seams[name]["loop_point_s"] = round(L, 2); seams[name]["match_cost"] = mc
        else:
            mx, fo = MUS_END[name]
            x = trim(x, -55, 0.0, 0.05)[:int(mx * SR)]
            y, I, tp = normalize(fade(x, 0.005, fo), MUS_T)
        y, I, tp = encode_verified(y, f"{PUB}/music/{name}.mp3")
        man.append(entry(name, "music", f, y, loop, I, tp, group="music"))
        print("music", name, man[-1]["duration_ms"], man[-1]["lufs"], man[-1]["true_peak_dbtp"])
    old = jload("post_state.json", {"manifest": [], "seams": {}})
    if not only: old = {"manifest": [], "seams": {}}  # full run rebuilds the manifest from scratch (no stale entries)
    byid = {e["id"]: e for e in old["manifest"]}; byid.update({e["id"]: e for e in man})
    assert len(byid) == len({e["id"] for e in byid.values()}) and len(man) == len({e["id"] for e in man}), "duplicate manifest id"
    seams = {**old["seams"], **seams}
    jsave("post_state.json", {"manifest": list(byid.values()), "seams": seams})
    write_manifest(list(byid.values()))


def write_manifest(items):
    order = {"vo": 0, "sfx": 1, "music": 2}
    ids = [e["id"] for e in items]
    dup = {i for i in ids if ids.count(i) > 1}
    assert not dup, f"manifest ids must be unique across vo/sfx/music: {dup}"
    want = {k for k, _, _ in ANNOUNCER} | {k for k, _ in VANCE} | {f"fighter_{k}" for k in FIGHTERS}
    miss = want - {e["id"] for e in items if e["kind"] == "vo"}
    assert not miss, f"VO lines missing from manifest: {miss}"
    items = sorted(items, key=lambda e: (order[e["kind"]], e["id"]))
    for e in items: e.pop("group", None) if False else None
    json.dump(items, open(f"{PUB}/manifest.json", "w"), indent=1)
    V = jload("voices.json")
    pal = [dict(key=k, voice_id=V[k], descriptor=FIGHTERS[k][0], design_prompt=FIGHTERS[k][1], model_id="eleven_v3",
                stability=FIGHTER_SETTINGS[k][0], similarity_boost=FIGHTER_SETTINGS[k][1], sample=f"audio/vo/fighter_{k}.mp3") for k in FIGHTERS]
    json.dump(dict(announcer=V["announcer"], vance=V["vance"], fighters=pal,
                   note="Runtime battle cries: POST /v1/text-to-speech/{voice_id} with model eleven_v3 and these voice_settings; keep cries <= 60 chars."),
              open(f"{PUB}/fighter_voices.json", "w"), indent=1)


if __name__ == "__main__":
    run(set(sys.argv[1:]))
