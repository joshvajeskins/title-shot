"""QA the final web/public/audio set: transcribe VO, re-measure loudness from the shipped mp3s, check loop seams, write QA.md."""
import difflib, glob, concurrent.futures as cf
from lib import *
from dsp import ebur, seam_report
from vo import stt, norm


def meas(e):
    f = f"{ROOT}/web/public/{e['file']}"
    ch = 2 if e["kind"] == "music" else 1
    x = decode(f, ch)
    I, tp = ebur(np.concatenate([x, np.zeros((int(0.6 * SR), ch), np.float32)]))
    r = dict(id=e["id"], kind=e["kind"], dur=round(len(x) / SR, 2), lufs=round(I, 1), tp=round(tp, 1), bytes=os.path.getsize(f),
             rms_db=round(float(20 * np.log10(np.sqrt(np.mean(x ** 2)) + 1e-9)), 1), manifest_dur=round(e["duration_ms"] / 1000, 2), loop=e["loop"])
    if e["loop"]:
        r["seam"] = seam_report(x)
    if e["kind"] == "vo":
        best, heard = 0, ""
        for _ in range(2):
            h = stt(f); s = difflib.SequenceMatcher(None, norm(e["text"]), norm(h)).ratio()
            if s > best: best, heard = s, h
            if s >= 0.99: break
        r.update(sim=round(best, 3), heard=heard, text=e["text"])
    return r


