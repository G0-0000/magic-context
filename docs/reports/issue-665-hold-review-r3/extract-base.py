#!/usr/bin/env python3
"""Extract master 24ebef59's versions of the seven modified production files.

These are the files differing between that master and the reviewed hold revision.
Use an explicit new output directory, never a checkout root or source directory.
This reads Git objects, never another working tree.
"""
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get("MC_665_R3") != "1":
    print("skipped: set MC_665_R3=1 to extract the review baseline")
    sys.exit(0)
base = "24ebef59e11a61a0317aafe53ce16c73451b7439"
paths = [
    "packages/pi-plugin/src/context-handler.ts",
    "packages/pi-plugin/src/pi-tag-identity-repair.ts",
    "packages/pi-plugin/src/provider-error-recovery-pi.ts",
    "packages/plugin/src/features/magic-context/pi-content-decisions.ts",
    "packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts",
    "packages/plugin/src/hooks/magic-context/transform.ts",
    "packages/plugin/src/v2/hooks/context.ts",
]
out = Path(sys.argv[1])
if out.exists():
    sys.exit("refusing to overwrite an existing baseline directory")
for p in paths:
    data = subprocess.check_output(["git", "show", f"{base}:{p}"])
    dest = out / p
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
(out / "base-files.txt").write_text("\n".join(paths) + "\n")
print(f"Extracted {len(paths)} production files from {base}")
