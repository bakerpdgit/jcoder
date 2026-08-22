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

import {
  FILE_SUPPORT_PATH, FILE_SUPPORT_SOURCE, SHADOWED_IMPORTS,
} from './javaFileSystem'

export { FILE_SUPPORT_PATH } from './javaFileSystem'

/** The class names the file-support unit occupies in the unnamed package. */
export const FILE_SUPPORT_CLASSES = [
  'JCoderFiles', 'JCoderFs', 'File', 'Path', 'Paths', 'Files',
  'FileReader', 'FileWriter', 'PrintWriter',
  'FileInputStream', 'FileOutputStream',
]

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
 *
 * `withFileSupport` adds the `Scanner(File)` constructor. It is conditional
 * because `File` comes from the separately-injected file-support unit, which is
 * left out when a student's own class would collide with it — and a Scanner
 * referring to a class that is not there would fail to compile.
 */
export function scannerSource(withFileSupport: boolean): string {
  return `import java.io.InputStream;
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
    /** Set when this Scanner reads a file rather than the console. */
    private String[] fileLines;
    private int fileLineIndex;

    public Scanner() {
    }

    /** The stream is ignored: input always comes from the console panel. */
    public Scanner(InputStream ignored) {
    }
${withFileSupport ? SCANNER_FILE_CONSTRUCTOR : ''}

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
        if (fileLines != null) {
            if (fileLineIndex >= fileLines.length) {
                eof = true;
                return null;
            }
            return fileLines[fileLineIndex++];
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
}

/**
 * The `new Scanner(new File("data.txt"))` constructor.
 *
 * The whole file is read once and then served line by line, so a Scanner over a
 * file behaves like one over the console — `nextLine`, `nextInt` and the rest
 * all work unchanged, and run out at the end of the file rather than blocking.
 */
const SCANNER_FILE_CONSTRUCTOR = `
    /** Reads from a file in the editor rather than from the console. */
    public Scanner(File source) throws java.io.FileNotFoundException {
        String text = JCoderFs.read(source.getPath());
        if (text == null) {
            throw new java.io.FileNotFoundException(source.getPath());
        }
        java.util.List<String> collected = new java.util.ArrayList<String>();
        int start = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\\n') {
                String line = text.substring(start, i);
                if (line.endsWith("\\r")) {
                    line = line.substring(0, line.length() - 1);
                }
                collected.add(line);
                start = i + 1;
            }
        }
        if (start < text.length()) {
            collected.add(text.substring(start));
        }
        fileLines = collected.toArray(new String[0]);
    }
`

/**
 * Rewrites the few constructs the browser compiler cannot accept.
 *
 * Both replacements keep the source on the same line and the same number of
 * lines — blanking or deleting one would shift every diagnostic below it and
 * send the Problems tab to the wrong place.
 */
export function prepareSource(
  text: string,
  options: { shadowFileClasses?: boolean } = {},
): string {
  const withFileImports = options.shadowFileClasses === true
  return (withFileImports ? stripShadowedImports(text) : text)
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

/** Builds the pattern that matches a single-type import of `qualifiedName`. */
function importPattern(qualifiedName: string): RegExp {
  const spaced = qualifiedName.split('.').join('[ \\t]*\\.[ \\t]*')
  return new RegExp(`^[ \\t]*import[ \\t]+${spaced}[ \\t]*;[ \\t]*$`, 'gm')
}

/**
 * Neutralises the imports that would otherwise beat jcoder's own classes.
 *
 * A single-type import outranks a class in the current package, so
 * `import java.io.File;` would pull in TeaVM's `File` — which compiles and then
 * silently finds nothing — instead of the one wired to the editor's files. An
 * on-demand `import java.io.*;` is left alone, because the unnamed package
 * already wins against those.
 */
function stripShadowedImports(text: string): string {
  let result = text
  for (const name of SHADOWED_IMPORTS) {
    result = result.replace(
      importPattern(name),
      `// [jcoder] ${name} is built in here — this import was removed automatically.`,
    )
  }
  return result
}

