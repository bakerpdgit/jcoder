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
