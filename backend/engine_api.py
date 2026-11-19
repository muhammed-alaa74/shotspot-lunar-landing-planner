"""Pure, cached Python facade for the native TypeScript SHOTSPOT engine.

The subprocess is deliberately a line-oriented worker rather than a server: it
loads the browser engine and data once, then accepts one JSON request per line.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
from typing import Any


_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_WORKER = _ROOT / "backend" / "engine_worker.mjs"


class EngineAPI:
    """Thread-safe, persistent adapter exposing the six deterministic tools."""

    def __init__(self, worker_path: str | os.PathLike[str] | None = None, *, data_dir: str | os.PathLike[str] | None = None, max_cache: int = 128) -> None:
        self.worker_path = Path(worker_path or os.environ.get("SHOTSPOT_ENGINE_WORKER", _DEFAULT_WORKER)).resolve()
        self.data_dir = Path(data_dir).resolve() if data_dir else None
        self.max_cache = max(1, int(max_cache))
        self._process: subprocess.Popen[str] | None = None
        self._lock = threading.RLock()
        self._cache: dict[str, dict[str, Any]] = {}
        self._sequence = 0

    @staticmethod
    def _safe_error(message: Any) -> str:
        text = str(message or "Engine request failed").replace("\r", " ").replace("\n", " ")
        # Do not expose subprocess paths, stack traces, or implementation details.
        text = text.split("Traceback", 1)[0].strip()
        text = " ".join(text.split())
        return text[:500] or "Engine request failed"

    def _start(self) -> subprocess.Popen[str]:
        if not self.worker_path.exists():
            raise ValueError(f"Engine worker is not available: {self._safe_error(self.worker_path.name)}")
        env = os.environ.copy()
        env.pop("GROQ_API_KEY", None)
        if self.data_dir:
            env["SHOTSPOT_DATA_DIR"] = str(self.data_dir)
        try:
            self._process = subprocess.Popen(
                [os.environ.get("NODE_EXECUTABLE", "node"), str(self.worker_path)],
                cwd=str(_ROOT),
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except (OSError, ValueError) as exc:
            self._process = None
            raise ValueError(f"Could not start engine worker: {self._safe_error(exc)}") from None
        return self._process

    def _ensure_started(self) -> subprocess.Popen[str]:
        process = self._process
        if process is None or process.poll() is not None:
            if process is not None:
                self._reap()
            process = self._start()
        return process

    def _reap(self) -> None:
        process, self._process = self._process, None
        if process is None:
            return
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass

    @staticmethod
    def _key(tool: str, args: dict[str, Any], context: dict[str, Any] | None) -> str:
        payload = json.dumps({"tool": tool, "args": args, "context": context}, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _request(self, tool: str, args: dict[str, Any], context: dict[str, Any] | None) -> dict[str, Any]:
        for attempt in range(2):
            process = self._ensure_started()
            try:
                assert process.stdin is not None and process.stdout is not None
                self._sequence += 1
                request = {"id": self._sequence, "tool": tool, "args": args, "context": context}
                process.stdin.write(json.dumps(request, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
                process.stdin.flush()
                line = process.stdout.readline()
                if not line:
                    raise RuntimeError("engine worker closed its output")
                response = json.loads(line)
                if response.get("error") is not None:
                    raise ValueError(self._safe_error(response["error"]))
                result = response.get("result")
                if not isinstance(result, dict):
                    raise RuntimeError("engine worker returned an invalid result")
                return result
            except ValueError:
                raise
            except (BrokenPipeError, OSError, RuntimeError, json.JSONDecodeError) as exc:
                self._reap()
                if attempt == 0:
                    continue
                raise ValueError(f"Engine worker failed: {self._safe_error(exc)}") from None
        raise ValueError("Engine worker failed")

    def call(self, tool: str, args: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call a deterministic engine tool and return an independent result copy."""
        if not isinstance(tool, str) or not tool.strip():
            raise ValueError("tool must be a non-empty string")
        if not isinstance(args, dict):
            raise ValueError("args must be an object")
        if context is not None and not isinstance(context, dict):
            raise ValueError("context must be an object")
        try:
            key = self._key(tool, args, context)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Invalid JSON arguments: {self._safe_error(exc)}") from None
        with self._lock:
            cached = self._cache.get(key)
            if cached is not None:
                return copy.deepcopy(cached)
            result = self._request(tool, args, context)
            # Keep the cache bounded without changing the public result.
            if len(self._cache) >= self.max_cache:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = copy.deepcopy(result)
            return copy.deepcopy(result)

    def close(self) -> None:
        with self._lock:
            self._reap()

    def clear_cache(self) -> None:
        with self._lock:
            self._cache.clear()

    def __enter__(self) -> "EngineAPI":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def __del__(self) -> None:  # pragma: no cover - best-effort interpreter cleanup
        try:
            self.close()
        except Exception:
            pass