/** `e.getMessage()` written against a plain variable — the form worth rewriting. */
const SIMPLE_GET_MESSAGE = /\b([A-Za-z_$][\w$]*)[ \t]*\.[ \t]*getMessage[ \t]*\([ \t]*\)/g

/** A `getMessage` method of the student's own, which must be left alone. */
const DECLARES_GET_MESSAGE = /\b(?:String|CharSequence|Object)[ \t]+getMessage[ \t]*\([ \t]*\)/

/**
 * Points `e.getMessage()` at the stand-in, since the real one cannot be called
 * (see `ERROR_HELPER_SOURCE`).
 *
 * Only the simple `identifier.getMessage()` form is rewritten. Anything more
 * involved — `lookUp().getMessage()`, `this.error.getMessage()` — is left for
 * javac to reject, with the explanation `explainDiagnostic` attaches, because a
 * regular expression cannot tell what the receiver's type is and guessing wrong
 * would silently change what the program does.
 */
export function rewriteGetMessage(text: string): string {
  return text.replace(SIMPLE_GET_MESSAGE, (whole, receiver: string) =>
    // `JCoderErr.messageOf(...)` would itself match on a later pass; it never
    // sees one, but keeping the guard makes the function safe to apply twice.
    receiver === 'JCoderErr' ? whole : `JCoderErr.messageOf(${receiver})`)
}

/** Path of the injected `Throwable.getMessage()` stand-in. */
export const ERROR_HELPER_PATH = 'JCoderErr.java'

/**
 * A stand-in for `Throwable.getMessage()`, which cannot be called at all here.
 *
 * TeaVM declares the method as `getMessage0` and annotates it `@Rename`, and
 * only its *own* compiler applies that rename. So javac — which reads the SDK
 * as-is — offers `getMessage0` and not `getMessage`, while TeaVM links
 * `getMessage` and not `getMessage0`. Neither name works from source: the two
 * halves of the toolchain disagree about what the method is called.
 *
 * `toString()` works in both, and `Throwable.toString()` is defined as the
 * class name, then ": ", then the message. So the message can be recovered by
 * splitting on the first ": " — a class name can contain neither a colon nor a
 * space, so the first occurrence is always the separator, and its absence
 * always means there was no message.
 *
 * `getClass()` is unavailable for exactly the same reason as `getMessage()`,
 * which is why the class name is not obtained directly.
 */
export const ERROR_HELPER_SOURCE = `/**
 * Recovers Throwable.getMessage(), which cannot be called directly in this
 * environment. Added by jcoder; you do not need to call it yourself.
 */
final class JCoderErr {
    private JCoderErr() {
    }

    static String messageOf(Throwable t) {
        if (t == null) {
            return null;
        }
        String text = t.toString();
        int separator = text.indexOf(": ");
        if (separator < 0) {
            return null;
        }
        return text.substring(separator + 2);
    }
}
`

/**
 * Blanks out string literals, character literals and comments, replacing each
 * character with a space.
 *
 * Scans that look for unsupported APIs run over the result, so that a mention
 * inside a string or a comment cannot produce an error on a line that is
 * perfectly legal. Lengths and line breaks are preserved, so a column number
 * taken from the blanked text still points at the right place in the original.
 */
export function blankLiteralsAndComments(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '
    }
  }
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      const end = text.indexOf('\n', i)
      blank(i, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2)
      blank(i, end === -1 ? text.length : end + 2)
      i = end === -1 ? text.length : end + 2
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i]
      let j = i + 1
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j++
        if (text[j] === '\n') break
        j++
      }
      blank(i, Math.min(j + 1, text.length))
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

/** Something jcoder can tell the student before javac even sees the file. */
export interface SourceProblem {
  path: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
}

/**
 * APIs that exist in the compile-time class library but cannot actually work
 * here, each with the explanation a student needs.
 *
 * Catching these up front matters because the failure they produce otherwise is
 * unrecognisable: `java.nio.file` compiles cleanly and then makes TeaVM report
 * "Parameter 1 of method {{m0}} is marked with @JSByRef", and `FileReader`
 * fails with "cannot access java.io.FileDescriptor".
 */
