/**
 * File access for student programs, emulated against the IDE's own filesystem.
 *
 * ## Why this exists
 *
 * TeaVM has a virtual filesystem and `java.io.File` already delegates to it,
 * but nothing can put anything *into* it from here: the API that mounts one
 * lives in `org.teavm.runtime.fs`, which the browser compiler's class library
 * does not expose to javac. `java.nio.file` fails inside TeaVM's code
 * generator, and `FileReader`/`FileWriter` fail on a missing
 * `java.io.FileDescriptor`. So none of the real file APIs can be made to work
 * without patching the toolchain itself.
 *
 * What *does* work is the trick already used for `Scanner`: student code sits
 * in the unnamed package, so a class declared there shadows the `java.*` one of
 * the same name. This file injects unnamed-package `File`, `Files`, `Path`,
 * `Paths`, `FileReader`, `FileWriter`, `PrintWriter`, `FileInputStream` and
 * `FileOutputStream` that talk to the editor's filesystem through the host
 * bridge, so ordinary textbook code runs unchanged — text and bytes alike.
 *
 * The byte streams matter as much as the text ones: reading and writing binary
 * files is a normal exercise, and TeaVM's own `DataInputStream` and
 * `DataOutputStream` wrap these, so `writeInt`/`readInt` and friends work.
 *
 * ## How it reaches the files
 *
 * Each run is given a *snapshot* of the editor's files, held in the worker (see
 * `FileBridge`). Reads and writes are answered from that snapshot immediately —
 * no thread ever blocks for a file — and whatever the program changed is handed
 * back when the run ends, so the editor and any connected folder catch up.
 *
 * The conversation reuses the channel the console input bridge already
 * established, because no new one can be declared: a command goes to the host a
 * character at a time through `System.err`, and the reply comes back through
 * `System.currentTimeMillis()`. See `utils/javaSupport` for why it has to be
 * this way.
 */

/** Written to `System.err` to introduce a filesystem command. */
export const COMMAND_CHAR = 2

/**
 * The commands the host understands. Each is a single line:
 *
 *   `R <path>`            read a file       → its text, or "absent"
 *   `B <path>`            read a file's bytes → one character per byte
 *   `S <path>`            stat              → `f<size>`, `d`, or "absent"
 *   `L <path>`            list a directory  → one name per line
 *   `D <path>`            delete            → `ok`, or "absent"
 *   `M <path>`            make directories   → `ok`
 *   `W <chars> <path>`    write a file      → `ok`; the text follows the line,
 *                                             exactly `<chars>` characters long
 *   `Y <bytes> <path>`    write raw bytes   → `ok`; as above, one character
 *                                             per byte
 *
 * "absent" is the end-of-input marker rather than a string, so it can never be
 * confused with a file whose contents happen to say "absent". A length prefix
 * is used for writes so that the text can contain anything at all, including
 * newlines, without needing an escape.
 */
/** Path of the injected file-support source. */
export const FILE_SUPPORT_PATH = 'JCoderFiles.java'

/**
 * Which names in this file shadow a `java.*` class, and therefore whose imports
 * have to be neutralised for the shadow to win.
 *
 * A single-type import such as `import java.io.File;` names a class that either
 * does not exist here or does not work, and it would beat the unnamed-package
 * class in Java's resolution order. Blanking the import lets ours through.
 */
export const SHADOWED_IMPORTS = [
  'java.io.File',
  'java.io.FileReader',
  'java.io.FileWriter',
  'java.io.PrintWriter',
  'java.io.FileInputStream',
  'java.io.FileOutputStream',
  'java.nio.file.Files',
  'java.nio.file.Path',
  'java.nio.file.Paths',
]

/**
 * The injected classes.
 *
 * All but one are package-private, which is legal and keeps them in a single
 * compilation unit: student code lives in the same (unnamed) package, so it can
 * still use them.
 */
