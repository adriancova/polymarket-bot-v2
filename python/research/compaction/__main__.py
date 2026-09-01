"""``python -m research.compaction`` — validate a compacted dataset.

Usage::

    uv run python -m research.compaction --manifest /objects/datasets/ds-1/manifest.json
    uv run python -m research.compaction --manifest ... --json

Exit codes: ``0`` the dataset validated, ``1`` it did not, ``2`` the manifest
itself could not be read, ``3`` an unexpected internal error (rendered as one
structured line, never a traceback).
"""

from research.compaction.validate import main

raise SystemExit(main())
