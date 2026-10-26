"""
ML forecast core: gradient boosting + logistic regression on candle features.

The service is stateless. It receives the candles in the request, trains a model on that history
(walk-forward, no future information), scores itself the same way, and predicts the direction of
the move `horizon` minutes ahead. Output matches the dashboard's /api/forecast JSON.

Honesty notes:
- Direction is a classification (price up / down after `steps` candles). The size of the move is
  `(2p - 1) * mean |historical move|`, a deliberately modest estimate; the band comes from recent
  volatility, which is far more predictable than direction.
- The backtest retrains periodically on past data only: a sample is used for training at time t
  only if its outcome (t' + steps) was already known at t.
"""
from __future__ import annotations

import math

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

SOURCE = "ML, gradient boosting + logistique"

WARMUP = 60  # candles needed before features are valid
MIN_TRAIN = 250  # samples before the first backtest prediction
MIN_LIVE_TRAIN = 150  # samples needed to train the live model
MAX_FITS = 12  # bounds backtest time: at most ~12 retrainings
MIN_RETRAIN_EVERY = 40
DEADBAND = 0.03  # |p - 0.5| below this => "flat"
Z = 1.28  # ~80 % band
VOL_WINDOW = 96
CONF_THRESHOLDS = (0.55, 0.60, 0.65, 0.70)
MIN_SAMPLES = 20


class InsufficientData(ValueError):
    pass


# --------------------------------------------------------------------------- features


def _rolling_std(x: np.ndarray, k: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) < k:
        return out
    cs = np.concatenate([[0.0], np.cumsum(x)])
    cs2 = np.concatenate([[0.0], np.cumsum(x * x)])
    s = cs[k:] - cs[:-k]
    s2 = cs2[k:] - cs2[:-k]
    out[k - 1 :] = np.sqrt(np.maximum(s2 / k - (s / k) ** 2, 0.0))
    return out


def _rolling_mean(x: np.ndarray, k: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) < k:
        return out
    cs = np.concatenate([[0.0], np.cumsum(x)])
    out[k - 1 :] = (cs[k:] - cs[:-k]) / k
    return out


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    alpha = 2.0 / (span + 1)
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = alpha * x[i] + (1 - alpha) * out[i - 1]
    return out


