#!/bin/bash
# Wrapper invoked by the browser as the native messaging host.
# Using an explicit python3 path avoids shebang resolution failures in the
# browser's restricted launch environment on macOS.
exec /usr/bin/python3 "$(dirname "$0")/host.py"
