#!/usr/bin/env python3
"""Opt-in live-provider check. Starts a disposable, tool-free pi TUI; requires pi and node."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import uuid

REPO = Path(__file__).resolve().parent.parent


class Harness:
    def __init__(self, terminal):
        self.terminal = terminal
        self.terminal_output = b""
        self.adapter = None
        self.buffer = b""
        self.updates = []
        self.next_id = 0

    def open_adapter(self):
        self.adapter = subprocess.Popen(
            ["node", str(REPO / "dist/cli.js")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.buffer = b""
        self.call("initialize", {"protocolVersion": 1, "clientCapabilities": {}})

    def close_adapter(self):
        if self.adapter is None:
            return
        self.adapter.stdin.close()
        try:
            self.adapter.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.adapter.terminate()
            self.adapter.wait(timeout=5)
        self.adapter = None

    def record(self, message):
        if message.get("method") == "session/update":
            self.updates.append(message["params"]["update"])

    def read(self, deadline):
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if line:
                    message = json.loads(line)
                    self.record(message)
                    return message
            readable, _, _ = select.select([self.terminal, self.adapter.stdout], [], [], 0.1)
            for stream in readable:
                try:
                    chunk = os.read(stream if isinstance(stream, int) else stream.fileno(), 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise RuntimeError("Pi TUI exited") from error
                    raise
                if stream == self.terminal:
                    self.terminal_output += chunk
                    if b"\x1b[6n" in chunk:
                        os.write(self.terminal, b"\x1b[1;1R")
                elif chunk:
                    self.buffer += chunk
                else:
                    raise RuntimeError("ACP adapter exited: " + self.adapter.stderr.read().decode())
        raise TimeoutError("Timed out waiting for ACP/pi; recent TUI output: " + repr(self.terminal_output[-3000:]))

    def call(self, method, params, timeout=90):
        self.next_id += 1
        request_id = self.next_id
        self.adapter.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n").encode())
        self.adapter.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            message = self.read(deadline)
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(json.dumps(message["error"]))
                return message["result"]

    def assistant_text(self, start):
        return "".join(update.get("content", {}).get("text", "") for update in self.updates[start:]
                       if update["sessionUpdate"] == "agent_message_chunk")


def main():
    with tempfile.TemporaryDirectory(prefix="zpl-live-") as cwd:
        pid, terminal = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            args = ["pi", "--no-session", "--no-extensions", "-e", str(REPO / "dist/extension.js"),
                    "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-tools", "--offline",
                    "--thinking", "off", "--name", "zed-pi-live-smoke"]
            if os.environ.get("PI_MODEL") and os.environ.get("PI_PROVIDER"):
                args += ["--provider", os.environ["PI_PROVIDER"], "--model", os.environ["PI_MODEL"]]
            os.execvp(args[0], args)
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
        harness = Harness(terminal)
        try:
            harness.open_adapter()
            deadline = time.monotonic() + 30
            while True:
                sessions = harness.call("session/list", {"cwd": cwd})["sessions"]
                if sessions:
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("Bridge did not start: " + repr(harness.terminal_output[-3000:]))
                time.sleep(0.2)
            assert len(sessions) == 1, sessions
            session_id = sessions[0]["sessionId"]
            assert f"PID {pid}" in sessions[0]["title"]
            harness.call("session/load", {"sessionId": session_id, "cwd": cwd, "mcpServers": []})
            token = "orchard-" + uuid.uuid4().hex[:10]
            start = len(harness.updates)
            result = harness.call("session/prompt", {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": f"Remember verification token {token}. Reply with exactly that token."}],
            })
            assert result["stopReason"] == "end_turn", result
            assert token in harness.assistant_text(start), harness.assistant_text(start)
            assert token.encode() in harness.terminal_output, "Zed-originated interaction not visible in TUI"
            print("PASS: ACP prompt streamed from the existing pi TUI process", flush=True)

            start = len(harness.updates)
            terminal_prompt = "What verification token did I ask you to remember? Reply with only the token."
            os.write(terminal, b"\x1b[200~" + terminal_prompt.encode() + b"\x1b[201~")
            time.sleep(0.1)
            os.write(terminal, b"\r")
            deadline = time.monotonic() + 90
            while token not in harness.assistant_text(start):
                harness.read(deadline)
            assert any(update["sessionUpdate"] == "user_message_chunk" and terminal_prompt in update.get("content", {}).get("text", "")
                       for update in harness.updates[start:]), "Terminal input did not reach ACP"
            print("PASS: terminal continuation recalled ACP-originated context and streamed back", flush=True)

            harness.close_adapter()
            harness.open_adapter()
            deadline = time.monotonic() + 20
            while True:
                try:
                    start = len(harness.updates)
                    harness.call("session/load", {"sessionId": session_id, "cwd": cwd, "mcpServers": []})
                    break
                except RuntimeError as error:
                    if "busy" not in str(error) or time.monotonic() > deadline:
                        raise
                    time.sleep(0.2)
            assert harness.assistant_text(start).count(token) == 2, harness.assistant_text(start)
            print("PASS: reconnect replayed both replies without resubmitting a prompt", flush=True)
        finally:
            harness.close_adapter()
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.1)
            else:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(terminal)


if __name__ == "__main__":
    main()
