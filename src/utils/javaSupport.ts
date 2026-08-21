/**
 * The Java-specific glue between the editor and the TeaVM toolchain.
 *
 * ## Why there is a hand-written Scanner here
 *
 * TeaVM ships its own implementation of a *subset* of the Java class library,
 * and two things a beginner's program relies on are missing from it:
 *
 *   - `java.util.Scanner` does not exist at all.
 *   - `System.in` is hard-wired to a stream whose every read throws
 *     `EOFException`, and TeaVM has no `System.setIn` to replace it.
 *
 * So the usual trick of redirecting the standard input stream — which is what
 * the .NET sibling of this project does with `Console.SetIn` — is not
 * available. Instead every compilation gets an extra source file defining a
 * `Scanner` in the default (unnamed) package.
 *
 * Because the student's own code is in the unnamed package too, an unqualified
 * `Scanner` resolves to this one, and `new Scanner(System.in)` compiles and
 * behaves as expected — the constructor takes (and ignores) an `InputStream`
 * precisely so that textbook code runs unchanged. The single-type import
 * `import java.util.Scanner;` is the one form that would not work, since it
 * names a class TeaVM does not have; `prepareSource` neutralises it.
 *
 * If a student writes their *own* `Scanner.java`, theirs wins and nothing is
 * injected — see `buildCompilationUnits`.
 *
 * ## Why the input bridge looks so strange
 *
 * The obvious way for the injected Scanner to reach JavaScript is TeaVM's
 * `@JSBody`. It cannot be used here: the browser build of javac cannot compile
 * *any* annotation that takes arguments. Its `AnnotationProxyMaker` is stubbed
 * out, so `java.lang.annotation.Annotation` resolves cyclically and javac
 * recurses until the stack overflows. Marker annotations (`@Override`,
 * `@Deprecated`, `@FunctionalInterface`) are fine; `@JSBody(...)` — and, for
 * the same reason, `@SuppressWarnings("...")` in student code — are not.
 *
 * That rules out declaring a new import, so the bridge is built out of two
 * imports the generated module *already* has, both of which the host can
 * intercept when it instantiates the module (see `javaPipeline`):
 *
 *   - `System.err` reaches JavaScript one character at a time. Writing
 *     `REQUEST_CHAR` is the request for a line; the host swallows that
 *     character and blocks until the user (or the Inputs tab) supplies one.
 *   - `System.currentTimeMillis()` is then called repeatedly, and the host
 *     answers with the line's characters, then `END_OF_LINE`. Once the line has
 *     been handed over the clock behaves normally again.
 *
 * It is a strange channel, but it is a *reliable* one: it needs no annotations,
 * no extra imports and no changes to the prebuilt compiler, and it is
 * synchronous, which is what makes a blocking read possible at all.
 */

/** Path of the injected support file, as javac sees it. */
export const SUPPORT_SOURCE_PATH = 'Scanner.java'

/**
 * The wire protocol between the injected `Scanner` and the host. Both sides are
 * generated from these constants so they cannot drift apart.
 */
/** Written to `System.err` to ask for a line. */
export const REQUEST_CHAR = 1
/** Returned by the clock once the current line has been fully handed over. */
export const END_OF_LINE = -1
/** Returned by the clock when there is no more input at all. */
export const END_OF_INPUT = -2
/** Guards against an unbounded read if the protocol ever desynchronises. */
export const MAX_LINE_CHARS = 65536

/**
 * `Scanner`, in the unnamed package, reading through the host bridge described
 * above.
 */
