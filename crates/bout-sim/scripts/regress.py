#!/usr/bin/env python3
"""Tuning aid: regress per-spec win rate on features from `sweep --csv`. Usage: regress.py pool.csv"""
import csv, sys
import numpy as np
rows = list(csv.DictReader(open(sys.argv[1])))
names = list(rows[0].keys())
y = np.array([float(r["wr"]) / 10 for r in rows])
X, labels = [], []
for k in ["p", "g", "s", "gr"]:
    X.append([float(r[k]) for r in rows]); labels.append("stat_" + k)
for si in range(6):
    X.append([1.0 if int(r["school"]) == si else 0.0 for r in rows]); labels.append("school%d" % si)
for si in range(1, 4):
    X.append([1.0 if int(r["style"]) == si else 0.0 for r in rows]); labels.append("style%d" % si)
for m in names[7:]:
    X.append([float(r[m]) for r in rows]); labels.append(m)
A = np.array(X).T
A = np.hstack([A, np.ones((len(rows), 1))])
coef, *_ = np.linalg.lstsq(A, y, rcond=None)
pred = A @ coef
ss = ((y - y.mean()) ** 2).sum()
print("n=%d std(wr)=%.1f R2=%.2f resid std=%.1f" % (len(y), y.std(), 1 - ((y - pred) ** 2).sum() / ss, (y - pred).std()))
for l, c in sorted(zip(labels, coef[:-1]), key=lambda t: -abs(t[1]))[:22]:
    print("%-16s %+.2f" % (l, c))
