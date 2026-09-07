/**
 * Makes division by zero catchable, by rewriting it before javac sees it.
 *
 * ## Why this exists
 *
 * TeaVM's WasmGC backend lowers integer division straight onto the machine
 * instruction, so `a / 0` raises a WebAssembly *trap* rather than a Java
 * exception. Traps are non-catchable by design, so a student's
 * `catch (ArithmeticException e)` never runs and the program simply stops.
 *
 * The other three cases of this — null dereference, array bounds and bad casts
 * — are fixed by turning on TeaVM's `strict` mode (see `teavmRuntime`). Division
 * is not: there is a `NullCheckInsertion` and a `BoundCheckInsertion` in TeaVM
 * but no division equivalent, and konsoletyper declined to add a naive one in
 * konsoletyper/teavm#1249, because doing it without a cost would need range
 * analysis to prove divisors non-zero.
 *
 * That reasoning is about production compilers. A playground program runs for a
 * couple of seconds, so the naive check is exactly what we want — we just have
 * to insert it ourselves.
 *
 * ## How
 *
 * `a / b` becomes `JCoderMath.div(a, b)`, whose `int` and `long` overloads
 * throw a real `ArithmeticException` before dividing. Anything Java code throws
 * is caught normally here, so a `try`/`catch` around it behaves like Java's.
 *
 * The overload set is the whole trick, and it is why both operands have to be
 * passed rather than just the divisor. Java picks the overload by *binary
 * numeric promotion*, which is the same rule that decides whether the division
 * itself is integer or floating point — so `total / count` on two ints lands on
 * `div(int, int)` and throws, while `1.0 / 0` widens to `div(double, double)`
 * and yields `Infinity`, exactly as Java requires. Guarding only the divisor
 * would look like half the work and get that second case wrong.
 *
 * ## What is deliberately left alone
 *
 * The scan is conservative: anything it cannot delimit with certainty is left
 * as it was, because a division that keeps today's behaviour is much better
 * than one whose meaning we have quietly changed. In particular it skips
 * divisions by a non-zero literal (`x / 2` cannot throw, and rewriting it would
 * stop the expression being a compile-time constant), a divisor that begins
 * with a cast or `new`, and a dividend that ends in `++` or `--`.
 *
 * Rewritten lines keep their line number but not their column, since the
 * replacement is longer than the original. Diagnostics on a line containing a
 * division can therefore point a few characters off.
 */

/** The class names this unit occupies in the unnamed package. */
export const MATH_HELPER_CLASSES = ['JCoderMath']

/** Path of the injected helper, as javac sees it. */
export const MATH_HELPER_PATH = 'JCoderMath.java'

/**
 * Integer division that throws rather than trapping.
 *
 * The `b == -1` branches are not an optimisation: `Integer.MIN_VALUE / -1`
 * overflows, which the WasmGC backend also reports as a trap ("divide result
 * unrepresentable") where the JLS (§15.17.2) defines the result as
 * `Integer.MIN_VALUE`. Negation wraps to the same value, so `-a` gives the
 * answer Java asks for without ever reaching the machine instruction.
 *
 * The `float` and `double` overloads exist purely so that overload resolution
 * has somewhere to send floating-point division; they must *not* check for
 * zero, because `1.0 / 0` is `Infinity` in Java, not an error.
 */
export const MATH_HELPER_SOURCE = `/**
 * Division that reports dividing by zero as a Java exception you can catch.
 * Added by jcoder; you do not need to call it yourself.
 */
final class JCoderMath {
    private JCoderMath() {
    }

    static int div(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        if (b == -1) {
            // Avoids the overflow of Integer.MIN_VALUE / -1, which also traps.
            return -a;
        }
        return a / b;
    }

    static long div(long a, long b) {
        if (b == 0L) {
            throw new ArithmeticException("/ by zero");
        }
        if (b == -1L) {
            return -a;
        }
        return a / b;
    }

    static float div(float a, float b) {
        return a / b;
    }

    static double div(double a, double b) {
        return a / b;
    }

    static int rem(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        if (b == -1) {
            return 0;
        }
        return a % b;
    }

    static long rem(long a, long b) {
        if (b == 0L) {
            throw new ArithmeticException("/ by zero");
        }
        if (b == -1L) {
            return 0L;
        }
        return a % b;
    }

    static float rem(float a, float b) {
        return a % b;
    }

    static double rem(double a, double b) {
        return a % b;
    }

    /**
     * Checks the divisor of a compound assignment such as \`x /= y\`, and
     * returns it unchanged. The dividend is passed only so that overload
     * resolution promotes the pair exactly as the division itself would.
     */
    static int divisor(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("/ by zero");
        }
        return b;
    }

    static long divisor(long a, long b) {
        if (b == 0L) {
            throw new ArithmeticException("/ by zero");
        }
        return b;
    }

    static float divisor(float a, float b) {
        return b;
    }

    static double divisor(double a, double b) {
        return b;
    }
}
`

