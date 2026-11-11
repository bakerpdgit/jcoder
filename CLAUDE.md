# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

A browser-based Java IDE: `.java` compiled and executed entirely client-side by
OpenJDK's `javac` and TeaVM, both of which are themselves WebAssembly. See
README.md for the architecture; this file covers the things that are easy to get
wrong.

## Development

```
npm run dev              # Vite dev server on :3000 with HMR
npm run build            # tsc -b && vite build → dist/
npm start                # serve dist/ via server.mjs
npm run fetch:runtime    # download public/teavm/ (no JDK needed)
```

`public/teavm/` **is** in git (see below) and is **not** produced by
`npm run build`. Were it missing, the app would still load and edit fine but Run
would report the bundle absent — a path covered by an e2e test, so keep it
working.

## Testing

```
npm test          # Vitest (jsdom)
npm run test:e2e  # Playwright against the built app
```

When driving the app with Playwright, capture the browser console
(`page.on('console')` for errors and `page.on('pageerror')`) rather than
relying on screenshots.

## Things that will bite you

### The compiler cannot be reused after generating WebAssembly

`Compiler.generateWebAssembly()` leaves its instance unusable: the *next*
`compile()` on it overflows the stack. Repeated `compile()` calls on their own
are fine — it is generating that spoils it. So `Toolchain.createSession()` makes
a **fresh compiler for every run**, which costs about 150ms because the two
class libraries are already in memory.

This was a real bug: the first run worked and every run after it failed with
"Maximum call stack size exceeded". Do not "optimise" the session away.

### Annotations with arguments used to crash javac

Older builds of javac had `AnnotationProxyMaker` stubbed out, so
`java.lang.annotation.Annotation` resolved cyclically and any annotation taking
arguments — or any `@interface` declaration — recursed until the stack
overflowed. teavm-javac 76b5b53 fixed the compile class library so javac reads
annotations properly, and `smoke.spec.ts` now compiles and runs an
`@interface Marker { String value(); }` to prove the bundle still has that fix.

What is left of the machinery built around the old behaviour:

* `javacCrashMessage` still explains a stack overflow if one happens anyway.
  The `@SuppressWarnings` strip that sat beside it is gone.
* **The injected `Scanner` does not use `@JSBody`**, which is why the input
  bridge looks the way it does. That is now a choice rather than a constraint —
  but the bridge works, and rewriting it would be a large change for no
  behaviour the student sees. `javaSupport.test.ts` asserts that
  `SCANNER_SOURCE` contains no annotation with brackets; keep that test until
  the bridge itself is reconsidered.

### The input bridge rides on two existing imports

Because no new import can be declared (see above), the injected `Scanner`
reaches JavaScript through imports the generated module already has:

* writing `REQUEST_CHAR` (U+0001) to `System.err` asks for a line — the host
  swallows that character and **blocks** there until one is available;
* `System.currentTimeMillis()` then returns the line's characters one at a time,
  followed by `END_OF_LINE`, and goes back to being a clock afterwards.

Both halves are generated from the constants in `utils/javaSupport.ts`.
`javaPipeline.test.ts` keeps a literal transcription of the Java loop and runs
it against the real `InputBridge`, which is the only way the two languages get
checked against each other — if you change the Java, change that transcription.

### javac and TeaVM used to disagree about `@Rename`d methods

TeaVM declares `Throwable.getMessage` as `getMessage0` with a `@Rename`
annotation and applies the rename in its *own* compiler. Older javac SDKs were
generated without applying it, so javac saw only `getMessage0` while TeaVM
linked only `getMessage` — neither spelling compiled and ran, and the same went
for `getClass`, `getCause` and `getLocalizedMessage`.

teavm-javac 199bed0c applies the rename when converting the class library, and
all four now resolve. `smoke.spec.ts` calls every one of them against the real
toolchain, which is what licenses the deletion of the `JCoderErr` rewrite that
used to stand in for `getMessage` — and of the `explainDiagnostic` branch that
apologised for the other three.

### Files are emulated, because none of the real APIs work

