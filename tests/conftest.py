import os
import sys

# The linter lives in tools/ rather than being installed, so tests import it
# from there. Keeps the repo free of packaging ceremony it does not need yet.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