const WORD_CHAR = /[A-Za-z0-9_$]/

/** A numeric literal, anchored at the start of the slice it is given. */
const NUMERIC_LITERAL =
  /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?)[lLfFdD]?/

/** What may sit inside the brackets of a cast — a type and nothing else. */
const TYPE_SHAPE = /^\s*[A-Za-z_$][A-Za-z0-9_$.\s]*(?:<[^<>]*>)?(?:\s*\[\s*\])*\s*$/

/**
 * Keywords whose `(…)` is a clause rather than a cast, so that half-written code
 * like `if (flag) total / n` cannot be read as one.
 *
 * `return` must *not* be here: `return (double) total / n;` is the commonest
 * place of all for a real cast, and treating it as a clause silently turns the
 * division back into an integer one.
 */
const CLAUSE_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'synchronized'])

/**
 * Words that begin a statement or clause rather than belonging to the
 * expression inside it, so the backwards scan stops in front of them.
 *
 * `new` is deliberately absent: it is part of the primary that follows it, and
 * is handled where the scan meets it.
 */
const STOP_KEYWORDS = new Set([
  ...CLAUSE_KEYWORDS,
  'return', 'else', 'do', 'case', 'throw', 'assert', 'yield',
  'instanceof', 'extends', 'implements', 'default',
])

function isWordChar(character: string | undefined): boolean {
  return character !== undefined && WORD_CHAR.test(character)
}

/** Index of the last non-space character at or before `from`, or -1. */
function skipSpaceBack(text: string, from: number): number {
  let i = from
  while (i >= 0 && /\s/.test(text[i])) i--
  return i
}

/** Index of the next non-space character at or after `from`, or `text.length`. */
function skipSpaceForward(text: string, from: number): number {
  let i = from
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Given the index of a `)` or `]`, the index of its partner, or null. */
function matchBackwards(text: string, closeIndex: number): number | null {
  const close = text[closeIndex]
  const open = close === ')' ? '(' : '['
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    if (text[i] === close) depth++
    else if (text[i] === open && --depth === 0) return i
  }
  return null
}

/** Given the index of a `(` or `[`, the index of its partner, or null. */
function matchForwards(text: string, openIndex: number): number | null {
  const open = text[openIndex]
  const close = open === '(' ? ')' : ']'
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return null
}

/** The word ending at `end`, used to tell `if (…)` from a cast. */
function wordEndingAt(text: string, end: number): string {
  let i = end
  while (i >= 0 && isWordChar(text[i])) i--
  return text.slice(i + 1, end + 1)
}

/**
 * Start of the postfix expression ending at `endIndex`, following `.` chains,
 * bracket groups and any cast in front of them. Null when the text does not end
 * in something this can delimit, which aborts the rewrite.
 */
function primaryStartBefore(text: string, endIndex: number): number | null {
  let i = skipSpaceBack(text, endIndex)
  if (i < 0) return null
  let start: number | null = null

  for (;;) {
    const character = text[i]

    if (character === ')' || character === ']') {
      const open = matchBackwards(text, i)
      if (open === null) return null
      // `while (i > 0) x / y` is not a cast, whatever it looks like.
      const before = skipSpaceBack(text, open - 1)
      if (before >= 0 && isWordChar(text[before])
        && CLAUSE_KEYWORDS.has(wordEndingAt(text, before))) {
        return start
      }
      start = open
      i = before
      if (i < 0) return start
      if (isWordChar(text[i]) || text[i] === ')' || text[i] === ']' || text[i] === '.') continue
      return start
    }

    if (isWordChar(character)) {
      let j = i
      while (j >= 0 && isWordChar(text[j])) j--
      // A keyword is where the expression starts, not part of it: swallowing
      // the `return` of `return (double) t / n` would produce nonsense.
      if (STOP_KEYWORDS.has(text.slice(j + 1, i + 1))) return start
      start = j + 1
      i = skipSpaceBack(text, j)
      if (i < 0) return start

      // `new Counter().total` — `new` belongs to the primary and ends it.
      if (isWordChar(text[i]) && wordEndingAt(text, i) === 'new') {
        return i - 2
      }

      if (text[i] === '.') {
        i = skipSpaceBack(text, i - 1)
        if (i < 0) return null
        continue
      }

      // `(double) total / count` — the cast belongs to the dividend, and
      // dropping it would turn a floating-point division into an integer one.
      if (text[i] === ')') {
        const open = matchBackwards(text, i)
        if (open === null) return null
        const before = skipSpaceBack(text, open - 1)
        if (before >= 0 && isWordChar(text[before])
          && CLAUSE_KEYWORDS.has(wordEndingAt(text, before))) {
          return start
        }
        // Anything that is not plainly a type is not worth guessing about.
        if (!TYPE_SHAPE.test(text.slice(open + 1, i))) return null
        start = open
        i = before
        if (i < 0) return start
        if (isWordChar(text[i]) || text[i] === ')' || text[i] === ']' || text[i] === '.') continue
        return start
      }

      return start
    }

    return null
  }
}

