#!/usr/bin/env python3
"""Command-line entry point for the Sewa Setu ingestion pipeline.

Examples
  python ingestion/run_ingestion.py --output build/release --validate
  python ingestion/run_ingestion.py --output build/release --publish --store r2
  python ingestion/run_ingestion.py --activate 2026-11-11T220000Z-a1b2c3 --store r2     # rollback
Exit codes: 0 ok, 2 systemic ingestion failure, 3 validation failed, 4 publish failed.
"""
from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sewasetu_ingest.config import load_policy, load_sources  # noqa: E402
from sewasetu_ingest.crawler.http import PoliteFetcher  # noqa: E402
from sewasetu_ingest.pipeline import PipelineError, PipelineOptions, run_pipeline  # noqa: E402
from sewasetu_ingest.publisher.release import PublishError, activate_release, publish_release  # noqa: E402
from sewasetu_ingest.publisher.store import ObjectStore, store_from_env  # noqa: E402
from sewasetu_ingest.registry import REGISTRY_KEY  # noqa: E402

log = logging.getLogger("ingest")


def archive_sources(store: ObjectStore, cache_dir: Path, snapshots, registry) -> int:
    """Uploads raw source snapshots content-addressed (never overwritten => history is retained)."""
    n = 0
    for sha, kind in dict.fromkeys(snapshots):
        key = f"sources/{kind}/{sha}.{'html.gz' if kind == 'html' else 'pdf'}"
        if store.head(key) or not (cache_dir / sha).exists():
            continue
        body = (cache_dir / sha).read_bytes()
        store.put(key, gzip.compress(body, 6) if kind == "html" else body, "application/gzip" if kind == "html" else "application/pdf", {"sha256": sha})
        n += 1
    store.put(REGISTRY_KEY, registry.dump(), "application/json")
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--output", default="build/release", help="directory for the generated release")
    ap.add_argument("--validate", action="store_true", help="fail (exit 3) when validation fails")
    ap.add_argument("--publish", action="store_true", help="upload to the store and switch current.json")
    ap.add_argument("--store", default=os.environ.get("INGEST_STORE", ""), help="'r2' or 'local:<dir>' (reads admin state/registry, target of --publish)")
    ap.add_argument("--activate", metavar="RELEASE_ID", help="roll current.json to an existing release and exit")
    ap.add_argument("--cache-dir", default="ingestion/.cache/raw")
    ap.add_argument("--max-services", type=int)
    ap.add_argument("--skip-pdfs", action="store_true")
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--embeddings", action="store_true", help="generate Workers AI embeddings (needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN)")
    ap.add_argument("--max-failure-ratio", type=float, default=0.10)
    ap.add_argument("--delay", type=float, help="override crawl delay seconds")
    ap.add_argument("--release-id")
    ap.add_argument("--pre-publish-check", metavar="COMMAND",
                    help="command run after validation and before any upload; a non-zero exit aborts publishing "
                         "(CI uses it to prove the Worker's Zod schemas can parse the release)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    store = store_from_env(args.store) if args.store else None
    if args.activate:
        if not store:
            ap.error("--activate requires --store")
        try:
            print(json.dumps(activate_release(store, args.activate)))
            return 0
        except PublishError as exc:
            log.error("activate failed: %s", exc)
            return 4

    sources, policy = load_sources(), load_policy()
    if args.delay is not None:
        policy = type(policy)(**{**policy.__dict__, "delay_seconds": args.delay})
    provider = None
    if args.embeddings:
        from sewasetu_ingest.embeddings.provider import WorkersAiRestProvider
        provider = WorkersAiRestProvider(os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_AI_TOKEN"])

    cache_dir = Path(args.cache_dir)
    from sewasetu_ingest.registry import SourceRegistry
    fetcher = PoliteFetcher(sources, policy, cache_dir=cache_dir, validators=SourceRegistry.load(store).validators())
    opts = PipelineOptions(output=Path(args.output), sources=sources, policy=policy, store=store, max_services=args.max_services,
                           skip_pdfs=args.skip_pdfs, ocr=not args.no_ocr, embedding_provider=provider,
                           max_failure_ratio=args.max_failure_ratio, release_id=args.release_id)
    try:
        result = run_pipeline(opts, fetcher)
    except PipelineError as exc:
        log.error("ingestion aborted: %s", exc)
        return 2

    t = result.report["totals"]
    log.info("services %s/%s extracted (%s failed) | pdfs %s extracted (%s failed, %s OCR) | failures %s",
             t["services_extracted"], t["services_discovered"], t["services_failed"], t["pdfs_extracted"], t["pdfs_failed"], t["pdfs_ocr"], len(result.report["failures"]))
    if not result.validation_passed:
        log.error("release validation FAILED - see %s/reports/validation-report.json", args.output)
        return 3 if args.validate or args.publish else 0
    if args.pre_publish_check:
        import shlex
        import subprocess
        check = subprocess.run(shlex.split(args.pre_publish_check), check=False)  # noqa: S603 - command comes from our own workflow
        if check.returncode != 0:
            log.error("pre-publish check failed (exit %s); nothing was uploaded", check.returncode)
            return 3
    if args.publish:
        if not store:
            ap.error("--publish requires --store")
        try:
            n = archive_sources(store, cache_dir, result.snapshots, result.registry)
            log.info("archived %d new raw source snapshot(s)", n)
            pointer = publish_release(Path(args.output), store)
            log.info("published release %s", pointer["release_id"])
        except PublishError as exc:
            log.error("publish failed: %s", exc)
            return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
