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

### Machine errors are rewritten before the student sees them

`explainRuntimeError` maps the WasmGC runtime's own wording ("dereferencing a
null pointer") onto the Java exception it stands for, plus a line saying it
cannot be caught. The raw text is kept on the last line so the message stays
searchable. `javaPipeline.test.ts` pins the exact strings observed from the
runtime — if TeaVM rewords one, that test fails rather than the student quietly
losing the explanation.

### Division is rewritten so that dividing by zero can be caught

`utils/javaDivision.ts` turns `a / b` into `JCoderMath.div(a, b)`, and `x /= y`
into `x /= JCoderMath.divisor(x, y)`, injecting a helper whose `int` and `long`
overloads throw a real `ArithmeticException`. TeaVM declined to check division
itself (konsoletyper/teavm#1249: too expensive without range analysis), and
`strict` mode does not cover it, so this is the only case jcoder has to fix in
the source rather than in the toolchain.

**Both operands are passed on purpose.** Overload resolution then promotes the
pair exactly as the division would, so `total / count` on two ints reaches
`div(int, int)` and throws, while `1.0 / 0` widens to `div(double, double)` and
stays `Infinity`. Guarding only the divisor is half the code and gets that
second case wrong — do not "simplify" it that way.

The backwards scan for the dividend is the fragile part, and it has already been
wrong once: it swallowed the `return` of `return (double) total / n`, which
compiled to nothing sensible, and before that dropped the cast, which silently
turned worked example 7's average from 7.333 into 7.0. Neither showed up in the
hand-written cases — `javaDivision.test.ts` now checks structurally that every
operand it produces looks like an expression, over every worked example. Keep
that test, and run an example in the browser after touching the scan.

`checkUnsupportedApis` therefore does **not** warn about catching
`ArithmeticException`, unlike the other two.

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
`ArithmeticException` is handled by the rewrite above.

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
