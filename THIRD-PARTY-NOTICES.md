# Third-party notices

java coder itself is MIT licensed (see [LICENSE](LICENSE)). It could not exist
without the projects below, and the whole compiler stack in particular is
somebody else's work: java coder drives it, it does not implement it.

## The Java toolchain

These are the files `npm run fetch:runtime` downloads into `public/teavm/`.
They are **not** part of this repository and are not covered by its licence.

### TeaVM

*Copyright © Alexey Andreev and contributors.*
Licensed under the **Apache License 2.0**.

* <https://teavm.org>
* <https://github.com/konsoletyper/teavm>

TeaVM is the ahead-of-time compiler that turns JVM bytecode into WebAssembly,
and it supplies the class library that student programs link against
(`runtime-classlib-teavm.bin`) and the Wasm GC loader
(`compiler.wasm-runtime.js`) that instantiates every generated program.

### teavm-javac

*Copyright © Alexey Andreev and contributors.*
Licensed under the **Apache License 2.0**.

* <https://github.com/konsoletyper/teavm-javac>
* Live demo: <https://teavm.org/playground.html>

teavm-javac is the project that compiles **javac and TeaVM themselves** to
WebAssembly, producing `compiler.wasm` and the two class-library archives.
Everything java coder does when you press Run — parse Java, report diagnostics,
emit bytecode, generate WebAssembly — happens inside that module. The
`CompilerLibrary` API java coder calls (`createCompiler`, `addSourceFile`,
`compile`, `detectMainClasses`, `generateWebAssembly`, …) is defined there.

### OpenJDK

*Copyright © Oracle and/or its affiliates, and OpenJDK contributors.*
Licensed under the **GNU General Public License, version 2, with the Classpath
Exception**.

* <https://openjdk.org>

The Java compiler inside `compiler.wasm` is OpenJDK's `javac`, compiled to
WebAssembly by teavm-javac. teavm-javac's own notice records that it includes no
OpenJDK source and modifies none: OpenJDK sources are downloaded and compiled to
bytecode during its build.

java coder does not redistribute these artifacts — `public/teavm/` is excluded from
this repository and fetched at build time from the TeaVM project's own site. If
you choose to commit or mirror `public/teavm/` in order to deploy, you are
redistributing the artifacts above, and the Apache-2.0 and GPLv2+CE terms travel
with them. Ship this file alongside them.

### JZlib

*Copyright © ymnk, JCraft, Inc.* Licensed under a **BSD-style licence**.

* <https://github.com/ymnk/jzlib>

Bundled inside `compiler.wasm` by teavm-javac, which uses it to read the
class-library archives.

## Bundled into the java coder application

| Project | Licence | |
|---|---|---|
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT | The code editor, self-hosted rather than loaded from a CDN |
| [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) | MIT | React bindings for Monaco |
| [React](https://react.dev) and React DOM | MIT | The UI |
| [JSZip](https://stuk.github.io/jszip/) | MIT **or** GPL-3.0-or-later (dual) | Importing and exporting a filesystem as `.zip`. java coder uses it under the MIT option. |

Monaco ships the [Codicon](https://github.com/microsoft/vscode-codicons) icon
font (`codicon.ttf`), whose code is MIT licensed and whose icons are licensed
under **CC BY 4.0**.

## Build and test tooling

Not shipped to users, but part of this repository's development setup:
[Vite](https://vite.dev) (MIT), [TypeScript](https://www.typescriptlang.org)
(Apache-2.0), [Tailwind CSS](https://tailwindcss.com) (MIT),
[PostCSS](https://postcss.org) (MIT), [Autoprefixer](https://github.com/postcss/autoprefixer)
(MIT), [Vitest](https://vitest.dev) (MIT), [jsdom](https://github.com/jsdom/jsdom)
(MIT), [Testing Library](https://testing-library.com) (MIT),
[fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) (Apache-2.0) and
[Playwright](https://playwright.dev) (Apache-2.0).

## Prior art

java coder is the Java counterpart of
[dotnetcoder](https://github.com/bakerpdgit/dotnetcoder) and
[pythoncoder](https://github.com/bakerpdgit/pythoncoder), and deliberately
copies their layout, their worker-thread design and their console-input model.