/** Extends an operand leftwards over prefix `~`, `++` and `--`. */
function withPrefixOperators(text: string, start: number): number {
  let result = start
  for (;;) {
    const i = skipSpaceBack(text, result - 1)
    if (i < 0) return result
    if (text[i] === '~') { result = i; continue }
    if ((text[i] === '-' || text[i] === '+') && text[i - 1] === text[i]) {
      result = i - 1
      continue
    }
    return result
  }
}

/**
 * Start of the dividend: the whole multiplicative chain ending at the operator,
 * since `*`, `/` and `%` share a precedence level and associate leftwards, so
 * `a * b / c` divides `a * b` and not `b`.
 */
function leftOperandStart(text: string, operatorIndex: number): number | null {
  let end = operatorIndex - 1
  for (;;) {
    const primary = primaryStartBefore(text, end)
    if (primary === null) return null
    const start = withPrefixOperators(text, primary)
    const before = skipSpaceBack(text, start - 1)
    if (before < 0) return start
    const character = text[before]
    const isMultiplicative = character === '*' || character === '/' || character === '%'
    if (isMultiplicative && text[before + 1] !== '=') {
      end = before - 1
      continue
    }
    return start
  }
}

/** Where the divisor ends (exclusive), or null when it cannot be delimited. */
function rightOperandEnd(text: string, operatorIndex: number): number | null {
  let i = skipSpaceForward(text, operatorIndex + 1)

  // Prefix operators bind tighter than division, so they are part of the
  // divisor. A cast is too, but telling `(int) x` from `(a) + b` reliably is
  // not worth it — those divisions keep the behaviour they have today.
  for (;;) {
    const character = text[i]
    if (character === '-' || character === '+') {
      i = skipSpaceForward(text, text[i + 1] === character ? i + 2 : i + 1)
      continue
    }
    if (character === '~' || character === '!') {
      i = skipSpaceForward(text, i + 1)
      continue
    }
    break
  }
  if (i >= text.length) return null

  if (text[i] === '(') {
    const close = matchForwards(text, i)
    if (close === null) return null
    const after = skipSpaceForward(text, close + 1)
    // `(int) x` — a parenthesised expression is never followed by another one.
    if (after < text.length && (isWordChar(text[after]) || text[after] === '(')) return null
    return postfixEnd(text, close + 1)
  }

  const literal = NUMERIC_LITERAL.exec(text.slice(i))
  if (literal) return i + literal[0].length

  if (!isWordChar(text[i]) || /[0-9]/.test(text[i])) return null
  let j = i
  while (j < text.length && isWordChar(text[j])) j++
  // `a / new int[2][0]` and friends: too rare to be worth delimiting.
  if (text.slice(i, j) === 'new') return null
  return postfixEnd(text, j)
}

/** Follows `.name`, `(…)`, `[…]` and a trailing `++` / `--` from `from`. */
function postfixEnd(text: string, from: number): number | null {
  let end = from
  for (;;) {
    const i = skipSpaceForward(text, end)
    if (i >= text.length) return end
    if (text[i] === '(' || text[i] === '[') {
      const close = matchForwards(text, i)
      if (close === null) return null
      end = close + 1
      continue
    }
    if (text[i] === '.') {
      const j = skipSpaceForward(text, i + 1)
      if (j >= text.length || !isWordChar(text[j])) return end
      let k = j
      while (k < text.length && isWordChar(text[k])) k++
      end = k
      continue
    }
    if ((text[i] === '+' || text[i] === '-') && text[i + 1] === text[i]) {
      end = i + 2
      continue
    }
    return end
  }
}