`java.nio.file` compiles and then makes TeaVM report "@JSByRef … not supported";
`FileReader`/`FileWriter` fail on a missing `java.io.FileDescriptor`; and
`java.io.File` compiles, runs, and silently finds nothing, because the API that
mounts a TeaVM virtual filesystem is not exposed to javac.

So `utils/javaFileSystem.ts` injects unnamed-package `File`, `Files`, `Path`,
`Paths`, `FileReader`, `FileWriter`, `PrintWriter`, `FileInputStream` and
`FileOutputStream` that shadow the `java.*` ones, exactly as the `Scanner`
does, and `SHADOWED_IMPORTS` neutralises the single-type imports that would
outrank them. They talk to `FileBridge`, which holds a snapshot of the editor's
files for the run; `onFilesChanged` writes back what changed once it ends.

`FileBridge` stores **bytes**, not text: the channel carries any UTF-16 code
unit unaltered (measured — a byte in 0…255 arrives as itself, one call per
character), so binary files ride the same wire as text with one character per
byte. Text reads and writes encode and decode UTF-8 at the edge. Do not
"simplify" the bridge back to strings; binary exercises depend on this.

The transport is not a bottleneck — about 14 million characters a second each
way — so `MAX_MOUNTED_FILE_BYTES` exists for memory, not speed. Oversized files
are skipped rather than truncated, because truncated data reads as corruption.

Injecting them unconditionally costs ~100ms of javac and nothing in the output,
because TeaVM drops unused classes — measured, not assumed. Do not add
cleverness to skip it.

`planCompilation` switches file support off entirely if a student declares a
class of the same name (a maze exercise with its own `Path` is not far-fetched)
and reports which name did it, because a duplicate-class error against a file
they cannot open would be baffling. `Scanner(File)` is therefore conditional
too — hence `scannerSource(withFileSupport)`.

Only `RandomAccessFile` is left unsupported, and `checkUnsupportedApis` reports
it before compiling. That scan reads `blankLiteralsAndComments` output so a
mention inside a string cannot fail a build, and reports once per rule per file.

Do not warn about `new Scanner(System.in)` — it is the spelling the whole app is
built around, including the starter template, and a badge on every run would
teach students to ignore the Problems tab.

### Naming an uncaught exception takes two tricks

Once a Java exception reaches JavaScript it is an opaque wasm object. TeaVM's
only channel is `error.message`, and that gives `"(could not fetch message)"`
whenever `getMessage()` is null — which is exactly the case for the bounds and
null checks students hit most. So:

* **The type** comes from `captureThrows`, which wraps the `teavm.takeStackTrace`
  import. `Throwable.fillInStackTrace` runs in every constructor and passes its
  own class name to that import; it is the only place the name is visible from
  JS. The last one constructed is the one that escaped, because a `throw`
  always follows its `new` and nothing runs after the throw that ends the run.
* **The frames** come from `public/teavm/deobfuscator.wasm`, enabled by the
  `stackDeobfuscator` option on `load`. Without it every frame is
  `java.lang.Throwable$FakeClass.fakeMethod(Throwable.java:10931)`, the number
  being a wasm byte offset. That file comes from the *TeaVM* repository, not
  teavm-javac — hence the second argument to `stage:runtime`.

`explainRuntimeError` prefers the name over the `MACHINE_ERRORS` table, and
must keep doing so: a student's `throw new IllegalStateException("divide by
zero")` would otherwise be reported as an uncatchable trap. The table is only
for genuine traps, which carry no name at all.

Frames for the exception's own constructor chain, `org.teavm.*`, and jcoder's
injected files are dropped — the student wrote none of them, and cannot open
the last. Two e2e tests pin all of this against the real toolchain.

### Division is the compiler's job again

`utils/javaDivision.ts` used to rewrite `a / b` onto an injected `JCoderMath`,
because TeaVM lowered integer division straight onto the machine instruction
and a divide by zero trapped rather than throwing. That was ~900 lines
including its tests, and the backwards scan for the dividend was the most
fragile code in the project — it was wrong twice, once dropping a cast so that
worked example 7 printed 7.0 instead of 7.333, once swallowing a `return`.

