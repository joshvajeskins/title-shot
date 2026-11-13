"""DSP helpers: trim, limiter, loudness, loop-seam search, mp3 encode."""
from lib import *


def trim(x, thr_db=-50.0, head=0.02, tail=0.10):
    m = np.abs(x).max(axis=1); thr = 10 ** (thr_db / 20)
    idx = np.where(m > thr)[0]
    if len(idx) == 0: return x
    a = max(0, idx[0] - int(head * SR)); b = min(len(x), idx[-1] + int(tail * SR))
    return x[a:b].copy()


def fade(x, fin=0.0, fout=0.0):
    x = x.copy()
    n = int(fin * SR)
    if n: x[:n] *= np.linspace(0, 1, n)[:, None]
    n = int(fout * SR)
    if n: x[-n:] *= np.linspace(1, 0, n)[:, None]
    return x


def limit(x, gain_db, ceil_db=-1.5):
    g = f"volume={gain_db}dB,alimiter=limit={10 ** (ceil_db / 20):.4f}:attack=1:release=40:level=disabled"
    p = sh("ffmpeg", "-v", "quiet", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]), "-i", "-", "-af", g, "-f", "f32le", "-",
           inp=x.astype(np.float32).tobytes())
    return np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, x.shape[1]).copy()


def measure(x):
    pad = np.zeros((int(0.6 * SR), x.shape[1]), dtype=np.float32)
    return ebur(np.concatenate([x, pad]))


def normalize(x, target, ceil_db=-1.5, max_gain=30.0):
    """Gain to target integrated LUFS; limiter holds true peak under ceil. Returns (y, lufs, tp)."""
    I, _ = measure(x)
    g = max(-40.0, min(target - I, max_gain)); y = x
    for _ in range(5):
        y = limit(x, g, ceil_db)
        I2, tp = measure(y)
        if abs(I2 - target) < 0.4 or I2 <= -69: break
        # stop pushing when the limiter is already doing >7 dB of work
        if np.abs(x).max() * 10 ** (g / 20) > 10 ** ((ceil_db + 7) / 20): break
        g += target - I2
    I2, tp = measure(y)
    c = ceil_db
    while tp > -1.0 and c > -6:  # hard guarantee: true peak <= -1 dBTP
        c -= 0.4; y = limit(x, g, c); I2, tp = measure(y)
    return y, I2, tp


def normalize_peak(x, peak_db):
    """Percussive hits: set sample peak to peak_db, then verify true peak <= -1 dBTP."""
    pk = 20 * np.log10(np.abs(x).max() + 1e-9)
    y = (x * 10 ** ((peak_db - pk) / 20)).astype(np.float32)
    I, tp = measure(y)
    while tp > -1.0:
        y = (y * 10 ** (-0.3 / 20)).astype(np.float32); I, tp = measure(y)
    return y, I, tp


# ---------------- loops ----------------
def spec_frames(x, n=1024, hop=512):
    m = x.mean(axis=1)
    if len(m) < n: return np.zeros((1, n // 2 + 1))
    w = np.hanning(n)
    fr = np.stack([np.abs(np.fft.rfft(m[i:i + n] * w)) for i in range(0, len(m) - n, hop)])
    return np.log1p(fr * 50)


def content_end(x, thr_db=-42.0):
    """Last second (in samples) whose RMS exceeds thr: generated tracks end in a silent tail that must not be looped."""
    w = SR // 2; m = x.mean(axis=1); end = 0
    for i in range(0, len(m) - w + 1, w):
        if 20 * np.log10(np.sqrt(np.mean(m[i:i + w] ** 2)) + 1e-9) > thr_db: end = i + w
    return end


def find_loop_point(x, c, lo_s, hop_s=0.0116, quiet=False):
    """Pick L (>= lo_s) so that x[L:L+c] (what plays after the wrap) best matches x[:c], with L+c inside the real content.
    quiet=True (SFX loops): only consider seam positions in the quietest 25% of 30 ms windows, so the wrap never lands on a transient.
    Returns (L, cost, percentile-rank of that cost among candidates: 0 = best)."""
    head = spec_frames(x[:c]); hi = min(len(x), content_end(x)) - c
    step = int(hop_s * SR); m = np.abs(x.mean(axis=1)); w = int(0.03 * SR)
    cands = list(range(int(lo_s * SR), hi, step))
    if quiet and len(cands) > 8:
        lv = np.array([m[L - w:L + w].mean() if L > w else 9 for L in cands]); thr = np.percentile(lv, 25)
        cands = [L for L, v in zip(cands, lv) if v <= thr]
    costs = [float(np.mean(np.abs(spec_frames(x[L:L + c]) - head)[:, :180])) for L in cands]
    i = int(np.argmin(costs))
    return cands[i], costs[i], float(np.mean(np.array(costs) < costs[i]) * 100)


def make_loop(x, c, lo_s=0.0, quiet=False):
    """Equal-power crossfade: out = x[:L] with its head blended with x[L:L+c]; out[0] continues out[-1] exactly."""
    c = int(c * SR)
    L, cost, pct = find_loop_point(x, c, lo_s, quiet=quiet)
    out = x[:L].copy(); tail = x[L:L + c]
    t = np.linspace(0, 1, c)[:, None]
    out[:c] = out[:c] * np.sin(t * np.pi / 2) + tail * np.cos(t * np.pi / 2)
    return out, L / SR, round(cost, 3)


def seam_report(y):
    """Wrap check on y+y: (1) click = largest sample jump within +-3 ms of the seam vs the 99.9th percentile of jumps elsewhere;
    (2) level step = |dB(rms next 250 ms) - dB(rms prev 250 ms)| at the seam vs the 95th percentile of such steps along the track."""
    m = y.mean(axis=1); n = len(m); d = np.abs(np.diff(np.concatenate([m, m])))
    k = int(0.003 * SR)
    seam_jump = float(max(d[n - k:n + k]))
    p999 = float(np.percentile(d, 99.9)) + 1e-9
    w = int(0.25 * SR); db = lambda v: 20 * np.log10(np.sqrt(np.mean(v ** 2)) + 1e-6)
    step = abs(db(m[:w]) - db(m[-w:]))
    steps = [abs(db(m[i:i + w]) - db(m[i - w:i])) for i in range(w, n - w, w // 2)]
    p95 = float(np.percentile(steps, 95)) if steps else 0.0
    return dict(seam_jump=round(seam_jump, 5), p999_jump=round(p999, 5), jump_ratio=round(seam_jump / p999, 2),
                level_step_db=round(float(step), 2), track_p95_step_db=round(p95, 2),
                ok=bool(seam_jump <= 1.5 * p999))


def encode_mp3(x, out, q=4):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sh("ffmpeg", "-v", "quiet", "-y", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]), "-i", "-", "-c:a", "libmp3lame", "-q:a", str(q), out, inp=x.astype(np.float32).tobytes())


def encode_verified(y, out, q=4):
    """Encode, decode the shipped mp3 and re-measure; lower gain until true peak <= -1 dBTP after lossy coding."""
    for _ in range(6):
        encode_mp3(y, out)
        z = decode(out, y.shape[1]); I, tp = measure(z)
        if tp <= -1.0: return y, I, tp
        y = (y * 10 ** (-0.5 / 20)).astype(np.float32)
    return y, I, tp
