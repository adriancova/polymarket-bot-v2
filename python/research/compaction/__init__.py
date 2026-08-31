"""Dataset validation for compacted Parquet archives (``WP-130``).

Handoff §2 locks DuckDB/Polars over Parquet as the research query layer, and
§0.1 requires the recorder to produce "replayable, checksummed datasets". This
package is the job that decides whether a written dataset actually *is* one.

Why it exists in Python rather than as one more TypeScript test: a validator
that shares its reader with the writer can only prove the writer is
self-consistent. This one opens the Parquet with DuckDB — an independent
implementation of the format — hashes the object bytes with ``hashlib``, and
checks the result against the dataset manifest. If both agree, the claim is
about the artifact, not about one library's opinion of it.

Entry point::

    uv run python -m research.compaction --manifest path/to/manifest.json
"""

from research.compaction.manifest import (
    DatasetManifest,
    ManifestError,
    load_manifest,
    parse_manifest,
)
from research.compaction.validate import (
    ValidationFinding,
    ValidationReport,
    validate_dataset,
)

__all__ = [
    "DatasetManifest",
    "ManifestError",
    "ValidationFinding",
    "ValidationReport",
    "load_manifest",
    "parse_manifest",
    "validate_dataset",
]
