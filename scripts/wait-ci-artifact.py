#!/usr/bin/env python3
"""Wait for a same-attempt artifact, stopping on a terminal producer or bounded deadline."""

import argparse
import json
import os
import time
import unittest
from urllib.request import Request, urlopen


def wait_for_artifact(fetch, producer, artifact, timeout, clock=time.monotonic, pause=time.sleep):
    deadline = clock() + timeout
    while True:
        if clock() >= deadline:
            raise RuntimeError(f"{producer}: artifact wait timed out after {timeout:g}s")
        jobs = fetch("jobs")["jobs"]
        matches = [job for job in jobs if job["name"] == producer]
        if len(matches) > 1:
            raise RuntimeError(f"{producer}: ambiguous producer jobs")
        job = matches[0] if matches else None
        if job and job["status"] == "completed" and job["conclusion"] != "success":
            raise RuntimeError(f"{producer}: producer ended {job['conclusion']} without a usable artifact")
        artifacts = fetch("artifacts")["artifacts"]
        ready = [item for item in artifacts if item["name"] == artifact and not item["expired"]]
        if len(ready) == 1:
            return ready[0]["id"]
        if len(ready) > 1:
            raise RuntimeError(f"{producer}: ambiguous artifact {artifact}")
        if job and job["status"] == "completed":
            raise RuntimeError(f"{producer}: producer succeeded without artifact {artifact}")
        remaining = deadline - clock()
        if remaining <= 0:
            raise RuntimeError(f"{producer}: artifact wait timed out after {timeout:g}s")
        pause(min(10, remaining))


def producer_for_attempt(current, history, producer):
    matches = [job for job in current if job["name"] == producer]
    if matches:
        return matches
    if any(job["name"] == "Preflight (checks and dists)" for job in current):
        return [{"name": producer, "status": "queued", "conclusion": None}]
    previous = [job for job in history if job["name"] == producer]
    return [max(previous, key=lambda job: job["id"])] if previous else []


class WaitTests(unittest.TestCase):
    def run_wait(self, status="in_progress", conclusion=None, ready=False, timeout=20):
        now = [0]
        calls = []

        def fetch(kind):
            calls.append(kind)
            if kind == "jobs":
                return {"jobs": [{"name": "producer", "status": status, "conclusion": conclusion}]}
            return {"artifacts": [{"name": "artifact", "expired": False, "id": 7}] if ready else []}

        def pause(seconds):
            now[0] += seconds

        return wait_for_artifact(fetch, "producer", "artifact", timeout, lambda: now[0], pause), now[0], calls

    def test_artifact_ready(self):
        self.assertEqual(self.run_wait(ready=True)[:2], (7, 0))

    def test_producer_failed(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer ended failure"):
            self.run_wait(status="completed", conclusion="failure")

    def test_producer_cancelled(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer ended cancelled"):
            self.run_wait(status="completed", conclusion="cancelled")

    def test_producer_timed_out(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer ended timed_out"):
            self.run_wait(status="completed", conclusion="timed_out")

    def test_success_without_artifact(self):
        with self.assertRaisesRegex(RuntimeError, "producer: producer succeeded without artifact"):
            self.run_wait(status="completed", conclusion="success")

    def test_wait_timeout(self):
        now = [0]
        fetch = lambda kind: {kind: []}
        with self.assertRaisesRegex(RuntimeError, "producer: artifact wait timed out after 23s"):
            wait_for_artifact(fetch, "producer", "artifact", 23, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds))
        self.assertEqual(now[0], 23)

    def test_failed_only_rerun_reuses_the_successful_producers_attempt(self):
        previous = {"id": 1, "name": "producer", "status": "completed", "conclusion": "success", "run_attempt": 1}
        self.assertEqual(producer_for_attempt([], [previous], "producer"), [previous])

    def test_rerun_preflight_prevents_consuming_previous_producer_artifacts(self):
        previous = {"id": 1, "name": "producer", "status": "completed", "conclusion": "success", "run_attempt": 1}
        current = [{"name": "Preflight (checks and dists)"}]
        self.assertEqual(producer_for_attempt(current, [previous], "producer")[0]["status"], "queued")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer", required=True)
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--timeout-minutes", type=float, required=True)
    args = parser.parse_args()
    if not 0 < args.timeout_minutes <= 360:
        parser.error("timeout must be positive and no more than six hours")
    base = os.environ["GITHUB_API_URL"] + "/repos/" + os.environ["GITHUB_REPOSITORY"] + "/actions/runs/" + os.environ["GITHUB_RUN_ID"]
    attempt = os.environ["GITHUB_RUN_ATTEMPT"]
    deadline = time.monotonic() + args.timeout_minutes * 60
    selected_attempt = [attempt]

    def request_page(route):
        request = Request(base + route, headers={
            "Authorization": "Bearer " + os.environ["GH_TOKEN"],
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with urlopen(request, timeout=max(0.001, min(30, deadline - time.monotonic()))) as response:
                result = json.load(response)
        except Exception as error:
            raise RuntimeError(f"{args.producer}: artifact API query failed: {error}") from error
        return result

    def inventory(route, kind):
        first = request_page(route + "per_page=100&page=1")
        items = first[kind]
        for page in range(2, (first["total_count"] + 99) // 100 + 1):
            items.extend(request_page(route + f"per_page=100&page={page}")[kind])
        return items

    def fetch(kind):
        if kind == "jobs":
            current = inventory(f"/attempts/{attempt}/jobs?", "jobs")
            history = []
            if not any(job["name"] in (args.producer, "Preflight (checks and dists)") for job in current):
                history = inventory("/jobs?filter=all&", "jobs")
            matches = producer_for_attempt(current, history, args.producer)
            if matches:
                selected_attempt[0] = str(matches[0].get("run_attempt", attempt))
            return {"jobs": matches}
        expected_name = args.artifact + "-" + selected_attempt[0]
        matches = [item for item in inventory("/artifacts?", "artifacts") if item["name"] == expected_name]
        return {"artifacts": [dict(item, name=args.artifact) for item in matches]}

    print(f"Waiting for {args.producer}: {args.artifact} (at most {args.timeout_minutes:g} minutes)", flush=True)
    artifact_id = wait_for_artifact(fetch, args.producer, args.artifact, args.timeout_minutes * 60)
    print(f"{args.producer}: artifact {artifact_id} ready", flush=True)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"artifact-id={artifact_id}\n")


if __name__ == "__main__":
    if os.sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[os.sys.argv[0]], verbosity=2)
    else:
        try:
            main()
        except Exception as error:
            os.sys.exit(str(error))
