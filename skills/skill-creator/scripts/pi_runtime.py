"""Pi JSON CLI backend for the Anthropic skill-creator scripts.

Added by Datalab Kit for Pi; upstream source pinned at
anthropics/skills dbd4588f9e1033efb41dad4bef2f7947c8993d44 (Apache-2.0).
"""

import json
import os
import selectors
import signal
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path


def pi_command(model: str | None = None) -> list[str]:
    """Use the host Pi installation without importing package-local Node modules."""
    # Keep configured extensions: they may register the selected model provider.
    # Discovery isolation concerns skills/context, not the user's credentials.
    command = [
        os.environ.get("PI_EXECUTABLE_PATH") or "pi",
        "--print", "--mode", "json", "--no-session",
        "--no-skills", "--no-prompt-templates", "--no-themes",
        "--no-context-files", "--no-approve",
        # Empty explicit sources suppress global SYSTEM.md/APPEND_SYSTEM.md
        # discovery while retaining Pi's built-in system prompt.
        "--system-prompt", "", "--append-system-prompt", "",
    ]
    if model:
        command.extend(["--model", model])
    return command


@contextmanager
def interrupt_on_termination():
    """Give CLI SIGTERM the same resource cleanup guarantees as Ctrl-C."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def _stop_process(process: subprocess.Popen) -> None:
    """Reap Pi and terminate its subprocess group, including tool children."""
    if os.name == "posix":
        # Also kill descendants if the group leader has already exited.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif process.poll() is None:
        process.kill()
    process.wait()


def run_pi(
    prompt: str,
    model: str | None,
    timeout: int,
    cwd: Path,
    options: list[str],
    on_event=None,
    cancel: threading.Event | None = None,
) -> str:
    """Run one fresh Pi session, optionally stopping at a decisive tool event.

    An on_event callback returning True marks an intentional early completion.
    Otherwise a valid agent_end, successful process exit and non-error assistant
    messages are required. Provider failures can exit zero in Pi JSON mode.
    """
    command = pi_command(model) + options
    # A file-backed stdin avoids argument-size limits and pipe write deadlocks.
    with tempfile.TemporaryFile() as stdin, tempfile.TemporaryFile() as stderr:
        stdin.write(prompt.encode("utf-8"))
        stdin.seek(0)
        process = subprocess.Popen(
            command, stdin=stdin, stdout=subprocess.PIPE, stderr=stderr,
            cwd=cwd, start_new_session=(os.name == "posix"),
        )
        deadline = time.monotonic() + timeout
        text = []
        ended = False
        assistant_seen = False
        buffer = b""

        def consume(line):
            nonlocal ended, assistant_seen
            if not line.strip():
                return False
            try:
                event = json.loads(line)
            except (ValueError, UnicodeDecodeError) as error:
                raise RuntimeError("Pi emitted invalid JSON on stdout") from error
            if not isinstance(event, dict):
                raise RuntimeError("Pi emitted a non-object JSON event")
            if event.get("type") == "message_end":
                message = event.get("message", {})
                if message.get("role") == "assistant":
                    assistant_seen = True
                    if message.get("stopReason") in ("error", "aborted"):
                        raise RuntimeError(f"Pi model failed: {message.get('errorMessage') or message['stopReason']}")
                    text.extend(block["text"] for block in message.get("content", []) if block.get("type") == "text")
            if event.get("type") == "agent_end":
                ended = True
            return bool(on_event and on_event(event))

        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    if cancel is not None and cancel.is_set():
                        raise RuntimeError("Pi evaluation cancelled")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f"Pi did not complete within {timeout} seconds")
                    if not selector.select(min(remaining, 0.1)):
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        if buffer and consume(buffer):
                            return "".join(text)
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if consume(line):
                            return "".join(text)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"Pi did not complete within {timeout} seconds")
            try:
                returncode = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as error:
                raise TimeoutError(f"Pi did not complete within {timeout} seconds") from error
            if returncode != 0:
                raise RuntimeError(f"Pi exited {returncode}")
            if not ended or not assistant_seen:
                raise RuntimeError("Pi exited without a complete assistant session")
            return "".join(text)
        except Exception as error:
            stderr.seek(0)
            diagnostic = stderr.read().decode("utf-8", errors="replace").strip()
            if diagnostic:
                raise RuntimeError(f"{error}\nPi stderr: {diagnostic}") from error
            raise
        finally:
            _stop_process(process)
            process.stdout.close()


def call_pi(prompt: str, model: str | None, timeout: int = 300) -> str:
    """Generate text without tools, skill discovery or writes in the package."""
    with tempfile.TemporaryDirectory(prefix="pi-skill-description-") as workdir:
        response = run_pi(prompt, model, timeout, Path(workdir), ["--no-tools"])
    if not response.strip():
        raise RuntimeError("Pi returned no description text")
    return response
