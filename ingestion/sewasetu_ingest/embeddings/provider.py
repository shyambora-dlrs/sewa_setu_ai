"""Embedding providers. The pipeline depends on the small :class:`EmbeddingProvider` protocol."""
from __future__ import annotations

import time
from typing import Protocol

import requests


class EmbeddingProvider(Protocol):
    model: str

    def embed_batch(self, texts: list[str]) -> list[list[float]]: ...


class WorkersAiRestProvider:
    """Calls Cloudflare Workers AI over its REST API (used from GitHub Actions, not the Worker).

    Requires ``CLOUDFLARE_ACCOUNT_ID`` and a token limited to Workers AI (``CLOUDFLARE_AI_TOKEN``).
    The same model (default ``@cf/baai/bge-m3``) MUST be used by the Worker at query time;
    the Worker refuses to mix vectors from a different model.
    """

    def __init__(self, account_id: str, token: str, model: str = "@cf/baai/bge-m3", session: requests.Session | None = None,
                 sleep=time.sleep, max_retries: int = 3):
        self.model = model
        self._url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
        self._token = token
        self._session = session or requests.Session()
        self._sleep = sleep
        self._max_retries = max_retries

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        for attempt in range(self._max_retries + 1):
            res = self._session.post(self._url, json={"text": texts}, headers={"Authorization": f"Bearer {self._token}"}, timeout=60)
            if res.status_code == 429 or res.status_code >= 500:
                if attempt == self._max_retries:
                    res.raise_for_status()
                self._sleep(2**attempt)
                continue
            res.raise_for_status()
            body = res.json()
            data = (body.get("result") or {}).get("data")
            if not data or len(data) != len(texts):
                raise RuntimeError("Workers AI returned an unexpected embedding payload")
            return data
        raise RuntimeError("embedding retries exhausted")
