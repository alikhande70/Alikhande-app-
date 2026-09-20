"""Strategy implementations for Tier-0 screening.

Every strategy here is a CANDIDATE and nothing more. None has passed the
tournament; several are expected to be eliminated. The EMA cross carries no
privilege over the others despite being the one already in the MQL5 tree.
"""

from .trend import EmaCross, DonchianBreakout
from .reversion import BandFade
from .volatility import SqueezeBreakout
from .null import RandomEntry, AlwaysLong

ALL = {
    "ema_cross": EmaCross,
    "donchian_breakout": DonchianBreakout,
    "band_fade": BandFade,
    "squeeze_breakout": SqueezeBreakout,
}

#: Benchmarks, never candidates. A strategy that cannot beat these has
#: no entry edge, whatever its own equity curve looks like.
NULLS = {
    "null_random_entry": RandomEntry,
    "null_always_long": AlwaysLong,
}