export const SCANNER_SOURCE = `import java.io.InputStream;
import java.util.NoSuchElementException;

/**
 * A subset of java.util.Scanner, supplied by jcoder because TeaVM's class
 * library does not include one. Reads from the console panel.
 */
public class Scanner {
    private static final char REQUEST = ${REQUEST_CHAR};
    private static final long END_OF_LINE = ${END_OF_LINE}L;
    private static final long END_OF_INPUT = ${END_OF_INPUT}L;

    /** Remainder of the current line, or null when no line is held. */
    private String pending;
    private boolean eof;

    public Scanner() {
    }

    /** The stream is ignored: input always comes from the console panel. */
    public Scanner(InputStream ignored) {
    }

    /**
     * Asks the host for one line. The host blocks inside the first call until
     * a line is available, then hands it back one character at a time.
     */
    private static String hostReadLine() {
        System.err.print(REQUEST);
        System.err.flush();
        StringBuilder sb = new StringBuilder();
        while (sb.length() < ${MAX_LINE_CHARS}) {
            long c = System.currentTimeMillis();
            if (c == END_OF_LINE) {
                return sb.toString();
            }
            if (c == END_OF_INPUT) {
                return null;
            }
            if (c < 0L || c > 65535L) {
                // The clock answered with a real time, so the host is not in
                // the middle of handing over a line. Treat it as end of input
                // rather than looping forever on nonsense.
                return null;
            }
            sb.append((char) c);
        }
        return sb.toString();
    }

    private String readLineFromHost() {
        if (eof) {
            return null;
        }
        String line = hostReadLine();
        if (line == null) {
            eof = true;
            return null;
        }
        return line;
    }

    /**
     * Makes sure a non-blank token is available in \`pending\`, reading further
     * lines if the current one is exhausted.
     */
    private boolean ensureToken() {
        while (true) {
            if (pending == null) {
                pending = readLineFromHost();
                if (pending == null) {
                    return false;
                }
            }
            int i = 0;
            while (i < pending.length() && isSpace(pending.charAt(i))) {
                i++;
            }
            if (i == pending.length()) {
                pending = null;
                continue;
            }
            pending = pending.substring(i);
            return true;
        }
    }

    private static boolean isSpace(char c) {
        return c == ' ' || c == '\\t' || c == '\\r' || c == '\\n' || c == '\\f';
    }

    public boolean hasNext() {
        return ensureToken();
    }

    public boolean hasNextLine() {
        if (pending != null) {
            return true;
        }
        pending = readLineFromHost();
        return pending != null;
    }

    public String next() {
        if (!ensureToken()) {
            throw new NoSuchElementException("No more input");
        }
        int i = 0;
        while (i < pending.length() && !isSpace(pending.charAt(i))) {
            i++;
        }
        String token = pending.substring(0, i);
        pending = pending.substring(i);
        return token;
    }

    /**
     * The rest of the current line, or the whole of the next one.
     *
     * Note the classic gotcha is preserved: after nextInt() this returns the
     * empty remainder of that line, exactly as the real Scanner does.
     */
    public String nextLine() {
        if (pending != null) {
            String line = pending;
            pending = null;
            return line;
        }
        String line = readLineFromHost();
        if (line == null) {
            throw new NoSuchElementException("No line found");
        }
        return line;
    }

    public int nextInt() {
        return Integer.parseInt(next().trim());
    }

    public long nextLong() {
        return Long.parseLong(next().trim());
    }

    public double nextDouble() {
        return Double.parseDouble(next().trim());
    }

    public float nextFloat() {
        return Float.parseFloat(next().trim());
    }

    public boolean nextBoolean() {
        return Boolean.parseBoolean(next().trim());
    }

    private String peekToken() {
        if (!ensureToken()) {
            return null;
        }
        int i = 0;
        while (i < pending.length() && !isSpace(pending.charAt(i))) {
            i++;
        }
        return pending.substring(0, i).trim();
    }

    public boolean hasNextInt() {
        String token = peekToken();
        if (token == null) {
            return false;
        }
        try {
            Integer.parseInt(token);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public boolean hasNextDouble() {
        String token = peekToken();
        if (token == null) {
            return false;
        }
        try {
            Double.parseDouble(token);
            return true;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public void close() {
    }
}
`

/**
 * Rewrites the few constructs the browser compiler cannot accept.
 *
 * Both replacements keep the source on the same line and the same number of
 * lines — blanking or deleting one would shift every diagnostic below it and
 * send the Problems tab to the wrong place.
 */
export function prepareSource(text: string): string {
  return text
    // Names a class TeaVM does not ship; the built-in Scanner takes its place.
    .replace(
      /^[ \t]*import[ \t]+java[ \t]*\.[ \t]*util[ \t]*\.[ \t]*Scanner[ \t]*;[ \t]*$/gm,
      '// [jcoder] Scanner is built in — this import was removed automatically.',
    )
    // An annotation with arguments crashes the browser build of javac, and this
    // one only ever silences warnings, so dropping it changes nothing that runs.
    // The character class excludes newlines on purpose: matching across lines
    // would collapse them and shift every diagnostic below.
    .replace(/@SuppressWarnings[ \t]*\([^)\r\n]*\)/g, '/* @SuppressWarnings */')
}

/** VFS path (`/Main.java`) → the name javac should see (`Main.java`). */
export function toCompilerPath(vfsPath: string): string {
  return vfsPath.replace(/^\/+/, '')
}

/** The inverse, for mapping a diagnostic's file back onto the editor. */
export function toVfsPath(compilerPath: string): string {
  return compilerPath.startsWith('/') ? compilerPath : `/${compilerPath}`
}

export interface CompilationUnit {
  path: string
  text: string
  /** True for the files jcoder adds itself, which must not surface in the UI. */
  injected: boolean
}

/**
 * The full set of sources handed to javac: the student's files, plus the
 * built-in `Scanner` unless they have written their own.
 */
export function buildCompilationUnits(
  sources: Array<{ path: string; text: string }>,
): CompilationUnit[] {
  const units: CompilationUnit[] = sources.map(source => ({
    path: toCompilerPath(source.path),
    text: prepareSource(source.text),
    injected: false,
  }))

  // Someone learning about classes may well write their own Scanner. Theirs
  // must win, or they would get a baffling "duplicate class" error from a file
  // they cannot see.
  const definesOwnScanner = units.some(unit => unit.path === SUPPORT_SOURCE_PATH)
  if (!definesOwnScanner) {
    units.unshift({ path: SUPPORT_SOURCE_PATH, text: SCANNER_SOURCE, injected: true })
  }
  return units
}

/**
 * Picks which `main` to run.
 *
 * `preferred` is whatever the user chose in the toolbar; it is honoured only if
 * javac still reports it, so deleting or renaming a class cannot leave the
 * picker pointing at something that no longer exists.
 */
export function chooseMainClass(candidates: string[], preferred: string | null): string | null {
  if (candidates.length === 0) return null
  if (preferred && candidates.includes(preferred)) return preferred
  const conventional = candidates.find(name => name === 'Main' || name.endsWith('.Main'))
  if (conventional) return conventional
  return [...candidates].sort((a, b) => a.localeCompare(b))[0]
}
