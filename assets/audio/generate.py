#!/usr/bin/env python3
"""Regenerate the whole TITLE SHOT+ audio set. Idempotent: existing raw/ sources are reused (delete a raw file to regenerate it).
  python3 assets/audio/generate.py            # voices -> vo -> sfx -> music -> post (ffmpeg) -> qa
  python3 assets/audio/generate.py post qa    # only the named stages
Needs ELEVENLABS_API_KEY in .env.local, ffmpeg, numpy, requests. ElevenLabs credits are spent only for missing raw files."""
import sys, subprocess, os
HERE = os.path.dirname(os.path.abspath(__file__))
STAGES = {"voices": ["voices.py"], "vo": ["vo.py"], "sfx": ["media.py", "sfx"], "music": ["media.py", "music"], "post": ["post.py"], "qa": ["qa.py"]}
for s in (sys.argv[1:] or list(STAGES)):
    print("==", s, flush=True)
    r = subprocess.run([sys.executable, *STAGES[s]], cwd=HERE)
    if r.returncode: sys.exit(r.returncode)