/** True when a divisor is a literal that cannot be zero, so needs no check. */
function isNonZeroLiteral(source: string): boolean {
  const literal = NUMERIC_LITERAL.exec(source.trim())
  if (!literal || literal[0].length !== source.trim().length) return false
  const digits = literal[0].replace(/[_lLfFdD]/g, '')
  const value = digits.startsWith('0b') || digits.startsWith('0B')
    ? Number.parseInt(digits.slice(2), 2)
    : Number(digits)
  return Number.isFinite(value) && value !== 0
}

/**
 * `x /= y` becomes `x /= JCoderMath.divisor(x, y)`.
 *
 * The compound form cannot go through `div`, because `x /= y` carries an
 * implicit narrowing cast back to `x`'s type that we would have to reproduce
 * without knowing what that type is. Checking the divisor in place leaves the
 * cast where it is. The dividend is repeated, so this is limited to plain names
 * — `x` and `this.total`, never `queue[next()]`, which would run twice.
 */
const COMPOUND_ASSIGNMENT =
  /(^|[;{}()]|\bfor\b|\belse\b|\bdo\b|:)(\s*)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(\s*)([/%])=/g

function rewriteCompoundAssignments(original: string, blanked: string): [string, string] {
  let out = original
  let mask = blanked
  let offset = 0
  for (const match of [...blanked.matchAll(COMPOUND_ASSIGNMENT)]) {
    const target = match[3]
    const operatorEnd = match.index + match[0].length
    const end = statementEnd(mask, operatorEnd + offset)
    if (end === null) continue
    const at = operatorEnd + offset
    const divisor = out.slice(at, end)
    const divisorMask = mask.slice(at, end)
    if (!divisorMask.trim() || isNonZeroLiteral(divisorMask)) continue
    // Spliced without trimming: `out` and `mask` must stay the same length, and
    // a blanked literal is spaces where the original has text.
    const replace = (text: string, expression: string) =>
      `${text.slice(0, at)} JCoderMath.divisor(${target},${expression})${text.slice(end)}`
    out = replace(out, divisor)
    mask = replace(mask, divisorMask)
    offset = out.length - original.length
  }
  return [out, mask]
}

/** End of the expression starting at `from`, at the `;` or `)` that closes it. */
function statementEnd(text: string, from: number): number | null {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const character = text[i]
    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') {
      if (depth === 0) return character === ')' ? i : null
      depth--
    } else if (character === ';' && depth === 0) return i
    else if (character === ',' && depth === 0) return i
  }
  return null
}

/**
 * Rewrites every division and remainder the scan can delimit onto `JCoderMath`.
 *
 * `blanked` is the same text with string literals, character literals and
 * comments replaced by spaces (see `blankLiteralsAndComments`). Both are
 * carried along together and spliced identically, so operand boundaries are
 * decided on text that cannot contain a `/` inside a string, while the output
 * keeps the student's literals intact.
 */
export function rewriteDivision(text: string, blanked: string): string {
  if (!/[/%]/.test(blanked)) return text

  let [out, mask] = rewriteCompoundAssignments(text, blanked)

  let from = 0
  for (;;) {
    let operator = -1
    for (let i = from; i < mask.length; i++) {
      if ((mask[i] === '/' || mask[i] === '%') && mask[i + 1] !== '=' && mask[i - 1] !== '=') {
        operator = i
        break
      }
    }
    if (operator === -1) return out

    const start = leftOperandStart(mask, operator)
    const end = start === null ? null : rightOperandEnd(mask, operator)
    if (start === null || end === null || isNonZeroLiteral(mask.slice(operator + 1, end))) {
      from = operator + 1
      continue
    }

    const method = mask[operator] === '/' ? 'div' : 'rem'
    // Operands are spliced verbatim rather than trimmed, so that `out` and
    // `mask` stay character-for-character the same length; a blanked string
    // literal is spaces where the original has text, and trimming the two would
    // remove different amounts and put every later index out by that much.
    const splice = (source: string) =>
      `${source.slice(0, start)}JCoderMath.${method}(${source.slice(start, operator)},`
      + `${source.slice(operator + 1, end)})${source.slice(end)}`
    const rewritten = splice(out)
    // The two strings must stay the same length, or every later index is wrong.
    const rewrittenMask = splice(mask)
    from = rewritten.length - (out.length - end)
    out = rewritten
    mask = rewrittenMask
  }
}