TeaVM implemented checked division in e54eb98 (teavm#1249, which konsoletyper
first declined and then did properly with range analysis), so the rewrite is
gone. `smoke.spec.ts` compiles and runs a divide by zero against the real
toolchain, which is what proves the bundle still has it.

**If that test ever fails, the rewrite is what has to come back**, and the
history of this file is where to find it. A bundle from `npm run fetch:runtime`
will fail it, correctly: the published build predates all of this.

Two things are worse than they were under the rewrite, both deliberate:

* **`getMessage()` is null.** TeaVM throws its `ArithmeticException` without a
  message where the JDK says "/ by zero", so `catch (ArithmeticException e)`
  prints `null`. `smoke.spec.ts` asserts that, so it is pinned rather than
  assumed.
* **A constant `Integer.MIN_VALUE / -1` kills the compiler.** `compiler.wasm`
  is itself TeaVM-compiled Java, so folding that division traps *inside the
  compiler* ("divide result unrepresentable") and generation ends with no
  output and no diagnostic. The old rewrite hid this by rewriting the division
  away. Now `checkUnsupportedApis` warns on the usual spelling and
  `noOutputMessage` explains the rest. Reproduces only in the browser compiler:
  under TeaVM's Gradle plugin the fold runs on a JVM and is correct.

  teavm#1355 was closed with a workaround — build the bootstrap compiler with
  strict mode on — and it does not work: adding `strict = true` to
  teavm-javac's `wasmGC` block makes TeaVM's own optimiser throw an NPE
  generating `com.sun.tools.javac.comp.Modules.computeTransitiveClosure`
  (`WasmInstructionsOptimizer.java:1202`). Tried and reverted; do not try it
  again without checking that upstream first.

### One exception cannot be caught — and the list used to be longer

`new int[-1]` is raised by the WasmGC backend as a machine trap, not a Java
object, so a `catch` — including `catch (Exception e)` — does not run and the
program stops. `checkUnsupportedApis` warns about catching
`NegativeArraySizeException` for that reason, and `examples.test.ts` runs the
same check over every worked example.

`ArrayIndexOutOfBoundsException`, `NullPointerException` and
`ClassCastException` **used** to behave that way and no longer do, because
`public/teavm/` is now built from source with `strictMode` on (see below). The
cast was the dangerous one: it produced `null` with no error at all.
`ArithmeticException` is checked by TeaVM itself (see above).

**This list is a property of the bundle, not of the source.** Do not add to it
or remove from it on reasoning alone — `smoke.spec.ts` has a test that runs all
three against the real toolchain and asserts `caught ANC`, and that test is the
authority. A bundle fetched with `npm run fetch:runtime` instead of built from
source will fail it, correctly.

### public/teavm/ is committed, and built from source

It is **in git** (about 7.4 MB), so a deployment needs no Java toolchain. That
makes this repository a redistributor of TeaVM, teavm-javac and OpenJDK's
`javac` — `THIRD-PARTY-NOTICES.md` has to travel with it, and says so.

It is built rather than downloaded because the artifacts at
`teavm.org/playground` have not been refreshed since **15 June 2025**. Building
from source is what supplies strict mode, javac's annotation handling and the
`@Rename` fix. `npm run stage:runtime -- <checkout>` copies the four files in
and records the teavm-javac commit in `manifest.json`; the build itself needs
**JDK 25**, not the JDK 21 teavm-javac's README claims, and `:compiler:build`
fails in `:compiler:prepareTestHarness` (an upstream missing `dependsOn` that
Gradle 9 rejects) — pass `-x :compiler:prepareTestHarness -x :compiler:test`.

Both workarounds this bundle made unnecessary have now been removed: the
`@SuppressWarnings` strip in `prepareSource`, and the `rewriteGetMessage` /
`JCoderErr` machinery. The latter also carried a real bug — it matched
`h.err.getMessage()` and emitted `h.JCoderErr.messageOf(err)`, because the
pattern never checked for a preceding dot — so a student writing
`this.error.getMessage()` got a baffling error. Deleting it fixed that.

