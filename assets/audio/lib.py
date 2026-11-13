"""Shared helpers for the TITLE SHOT+ audio pipeline (ElevenLabs only)."""
import os, re, json, base64, subprocess, sys, time
import requests
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
RAW = os.path.join(HERE, "raw")
PUB = os.path.join(ROOT, "web", "public", "audio")
SR = 44100
API = "https://api.elevenlabs.io"


def load_env():
    p = os.path.join(ROOT, ".env.local")
    if os.path.exists(p):
        for l in open(p):
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", l)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


load_env()
KEY = os.environ.get("ELEVENLABS_API_KEY", "")
H = {"xi-api-key": KEY}


def jload(name, default=None):
    p = os.path.join(HERE, name)
    return json.load(open(p)) if os.path.exists(p) else default


def jsave(name, obj):
    json.dump(obj, open(os.path.join(HERE, name), "w"), indent=1)


def sh(*a, inp=None):
    return subprocess.run(list(a), capture_output=True, input=inp)


def decode(f, ch):
    b = sh("ffmpeg", "-v", "quiet", "-i", f, "-ac", str(ch), "-ar", str(SR), "-f", "f32le", "-").stdout
    return np.frombuffer(b, dtype=np.float32).reshape(-1, ch).copy()


def ebur(x):
    """Return (integrated LUFS, true peak dBTP) for float32 array (n, ch)."""
    p = sh("ffmpeg", "-v", "info", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]), "-i", "-",
           "-af", "ebur128=peak=true", "-f", "null", "-", inp=x.astype(np.float32).tobytes())
    t = p.stderr.decode(); s = t[t.rfind("Summary:"):]
    mi = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", s); mp = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", s)
    I = float(mi.group(1)) if mi else -70.0
    tp = float(mp.group(1)) if mp else -70.0
    return I, tp
