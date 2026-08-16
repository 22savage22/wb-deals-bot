import html
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def run(module_name, func):
    print("== %s ==" % module_name)
    t0 = __import__("time").time()
    try:
        func()
    except AssertionError as exc:
        print("FAIL %s: %s" % (module_name, exc))
        raise
    print("PASS %s (%.1fs)" % (module_name, __import__("time").time() - t0))
    print()


def main():
    run("test_tg", lambda: __import__("test_tg").main())
    run("test_smart", lambda: __import__("test_smart").main())
    run("test_state", lambda: __import__("test_state").main())
    run("test_wb", lambda: __import__("test_wb").main())
    run("test_admin", lambda: __import__("test_admin").main())
    run("test_bot", lambda: __import__("test_bot").main())
    run("test_scanner", lambda: __import__("test_scanner").main())
    run("test_poller", lambda: __import__("test_poller").main())
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
