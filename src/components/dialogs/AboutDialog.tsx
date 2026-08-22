import { useEffect, useRef, type ReactNode } from 'react'
import { PRODUCT_NAME } from '../../constants'

/**
 * What this is, what it deliberately cannot do, and who wrote the parts that do
 * the actual work.
 *
 * The "what it cannot do" list is the point of the dialog: almost every
 * surprise a student hits here is a limitation of compiling Java inside a
 * browser tab, and saying so up front is kinder than letting them discover it
 * halfway through an exercise. Keep it honest and keep it current.
 */

interface Props {
  open: boolean
  onClose: () => void
}

export function AboutDialog({ open, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="modal-card modal-card-wide" role="dialog" aria-modal="true" aria-label={`About ${PRODUCT_NAME}`}>
        <h2 className="mb-3 text-base font-semibold text-slate-100">About {PRODUCT_NAME}</h2>

        <div className="about-scroll min-h-0 flex-1 overflow-y-auto pr-1 text-sm leading-relaxed text-slate-300">
          <Section title="What this is for">
            <p>
              A place for students to write, run and experiment with Java without installing
              anything. It is built for learning the language — trying an idea, seeing what an
              error message means, getting a program to work — and it is deliberately not a
              full-fledged development environment. Real projects belong in a real IDE such as
              IntelliJ IDEA, Eclipse or VS Code; this is the sketchpad you reach for first.
            </p>
          </Section>

          <Section title="What it cannot do">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <strong className="text-slate-200">No libraries.</strong> There is no Maven or
                Gradle and no way to add a JAR. You have the built-in class library and nothing
                beyond it — which is plenty for coursework, and a hard stop for anything else.
              </li>
              <li>
                <strong className="text-slate-200">Only part of the class library.</strong> Much
                of <code>java.lang</code>, <code>java.util</code> and <code>java.io</code> is
                here, but not all of it, and reflection is not worth relying on.
              </li>
              <li>
                <strong className="text-slate-200">Input comes from a built-in Scanner.</strong>{' '}
                <code>new Scanner(System.in)</code> works exactly as you would expect, but it is
                this site's own Scanner: <code>System.in</code> and <code>BufferedReader</code>{' '}
                are not available, and <code>import java.util.Scanner;</code> is removed for you.
              </li>
              <li>
                <strong className="text-slate-200">Annotations with brackets do not compile.</strong>{' '}
                <code>@Override</code> and <code>@FunctionalInterface</code> are fine;{' '}
                <code>@SuppressWarnings("…")</code> and your own <code>@interface</code>{' '}
                declarations are not — a limitation of the browser build of the compiler.
              </li>
              <li>
                <strong className="text-slate-200">Files are the ones in the editor.</strong>{' '}
                <code>File</code>, <code>Scanner</code>, <code>FileReader</code>,{' '}
                <code>FileWriter</code>, <code>PrintWriter</code> and <code>Files</code> read and
                write text; <code>FileInputStream</code>, <code>FileOutputStream</code> and{' '}
                <code>DataInputStream</code> handle bytes. Folders work, and anything your
                program writes appears in the file list once it finishes. There is no access to
                your computer's own disk, files above 8 MB are left out, and{' '}
                <code>RandomAccessFile</code> is not supported.
              </li>
              <li>
                <strong className="text-slate-200">Some errors cannot be caught.</strong>{' '}
                Dividing by zero, running off the end of an <em>array</em>, and using a null
                reference stop the program rather than being caught, because they come from the
                WebAssembly machine rather than from Java. Errors the class library throws are
                caught as normal — including <code>list.get(99)</code>,{' '}
                <code>Integer.parseInt</code> and anything you throw yourself. One to watch:
                a cast to the wrong type, such as <code>(Integer) someText</code>, quietly
                gives <code>null</code> instead of failing.
              </li>
              <li>
                <strong className="text-slate-200">No network.</strong> Sockets and HTTP are
                unavailable: there is no server behind this.
              </li>
              <li>
                <strong className="text-slate-200">No debugger yet.</strong> No breakpoints, no
                stepping. Print statements, for now.
              </li>
              <li>
                <strong className="text-slate-200">A first load of about 7 MB.</strong> The
                compiler and its class libraries are downloaded once; after that the browser
                caches them.
              </li>
              <li>
                <strong className="text-slate-200">Chrome or Edge for folder access.</strong>{' '}
                Connecting a real folder on disk needs the File System Access API, which Firefox
                and Safari do not implement. Everything else works in any modern browser.
              </li>
            </ul>
          </Section>

          <Section title="Your code stays with you">
            <p>
              Nothing is uploaded anywhere. Compilation and execution both happen inside your own
              browser tab, and your files are stored locally in the browser. There is no account,
              no server-side storage and no tracking.
            </p>
          </Section>

          <Section title="Built with">
            <p>
              <Link href="https://github.com/konsoletyper/teavm">TeaVM</Link> and{' '}
              <Link href="https://github.com/konsoletyper/teavm-javac">teavm-javac</Link>{' '}
              (Apache 2.0, © Alexey Andreev and contributors), which are what compile and run your
              code here; they embed <Link href="https://openjdk.org">OpenJDK</Link>'s Java
              compiler (GPL v2 with the Classpath Exception). The{' '}
              <Link href="https://github.com/microsoft/monaco-editor">Monaco Editor</Link> (MIT,
              © Microsoft Corporation) with{' '}
              <Link href="https://github.com/microsoft/vscode-codicons">Codicons</Link> (CC BY
              4.0, © Microsoft Corporation);{' '}
              <Link href="https://github.com/facebook/react">React</Link> (MIT, © Meta Platforms,
              Inc.); and <Link href="https://github.com/Stuk/jszip">JSZip</Link> (used under its
              MIT option). With thanks to all of them.
            </p>
            <p className="mt-2">
              Full licence texts: <Link href="/third-party-notices.txt">third-party notices</Link>{' '}
              and <Link href="/monaco-third-party-notices.txt">Monaco's own notices</Link>.
            </p>
          </Section>

          <Section title="Trademarks">
            <p className="text-xs text-slate-500">
              Java and OpenJDK are registered trademarks of Oracle and/or its affiliates. This
              project is independent and is not affiliated with, endorsed by, or sponsored by
              Oracle. The name is descriptive: it is a coder for Java.
            </p>
          </Section>
        </div>

        <div className="mt-4 flex shrink-0 justify-end">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith('http')
  return (
    <a
      href={href}
      target="_blank"
      rel={external ? 'noreferrer noopener' : undefined}
      className="text-emerald-400 underline decoration-emerald-400/40 underline-offset-2 hover:decoration-emerald-400"
    >
      {children}
    </a>
  )
}