export const FILE_SUPPORT_SOURCE = `import java.io.IOException;
import java.io.FileNotFoundException;
import java.io.Reader;
import java.io.Writer;
import java.util.ArrayList;
import java.util.List;

/** Marker for the compilation unit; the useful classes are below. */
public final class JCoderFiles {
    private JCoderFiles() {
    }
}

/**
 * Talks to the editor's filesystem. Added by jcoder; you do not need to call
 * this yourself.
 */
final class JCoderFs {
    private static final char COMMAND = ${COMMAND_CHAR};
    private static final long END_OF_LINE = -1L;
    private static final long ABSENT = -2L;

    private JCoderFs() {
    }

    /** Turns "demo.txt", "./demo.txt" and "/demo.txt" into one spelling. */
    static String normalise(String path) {
        if (path == null) {
            return "/";
        }
        String p = path.replace('\\\\', '/');
        while (p.startsWith("./")) {
            p = p.substring(2);
        }
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        while (p.indexOf("//") >= 0) {
            p = p.replace("//", "/");
        }
        if (p.length() > 1 && p.endsWith("/")) {
            p = p.substring(0, p.length() - 1);
        }
        return p;
    }

    /** Sends a command and returns the reply, or null when the host says absent. */
    static String send(String command) {
        System.err.print(COMMAND);
        System.err.print(command);
        System.err.print('\\n');
        System.err.flush();
        return receive();
    }

    /** As above, with text following the command line. */
    static String sendWithText(String command, String text) {
        System.err.print(COMMAND);
        System.err.print(command);
        System.err.print('\\n');
        System.err.print(text);
        System.err.flush();
        return receive();
    }

    private static String receive() {
        StringBuilder sb = new StringBuilder();
        while (true) {
            long c = System.currentTimeMillis();
            if (c == END_OF_LINE) {
                return sb.toString();
            }
            if (c == ABSENT) {
                return null;
            }
            if (c < 0L || c > 65535L) {
                // The clock answered with a real time, so no reply is coming.
                return null;
            }
            sb.append((char) c);
        }
    }

    static String read(String path) {
        return send("R " + normalise(path));
    }

    /**
     * The file's bytes. Each arrives as one character in 0..255, which the
     * channel carries unchanged.
     */
    static byte[] readBytes(String path) {
        String wire = send("B " + normalise(path));
        if (wire == null) {
            return null;
        }
        byte[] bytes = new byte[wire.length()];
        for (int i = 0; i < wire.length(); i++) {
            bytes[i] = (byte) wire.charAt(i);
        }
        return bytes;
    }

    static void writeBytes(String path, byte[] bytes, int length) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) {
            sb.append((char) (bytes[i] & 0xFF));
        }
        String reply = sendWithText("Y " + length + " " + normalise(path), sb.toString());
        if (reply == null) {
            throw new IOException("Could not write " + path);
        }
    }

    static String stat(String path) {
        return send("S " + normalise(path));
    }

    static void write(String path, String text) throws IOException {
        String reply = sendWithText("W " + text.length() + " " + normalise(path), text);
        if (reply == null) {
            throw new IOException("Could not write " + path);
        }
    }

    static String[] list(String path) {
        String reply = send("L " + normalise(path));
        if (reply == null || reply.isEmpty()) {
            return reply == null ? null : new String[0];
        }
        return reply.split("\\n");
    }

    static boolean delete(String path) {
        return send("D " + normalise(path)) != null;
    }

    static boolean mkdirs(String path) {
        return send("M " + normalise(path)) != null;
    }
}

/** A file or folder in the editor's filesystem. */
class File {
    private final String path;

    File(String path) {
        this.path = JCoderFs.normalise(path);
    }

    File(String parent, String child) {
        this.path = JCoderFs.normalise(parent + "/" + child);
    }

    File(File parent, String child) {
        this.path = JCoderFs.normalise(parent.getPath() + "/" + child);
    }

    String getPath() {
        return path;
    }

    String getAbsolutePath() {
        return path;
    }

    String getName() {
        int i = path.lastIndexOf('/');
        return i < 0 ? path : path.substring(i + 1);
    }

    String getParent() {
        int i = path.lastIndexOf('/');
        if (i <= 0) {
            return i == 0 && path.length() > 1 ? "/" : null;
        }
        return path.substring(0, i);
    }

    File getParentFile() {
        String parent = getParent();
        return parent == null ? null : new File(parent);
    }

    boolean exists() {
        return JCoderFs.stat(path) != null;
    }

    boolean isFile() {
        String s = JCoderFs.stat(path);
        return s != null && s.startsWith("f");
    }

    boolean isDirectory() {
        String s = JCoderFs.stat(path);
        return s != null && s.startsWith("d");
    }

    long length() {
        String s = JCoderFs.stat(path);
        if (s == null || !s.startsWith("f")) {
            return 0L;
        }
        try {
            return Long.parseLong(s.substring(1));
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    boolean delete() {
        return JCoderFs.delete(path);
    }

    boolean mkdir() {
        return JCoderFs.mkdirs(path);
    }

    boolean mkdirs() {
        return JCoderFs.mkdirs(path);
    }

    boolean createNewFile() throws IOException {
        if (exists()) {
            return false;
        }
        JCoderFs.write(path, "");
        return true;
    }

    String[] list() {
        return JCoderFs.list(path);
    }

    File[] listFiles() {
        String[] names = JCoderFs.list(path);
        if (names == null) {
            return null;
        }
        File[] files = new File[names.length];
        for (int i = 0; i < names.length; i++) {
            files[i] = new File(path + "/" + names[i]);
        }
        return files;
    }

    public String toString() {
        return path;
    }
}

/** What Paths.get() returns. */
class Path {
    private final String value;

    Path(String value) {
        this.value = JCoderFs.normalise(value);
    }

    String toStringValue() {
        return value;
    }

    File toFile() {
        return new File(value);
    }

    Path getFileName() {
        return new Path(new File(value).getName());
    }

    Path getParent() {
        String parent = new File(value).getParent();
        return parent == null ? null : new Path(parent);
    }

    Path resolve(String other) {
        return new Path(value + "/" + other);
    }

    public String toString() {
        return value;
    }
}

class Paths {
    private Paths() {
    }

    static Path get(String first) {
        return new Path(first);
    }

    static Path get(String first, String second) {
        return new Path(first + "/" + second);
    }
}

class Files {
    private Files() {
    }

    private static String require(Path path) throws IOException {
        String text = JCoderFs.read(path.toString());
        if (text == null) {
            throw new java.io.FileNotFoundException(path.toString());
        }
        return text;
    }

    static List<String> readAllLines(Path path) throws IOException {
        String text = require(path);
        List<String> lines = new ArrayList<String>();
        if (text.isEmpty()) {
            return lines;
        }
        int start = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\\n') {
                String line = text.substring(start, i);
                if (line.endsWith("\\r")) {
                    line = line.substring(0, line.length() - 1);
                }
                lines.add(line);
                start = i + 1;
            }
        }
        if (start < text.length()) {
            String line = text.substring(start);
            if (line.endsWith("\\r")) {
                line = line.substring(0, line.length() - 1);
            }
            lines.add(line);
        }
        return lines;
    }

    static String readString(Path path) throws IOException {
        return require(path);
    }

    static void writeString(Path path, CharSequence text) throws IOException {
        JCoderFs.write(path.toString(), text.toString());
    }

    static void write(Path path, List<String> lines) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String line : lines) {
            sb.append(line);
            sb.append('\\n');
        }
        JCoderFs.write(path.toString(), sb.toString());
    }

    static boolean exists(Path path) {
        return JCoderFs.stat(path.toString()) != null;
    }

    static void createDirectories(Path path) throws IOException {
        JCoderFs.mkdirs(path.toString());
    }

    static void delete(Path path) throws IOException {
        if (!JCoderFs.delete(path.toString())) {
            throw new java.io.FileNotFoundException(path.toString());
        }
    }

    static byte[] readAllBytes(Path path) throws IOException {
        byte[] bytes = JCoderFs.readBytes(path.toString());
        if (bytes == null) {
            throw new java.io.FileNotFoundException(path.toString());
        }
        return bytes;
    }

    static void write(Path path, byte[] bytes) throws IOException {
        JCoderFs.writeBytes(path.toString(), bytes, bytes.length);
    }
}

/** Reads a file as raw bytes, so it can be wrapped in a DataInputStream. */
class FileInputStream extends java.io.InputStream {
    private final byte[] bytes;
    private int position;

    FileInputStream(String path) throws FileNotFoundException {
        this.bytes = open(path);
    }

    FileInputStream(File file) throws FileNotFoundException {
        this.bytes = open(file.getPath());
    }

    private static byte[] open(String path) throws FileNotFoundException {
        byte[] content = JCoderFs.readBytes(path);
        if (content == null) {
            throw new FileNotFoundException(path + " (no such file)");
        }
        return content;
    }

    public int read() {
        return position >= bytes.length ? -1 : bytes[position++] & 0xFF;
    }

    public int read(byte[] buffer, int offset, int length) {
        if (position >= bytes.length) {
            return -1;
        }
        int count = Math.min(length, bytes.length - position);
        for (int i = 0; i < count; i++) {
            buffer[offset + i] = bytes[position + i];
        }
        position += count;
        return count;
    }

    public int available() {
        return bytes.length - position;
    }

    public long skip(long count) {
        long moved = Math.min(count, bytes.length - position);
        position += (int) moved;
        return moved;
    }

    public void close() {
    }
}

/** Collects raw bytes and saves them when closed. */
class FileOutputStream extends java.io.OutputStream {
    private final String path;
    private byte[] buffer = new byte[256];
    private int length;
    private boolean closed;

    FileOutputStream(String path) throws IOException {
        this(path, false);
    }

    FileOutputStream(File file) throws IOException {
        this(file.getPath(), false);
    }

    FileOutputStream(String path, boolean append) throws IOException {
        this.path = path;
        if (append) {
            byte[] existing = JCoderFs.readBytes(path);
            if (existing != null) {
                ensure(existing.length);
                for (int i = 0; i < existing.length; i++) {
                    buffer[i] = existing[i];
                }
                length = existing.length;
            }
        }
    }

    FileOutputStream(File file, boolean append) throws IOException {
        this(file.getPath(), append);
    }

    private void ensure(int extra) {
        if (length + extra <= buffer.length) {
            return;
        }
        int size = buffer.length;
        while (size < length + extra) {
            size *= 2;
        }
        byte[] grown = new byte[size];
        for (int i = 0; i < length; i++) {
            grown[i] = buffer[i];
        }
        buffer = grown;
    }

    public void write(int value) {
        ensure(1);
        buffer[length++] = (byte) value;
    }

    public void write(byte[] source, int offset, int count) {
        ensure(count);
        for (int i = 0; i < count; i++) {
            buffer[length + i] = source[offset + i];
        }
        length += count;
    }

    public void flush() throws IOException {
        JCoderFs.writeBytes(path, buffer, length);
    }

    public void close() throws IOException {
        if (!closed) {
            closed = true;
            flush();
        }
    }
}

/** Reads a file as characters, so it can be wrapped in a BufferedReader. */
class FileReader extends Reader {
    private final String text;
    private int position;

    FileReader(String path) throws FileNotFoundException {
        this.text = open(path);
    }

    FileReader(File file) throws FileNotFoundException {
        this.text = open(file.getPath());
    }

    private static String open(String path) throws FileNotFoundException {
        String content = JCoderFs.read(path);
        if (content == null) {
            throw new FileNotFoundException(path + " (no such file)");
        }
        return content;
    }

    public int read(char[] buffer, int offset, int length) {
        if (position >= text.length()) {
            return -1;
        }
        int count = Math.min(length, text.length() - position);
        for (int i = 0; i < count; i++) {
            buffer[offset + i] = text.charAt(position + i);
        }
        position += count;
        return count;
    }

    public int read() {
        return position >= text.length() ? -1 : text.charAt(position++);
    }

    public void close() {
    }
}

/** Collects everything written and saves it when closed. */
class FileWriter extends Writer {
    private final String path;
    private final StringBuilder buffer = new StringBuilder();
    private boolean closed;

    FileWriter(String path) throws IOException {
        this(path, false);
    }

    FileWriter(File file) throws IOException {
        this(file.getPath(), false);
    }

    FileWriter(String path, boolean append) throws IOException {
        this.path = path;
        if (append) {
            String existing = JCoderFs.read(path);
            if (existing != null) {
                buffer.append(existing);
            }
        }
    }

    FileWriter(File file, boolean append) throws IOException {
        this(file.getPath(), append);
    }

    /** Lets PrintWriter wrap this writer, which is a common way to write it. */
    String targetPath() {
        return path;
    }

    String buffered() {
        return buffer.toString();
    }

    public void write(char[] chars, int offset, int length) {
        buffer.append(chars, offset, length);
    }

    public void write(String text) {
        buffer.append(text);
    }

    public void write(int c) {
        buffer.append((char) c);
    }

    public void flush() throws IOException {
        JCoderFs.write(path, buffer.toString());
    }

    public void close() throws IOException {
        if (!closed) {
            closed = true;
            flush();
        }
    }
}

/** print/println onto a file, saved when closed. */
class PrintWriter {
    private final String path;
    private final StringBuilder buffer = new StringBuilder();
    private boolean closed;

    PrintWriter(String path) throws IOException {
        this.path = path;
    }

    PrintWriter(File file) throws IOException {
        this.path = file.getPath();
    }

    /** new PrintWriter(new FileWriter("out.txt")) — writes to the same file. */
    PrintWriter(FileWriter writer) throws IOException {
        this.path = writer.targetPath();
        this.buffer.append(writer.buffered());
    }

    public void print(String text) {
        buffer.append(text);
    }

    public void print(Object value) {
        // String.valueOf, because this class library declares
        // StringBuilder.append(Object) twice and the call is ambiguous.
        buffer.append(String.valueOf(value));
    }

    public void print(int value) {
        buffer.append(value);
    }

    public void print(long value) {
        buffer.append(value);
    }

    public void print(double value) {
        buffer.append(value);
    }

    public void print(char value) {
        buffer.append(value);
    }

    public void print(boolean value) {
        buffer.append(value);
    }

    public void println() {
        buffer.append('\\n');
    }

    public void println(String text) {
        buffer.append(text);
        buffer.append('\\n');
    }

    public void println(Object value) {
        buffer.append(String.valueOf(value));
        buffer.append('\\n');
    }

    public void println(int value) {
        buffer.append(value);
        buffer.append('\\n');
    }

    public void println(long value) {
        buffer.append(value);
        buffer.append('\\n');
    }

    public void println(double value) {
        buffer.append(value);
        buffer.append('\\n');
    }

    public void println(char value) {
        buffer.append(value);
        buffer.append('\\n');
    }

    public void println(boolean value) {
        buffer.append(value);
        buffer.append('\\n');
    }

    public void flush() {
        try {
            JCoderFs.write(path, buffer.toString());
        } catch (IOException e) {
            // Matches java.io.PrintWriter, which never throws from print methods.
        }
    }

    public void close() {
        if (!closed) {
            closed = true;
            flush();
        }
    }
}
`
