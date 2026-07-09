# SageTV V9 Plugin Dev-Mode

Practical facts about `devmode` plugin loading in stock upstream
[`google/sagetv`](https://github.com/google/SageTV) (SageTV V9). None of this is
PWA-specific — it applies to any SageTV plugin.

Source of truth: `java/sage/plugin/CorePluginManager.java` in the upstream
tree. Line numbers below reference the current upstream `master`.

---

## Enabling dev mode

Set in `Sage.properties`:

```
devmode=true
```

`CorePluginManager.isDevMode()` reads this on every plugin-repo refresh.

---

## Two dev catalog locations — very different behavior

| Path | Reader class | Read when | Overrides applied |
|---|---|---|---|
| `SageTV/SageTVPluginsDev.xml` | `RepoSAXHandler` (default) | Always (devmode or not) | **None** — XML values used verbatim |
| `SageTV/SageTVPluginsDev.d/*.xml` | `DevRepoSAXHandler` | Only when `devmode=true` | `<Location>` → rewritten to `file://…/SageTVPluginsDev.d/<basename>` if the referenced local file exists; `<MD5>` → recomputed from that local file; `<Version>` → **appended with `.yyMMddHHmm` (current wall time at parse)** so every refresh looks like a new build |

`DevRepoSAXHandler.canHandleFile()` (line ~3423) matches only when the XML's
parent directory name is exactly `SageTVPluginsDev.d`.

The `.d/` mechanism was designed for "continuous push": drop a new zip with
the same name, and Sage auto-detects. The comment in-source even says
*"LIMITATION: can only update once a minute :)"*.

---

## The `.d/` overflow bug (unfixed upstream since 2022)

`CorePluginManager.compareVersions(String, String)` (line ~2934) splits each
version by `.` and calls `Integer.parseInt(component)` — with **no try/catch**.

For a year `yy >= 22`, `yyMMddHHmm` becomes a 10-digit number greater than
`Integer.MAX_VALUE` (2,147,483,647). Example: `2607091120` (July 9, 2026 11:20).

Result:

```
java.lang.NumberFormatException: For input string: "2607091120"
  at sage.plugin.CorePluginManager.compareVersions(...)
  at sage.plugin.CorePluginManager.postMessagesForAvailableUpdates(...)
  at sage.plugin.CorePluginManager.refreshAvailablePlugins(...)
```

Observable symptoms:

- "Update available" indicator never clears.
- Sage prints the stack trace every plugin-repo refresh (~ every 30 s).
- Whether the UI's **Update** button actually installs is code-path dependent
  — the notification path definitely fails; some install paths may proceed.

**Workaround: don't use `SageTVPluginsDev.d/`.** Put your dev catalog in the
single-file `SageTV/SageTVPluginsDev.xml` instead. That file is read by the
plain `RepoSAXHandler` with no overrides, so the version stays exactly what
you write in `<Version>`. You lose auto-detect-by-mtime; you gain reliable
version compares.

If you still want per-build auto-refresh: script your deploy to bump
`<Version>` with an int-safe suffix (e.g. `MMddHHmm` — 8 digits max
`12312359` — fits well under `INT_MAX` and works forever) and rewrite the
XML each build.

---

## Version comparison rules (`compareVersions`)

- Component-wise `int` compare via `Integer.parseInt`.
- **Shorter version is smaller**: `1.0.0` < `1.0.0.1`. Appending a component
  makes the version "newer".
- Any non-integer or overflowing component → `NumberFormatException` (fatal,
  bubbled up).

So valid version strings for stock SageTV are strictly
`digitsSSSS.digitsSSSS.digitsSSSS[.digitsSSSS…]` where each `digitsSSSS`
fits in a 32-bit signed int.

---

## Standard plugin install flow (`<PluginType>Standard</PluginType>`)

1. Catalog XML parsed on startup and on periodic refresh.
2. If catalog version > installed version → offered as an update.
3. On install:
   - Zip downloaded from `<Location>` (HTTP or `file://`).
   - MD5 verified against `<MD5>` (or auto-computed for `.d/` entries).
   - Unzipped by `<PackageType>`:
     | PackageType | Extracted to |
     |---|---|
     | `JAR` | `SageTV/JARs/` |
     | `System` | `SageTV/` root (respects `<ResourcePath>` for subfolder layout) |
     | `STV` | `SageTV/STVs/` |
     | `STVI` | `SageTV/STVs/<current-stv>/STVIs/` |
4. `<ImplementationClass>.start()` invoked (Standard plugins only).
5. Install recorded under `sagetv_core_plugins/<id>/*` in `Sage.properties`.

---

## Classpath duplication trap

Sage runs with `-cp Sage.jar:JARs/*`. Everything matching the wildcard is
on the classpath. If you drop `myplugin-v2.jar` next to an existing
`myplugin-v1.jar`, both are visible and the JVM's URLClassLoader picks
whichever the directory scan finds first (undefined order — often
alphabetical or inode order, but **not** guaranteed).

Always move the old jar aside before dropping the new one. A `.prev-<ts>`
suffix is safe because the `JARs/*` glob does not match it. Example:

```bash
mv /opt/sagetv/server/JARs/myplugin-1.0.0.jar \
   /opt/sagetv/server/JARs/myplugin-1.0.0.jar.prev-$(date +%Y%m%d-%H%M%S)
cp /tmp/myplugin-1.0.1.jar /opt/sagetv/server/JARs/
```

---

## Class hot-reload does not work

The JVM caches class definitions in the boot classloader (and in whatever
`URLClassLoader` Sage's plugin manager gives out). Even if Sage's plugin
manager cleanly calls `stop()` on the old plugin instance, disposes the
classloader, and instantiates from a "new" classloader, the class *bytes*
already loaded stay loaded.

**A Java jar change requires a full Sage JVM restart to take effect.**
There is no combination of Plugin Manager → Update clicks that avoids this.

Static resources *served by* a plugin (JS / CSS / HTML / images) may be
re-read from disk on each HTTP request — that depends entirely on the
plugin's own serving code (e.g. Jetty `ResourceHandler` vs. classpath
resource loading). If your plugin serves web assets from a filesystem
directory, browser-side JS/CSS changes take effect on next fetch without
a restart. If it serves them via `getClass().getResource(...)` from inside
the jar, changes require a restart too.

---

## `Sage.properties` plugin state is Sage-owned

These keys are **written by Sage itself** during install/uninstall/enable
operations:

```
sagetv_core_plugins/<id>/version
sagetv_core_plugins/<id>/installdate
sagetv_core_plugins/<id>/installindex
sagetv_core_plugins/<id>/enabled
sagetv_core_plugins/<id>/impl
sagetv_core_plugins/<id>/name
sagetv_core_plugins/<id>/type
sagetv_core_plugins/<id>/desc
… (and other metadata copied from the catalog XML)
plugin/hidden/<id>
```

Do NOT hand-edit these. Any manual value gets clobbered on the next plugin
operation, and mismatched state between these keys and the actual jar on
disk causes install/upgrade to skip silently.

Your plugin's **own** properties (typically namespaced under the plugin id,
e.g. `myplugin/port=8099`) come from `<Property>` tags in the plugin XML and
are fine to edit at runtime through the Plugin Manager UI.

