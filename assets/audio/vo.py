"""Generate VO (announcer, vance, fighter samples), transcribe each take, pick the best. Idempotent."""
import sys, difflib, concurrent.futures as cf
from lib import *
from spec_vo import *


def norm(s):
    s = re.sub(r"\[[^\]]*\]", " ", s.lower()).replace("’", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]", " ", s)).strip()


def stt(path):
    for _ in range(3):
        r = requests.post(f"{API}/v1/speech-to-text", headers=H, data={"model_id": "scribe_v1", "language_code": "en", "tag_audio_events": "false"},
                          files={"file": open(path, "rb")})
        if r.status_code == 200: return r.json().get("text", "")
        time.sleep(2)
    return ""


def tts(voice, text, stab, sim, out, model="eleven_v4"):  # newest model for any new line; existing raw takes are reused
    r = requests.post(f"{API}/v1/text-to-speech/{voice}?output_format=mp3_44100_128", headers=H,
                      json={"text": text, "model_id": model, "voice_settings": {"stability": stab, "similarity_boost": sim}}, timeout=300)
    if r.status_code != 200:
        print("TTS ERR", out, r.status_code, r.text[:200]); return False
    open(out, "wb").write(r.content); return True


def job(item):
    key, text, takes, voice, stab, sim, tag = item
    res = []
    for t in range(takes):
        f = f"{RAW}/vo/{key}_t{t}.mp3"
        if not os.path.exists(f):
            if not tts(voice, tag + text, stab, sim, f): continue
        heard = stt(f)
        s = difflib.SequenceMatcher(None, norm(text), norm(heard)).ratio()
        dur = len(decode(f, 1)) / SR
        res.append(dict(take=t, file=f, heard=heard, sim=round(s, 3), dur=round(dur, 2)))
    return key, text, res


def main(only, force=False):
    V = jload("voices.json")
    items = []
    for k, text, takes in ANNOUNCER:
        items.append((k, text, takes, V["announcer"], 0.0, 0.8, TAGS.get(k, "")))
    for k, text in VANCE:
        items.append((k, text, 1, V["vance"], 0.5, 0.8, TAGS.get(k, "")))
    for k in FIGHTERS:
        st, sim = FIGHTER_SETTINGS[k]
        items.append((f"fighter_{k}", SAMPLE, 1, V[k], st, sim, ""))
    mt = int(os.environ.get("TAKES", "0"))
    items = [(i[0], i[1], max(i[2], mt) if only else i[2], *i[3:]) for i in items if not only or i[0] in only]
    out = jload("vo_picks.json", {})
    with cf.ThreadPoolExecutor(4) as ex:
        for key, text, res in ex.map(job, items):
            if not res: print("FAILED", key); continue
            best = max(res, key=lambda r: (r["sim"], r["dur"]))
            ov = (jload("vo_overrides.json", {}) or {}).get(key)  # manual pick after shipped-file STT disagreed with raw STT
            if ov is not None: best = next((r for r in res if r["take"] == ov), best)
            open(f"{RAW}/vo/{key}.mp3", "wb").write(open(best["file"], "rb").read())
            out[key] = dict(text=text, picked=best["take"], takes=[{k: v for k, v in r.items() if k != "file"} for r in res])
            print(key, best["sim"], best["dur"], "|", best["heard"])
    jsave("vo_picks.json", out)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
