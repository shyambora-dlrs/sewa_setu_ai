"""Sewa Setu knowledge ingestion pipeline.

Runs OUTSIDE the Cloudflare Worker (GitHub Actions or a developer machine):
crawl -> extract -> normalise -> validate -> chunk -> index -> publish an
immutable release to R2. See INGESTION.md for the full description.
"""

SCHEMA_VERSION = "1.0.0"
