"""Historical bar data, with provenance attached.

Pure standard library on purpose. This module has to run in every scheduled
session without a package install step, and a research pipeline that cannot
fetch its own data because a wheel failed to build is not a research pipeline.

THE POINT OF THIS MODULE IS THE PROVENANCE, NOT THE DOWNLOAD.

Every series records where it came from, what it really is, and a content hash
of the bars. The hash is what makes an experiment reproducible: a result
recorded against hash X can be re-derived from the same bars, and if the
provider silently revises history the hash changes and the mismatch is visible
rather than silent.

The `proxy_for` field is the most important thing here. The instrument the
owner trades is spot XAUUSD at a retail broker. What is reachable from this
environment for free is GC=F, the COMEX gold *futures* contract. Those are
correlated but they are not the same instrument, and a result on one is a lead
about the other, never a finding. Series that stand in for something else say
so, and the ledger refuses to forget it.
"""

from __future__ import annotations

import hashlib
import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

CACHE_DIR = Path(__file__).resolve().parent.parent / "data_cache"
USER_AGENT = "Mozilla/5.0 (compatible; Alikhande-research/0.1)"
FETCH_TIMEOUT = 45


# --------------------------------------------------------------------------
# Types
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Bar:
    """One OHLCV bar. `ts` is the bar's OPEN time, epoch seconds, UTC."""

    ts: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    @property
    def dt(self) -> datetime:
        return datetime.fromtimestamp(self.ts, tz=timezone.utc)

    @property
    def date_str(self) -> str:
        return self.dt.strftime("%Y-%m-%d")

    def is_sane(self) -> bool:
        """Internal consistency. A bar failing this is bad data, not a bad day."""
        return (
            self.high >= self.low
            and self.high >= self.open
            and self.high >= self.close
            and self.low <= self.open
            and self.low <= self.close
            and self.low > 0.0
        )


@dataclass
class Instrument:
    """What a symbol IS, as opposed to what someone hopes it stands for."""

    key: str
    source: str            # "yahoo" | "fred"
    symbol: str            # the provider's symbol
    description: str
    proxy_for: str | None = None   # the real instrument this substitutes for
    caveat: str = ""               # why the substitution is imperfect

    @property
    def is_proxy(self) -> bool:
        return self.proxy_for is not None


@dataclass
class Series:
    instrument: Instrument
    interval: str
    bars: list[Bar] = field(default_factory=list)
    fetched_at: str = ""

    def __len__(self) -> int:
        return len(self.bars)

    @property
    def content_hash(self) -> str:
        """SHA-256 over the bar values. Identifies the data, not the file.

        Re-fetching unchanged history reproduces the hash; a provider revising
        history changes it, which is exactly when an old result stops being
        reproducible and somebody needs to know.
        """
        h = hashlib.sha256()
        h.update(f"{self.instrument.source}:{self.instrument.symbol}:{self.interval}".encode())
        for b in self.bars:
            h.update(f"|{b.ts}:{b.open:.6f}:{b.high:.6f}:{b.low:.6f}:{b.close:.6f}".encode())
        return h.hexdigest()[:16]

    @property
    def period(self) -> tuple[str, str]:
        if not self.bars:
            return ("", "")
        return (self.bars[0].date_str, self.bars[-1].date_str)

    def slice_dates(self, start: str | None = None, end: str | None = None) -> "Series":
        """Inclusive date slice. Used to keep in-sample and out-of-sample apart."""
        sel = [
            b for b in self.bars
            if (start is None or b.date_str >= start) and (end is None or b.date_str <= end)
        ]
        return Series(self.instrument, self.interval, sel, self.fetched_at)

    def provenance(self) -> dict:
        lo, hi = self.period
        return {
            "instrument_key": self.instrument.key,
            "source": self.instrument.source,
            "symbol": self.instrument.symbol,
            "interval": self.interval,
            "proxy_for": self.instrument.proxy_for,
            "is_proxy": self.instrument.is_proxy,
            "caveat": self.instrument.caveat,
            "bars": len(self.bars),
            "period_start": lo,
            "period_end": hi,
            "content_hash": self.content_hash,
            "fetched_at": self.fetched_at,
        }

    def sanity_report(self) -> dict:
        """Data faults worth knowing about before trusting any result built on it."""
        bad = [b.ts for b in self.bars if not b.is_sane()]
        dupes, gaps = [], []
        seen = set()
        prev = None
        for b in self.bars:
            if b.ts in seen:
                dupes.append(b.ts)
            seen.add(b.ts)
            if prev is not None and b.ts <= prev:
                gaps.append(b.ts)          # out of order
            prev = b.ts
        return {
            "insane_bars": len(bad),
            "duplicate_timestamps": len(dupes),
            "out_of_order": len(gaps),
            "clean": not (bad or dupes or gaps),
        }


# --------------------------------------------------------------------------
# Instrument registry
# --------------------------------------------------------------------------