### Examples have to compile, and nothing in CI proves it

`utils/examples.ts` is plain Java text, so a mistake in it only shows up when a
student picks it from the menu. `examples.test.ts` covers what can be checked
without a compiler — the class name matches the file, there is a `main`, no
annotation takes arguments, no fully-qualified `java.io.File`, no pre-flight
warning — but compiling them needs the browser. After changing an example, run
it.

### The injected Java is a TypeScript template literal

So `'\n'` written with one backslash becomes a *real newline* inside a Java
character literal, and javac reports "illegal line end in character literal"
against a file the student cannot see. Write `'\\n'`. This has bitten twice;
`javaSupport.test.ts` now checks every injected source for a literal that runs
off the end of its line, which is cheaper than finding out from the browser.

### Cross-origin isolation is load-bearing

Reading input blocks the worker via `Atomics.wait`, which needs
`SharedArrayBuffer`, which needs COOP/COEP on every response. The headers are
duplicated in `vite.config.ts`, `server.mjs` and `public/_headers` — change one,
change all three. `test/e2e/smoke.spec.ts` asserts `crossOriginIsolated`.

It is also why the toolchain is vendored into `public/teavm/` rather than
fetched from teavm.org at runtime: COEP would block it.

### Atomics.wait is illegal on the main thread

That is the only reason the worker exists. `?runtime=main` is a diagnostic
fallback where input can only come from the Inputs tab; do not make it the
default "to simplify things", because typed input stops working entirely.

### Every exit path must clear the phase

`compileAndRun` reports the phase separately from the exit code, so a failed
compilation that returns early without `onStatus('idle')` leaves the status line
reading "compiling…" for ever. Use the local `finish()` helper rather than
calling `onExit` directly.

### Stdout must be flushed before the program blocks

A prompt written with `System.out.print` has no newline, so it sits in
`ConsoleSink`'s buffer. `InputBridge`'s `readLine` callback flushes both sinks
first — otherwise the caret appears above the prompt it belongs to.

### The compiler's diagnostic objects do not outlive the call

`onDiagnostic` hands over a live view onto Java memory. Copy the fields;
retaining the object gives garbage. The registration it returns cannot be used
to unsubscribe either — its `destroy` does not survive the crossing into
JavaScript — which is a second reason each run gets a fresh compiler.

### The licence texts under public/ are generated

`public/third-party-notices.txt` and `public/monaco-third-party-notices.txt` are
written by `scripts/build-notices.mjs` from `THIRD-PARTY-NOTICES.md` and from
the monaco-editor package, and are gitignored. `predev` and `prebuild` run it,
so it is not a step anyone has to remember — but it does mean the About
dialog's licence links 404 until one of those has run at least once. Edit
`THIRD-PARTY-NOTICES.md`, never the generated `.txt`.

`server.mjs` serves `.txt` as `text/plain` on purpose: without that the browser
downloads the notices instead of showing them.

### Monaco is self-hosted, deliberately

`src/utils/monacoSetup.ts` imports `edcore.main` plus *tokenizer-only* language
contributions. It does not use the default CDN loader (school networks block
CDNs, and cross-origin isolation blocks cross-origin scripts) and it does not
import the TypeScript/HTML/CSS language services (each pulls in a multi-megabyte
worker). If you add a language, add its `basic-languages/*/*.contribution`
import, not the `language/*/monaco.contribution` service.

## Conventions

* **No native browser dialogs.** No `window.confirm`, `alert` or `prompt` — they
  ignore the theme and block the worker's message pump. Use `useDialogs()` from
  `components/dialogs/DialogProvider`.
* **Dark-first Tailwind.** Components use `slate-*` classes; the light theme
  remaps them in `src/styles/index.css` under `html[data-theme="light"]`. If you
  introduce a colour that is not already remapped, add an override and check it
  in light mode.
* **The virtual filesystem is the project.** `getSourceFiles` hands javac every
  `.java` file in the active filesystem, so multi-file projects and packages
  work without any build file.
* TypeScript is strict, and `noUnusedLocals`/`noUnusedParameters` are on; the
  build fails on type errors.