def build_features(t: np.ndarray, o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, res_minutes: int) -> np.ndarray:
    """Feature matrix [n, f]; row i only uses candles up to and including i. NaN where undefined."""
    n = len(c)
    lc = np.log(c)
    lr1 = np.zeros(n)
    lr1[1:] = np.diff(lc)
    vol5, vol20, vol50 = (_rolling_std(lr1, k) for k in (5, 20, 50))
    scale = np.where(vol20 > 0, vol20, np.nan)

    cols: list[np.ndarray] = []
    # Scale-free momentum: k-step return in units of its expected noise
    for k in (1, 2, 3, 5, 8, 13, 21, 34):
        r = np.full(n, np.nan)
        r[k:] = lc[k:] - lc[:-k]
        cols.append(r / (scale * math.sqrt(k)))
    cols.append(vol5 / vol50)
    cols.append(vol20 / vol50)

    gains = np.maximum(lr1, 0.0)
    losses = np.maximum(-lr1, 0.0)
    g, ls = _rolling_mean(gains, 14), _rolling_mean(losses, 14)
    denom = g + ls
    cols.append(np.where(denom > 0, g / np.where(denom > 0, denom, 1.0), 0.5))

    for span in (10, 20, 50):
        cols.append((lc - np.log(_ema(c, span))) / scale)

    cols.append((h - l) / c / scale)
    cols.append((c - o) / c / scale)
    cols.append((h - np.maximum(o, c)) / c / scale)
    cols.append((np.minimum(o, c) - l) / c / scale)

    win = np.lib.stride_tricks.sliding_window_view
    hi20 = np.full(n, np.nan)
    lo20 = np.full(n, np.nan)
    if n >= 20:
        hi20[19:] = win(h, 20).max(axis=1)
        lo20[19:] = win(l, 20).min(axis=1)
    rng = hi20 - lo20
    cols.append(np.where(rng > 0, (c - lo20) / np.where(rng > 0, rng, 1.0), 0.5))

    if res_minutes < 1440:
        tod = 2 * math.pi * ((t % 86400) / 86400.0)
        cols += [np.sin(tod), np.cos(tod)]
    if res_minutes < 10080:
        dow = 2 * math.pi * (((t // 86400) + 3) % 7) / 7.0
        cols += [np.sin(dow), np.cos(dow)]

    X = np.column_stack(cols).astype(float)
    X[:WARMUP] = np.nan
    return X


# --------------------------------------------------------------------------- model


def fit_predict(X_train: np.ndarray, y_train: np.ndarray, X_test: np.ndarray) -> np.ndarray:
    """P(up) for each row of X_test: average of a shallow gradient-boosted forest and a ridge logistic model."""
    if len(X_test) == 0:
        return np.empty(0)
    if y_train.min() == y_train.max():
        return np.full(len(X_test), 0.5)
    gbm = HistGradientBoostingClassifier(
        max_depth=3,
        learning_rate=0.05,
        max_iter=120,
        min_samples_leaf=30,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=0,
    )
    lin = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=300))
    gbm.fit(X_train, y_train)
    lin.fit(X_train, y_train)
    return 0.5 * gbm.predict_proba(X_test)[:, 1] + 0.5 * lin.predict_proba(X_test)[:, 1]


def _labels(c: np.ndarray, steps: int, X: np.ndarray):
    n = len(c)
    fwd = np.full(n, np.nan)
    fwd[: n - steps] = np.log(c[steps:] / c[:-steps])
    valid = np.isfinite(X).all(axis=1)
    labelled = valid & np.isfinite(fwd) & (fwd != 0)
    return fwd, valid, labelled


# --------------------------------------------------------------------------- backtest


def hit_stat(hits: int, samples: int, steps: int = 1) -> dict:
    """Same definition as the dashboard: ~95 % margin, with overlapping horizons counted once."""
    if samples < MIN_SAMPLES:
        return {"hitRate": None, "samples": samples, "margin": None}
    effective = max(1.0, samples / max(1, steps))
    return {"hitRate": hits / samples, "samples": samples, "margin": min(0.5, 1.96 * 0.5 / math.sqrt(effective))}


def walk_forward(X: np.ndarray, c: np.ndarray, steps: int) -> dict:
    n = len(c)
    fwd, valid, labelled = _labels(c, steps, X)
    last_t = n - 1 - steps
    cum = np.cumsum(labelled)
    empty = {
        **hit_stat(0, 0, steps),
        "baselines": {"alwaysUp": hit_stat(0, 0, steps), "lastMove": hit_stat(0, 0, steps)},
        "byConfidence": [{"minConfidence": t, **hit_stat(0, 0, steps)} for t in CONF_THRESHOLDS],
    }
    if last_t < 1 or not (cum >= MIN_TRAIN).any():
        return empty
    t_start = int(np.argmax(cum >= MIN_TRAIN)) + steps
    if t_start > last_t:
        return empty

    n_test = last_t - t_start + 1
    block = max(MIN_RETRAIN_EVERY, math.ceil(n_test / MAX_FITS))
    ps: list[float] = []
    ts: list[int] = []
    for b in range(t_start, last_t + 1, block):
        # Only samples whose outcome was already known at time b: index j with j + steps <= b
        train = np.where(labelled[: b - steps + 1])[0]
        test = np.array([t for t in range(b, min(b + block, last_t + 1)) if valid[t]], dtype=int)
        if len(train) < MIN_TRAIN or len(test) == 0:
            continue
        p = fit_predict(X[train], (fwd[train] > 0).astype(int), X[test])
        ps.extend(p.tolist())
        ts.extend(test.tolist())

    hits = samples = up_hits = last_hits = 0
    conf = [[0, 0] for _ in CONF_THRESHOLDS]
    for p, t in zip(ps, ts):
        if abs(p - 0.5) < DEADBAND:
            continue
        actual = c[t + steps] - c[t]
        if actual == 0:
            continue
        went_up = actual > 0
        hit = (p > 0.5) == went_up
        samples += 1
        hits += hit
        up_hits += went_up
        last_hits += (c[t] - c[t - 1] >= 0) == went_up
        confidence = max(p, 1 - p)
        for k, thr in enumerate(CONF_THRESHOLDS):
            if confidence >= thr:
                conf[k][1] += 1
                conf[k][0] += hit
    return {
        **hit_stat(hits, samples, steps),
        "baselines": {"alwaysUp": hit_stat(up_hits, samples, steps), "lastMove": hit_stat(last_hits, samples, steps)},
        "byConfidence": [{"minConfidence": thr, **hit_stat(h_, s_, steps)} for thr, (h_, s_) in zip(CONF_THRESHOLDS, conf)],
    }


# --------------------------------------------------------------------------- forecast


def ml_forecast(candles: list[dict], res_minutes: int, horizon: int) -> dict:
    t = np.array([k["time"] for k in candles], dtype=float)
    o, h, l, c = (np.array([k[f] for k in candles], dtype=float) for f in ("open", "high", "low", "close"))
    n = len(c)
    steps = max(1, round(horizon / res_minutes))

    X = build_features(t, o, h, l, c, res_minutes)
    fwd, valid, labelled = _labels(c, steps, X)
    train = np.where(labelled)[0]
    if len(train) < MIN_LIVE_TRAIN:
        raise InsufficientData(f"not enough history: {len(train)} training samples, need {MIN_LIVE_TRAIN}")
    if not valid[n - 1]:
        raise InsufficientData("latest candle has no valid features (flat market?)")

    p_up = float(fit_predict(X[train], (fwd[train] > 0).astype(int), X[n - 1 : n])[0])
    if abs(p_up - 0.5) < DEADBAND:
        direction = "flat"
    else:
        direction = "up" if p_up > 0.5 else "down"

    total = (2 * p_up - 1) * float(np.mean(np.abs(fwd[train])))
    lr1 = np.diff(np.log(c))[-VOL_WINDOW:]
    sigma = float(np.std(lr1))
    last = c[-1]
    step_sec = res_minutes * 60
    points = []
    for k in range(1, steps + 1):
        mu = total * k / steps
        spread = Z * sigma * math.sqrt(k)
        points.append(
            {
                "time": int(t[-1] + k * step_sec),
                "value": float(last * math.exp(mu)),
                "low": float(last * math.exp(mu - spread)),
                "high": float(last * math.exp(mu + spread)),
            }
        )

    bt = walk_forward(X, c, steps)
    return {
        "points": points,
        "direction": direction,
        "confidence": max(p_up, 1 - p_up),
        "backtestHitRate": bt["hitRate"],
        "backtestSamples": bt["samples"],
        "backtest": bt,
        "source": SOURCE,
    }