def main():
    man = json.load(open(f"{PUB}/manifest.json"))
    with cf.ThreadPoolExecutor(4) as ex: res = list(ex.map(meas, man))
    jsave("qa_results.json", res)
    L = ["# TITLE SHOT+ audio QA", "", f"Files: {len(res)} (vo {sum(r['kind']=='vo' for r in res)}, sfx {sum(r['kind']=='sfx' for r in res)}, music {sum(r['kind']=='music' for r in res)}). "
         f"Total size {sum(r['bytes'] for r in res)/1e6:.2f} MB (mp3 VBR q4). Loudness is re-measured from the shipped mp3s (ffmpeg ebur128).", ""]
    bad = [r for r in res if r["kind"] == "vo" and r["sim"] < 0.92]
    L += ["## Voice-over transcription (ElevenLabs scribe_v1)", "",
          f"Lines checked: {sum(r['kind']=='vo' for r in res)}. Below 0.92 similarity: {len(bad)}.", "",
          "| id | dur s | LUFS | dBTP | sim | heard |", "|---|---|---|---|---|---|"]
    for r in res:
        if r["kind"] == "vo": L.append(f"| {r['id']} | {r['dur']} | {r['lufs']} | {r['tp']} | {r['sim']} | {r['heard']} |")
    L += ["", "## Music", "", "| id | dur s | LUFS | dBTP | loop | seam jump ratio | level step dB (track p95) | seam ok |", "|---|---|---|---|---|---|---|---|"]
    for r in res:
        if r["kind"] == "music":
            s = r.get("seam", {}); ls = str(s.get('level_step_db','-')) + ' (' + str(s.get('track_p95_step_db','-')) + ')'; L.append(f"| {r['id']} | {r['dur']} | {r['lufs']} | {r['tp']} | {r['loop']} | {s.get('jump_ratio','-')} | {ls} | {s.get('ok','-')} |")
    L += ["", "## SFX", "", "| id | dur s | LUFS | dBTP | loop | seam ok |", "|---|---|---|---|---|---|"]
    for r in res:
        if r["kind"] == "sfx":
            L.append(f"| {r['id']} | {r['dur']} | {r['lufs']} | {r['tp']} | {r['loop']} | {r.get('seam',{}).get('ok','-')} |")
    over = [r["id"] for r in res if r["tp"] > -1.0]
    mfl = {e["id"]: e["lufs"] for e in man}
    lufs_drift = [(r["id"], mfl[r["id"]], r["lufs"]) for r in res if abs(mfl[r["id"]] - r["lufs"]) > 0.3]
    ids = [e["id"] for e in man]; dupes = sorted({i for i in ids if ids.count(i) > 1})
    from spec_vo import ANNOUNCER, VANCE, FIGHTERS
    want = {k for k, _, _ in ANNOUNCER} | {k for k, _ in VANCE} | {f"fighter_{k}" for k in FIGHTERS}
    vo_missing = sorted(want - {e["id"] for e in man if e["kind"] == "vo"})
    on_disk = {os.path.relpath(p, f"{ROOT}/web/public") for p in glob.glob(f"{PUB}/*/*.mp3")}
    orphans = sorted(on_disk - {e["file"] for e in man}); dead = sorted({e["file"] for e in man} - on_disk)
    lens = [r["id"] for r in res if abs(r["dur"] - r["manifest_dur"]) > 0.05]
    L += ["", "## Checks", "", f"- true peak > -1 dBTP: {over or 'none'}",
          f"- manifest ids unique across vo/sfx/music: {'OK' if not dupes else dupes}",
          f"- every scripted VO line (30 announcer + 5 Vance + 8 fighter = {len(want)}) has a manifest entry: {'OK' if not vo_missing else vo_missing}",
          f"- mp3 files on disk not referenced by the manifest / manifest files missing on disk: {orphans or 'none'} / {dead or 'none'}",
          f"- manifest `lufs` vs LUFS re-measured from the shipped mp3 differs by >0.3 dB: {lufs_drift or 'none'}",
          "- `lufs` convention: ebur128 integrated loudness with 0.6 s of trailing silence appended, so sub-400 ms hits get a valid value (an unpadded read is 1-3 dB higher; ui_tick is below the gate unpadded). For hits and UI ticks mix from `peak_dbfs`/`rms_dbfs`, not `lufs`.",
          f"- shipped mp3 duration differs from manifest by >50 ms (gapless/priming drift): {lens or 'none'}",
          f"- VO LUFS range: {min(r['lufs'] for r in res if r['kind']=='vo')} to {max(r['lufs'] for r in res if r['kind']=='vo')} (target -16)",
          f"- music LUFS range: {min(r['lufs'] for r in res if r['kind']=='music')} to {max(r['lufs'] for r in res if r['kind']=='music')} (target -18)",
          "", "## Notes", "",
          "- final_minutes_loop is a deliberate dynamic arc (sparse ticks, a loud 16 s body, sparse ticks). The head accent at the wrap is the same ~-14 dB tick the track plays every 4 s (hits at 4, 8, ..., 32 s in the loop; the wrap lands exactly 4 s after the hit at 32 s), so the wrap is beat-consistent rather than a sting. Measured per-0.5 s levels: tail -31 to -33 dB, hit -13 to -20 dB, body -13 dB. Needs a human listen to confirm it reads as a pulse and not a stinger.",
          "- QA.md and the manifest are regenerated by `generate.py post qa`; `generate.py post` on a full run rebuilds the manifest from scratch and asserts unique ids across vo/sfx/music and that every scripted VO line is present.",
          "", "## Not run", "",
          "- No human listening pass was possible in this lane (no audio device). Voice choice, SFX taste and music feel are verified by proxies only: STT intelligibility, pitch estimate, duration, loudness, spectral seam match.",
          "- Loops are crossfaded at a spectrally matched loop point, not tempo-locked to a bar grid; a beat-phase glitch at the seam is possible on the music loops even though there is no click.",
          "- Browser gapless playback of mp3 loops depends on the decoder honouring the LAME tag; use Web Audio `AudioBufferSourceNode.loop` (not `<audio loop>`).", ""]
    open(f"{HERE}/QA.md", "w").write("\n".join(L))
    print("bad VO:", [(r["id"], r["sim"], r["heard"]) for r in bad]); print("dupes", dupes, "vo_missing", vo_missing, "orphans", orphans, "dead", dead, "lufs_drift", lufs_drift); print("tp over:", over, "dur drift:", lens)
    for r in res:
        if r["loop"]: print(r["id"], r["dur"], r["seam"])


main()
