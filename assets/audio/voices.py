"""Design + save voices (announcer, vance, 8 fighters). Idempotent: skips voices already in voices.json."""
import sys, base64, difflib
from lib import *
from spec_vo import DESIGNED, FIGHTERS, SAMPLE


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]", " ", s.lower())).strip()


def stt(path):
    r = requests.post(f"{API}/v1/speech-to-text", headers=H, data={"model_id": "scribe_v1", "language_code": "en", "tag_audio_events": "false"},
                      files={"file": open(path, "rb")})
    return r.json().get("text", "") if r.status_code == 200 else ""


def f0(path):
    x = decode(path, 1)[:, 0]; x = x[int(0.2 * SR):int(2.5 * SR)]
    if len(x) < 4000: return 0
    vals = []
    for s in range(0, len(x) - 2048, 2048):
        w = x[s:s + 2048]
        if np.abs(w).max() < 0.02: continue
        a = np.correlate(w, w, "full")[2047:]
        lo, hi = int(SR / 400), int(SR / 60)
        k = lo + int(np.argmax(a[lo:hi]))
        if a[k] > 0.3 * a[0]: vals.append(SR / k)
    return float(np.median(vals)) if vals else 0


def design(key, desc, text, auto=False):
    body = {"voice_description": desc, "model_id": "eleven_ttv_v3"}
    if auto: body["auto_generate_text"] = True
    else: body["text"] = text
    r = requests.post(f"{API}/v1/text-to-voice/design", headers=H, json=body, timeout=300)
    if r.status_code != 200:
        print(key, "design ERR", r.status_code, r.text[:300]); return None
    return r.json()


def main(only):
    V = jload("voices.json", {})
    items = {k: (v["desc"], v["text"], v["name"]) for k, v in DESIGNED.items()}
    for k, (d, desc) in FIGHTERS.items():
        items[k] = (desc, SAMPLE if len(SAMPLE) >= 100 else SAMPLE + " " + SAMPLE + " " + SAMPLE, f"TitleShot fighter {d}")
    for k, (desc, text, name) in items.items():
        if only and k not in only: continue
        if k in V and not only: continue
        j = design(k, desc, text)
        if not j: continue
        best = None; cands = []
        for i, p in enumerate(j["previews"]):
            f = f"{RAW}/previews/{k}_{i}.mp3"
            open(f, "wb").write(base64.b64decode(p["audio_base_64"]))
            heard = stt(f)
            sim = difflib.SequenceMatcher(None, norm(text), norm(heard)).ratio()
            c = dict(i=i, vid=p["generated_voice_id"], sim=round(sim, 3), f0=round(f0(f)), dur=p.get("duration_secs"))
            cands.append(c)
        # pick: highest intelligibility; among near-ties prefer the lowest pitch for deep archetypes
        deep = k in ("announcer", "vance", "gruff_veteran", "theatrical_villain", "calm_monk", "deadpan_robot", "regal_grand")
        top = max(c["sim"] for c in cands)
        pool = [c for c in cands if c["sim"] >= top - 0.04]
        best = min(pool, key=lambda c: c["f0"]) if deep else max(pool, key=lambda c: c["f0"])
        r = requests.post(f"{API}/v1/text-to-voice", headers=H, json={"voice_name": name, "voice_description": desc, "generated_voice_id": best["vid"]})
        if r.status_code != 200:
            print(k, "save ERR", r.status_code, r.text[:300]); continue
        V[k] = r.json()["voice_id"]
        jsave("voices.json", V)
        jsave(f"raw/previews/{k}.json", dict(chosen=best, candidates=cands))
        print("ok", k, V[k], best, cands)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
