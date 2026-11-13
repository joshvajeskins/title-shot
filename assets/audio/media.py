"""Generate SFX and music raw sources. Idempotent (skips existing). Usage: media.py sfx|music [ids...]"""
import sys, concurrent.futures as cf
from lib import *
from spec_sfx import SFX
from spec_music import MUSIC


def sfx_jobs():
    for k, (p, d, n, loop) in SFX.items():
        for i in range(n):
            yield (k if n == 1 else f"{k}_{i + 1}", p, d, loop, i)


def do_sfx(j):
    name, p, d, loop, i = j
    f = f"{RAW}/sfx/{name}.mp3"
    if os.path.exists(f): return name, "cached"
    body = {"text": p, "duration_seconds": d, "prompt_influence": 0.55, "model_id": "eleven_text_to_sound_v2"}
    if loop: body["loop"] = True
    for a in range(3):
        r = requests.post(f"{API}/v1/sound-generation?output_format=mp3_44100_128", headers=H, json=body, timeout=300)
        if r.status_code == 200:
            open(f, "wb").write(r.content); return name, "ok"
        if r.status_code == 429: time.sleep(5); continue
        break
    return name, f"ERR {r.status_code} {r.text[:200]}"


def do_music(k):
    p, ms, loop = MUSIC[k]
    f = f"{RAW}/music/{k}.mp3"
    if os.path.exists(f): return k, "cached"
    for a in range(3):
        r = requests.post(f"{API}/v1/music?output_format=mp3_44100_128", headers=H,
                          json={"prompt": p, "music_length_ms": ms, "model_id": "music_v1", "force_instrumental": True}, timeout=900)
        if r.status_code == 200:
            open(f, "wb").write(r.content); return k, "ok"
        if r.status_code == 429: time.sleep(10); continue
        break
    return k, f"ERR {r.status_code} {r.text[:300]}"


if __name__ == "__main__":
    kind, only = sys.argv[1], set(sys.argv[2:])
    if kind == "sfx":
        jobs = [j for j in sfx_jobs() if not only or j[0] in only or j[0].rsplit("_", 1)[0] in only]
        fn, w = do_sfx, 4
    else:
        jobs = [k for k in MUSIC if not only or k in only]
        fn, w = do_music, 3
    with cf.ThreadPoolExecutor(w) as ex:
        for res in ex.map(fn, jobs): print(*res, flush=True)
