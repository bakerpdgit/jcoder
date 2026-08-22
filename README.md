# java coder

A browser-based Java IDE. Students write Java, press Run, and the code is
compiled and executed **entirely in their browser** — no server, no install,
nothing to set up on the machine they are sitting at.

It is the Java counterpart to
[dotnetcoder](https://github.com/bakerpdgit/dotnetcoder) and
[pythoncoder](https://github.com/bakerpdgit/pythoncoder), and follows the same
shape: Monaco editor, an IndexedDB virtual filesystem with multiple named
workspaces, the ability to connect a real folder on disk, and a console where
the caret appears inline when the program asks for input.

## How it works

The same trick Pyodide uses. Nobody compiles a Java compiler in their browser —
someone compiles it to WebAssembly once, and the app fetches the result. That
someone is the [TeaVM](https://teavm.org) project, whose
[teavm-javac](https://github.com/konsoletyper/teavm-javac) builds OpenJDK's
`javac` **and** TeaVM itself into a single WebAssembly module.

| | |
|---|---|
| **Once, at setup** | `npm run fetch:runtime` downloads `compiler.wasm` and two class libraries into `public/teavm/`. |
| **Every visit, in the browser** | Those static files are downloaded (and then cached). Pressing Run compiles the student's source *twice*, in the tab. |

Every run is two compilations:

```
 .java  ──javac──▶  .class  ──TeaVM──▶  .wasm  ──▶  running
```

`javac` produces ordinary JVM bytecode; TeaVM turns that bytecode into a
WebAssembly module; the browser instantiates it and calls its `main`. Both
compilers are themselves WebAssembly, running in the same tab.

```
 browser tab
 ├─ React + Monaco (main thread)          ← editor, filesystem, console UI
 └─ runner.worker.ts (worker thread)
     ├─ compiler.wasm                     ← javac + TeaVM
     └─ app.wasm                          ← the student's program
```

The toolchain lives on a **worker thread** for one reason: reading a line of
input has to block. The program calls synchronously into JavaScript, which parks
on `Atomics.wait` until the UI writes a line into a `SharedArrayBuffer`.
`Atomics.wait` is illegal on the main thread, so the runtime cannot live there.
That in turn requires the page to be **cross-origin isolated** — see
[Required headers](#required-headers).

## Getting started

You need **Node 20+**. You do *not* need a JDK, Maven or Gradle: the toolchain
is downloaded prebuilt.

```
npm install
npm run fetch:runtime     # ~6.7 MB into public/teavm/
npm run dev               # http://localhost:3000
```

```
npm run build && npm start    # production build served by server.mjs
```

`public/teavm/` is **not** in git and is **not** produced by `npm run build`.
Without it the app loads and edits fine, but Run reports that the bundle is
missing and tells you which command to run. That failure path is covered by an
e2e test — keep it working.

### Building the toolchain from source

Only necessary if you want to pin a particular TeaVM revision or patch the
compiler. teavm-javac needs **JDK 21** and builds with Gradle:

```
git clone https://github.com/konsoletyper/teavm-javac
cd teavm-javac
./gradlew :compiler:build
```

Copy `compiler.wasm` and `compiler.wasm-runtime.js` from
`compiler/build/generated/teavm/wasm-gc/`, and the two `*.bin` class libraries
from `compiler/build/classlib/`, into `public/teavm/`.

`JCODER_TEAVM_BASE=https://example.com/my-build npm run fetch:runtime` points the
download at your own host instead.

## Using it

* **Run (Ctrl+Enter or F5)** — compiles *every* `.java` file in the current
  filesystem, so projects can be split across files and packages.
* **Examples** — drops a ready-made, commented program into the current
  filesystem and pins it as the class to run, so the next thing to do is press
  Run. Eight of them, from a first calculation up to inheritance. Adding one
  that is already there asks before replacing it.
* **Main** — which class's `main` to run. *auto* prefers a class called `Main`,
  otherwise the first one alphabetically; the dropdown lists everything javac
  found so you can pin one.
* **Console** — `System.out` in normal text, `System.err` in red.
* **Inputs tab** — one line per read, supplied before the run. This is the
  reliable way to give a program its data. Lines are consumed from the top on
  every run.
* **Typed input** — the caret appears in the console itself when the program
  reads and the Inputs tab has run out. Pasting several lines behaves like a
  terminal: each newline answers one read, and a final line without a newline
  stays at the prompt. **End input** (or Ctrl+D) closes stdin.
* **Problems tab** — compiler diagnostics from *both* compilers; clicking one
  jumps to the position in the editor, which also gets red squiggles.
* **Args** — passed to `main(String[] args)`. Quoted arguments are honoured.
* **Restart** — WebAssembly cannot be interrupted from outside, so stopping a
  runaway program means discarding the worker and booting a fresh toolchain.
  The bundle comes from cache, so it takes a second or two.
* **Filesystems** — each is an independent workspace in IndexedDB. Create,
  rename, delete, import a `.zip` as a new filesystem, or download one as a
  `.zip`.
* **About** — the ⓘ button in the top right: what this is for, what it
  deliberately cannot do, and the licences of everything it is built from. Worth
  pointing students at before they hit a limitation the hard way.
* **Connect a folder** — opens a real folder from disk, after asking which of
  two things you want:
  * **Two-way link** — every change made here is applied to the folder on your
    computer straight away, including files your programs write and files you
    delete. The browser is asked for write access only in this case.
  * **One-way import** — copies the files in and never writes back.

  No starter file is created either way: it is your folder, not a new
  workspace. Chrome/Edge only — the File System Access API does not exist in
  Firefox or Safari, where upload and download still work. There is no file
  watching: use **Reload from the connected folder** to pick up outside edits,
  and permissions reset on page reload.

## Reading input, and the built-in Scanner

`Scanner` is the first thing a Java course teaches for input, and TeaVM's class
library does not have one — nor does it have a working `System.in`, whose every
read throws `EOFException`, and there is no `System.setIn` to replace it.

So java coder adds a `Scanner` of its own to every compilation, in the default
package. Textbook code works unchanged:

```java
public class Main {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in);
        System.out.print("What is your name? ");
        String name = input.nextLine();
        System.out.println("Hello, " + name + "!");
    }
}
```

`nextLine`, `next`, `nextInt`, `nextLong`, `nextDouble`, `nextFloat`,
`nextBoolean`, `hasNext`, `hasNextLine`, `hasNextInt`, `hasNextDouble` and
`close` all behave as they do on a real JVM — including the classic gotcha where
`nextInt()` followed by `nextLine()` returns the empty remainder of the line.

Two consequences worth knowing:

* `import java.util.Scanner;` names a class TeaVM does not ship, so jcoder
  removes that one line automatically (`import java.util.*;` is fine, and so is
  writing no import at all). Line numbers are preserved, so diagnostics still
  point at the right place.
* If you write your own `Scanner.java`, yours wins and nothing is injected.

`System.in`, `BufferedReader(new InputStreamReader(System.in))` and
`System.console()` do **not** work. Use `Scanner`.

## Reading and writing files

A program can open the files in the sidebar, folders included:

```java
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws Exception {
        List<String> lines = Files.readAllLines(Paths.get("demo.txt"));

        PrintWriter out = new PrintWriter("results/upper.txt");
        for (String line : lines) out.println(line.toUpperCase());
        out.close();
    }
}
```

Binary files work too, which is what makes byte-level exercises possible:

```java
DataOutputStream out = new DataOutputStream(new FileOutputStream("scores.bin"));
out.writeInt(4242);
out.close();
```

**Text:** `File`, `Scanner(File)`, `FileReader` (with `BufferedReader`),
`FileWriter`, `PrintWriter`, and `Files.readAllLines`/`readString`/`write`/
`writeString`/`exists`/`createDirectories`/`delete`.

**Bytes:** `FileInputStream`, `FileOutputStream`, `Files.readAllBytes` and
`Files.write(path, byte[])`. TeaVM's own `DataInputStream`,
`DataOutputStream`, `BufferedInputStream` and `BufferedOutputStream` wrap
these, so `writeInt`/`readInt` and the rest work as they should.

Missing files throw `FileNotFoundException`, writing to `a/b/c.txt` creates the
folders, and whatever the program wrote appears in the sidebar when it
finishes — including in a connected folder on disk. `RandomAccessFile` is the
one file API with no stand-in.

### How, and what it costs

None of the real file APIs can work here. TeaVM *has* a virtual filesystem and
`java.io.File` already delegates to it, but the API that mounts one is not
exposed to javac; `java.nio.file` fails inside TeaVM's code generator; and
`FileReader` fails on a missing `java.io.FileDescriptor`. So jcoder supplies its
own `File`, `Files`, `Path`, `Paths`, `FileReader`, `FileWriter` and
`PrintWriter` in the unnamed package, which shadow the `java.*` ones for
student code exactly as the built-in `Scanner` does. Imports that would
outrank them (`import java.io.File;`) are neutralised, the same way and with
the same line-preserving trick.

They talk to a **snapshot** of the editor's files held in the worker for the
duration of the run, over the same channel the console input bridge uses. That
channel carries any UTF-16 code unit unaltered, so a byte in 0–255 crosses it
untouched — which is why binary files work at all. Consequences worth knowing:

* The program sees the files as they were when Run was pressed, and the editor
  sees the program's writes when it finishes — they do not interleave.
* Files are capped at 8 MB each and 32 MB in total per run
  (`MAX_MOUNTED_FILE_BYTES`). Anything larger is left out rather than
  truncated, and named in a message, because a truncated file reads as corrupt
  data. Speed is not the reason for the cap: the channel moves about 14 million
  characters a second, so even an 8 MB file crosses in well under a second.
* If your own class is called `File`, `Files`, `Path`, `Paths`, `FileReader`,
  `FileWriter` or `PrintWriter`, yours wins and file support switches itself
  off, with a warning saying so. Rename it if you need to open a file.

## Limitations

These come from the browser build of the compiler, not from jcoder, and are
worth knowing before setting an exercise.

* **Annotations that take arguments do not compile.** `@Override`,
  `@Deprecated` and `@FunctionalInterface` are fine; `@SuppressWarnings("…")`
  and any `@interface` of your own are not — javac's annotation handling is
  stubbed out in this build and recurses until the stack overflows. jcoder
  removes `@SuppressWarnings(…)` for you and explains the rest if it happens.
* **The class library is a subset.** TeaVM implements much of `java.lang`,
  `java.util` and `java.io`, but not all of it, and there is no reflection worth
  relying on. See [TeaVM's own notes](https://teavm.org/docs/runtime/java-classes.html).
* **`System.exit()` aborts the program** rather than setting an exit code.
* **Some errors cannot be caught.** The dividing line is who raises the error.
  Anything the *class library* checks and throws behaves normally —
  `list.get(99)`, `"abc".charAt(9)`, `Integer.parseInt("zz")`,
  `Objects.requireNonNull`, and anything you `throw` yourself, including your own
  exception classes. Anything the *WebAssembly machine* raises passes straight
  through `catch` — even `catch (Exception e)` — and stops the program:

  | | |
  |---|---|
  | `arr[99]` on a raw array | stops the program |
  | `null.something()` | stops the program |
  | integer `/ 0` | stops the program |
  | `new int[-1]` | stops the program |
  | **a bad cast, `(Integer) aString`** | **silently gives `null`** |

  The first four are reported with the Java exception they correspond to and a
  note that they cannot be caught, and a program that tries to catch one gets a
  warning before it runs. **The cast is the one to watch**, because nothing is
  reported at all: the value simply comes out `null`. Note that `list.get(99)`
  *is* catchable while `arr[99]` is not, so collections are the safer choice for
  an exercise about handling errors.

  All of these come from TeaVM's WasmGC backend running without its `strict`
  option, which the browser build does not expose. See
  [TeaVM #1106](https://github.com/konsoletyper/teavm/issues/1106).
* **Files are emulated.** Text and binary both work — see
  [Reading and writing files](#reading-and-writing-files) — but they are the
  editor's files, not your computer's, and `RandomAccessFile` has no stand-in.
* **`getMessage()` is rewritten for you.** TeaVM names the method `getMessage0`
  and renames it while compiling, so javac offers a name TeaVM will not link and
  TeaVM offers one javac cannot see — neither spelling works from source. jcoder
  rewrites `e.getMessage()` onto an injected helper that recovers the message
  from `toString()`, so ordinary `try`/`catch` code just works. `getClass()`,
  `getCause()` and `getLocalizedMessage()` have the same problem and are only
  explained, not fixed — use `e.toString()`.
* **Exception stack traces have no frames.** The generated module is obfuscated,
  so the type and message are reported but not the line.
* **No debugger yet** — breakpoints and stepping are the obvious next step.
* Chrome or Edge is recommended: **Connect a folder** needs the File System
  Access API, which Firefox and Safari do not implement.

## Required headers

`SharedArrayBuffer` needs cross-origin isolation on **every** response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
Origin-Agent-Cluster: ?1
```

These are set in three places, which must stay in step:

* `vite.config.ts` — dev and preview servers
* `server.mjs` — the production Node server
* `public/_headers` — Cloudflare Pages (copied to `dist/_headers` at build time)

Without them the editor still works, but the console input box is replaced by a
warning and a program that reads input sees end-of-input immediately.
`test/e2e/smoke.spec.ts` asserts `crossOriginIsolated === true`, so a regression
fails the build rather than silently degrading.

The toolchain must also be served from your own origin, which is why
`fetch:runtime` vendors it: under COEP a cross-origin `compiler.wasm` would be
blocked.

## Bundle size

`public/teavm/` is about **6.7 MB**, served compressed and then cached:

| | |
|---|---|
| `compiler.wasm` | 4.1 MB — javac + TeaVM |
| `runtime-classlib-teavm.bin` | 2.4 MB — the class library generated code links against |
| `compile-classlib-teavm.bin` | 200 kB — the class library javac resolves against |
| `compiler.wasm-runtime.js` | 12 kB — the Wasm GC loader |

Make sure your host serves it with compression and long-lived cache headers.
Cloudflare Pages does both by default.

## Troubleshooting

* The status line names the boot step in flight, and a step that stalls says so
  in the console after 30 seconds.
* `?trace=1` turns on verbose logging.
* `?runtime=main` boots the toolchain on the UI thread instead of the worker:
  typed input stops working and a runaway program freezes the tab, but it
  isolates whether the worker is at fault. `?runtime=worker` pins the worker
  with no fallback.

## Project layout

```
src/
  App.tsx                     Root component: layout, filesystem state, main-class picker
  constants.ts                Runtime path, SharedArrayBuffer layout, size limits
  types/index.ts              Shared types, including the worker protocol
  hooks/useRunner.ts          Worker lifecycle, console buffer, stdin plumbing
  workers/
    runner.worker.ts          Hosts the toolchain; blocks on Atomics.wait for input
    bootRuntime.ts            Loads compiler.wasm and the class libraries
    javaPipeline.ts           compile → generate → load → run, shared by both hosts
    teavmRuntime.ts           Typings for the loader and the compiler API
  utils/
    javaSupport.ts            The injected Scanner and the input bridge protocol
    virtualFS.ts              IndexedDB filesystems, entries, import/export
    stdinChannel.ts           The SharedArrayBuffer stdin protocol (both sides)
    languages.ts              Language registry
    localFolderIo.ts          File System Access API helpers
    monacoSetup.ts            Self-hosted Monaco, tokenizer-only languages
    storage.ts, args.ts, consoleInput.ts, mainThreadRuntime.ts, runtimeHost.ts
  components/
    CodeEditor.tsx            Monaco + diagnostic markers
    ConsolePanel.tsx          Console / Inputs / Problems tabs, inline input caret
    FileSystemPanel.tsx       Filesystem browser, folder connect, zip import
    dialogs/DialogProvider.tsx  Promise-based confirm/prompt/alert
    dialogs/AboutDialog.tsx     What this is, what it cannot do, and credits

scripts/fetch-runtime.mjs     Downloads public/teavm/
scripts/build-notices.mjs     Publishes the licence texts the About dialog links to
```

## Testing

```
npm test          # Vitest: the input bridge, the VFS, the stdin protocol, …
npm run test:e2e  # Playwright: the built app in Chromium
```

The e2e suite runs against `dist/`. Tests that need the toolchain skip
themselves when `public/teavm/` is absent, so CI without the bundle still gets a
useful signal from the shell and header tests.

## Deploying

Any static host works. For Cloudflare Pages:

* build command: `npm run fetch:runtime && npm run build`
* output directory: `dist`
* or commit `public/teavm/` (remove it from `.gitignore`) and use `npm run build`
  alone — but see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) first, since
  that means redistributing the toolchain.

## Credits

java coder is a thin shell around other people's compilers. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — in particular
[TeaVM](https://teavm.org) and
[teavm-javac](https://github.com/konsoletyper/teavm-javac) by Alexey Andreev,
which do all of the actual compiling, and OpenJDK, whose `javac` is inside them.
