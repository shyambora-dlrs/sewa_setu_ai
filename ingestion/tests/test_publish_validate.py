"""Atomic publishing, rollback, retention, validation failures and embeddings."""
import json
import shutil

import pytest
import requests

from conftest import FakeResponse, FakeSession
from sewasetu_ingest.embeddings.build import build_embedding_index, quantize
from sewasetu_ingest.embeddings.provider import WorkersAiRestProvider
from sewasetu_ingest.pipeline import PipelineOptions, run_pipeline
from sewasetu_ingest.publisher.release import PublishError, activate_release, prune_releases, publish_release, validate_and_record
from sewasetu_ingest.publisher.store import LocalDirObjectStore, S3ObjectStore
from sewasetu_ingest.validators.validate import validate_release
from test_pipeline import FakeFetcher, pages


def build(tmp_path, sources, policy, release_id, **kw):
    opts = PipelineOptions(output=tmp_path / release_id, sources=sources, policy=policy, release_id=release_id, **kw)
    res = run_pipeline(opts, FakeFetcher(pages()))
    assert res.validation_passed
    return tmp_path / release_id


class RecordingStore(LocalDirObjectStore):
    """Records the order of writes; can inject a failure on the Nth put."""

    def __init__(self, root, fail_on=None, corrupt=False):
        super().__init__(root)
        self.puts, self.fail_on, self.corrupt = [], fail_on, corrupt

    def put(self, key, data, content_type="application/json", metadata=None):
        if self.fail_on is not None and len(self.puts) == self.fail_on:
            raise OSError("simulated upload failure")
        self.puts.append(key)
        super().put(key, data[:-1] if self.corrupt and key.endswith("summaries.json") else data, content_type, metadata)


def test_current_json_is_written_last_after_every_object(tmp_path, sources, policy):
    out = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    store = RecordingStore(tmp_path / "store")
    pointer = publish_release(out, store)
    assert store.puts[-1] == "current.json" and store.puts.count("current.json") == 1
    assert all(k.startswith("releases/2026-11-11T100000Z-aaaaaa/") for k in store.puts[:-1])
    assert pointer["release_id"] == "2026-11-11T100000Z-aaaaaa"
    assert json.loads(store.get("current.json"))["release_id"] == pointer["release_id"]


def test_failed_upload_leaves_the_previous_pointer_untouched(tmp_path, sources, policy):
    first = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    store = RecordingStore(tmp_path / "store")
    publish_release(first, store)
    before = store.get("current.json")
    second = build(tmp_path, sources, policy, "2026-11-12T100000Z-bbbbbb")
    broken = RecordingStore(tmp_path / "store", fail_on=5)
    with pytest.raises(OSError):
        publish_release(second, broken)
    assert broken.get("current.json") == before


def test_upload_verification_failure_blocks_the_pointer_switch(tmp_path, sources, policy):
    first = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    store = RecordingStore(tmp_path / "store")
    publish_release(first, store)
    before = store.get("current.json")
    second = build(tmp_path, sources, policy, "2026-11-12T100000Z-bbbbbb")
    with pytest.raises(PublishError, match="verification failed"):
        publish_release(second, RecordingStore(tmp_path / "store", corrupt=True))
    assert store.get("current.json") == before


def test_refuses_to_publish_a_release_that_failed_validation(tmp_path, sources, policy):
    out = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    (out / "catalog/services/test-income-certificate.json").write_text("{}")
    rep = validate_and_record(out)
    assert not rep.passed
    with pytest.raises(PublishError, match="failed validation"):
        publish_release(out, LocalDirObjectStore(tmp_path / "store"))
    assert not (tmp_path / "store" / "current.json").exists()