INSTRUMENTS: dict[str, Instrument] = {
    "GOLD": Instrument(
        key="GOLD", source="yahoo", symbol="GC=F",
        description="COMEX gold futures, front month, continuous",
        proxy_for="XAUUSD spot at a retail broker",
        caveat=(
            "Futures, not spot: has contract roll effects, an exchange session rather "
            "than a 24/5 OTC session, exchange volume rather than broker volume, and "
            "no retail bid/ask. Treat every result as a LEAD about XAUUSD, never a "
            "finding about it."
        ),
    ),
    "EURUSD": Instrument(
        key="EURUSD", source="yahoo", symbol="EURUSD=X",
        description="EUR/USD indicative rate",
        proxy_for="EURUSD at a retail broker",
        caveat=(
            "An indicative mid rate with no bid/ask, so it contains no real spread. "
            "Cost assumptions are applied on top and are assumptions, not measurements."
        ),
    ),
    "DXY": Instrument(
        key="DXY", source="yahoo", symbol="DX-Y.NYB",
        description="US Dollar Index",
        proxy_for=None,
        caveat="Used as a conditioning variable, not traded.",
    ),
    "SILVER": Instrument(
        key="SILVER", source="yahoo", symbol="SI=F",
        description="COMEX silver futures",
        proxy_for="XAGUSD spot",
        caveat="Futures, not spot. Used mainly as a correlation check against gold.",
    ),
    "USDEUR_FRED": Instrument(
        key="USDEUR_FRED", source="fred", symbol="DEXUSEU",
        description="Fed H.10 daily USD/EUR noon rate, from 1999",
        proxy_for="EURUSD at a retail broker",
        caveat=(
            "One official fixing per business day, not a tradable series. Long history "
            "makes it useful for regime study; it is not usable for execution modelling."
        ),
    ),
}


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT, context=ctx) as resp:
        return resp.read()


def _fetch_yahoo(symbol: str, interval: str, range_: str) -> list[Bar]:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?range={range_}&interval={interval}"
    )
    payload = json.loads(_http_get(url))

    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(f"yahoo error for {symbol}: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise RuntimeError(f"yahoo returned no result for {symbol}")

    res = results[0]
    stamps = res.get("timestamp") or []
    quote = (res.get("indicators", {}).get("quote") or [{}])[0]
    o, h, l, c = (quote.get(k) or [] for k in ("open", "high", "low", "close"))
    v = quote.get("volume") or [0] * len(stamps)

    bars = []
    for i, ts in enumerate(stamps):
        # Providers emit nulls for non-trading stamps. A bar with a missing
        # component is dropped rather than interpolated: inventing a price is
        # how a backtest ends up trading data that never existed.
        try:
            bar = Bar(int(ts), float(o[i]), float(h[i]), float(l[i]), float(c[i]),
                      float(v[i] or 0.0))
        except (TypeError, ValueError, IndexError):
            continue
        if bar.is_sane():
            bars.append(bar)
    return bars


def _fetch_fred(series_id: str) -> list[Bar]:
    """FRED gives one close per day. Synthesised into OHLC with O=H=L=C.

    That is a real limitation, not a formatting detail: no intrabar range means
    no stop-inside-the-bar modelling, so FRED series are for regime study only.
    """
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
    text = _http_get(url).decode("utf-8", errors="replace")

    bars = []
    for line in text.splitlines()[1:]:
        parts = line.split(",")
        if len(parts) < 2:
            continue
        date_s, val_s = parts[0].strip(), parts[1].strip()
        if not val_s or val_s == ".":
            continue                     # FRED marks holidays with a dot
        try:
            px = float(val_s)
            ts = int(datetime.strptime(date_s, "%Y-%m-%d")
                     .replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
        if px > 0:
            bars.append(Bar(ts, px, px, px, px, 0.0))
    return bars


def fetch(key: str, interval: str = "1d", range_: str = "10y",
          use_cache: bool = True, max_age_hours: float = 12.0) -> Series:
    """Fetch (or load from cache) the bars for a registered instrument."""
    if key not in INSTRUMENTS:
        raise KeyError(f"unknown instrument '{key}'. Known: {sorted(INSTRUMENTS)}")
    inst = INSTRUMENTS[key]

    cache_path = CACHE_DIR / f"{key}_{interval}_{range_}.json"
    if use_cache and cache_path.exists():
        age_h = (time.time() - cache_path.stat().st_mtime) / 3600.0
        if age_h < max_age_hours:
            return _load_cache(cache_path, inst, interval)

    if inst.source == "yahoo":
        bars = _fetch_yahoo(inst.symbol, interval, range_)
    elif inst.source == "fred":
        bars = _fetch_fred(inst.symbol)
    else:
        raise ValueError(f"unknown source '{inst.source}'")

    if not bars:
        raise RuntimeError(f"no usable bars returned for {key}")

    bars.sort(key=lambda b: b.ts)
    series = Series(inst, interval, bars,
                    datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    _save_cache(cache_path, series)
    return series


def _save_cache(path: Path, series: Series) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "provenance": series.provenance(),
        "bars": [[b.ts, b.open, b.high, b.low, b.close, b.volume] for b in series.bars],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def _load_cache(path: Path, inst: Instrument, interval: str) -> Series:
    payload = json.loads(path.read_text(encoding="utf-8"))
    bars = [Bar(int(r[0]), r[1], r[2], r[3], r[4], r[5]) for r in payload["bars"]]
    return Series(inst, interval, bars, payload["provenance"].get("fetched_at", ""))
