# Convenience targets. Everything here also runs in CI, so a green `make check`
# locally means the same checks will pass there.
PY      ?= python3
PYTHONPATH := tools
export PYTHONPATH

.PHONY: help check test lint lint-report install-dev clean

help:
	@echo "make test        - run the Python test suite"
	@echo "make lint        - lint the MQL5 sources (strict: MEDIUM blocks)"
	@echo "make lint-report - lint in JSON, for tooling"
	@echo "make check       - test + lint, the same gate CI applies"
	@echo "make install-dev - install the tooling dependencies"

install-dev:
	$(PY) -m pip install -r requirements-dev.txt

# Prefer `python -m pytest` (what CI does, and what picks up the right
# interpreter), but fall back to a standalone `pytest` on PATH -- uv and pipx
# install it into an isolated environment no system interpreter can import.
test:
	@if $(PY) -c "import pytest" >/dev/null 2>&1; then \
	    echo "$(PY) -m pytest tests/ -q"; $(PY) -m pytest tests/ -q; \
	elif command -v pytest >/dev/null 2>&1; then \
	    echo "pytest tests/ -q"; pytest tests/ -q; \
	else \
	    echo "pytest not found. Run 'make install-dev'."; exit 1; \
	fi

lint:
	$(PY) -m mql5lint MQL5 --strict

lint-report:
	$(PY) -m mql5lint MQL5 --format json

check: test lint
	@echo "All checks passed. NOTE: this does not prove the MQL5 compiles -"
	@echo "MetaEditor is Windows-only. See docs/TESTING.md."

clean:
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
	rm -rf .pytest_cache