const UNSUPPORTED_APIS: Array<{
  pattern: RegExp
  /** Blanked out before `pattern` runs, for spellings that are in fact fine. */
  except?: RegExp
  severity: 'error' | 'warning'
  message: string
}> = [
  {
    // The plain name resolves to jcoder's working class; the qualified one
    // names TeaVM's, which compiles and then finds nothing. Import lines are
    // skipped by the scanner, since those are rewritten rather than rejected.
    pattern: /\bjava\s*\.\s*(?:io|nio\s*\.\s*file)\s*\.\s*(?:File|Files|Path|Paths|FileReader|FileWriter|PrintWriter|FileInputStream|FileOutputStream)\b/,
    severity: 'error',
    message:
      'Write the plain class name rather than the full java.io / java.nio.file one.\n\n' +
      'For example `new File("data.txt")` rather than `new java.io.File("data.txt")`. ' +
      'The plain name is the version wired up to the files in the editor; the ' +
      'fully-qualified one is not, and would silently find nothing.',
  },
  {
    // Random access is the one file API left without a stand-in: the bridge
    // hands a whole file over at once, and a playground has no use for seeking.
    pattern: /\bRandomAccessFile\b/,
    severity: 'error',
    message:
      'RandomAccessFile is not supported here.\n\n' +
      'Reading and writing a whole file does work: use FileInputStream or ' +
      'FileOutputStream for bytes, or Scanner, FileReader, FileWriter and ' +
      'PrintWriter for text.',
  },
  {
    // TeaVM's WebAssembly backend raises these as machine-level traps rather
    // than Java objects, so they sail straight through a catch — even a
    // `catch (Exception e)` — and stop the program. Silently not catching an
    // exception is about the worst way for this to be discovered.
    pattern: /\bcatch\s*\(\s*(?:final\s+)?(?:java\s*\.\s*lang\s*\.\s*)?(?:ArithmeticException|ArrayIndexOutOfBoundsException|IndexOutOfBoundsException|NullPointerException)\b/,
    severity: 'warning',
    message:
      'This kind of error cannot be caught here.\n\n' +
      'Dividing by zero, reading past the end of an array and using a null ' +
      'reference stop the program in this environment instead of being caught — ' +
      'they come from the WebAssembly machine rather than from Java. Test for ' +
      'them with an if beforehand. Errors that Java code throws, such as ' +
      'NumberFormatException from Integer.parseInt, are caught normally.',
  },
  {
    pattern: /\bSystem\s*\.\s*in\b/,
    // `new Scanner(System.in)` is the form this whole app is built around: the
    // built-in Scanner ignores the stream it is handed. Warning about the one
    // spelling everybody is told to write — including the starter template —
    // would put a badge on the Problems tab on every single run.
    except: /\bScanner\s*\(\s*System\s*\.\s*in\s*\)/g,
    severity: 'warning',
    message:
      'System.in cannot be read directly here — every read reports the end of the ' +
      'stream. Read input with a Scanner instead: new Scanner(System.in) works, ' +
      'because the built-in Scanner ignores the stream it is given and reads from ' +
      'the console.',
  },
]

/**
 * Finds unsupported APIs before compiling, so the student gets a message about
 * their own line rather than an error from inside the compiler.
 */
export function checkUnsupportedApis(
  sources: Array<{ path: string; text: string }>,
): SourceProblem[] {
  const problems: SourceProblem[] = []
  for (const source of sources) {
    const lines = blankLiteralsAndComments(source.text).split('\n')
    // One report per file per rule. A program that reads a file mentions
    // java.nio.file on the import, on the declaration and again on the call;
    // three copies of the same paragraph is noise, and the first is where the
    // student should look anyway.
    const reported = new Set<string>()
    lines.forEach((line, index) => {
      // Imports naming a shadowed class are rewritten, not rejected.
      if (/^[ \t]*import[ \t]/.test(line)) return
      for (const api of UNSUPPORTED_APIS) {
        if (reported.has(api.message)) continue
        // Blanked rather than deleted, so the column still lines up.
        const scanned = api.except
          ? line.replace(api.except, hit => ' '.repeat(hit.length))
          : line
        const match = api.pattern.exec(scanned)
        if (!match) continue
        reported.add(api.message)
        problems.push({
          path: source.path,
          line: index + 1,
          column: match.index + 1,
          message: api.message,
          severity: api.severity,
        })
      }
    })
  }
  return problems
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

/** Top-level types a source file declares, for spotting name collisions. */
export function declaredTypeNames(text: string): Set<string> {
  const names = new Set<string>()
  const declaration = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g
  const blanked = blankLiteralsAndComments(text)
  let match: RegExpExecArray | null
  while ((match = declaration.exec(blanked)) !== null) names.add(match[1])
  return names
}

export interface CompilationPlan {
  units: CompilationUnit[]
  /**
   * Names the student used that jcoder also wanted, so file support had to be
   * left out. Empty in the normal case.
   */
  fileSupportBlockedBy: string[]
}

/**
 * The full set of sources handed to javac: the student's files, plus the
 * built-in `Scanner`, the file-support classes, and the `getMessage` helper if
 * anything needed it.
 *
 * Injecting file support unconditionally costs about 100ms of javac and nothing
 * at all in the generated module, because TeaVM drops the classes a program
 * does not use. That is cheaper than working out whether it is needed.
 */
export function planCompilation(
  sources: Array<{ path: string; text: string }>,
): CompilationPlan {
  // A student who has written their own getMessage() — on a custom exception,
  // say — has a method that genuinely works, so their calls must be left to
  // resolve to it. One declaration anywhere turns the rewrite off everywhere,
  // which is blunt but never wrong in the dangerous direction.
  const declaresGetMessage = sources.some(source =>
    DECLARES_GET_MESSAGE.test(blankLiteralsAndComments(source.text)))

  // `Path` is a name a student might genuinely want — a maze exercise, say — so
  // a collision has to lose gracefully rather than produce a duplicate-class
  // error against a file they cannot open.
  const studentTypes = new Set<string>()
  for (const source of sources) {
    for (const name of declaredTypeNames(source.text)) studentTypes.add(name)
  }
  const fileSupportBlockedBy = FILE_SUPPORT_CLASSES.filter(name => studentTypes.has(name))
  const withFileSupport = fileSupportBlockedBy.length === 0

  let rewroteGetMessage = false
  const units: CompilationUnit[] = sources.map((source) => {
    const prepared = prepareSource(source.text, { shadowFileClasses: withFileSupport })
    const text = declaresGetMessage ? prepared : rewriteGetMessage(prepared)
    if (text !== prepared) rewroteGetMessage = true
    return { path: toCompilerPath(source.path), text, injected: false }
  })

  // Someone learning about classes may well write their own Scanner. Theirs
  // must win, or they would get a baffling "duplicate class" error from a file
  // they cannot see.
  const definesOwnScanner = units.some(unit => unit.path === SUPPORT_SOURCE_PATH)
  if (!definesOwnScanner && !studentTypes.has('Scanner')) {
    units.unshift({
      path: SUPPORT_SOURCE_PATH,
      text: scannerSource(withFileSupport),
      injected: true,
    })
  }

  if (withFileSupport && !units.some(unit => unit.path === FILE_SUPPORT_PATH)) {
    units.unshift({ path: FILE_SUPPORT_PATH, text: FILE_SUPPORT_SOURCE, injected: true })
  }

  // Only carried when something actually calls it, so a program that never
  // touches exceptions does not pay to compile it.
  const definesOwnHelper = units.some(unit => unit.path === ERROR_HELPER_PATH)
  if (rewroteGetMessage && !definesOwnHelper) {
    units.unshift({ path: ERROR_HELPER_PATH, text: ERROR_HELPER_SOURCE, injected: true })
  }
  return { units, fileSupportBlockedBy }
}

/** Backwards-compatible view of `planCompilation` for callers wanting only the sources. */
export function buildCompilationUnits(
  sources: Array<{ path: string; text: string }>,
): CompilationUnit[] {
  return planCompilation(sources).units
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
