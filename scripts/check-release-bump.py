#!/usr/bin/env python3
"""Keep a CI-certified release tree unchanged except for versions and public notes."""

import argparse
import json
import subprocess
import sys

MANIFESTS = {f"packages/{package}/package.json" for package in ("plugin", "pi-plugin", "cli")}


def git(*args):
    return subprocess.check_output(["git", *args])


def check_bump(base, version, staged):
    target = ":" if staged else "HEAD:"
    notes = {"CHANGELOG.md", f".cortexkit/release-notes/v{version}.md"}
    diff_args = ["--cached"] if staged else []
    targets = [] if staged else ["HEAD"]
    paths = git("diff", *diff_args, "--name-only", "-z", base, *targets, "--").decode().split("\0")
    for path in filter(None, paths):
        if path not in MANIFESTS | notes:
            raise RuntimeError(f"CI reuse refuses non-version/notes change: {path}")
        if path in MANIFESTS:
            before = json.loads(git("show", f"{base}:{path}"))
            after = json.loads(git("show", f"{target}{path}"))
            if after.get("version") != version:
                raise RuntimeError(f"Release version mismatch: {path}")
            before.pop("version", None)
            after.pop("version", None)
            if before != after:
                raise RuntimeError(f"CI reuse refuses non-version manifest change: {path}")
        # Even a version-only edit must not change an executable bit or add a symlink.
        mode = git("ls-files", "--stage", "--", path).decode().split()[0] if staged else git("ls-tree", "HEAD", "--", path).decode().split()[0]
        if mode != "100644":
            raise RuntimeError(f"CI reuse refuses file mode change: {path}")
    if not staged:
        commits = git("rev-list", f"{base}..HEAD").decode().splitlines()
        if commits and (len(commits) != 1 or git("rev-parse", "HEAD^").decode().strip() != base):
            raise RuntimeError("CI reuse requires a single version/notes bump on the certified commit")
    print("Release bump contains only versions and public notes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base")
    parser.add_argument("version")
    parser.add_argument("--staged", action="store_true")
    args = parser.parse_args()
    check_bump(args.base, args.version, args.staged)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, IndexError, subprocess.SubprocessError) as error:
        sys.exit(f"release-bump: {error}")
