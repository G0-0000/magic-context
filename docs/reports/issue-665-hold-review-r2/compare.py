#!/usr/bin/env python3
"""Compare the per-pass traces written by differential.sh.

For every trace file present in both <out>/head and <out>/base, report the
passes whose served bytes, pending-operation count, tag statuses or refusal
differ, with the events that pass carried."""
import json
import os
import re
import sys

out = sys.argv[1]
fields = ("hash", "pending", "tags", "refused", "pair")
total_unheld = 0
# A "root" divergence is a diverged pass whose previous pass matched: the pass
# where the two builds first part ways. Its events name the likely cause.
root_causes = {}
for name in sorted(os.listdir(os.path.join(out, "head"))):
    if not name.startswith("trace."):
        continue
    base_path = os.path.join(out, "base", name)
    if not os.path.exists(base_path):
        print(f"{name}: no base trace")
        continue
    head = [json.loads(line) for line in open(os.path.join(out, "head", name))]
    base = [json.loads(line) for line in open(base_path)]
    diverged = []
    for h, b in zip(head, base):
        changed = [f for f in fields if h.get(f) != b.get(f)]
        if changed:
            diverged.append((h, b, changed))
    unheld = "unheld" in name
    if unheld:
        total_unheld += len(head)
        diverged_passes = {h["pass"] for h, _, _ in diverged}
        for h, _, _ in diverged:
            if h["pass"] - 1 not in diverged_passes:
                key = " ".join(sorted(set(h["events"]) & {"idle-expiry", "first-render", "carried-repair", "carried-pending", "no-lkg", "restart", "flush", "history-refresh", "directory-fallback", "compartment"})) or "(none)"
                root_causes.setdefault(name.split("-")[0].replace("trace.", ""), {}).setdefault(key, 0)
                root_causes[name.split("-")[0].replace("trace.", "")][key] += 1
    print(f"{name}: {len(head)} passes (base {len(base)}), {len(diverged)} diverged")
    for h, b, changed in diverged[:12]:
        print(
            f"  pass {h['pass']} events={h['events']} unavoidable={h['unavoidable']} "
            f"changed={changed} head(pending={h['pending']},before={h.get('pendingBefore')}) "
            f"base(pending={b['pending']},before={b.get('pendingBefore')})"
        )
    if len(diverged) > 12:
        print(f"  ... {len(diverged) - 12} more")
print(f"unheld passes compared: {total_unheld}")
for host, causes in sorted(root_causes.items()):
    print(f"unheld root divergences on {host}: " + ", ".join(f"{k}={v}" for k, v in sorted(causes.items(), key=lambda kv: -kv[1])))
for label in ("head", "base"):
    for log in ("pi.log", "opencode.log"):
        path = os.path.join(out, label, log)
        if not os.path.exists(path):
            continue
        text = open(path).read()
        strict = len(re.findall(r"strict-binding", text))
        held = len(re.findall(r"held-prefix-changed", text))
        refusals = len(re.findall(r"\brefusal\b", text))
        rerender = len(re.findall(r"m0m1-rerendered", text))
        folded = len(re.findall(r"m0m1-folded", text))
        summary = re.findall(r"^\s*\d+ (?:pass|fail)$", text, re.M)
        print(f"{label}/{log}: strict-binding={strict} held-prefix-changed={held} refusal={refusals} m0m1-rerendered={rerender} m0m1-folded={folded} {' '.join(s.strip() for s in summary)}")
