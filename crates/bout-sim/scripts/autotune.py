#!/usr/bin/env python3
"""Damped move-balance tuner. Runs `sweep --tune --csv`, regresses spec win rate on move presence,
and nudges each move's strength knob toward a zero coefficient. Only edits numbers in src/moves.rs.
Usage: autotune.py [iterations]   (descs in moves.rs must be refreshed by hand afterwards)"""
import csv, re, subprocess, sys
import numpy as np

MOVES = "src/moves.rs"
CSV = "/private/tmp/claude-501/pool.csv"


def run():
    out = subprocess.run(["cargo", "run", "--release", "--bin", "sweep", "--", "--tune", "--csv", CSV],
                         capture_output=True, text=True).stdout
    gates = [l for l in out.splitlines() if l.startswith("| G") or "quantiles" in l]
    return gates


def coefs():
    rows = list(csv.DictReader(open(CSV)))
    names = list(rows[0].keys())
    y = np.array([float(r["wr"]) / 10 for r in rows])
    X, labels = [], []
    for k in ["p", "g", "s", "gr"]:
        X.append([float(r[k]) for r in rows]); labels.append("stat_" + k)
    for si in range(1, 6):
        X.append([1.0 if int(r["school"]) == si else 0.0 for r in rows]); labels.append("school%d" % si)
    for si in range(1, 4):
        X.append([1.0 if int(r["style"]) == si else 0.0 for r in rows]); labels.append("style%d" % si)
    for m in names[7:]:
        X.append([float(r[m]) for r in rows]); labels.append(m)
    A = np.array(X).T
    A = np.hstack([A, np.ones((len(rows), 1))])
    lam = 2.0
    I = np.eye(A.shape[1]); I[-1, -1] = 0
    c = np.linalg.solve(A.T @ A + lam * I, A.T @ y)
    return dict(zip(labels, c[:-1])), float(y.std())


LINE = re.compile(r'^(\s*mv!\(")(\w+)(",.*?, )(\w+), (\d+), (\d+), (\d+), (\d+), (&\[.*?\]), (".*"\),)$')


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def adjust(line, coef, damp):
    m = LINE.match(line)
    if not m:
        return line
    pre, mid, mid2, kind, power, acc, cd, cost, fx, tail = m.groups()
    power, acc, cd, cost = int(power), int(acc), int(cd), int(cost)
    step = -coef * damp
    if kind == "Strike":
        power = clamp(round(power + step * 0.6), 8, 50)
    else:
        def bump(pat, gain, lo, hi):
            nonlocal fx
            mm = re.search(pat, fx)
            if mm:
                v = clamp(round(int(mm.group(2)) + step * gain), lo, hi)
                fx = fx[:mm.start(2)] + str(v) + fx[mm.end(2):]
                return True
            return False
        done = bump(r'(Shield\()(\d+)', 1.5, 8, 60)
        done = bump(r'(Heal\()(\d+)', 1.0, 10, 60) or done
        done = bump(r'(Stun\()(\d+)', 2.0, 20, 100) or done
        if not done and kind == "Hex" and power > 0:
            power = clamp(round(power + step * 0.5), 6, 18)
        elif not done:
            if abs(step) > 2.5:
                cd = clamp(cd + (1 if step < 0 else -1), 1, 5)
            elif abs(step) > 0.8:
                cost = clamp(cost + (1 if step < 0 else -1), 5, 14)
    return f'{pre}{mid}{mid2}{kind}, {power}, {acc}, {cd}, {cost}, {fx}, {tail}'


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    for it in range(iters):
        gates = run()
        c, sd = coefs()
        worst = sorted(((abs(v), k, v) for k, v in c.items() if not k.startswith("stat")), reverse=True)[:6]
        print("iter", it, "wr std %.1f" % sd, "| worst:", ", ".join("%s %+.1f" % (k, v) for _, k, v in worst))
        for g in gates:
            if g.startswith("| G1") or g.startswith("| G4") or "quantiles" in g:
                print("  ", g)
        src = open(MOVES).read().split("\n")
        out = []
        for line in src:
            m = re.match(r'^\s*mv!\("(\w+)"', line)
            if m and m.group(1) in c:
                line = adjust(line, c[m.group(1)], 0.5)
            out.append(line)
        open(MOVES, "w").write("\n".join(out))


main()