---

## Recommended dev workflow (works around all the bugs above)

1. Build your jar.
2. Zip it: `mkdir -p work && cp myplugin-<ver>.jar work/ && (cd work && zip -q ../myplugin-jar-<ver>.zip *)`.
3. Move any older `myplugin-*.jar` in `SageTV/JARs/` aside with a `.prev-*` suffix.
4. Copy zip to `SageTV/SageTVPluginsDev.xml`'s referenced location (typically a project-owned
   dev-drop directory, NOT `SageTVPluginsDev.d/`).
5. Rewrite `SageTV/SageTVPluginsDev.xml` with the new `<Version>` (bump every
   build), `<Location>` (file:// URL to your zip), and `<MD5>`
   (`md5sum` of the zip).
6. Restart Sage. The Plugin Manager will detect the version bump, install
   from the zip, and record fresh `sagetv_core_plugins/<id>/*` state.
7. Verify: `sagetv_core_plugins/<id>/version` in `Sage.properties` now
   equals the version you wrote in the XML.

For a browser client with a service-worker cache, also bump your SW cache
name so old clients invalidate their cached JS.

---

## Fast-path: single-shot deploy without Plugin Manager

If you don't need the Plugin Manager to know about the change (e.g. you're
iterating rapidly and Sage's install machinery is overhead):

```bash
/opt/sagetv/server/stopsage
mv /opt/sagetv/server/JARs/myplugin-<ver>.jar \
   /opt/sagetv/server/JARs/myplugin-<ver>.jar.prev-$(date +%Y%m%d-%H%M%S)
cp /tmp/myplugin-<new-ver>.jar /opt/sagetv/server/JARs/
/opt/sagetv/server/startsage
```

`sagetv_core_plugins/<id>/version` will still show the old version until
you also update through the Plugin Manager, but the actual running code
comes from whatever jar is on the classpath at JVM start. This is fine
for personal dev but drifts the state → forget to do a Plugin Manager
install eventually and you'll be surprised what an "official" install
reverts to. Use sparingly.
