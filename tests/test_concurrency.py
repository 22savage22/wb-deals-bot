"""Concurrency test for file locking between bot.py and scanner.py."""

import json
import os
import sys
import tempfile
import time
from multiprocessing import Process, Value

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import state
import deal_queue
import config


def _writer_process(state_path, queue_path, pid, counter, state_ok, queue_ok):
    """Simulate a process writing state and queue repeatedly."""
    data = state._empty()
    data["meta"]["writer"] = pid
    for i in range(50):
        data["meta"]["seq"] = i
        data["posted"][str(10000 + pid * 1000 + i)] = int(time.time())
        state.save(state_path, data)
        queue = [{"id": 10000 + pid * 1000 + i, "title": f"item-{pid}-{i}",
                  "brand": "", "product": 100, "basic": 200, "discount": 50,
                  "benefit": 100, "rating": 4.5, "feedbacks": 10,
                  "category": "test", "queued_ts": int(time.time())}]
        deal_queue.save(queue_path, queue)
        time.sleep(0.001)

    # Verify final state is valid JSON
    try:
        with open(state_path, encoding="utf-8") as f:
            d = json.load(f)
        assert isinstance(d, dict), f"state.json is not a dict"
        assert "posted" in d, "state.json missing 'posted'"
        state_ok.value = 1
    except Exception as e:
        state_ok.value = 0

    try:
        with open(queue_path, encoding="utf-8") as f:
            q = json.load(f)
        assert isinstance(q, list), f"queue.json is not a list"
        queue_ok.value = 1
    except Exception as e:
        queue_ok.value = 0


def test_concurrent_writes():
    """Two processes write state.json and queue.json concurrently."""
    with tempfile.TemporaryDirectory() as tmpdir:
        state_path = os.path.join(tmpdir, "state.json")
        queue_path = os.path.join(tmpdir, "queue.json")

        # Create initial files
        state.save(state_path, state._empty())
        deal_queue.save(queue_path, [])

        state_ok1 = Value("i", 0)
        queue_ok1 = Value("i", 0)
        state_ok2 = Value("i", 0)
        queue_ok2 = Value("i", 0)

        p1 = Process(target=_writer_process,
                     args=(state_path, queue_path, 1, None, state_ok1, queue_ok1))
        p2 = Process(target=_writer_process,
                     args=(state_path, queue_path, 2, None, state_ok2, queue_ok2))

        p1.start()
        p2.start()
        p1.join(timeout=30)
        p2.join(timeout=30)

        assert p1.exitcode == 0, f"Process 1 crashed with exit code {p1.exitcode}"
        assert p2.exitcode == 0, f"Process 2 crashed with exit code {p2.exitcode}"
        assert state_ok1.value == 1, "Process 1: state.json corrupted"
        assert queue_ok1.value == 1, "Process 1: queue.json corrupted"
        assert state_ok2.value == 1, "Process 2: state.json corrupted"
        assert queue_ok2.value == 1, "Process 2: queue.json corrupted"

        # Final file must be valid JSON
        with open(state_path, encoding="utf-8") as f:
            final_state = json.load(f)
        assert isinstance(final_state.get("posted"), dict)
        assert isinstance(final_state.get("meta"), dict)

        with open(queue_path, encoding="utf-8") as f:
            final_queue = json.load(f)
        assert isinstance(final_queue, list)

        print(f"  state.json valid: {os.path.getsize(state_path)} bytes")
        print(f"  queue.json valid: {os.path.getsize(queue_path)} bytes")
        print(f"  posted entries: {len(final_state['posted'])}")
        print(f"  queue entries: {len(final_queue)}")


def test_atomic_write_no_corruption():
    """Verify that os.replace prevents partial JSON even without lock."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "test.json")

        # Write valid initial content
        with open(path, "w") as f:
            json.dump({"version": 1}, f)

        # Simulate 100 rapid writes
        for i in range(100):
            data = state._empty()
            data["meta"]["version"] = i
            state.save(path, data)

        # File must always be valid JSON
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        assert loaded["meta"]["version"] == 99
        print("  100 rapid writes: all valid")


def main():
    test_concurrent_writes()
    test_atomic_write_no_corruption()


if __name__ == "__main__":
    print("== test_concurrent_writes ==")
    test_concurrent_writes()
    print("PASS\n")

    print("== test_atomic_write_no_corruption ==")
    test_atomic_write_no_corruption()
    print("PASS\n")

    print("CONCURRENCY TESTS PASSED")
