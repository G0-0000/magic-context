---
title: Troubleshooting
description: Common failure modes and how to fix them, organized by symptom.
---

Start with the doctor command — it covers most common issues automatically:

```bash
npx @cortexkit/magic-context@latest doctor
```

Add `--force` to auto-fix what it can. Add `--issue` to generate a sanitized bug report.

---

## Plugin not loading

**Symptom:** The TUI sidebar doesn't appear in OpenCode, `/ctx-status` returns an unknown command, or the Pi/OMP footer shows no Magic Context status.

**Fix — try in order:**

1. **Restart the harness.** After installation, restart OpenCode or Pi; in OMP, restart or run `/reload-plugins`.

2. **Run doctor.** Doctor verifies the plugin entry in your config, checks for version mismatches, and confirms the plugin package is present:
   ```bash
   npx @cortexkit/magic-context@latest doctor --force
   ```
   `--force` clears stale npm plugin caches that sometimes prevent the latest version from loading.

3. **Check for version pin conflicts.** If your `opencode.json` or npm config pins the plugin to an older version, the new package may not load. Remove explicit version pins and let `@latest` resolve.

4. **`.npmrc` `min-release-age` setting.** Some `.npmrc` configurations set a minimum release age before packages are treated as stable. If you have `prefer-stable` or `min-release-age` set, the latest Magic Context release may not be available to `npx`. Try running `npx --yes @cortexkit/magic-context@latest setup` to bypass the cache, or clear npm's download cache with `npm cache clean --force`.

---

## Doctor finds more than one installation

The doctor reports every detected OpenCode installation in a table with an `[active]` marker, path, version, and source. The first entry is the active path (PATH is checked first). If both harnesses are installed, use `--harness opencode` or `--harness pi` to select which doctor to run without a prompt.

```bash
npx @cortexkit/magic-context@latest doctor --harness opencode
```

---

## Merge split project identities

If the same project has memories under two project identities, preview a merge before changing the shared database:

```bash
npx @cortexkit/magic-context@latest doctor merge-identity \
  --from <source-id> --to <target-id> --dry-run
```

The preview lists the project-scoped tables and rows that would be considered. A write requires an explicit confirmation flag:

```bash
npx @cortexkit/magic-context@latest doctor merge-identity \
  --from <source-id> --to <target-id> --yes
```

Without `--dry-run` or `--yes`, the command refuses to mutate `context.db`.

---

## Storage unavailable / schema fence error

**Symptom:** After downgrading the plugin, you see a message like "schema fence: database was written by a newer version" or "Magic Context disabled itself — storage unavailable." Magic Context refuses to start.

**Why it happens:** The shared database has been migrated to a newer schema by a higher version of the plugin. Older plugin versions cannot safely open a database created by a newer one, so they fail closed (fail-safe).

**Fix:** Upgrade the plugin back to the version that last wrote the database (or a newer one):
```bash
npx @cortexkit/magic-context@latest setup
```

If you need to downgrade intentionally, run `doctor --force` afterward — it will report whether the schema is compatible. If not, the only option is to delete the database (`~/.local/share/cortexkit/magic-context/context.db`) and start fresh. **This deletes all memories and compartments** — back up first if you want to preserve anything.

---

## Historian failures

**Symptom:** You see a recurring warning about the historian failing, or the historian progress in `/ctx-status` shows repeated retries.

**Why it happens:** The historian runs as a background agent with model selection separate from the main coding model. Transient provider failures can retry, but an unavailable primary model and unavailable configured fallbacks prevent new compartments.

**Fix:**

1. Check the harness-specific model in `magic-context.jsonc`: `historian.opencode.model` for OpenCode or `historian.pi.model` for Pi.
2. Run `doctor` to inspect the active configuration and reported provider errors.
3. Add ordered alternatives under the matching harness block's `fallback_models`. Magic Context does not add a hidden provider-agnostic fallback list; after your explicit list, the live session model is the last resort.
4. If runs succeed but compartments are confusing, choose a stronger historian model. Summary quality comes from the historian model, not the main model. See [Historian → Choose the historian model](/concepts/historian/#choose-the-historian-model).

---

## Context stuck high

**Symptom:** Context usage stays near or above the execution threshold even after several turns. Historian seems to be running but the percentage doesn't drop.

**Fix — try in order:**

1. **Check `/ctx-status`.** Separate compartment history, protected recent work, queued drops, and reclaimable tool output. A historian run only shrinks settled conversation; its compartments remain in the prompt.

2. **Let eligible reclaim land.** Queued `ctx_reduce` work and automatic age-based reclaim apply on a pass that is already rebuilding the cache. Automatic reclaim never starts that rewrite by itself.

3. **Force a flush only when needed.** `/ctx-flush` explicitly applies queued operations. It invalidates the current cached prefix, so use it when immediate space matters more than preserving that cache.

4. **Rebuild compartments only if state is wrong.** `/ctx-recomp` rebuilds compartments from raw history. A long session can require several historian calls.

5. **Check the relevant budget.** `history_budget_percentage` controls retained compartment history, while `protected_tokens` controls recent token mass protected from normal reclaim. Use the [generated configuration reference](/reference/configuration/#context-management) for exact defaults and ranges.

The [worked percentage examples](/concepts/how-it-works/#work-through-the-numbers) explain why crossing a threshold does not imply a target landing size.

---

## Desktop app: first-launch network request

**Symptom:** On first launch, the Magic Context Desktop app makes a network request or seems slow to start.

**Why it happens:** The local embedding model (`Xenova/all-MiniLM-L6-v2`, ~90 MB) is downloaded on first use when `embedding.provider` is `"local"` (the default). This is a one-time download; subsequent launches use the cached model at `~/.local/share/cortexkit/magic-context/models/`.

**Fix:** If you want to avoid this download, set `embedding.provider: "off"` in your config (full-text search still works) or point it at a remote endpoint. See the [configuration reference](/reference/configuration/) for embedding options.

---

## Desktop app: blank window on Linux / WSL2

**Symptom:** The Magic Context Desktop app opens to a blank window (only the top menu, no content), often with `Could not create default EGL display: EGL_BAD_PARAMETER` in the terminal. Most common on non-Ubuntu Linux distributions and under WSL2.

**Why it happens:** The app's embedded WebView (WebKitGTK) cannot create a graphics surface against your host's driver stack. The bundled WebKitGTK is built for one environment and does not always match another distribution's Mesa/driver versions. Environment-variable workarounds (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, etc.) usually do not help for this class.

**Fix:** Run the dashboard in **browser mode** instead of as a desktop window. The same binary, started with `--serve`, runs a local web server you open in your normal browser, so no embedded WebView is created:

```sh
magic-context-dashboard --serve
```

It prints a URL with a one-time token; open it in your browser (under WSL2, open it in your Windows browser via `localhost`). See [Browser mode (`--serve`)](/reference/dashboard/#browser-mode---serve) for per-OS invocations and options.

A native package using your system's own WebKitGTK (the `.deb` or `.rpm` rather than the `.AppImage`) can also resolve it on some distributions.

---

## Filing a bug report

Run:
```bash
npx @cortexkit/magic-context@latest doctor --issue
```

This auto-bundles redacted logs, config (with secrets stripped), and diagnostic output into a ready-to-file report. Paste the output into a GitHub issue at [github.com/cortexkit/magic-context](https://github.com/cortexkit/magic-context/issues).
