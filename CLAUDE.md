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

`public/teavm/` is **not** in git and is **not** produced by `npm run build`.
Without it the app loads and edits fine but Run reports that the bundle is
missing. That failure path is covered by an e2e test — keep it working.

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

### Annotations with arguments crash javac

This build of javac has `AnnotationProxyMaker` stubbed out, so
`java.lang.annotation.Annotation` resolves cyclically and any annotation that
takes arguments — or any `@interface` declaration — recurses until the stack
overflows. Marker annotations (`@Override`, `@Deprecated`,
`@FunctionalInterface`) are fine.

Two consequences, both load-bearing:

* `prepareSource` strips `@SuppressWarnings(…)` from student code, and
  `javacCrashMessage` explains the rest when it happens anyway.
* **The injected `Scanner` must not use `@JSBody`**, which is why the input
  bridge looks the way it does. `javaSupport.test.ts` asserts that
  `SCANNER_SOURCE` contains no annotation with brackets — keep that test.

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

### javac and TeaVM disagree about `@Rename`d methods

TeaVM declares `Throwable.getMessage` as `getMessage0` with a `@Rename`
annotation and applies the rename in its *own* compiler. The javac SDK is
generated without applying it, so **javac sees only `getMessage0` and TeaVM
links only `getMessage`** — neither spelling compiles and runs. The same is true
of `getClass`, `getCause` and `getLocalizedMessage`.

`getMessage()` is common enough in teaching to be worth fixing, so
`buildCompilationUnits` rewrites the simple `identifier.getMessage()` form onto
`JCoderErr.messageOf`, which recovers the message by splitting `toString()` on
the first `": "`. The rewrite is switched off entirely if any source declares a
`getMessage` of its own, because a student's override does work and must keep
winning. Complex receivers are left alone and `explainDiagnostic` explains them.

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

### Some exceptions cannot be caught, and it is silent

TeaVM's WasmGC backend raises `ArithmeticException`,
`ArrayIndexOutOfBoundsException` and `NullPointerException` as machine traps,
not Java objects, so a `catch` — including `catch (Exception e)` — simply does
not run and the program stops. Anything Java code `throw`s is caught normally,
custom exception classes included. `checkUnsupportedApis` warns when a program
catches one of the three, because silently not catching is the worst way to
find out. The examples must not rely on it either — `examples.test.ts` runs the
same check over every one of them.

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
