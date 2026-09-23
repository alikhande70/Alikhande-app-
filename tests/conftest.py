import os
import sys

# The linter lives in tools/ and the research engine in research/, neither of
# them installed. Keeps the repo free of packaging ceremony it does not need.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for sub in ("tools", "research"):
    path = os.path.join(_ROOT, sub)
    if path not in sys.path:
        sys.path.insert(0, path)