def test_rollback_restores_the_previous_release_and_history(tmp_path, sources, policy):
    store = LocalDirObjectStore(tmp_path / "store")
    publish_release(build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa"), store)
    publish_release(build(tmp_path, sources, policy, "2026-11-12T100000Z-bbbbbb"), store)
    cur = json.loads(store.get("current.json"))
    assert cur["release_id"].endswith("bbbbbb") and cur["previous_release_ids"] == ["2026-11-11T100000Z-aaaaaa"]
    pointer = activate_release(store, "2026-11-11T100000Z-aaaaaa")
    assert pointer["release_id"].endswith("aaaaaa") and pointer["previous_release_ids"] == ["2026-11-12T100000Z-bbbbbb"]
    with pytest.raises(PublishError, match="does not exist"):
        activate_release(store, "2020-01-01T000000Z-ghost0")


def test_retention_prunes_old_releases_but_keeps_rollback_targets(tmp_path, sources, policy):
    store = LocalDirObjectStore(tmp_path / "store")
    ids = [f"2026-11-0{i}T100000Z-a{i}a{i}a{i}" for i in range(1, 6)]
    for rid in ids:
        publish_release(build(tmp_path, sources, policy, rid), store, keep_releases=3)
    remaining = [p.split("/")[1] for p in store.list_prefixes("releases/")]
    assert remaining == sorted(ids)[-3:]
    cur = json.loads(store.get("current.json"))
    assert cur["release_id"] == ids[-1] and all(store.head(f"releases/{r}/manifest.json") for r in cur["previous_release_ids"] if r in remaining)


def test_validator_detects_broken_releases(tmp_path, sources, policy):
    out = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    assert validate_release(out).passed

    def broken(mutate):
        d = tmp_path / "copy"
        shutil.rmtree(d, ignore_errors=True)
        shutil.copytree(out, d)
        mutate(d)
        return validate_release(d)

    def edit_service(d, fn):
        p = d / "catalog/services/test-income-certificate.json"
        s = json.loads(p.read_text()); fn(s); p.write_text(json.dumps(s))

    r = broken(lambda d: edit_service(d, lambda s: s.update(sources=[])))
    assert any("source" in e for e in r.errors)
    r = broken(lambda d: edit_service(d, lambda s: s["fees"].update(source_chunk_ids=[])))
    assert any("fee has no supporting source chunk" in e for e in r.errors)
    r = broken(lambda d: edit_service(d, lambda s: s["required_documents"][0].update(source_chunk_id=None)))
    assert any("mandatory document" in e for e in r.errors)
    r = broken(lambda d: edit_service(d, lambda s: s.update(publication_status="verified")))
    assert any("verified without last_verified_at" in e or "checksum" in e for e in r.errors)
    r = broken(lambda d: (d / "catalog/services/test-trade-licence.json").unlink())
    assert any("missing" in e or "match" in e for e in r.errors)
    r = broken(lambda d: (d / "manifest.json").write_text(json.dumps({**json.loads((d / "manifest.json").read_text()), "chunk_count": 1})))
    assert any("chunk_count" in e for e in r.errors)
    r = broken(lambda d: (d / "chunks/chunk-shard-000.json").write_text("[]"))
    assert not r.passed


def test_validator_rejects_http_source_urls_and_unknown_chunk_services(tmp_path, sources, policy):
    out = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa")
    p = out / "catalog/services/test-trade-licence.json"
    s = json.loads(p.read_text()); s["sources"][0]["source_url"] = "http://insecure.example.gov.in/x"; p.write_text(json.dumps(s))
    assert any("https" in e for e in validate_release(out).errors)


def test_embeddings_are_quantized_sharded_and_aligned(tmp_path):
    class Fake:
        model = "fake-embed"
        def embed_batch(self, texts): return [[1.0, 0.0, 0.0, 0.0] if "fee" in t else [0.0, 1.0, 0.0, 0.0] for t in texts]
    chunks = [{"chunk_id": f"c{i}", "text": "fee" if i % 2 else "docs"} for i in range(5)]
    meta, shards = build_embedding_index(chunks, Fake(), shard_size=2)
    assert meta["doc_ids"] == [c["chunk_id"] for c in chunks] and meta["dimensions"] == 4 and meta["model"] == "fake-embed"
    assert [len(s["v"]) for s in shards] == [2, 2, 1]
    assert quantize([1, 0, 0, 0]) == "fwAAAA=="  # int8 127,0,0,0


def test_release_with_embeddings_validates(tmp_path, sources, policy):
    class Fake:
        model = "fake-embed"
        def embed_batch(self, texts): return [[1.0, 0.5, 0.25, 0.1] for _ in texts]
    out = build(tmp_path, sources, policy, "2026-11-11T100000Z-aaaaaa", embedding_provider=Fake())
    m = json.loads((out / "manifest.json").read_text())
    assert m["retrieval"]["embedding_model"] == "fake-embed" and (out / m["retrieval"]["embedding_index"]).exists()


def test_workers_ai_provider_retries_and_validates_payload():
    ok = FakeResponse(200, json.dumps({"result": {"data": [[0.1, 0.2], [0.3, 0.4]]}}).encode())
    ok.json = lambda: {"result": {"data": [[0.1, 0.2], [0.3, 0.4]]}}
    rate = FakeResponse(429)
    rate.raise_for_status = lambda: (_ for _ in ()).throw(requests.HTTPError("429"))
    session = type("S", (), {"calls": [], "post": lambda self, url, json=None, headers=None, timeout=None: (self.calls.append((url, json, headers)), [rate, ok][len(self.calls) - 1])[1]})()
    ok.raise_for_status = lambda: None
    prov = WorkersAiRestProvider("acct", "tok", session=session, sleep=lambda s: None)
    assert prov.embed_batch(["a", "b"]) == [[0.1, 0.2], [0.3, 0.4]]
    assert session.calls[0][0].endswith("/accounts/acct/ai/run/@cf/baai/bge-m3") and session.calls[0][2]["Authorization"] == "Bearer tok"


def test_s3_store_uses_the_injected_client_and_r2_env_is_validated(monkeypatch):
    calls = []
    class C:
        class exceptions: NoSuchKey = KeyError
        def put_object(self, **kw): calls.append(kw)
        def head_object(self, **kw): return {"ContentLength": 3, "Metadata": {"sha256": "x"}}
    s = S3ObjectStore("acct", "bucket", "k", "s", client=C())
    s.put("a/b.json", b"abc", metadata={"sha256": "x"})
    assert calls[0]["Bucket"] == "bucket" and calls[0]["Metadata"] == {"sha256": "x"} and s.head("a/b.json")["size"] == 3
    from sewasetu_ingest.publisher.store import store_from_env
    for v in ("CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
        monkeypatch.delenv(v, raising=False)
    with pytest.raises(RuntimeError, match="missing environment variables"):
        store_from_env("r2")
