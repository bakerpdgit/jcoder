import { describe, expect, it } from 'vitest'
import { MATH_HELPER_SOURCE, rewriteDivision } from './javaDivision'
import { blankLiteralsAndComments } from './javaSupport'
import { EXAMPLES } from './examples'

/** The rewrite as the compiler pipeline applies it. */
function rewrite(source: string): string {
  return rewriteDivision(source, blankLiteralsAndComments(source))
}

/** Whitespace is not what these tests are about; javac does not care either. */
function tidy(source: string): string {
  return rewrite(source).replace(/\s+/g, ' ').trim()
}

describe('rewriting division onto the checked helper', () => {
  it('rewrites a division between two variables', () => {
    expect(tidy('int c = a / b;')).toBe('int c = JCoderMath.div(a , b);')
  })

  it('rewrites remainder onto its own method', () => {
    expect(tidy('int c = a % b;')).toBe('int c = JCoderMath.rem(a , b);')
  })

  it('leaves a division by a literal alone, since it cannot throw', () => {
    // Also keeps the expression a compile-time constant, which `case` needs.
    expect(tidy('int half = total / 2;')).toBe('int half = total / 2;')
    expect(tidy('int c = a % 10;')).toBe('int c = a % 10;')
    expect(tidy('double d = x / 2.5;')).toBe('double d = x / 2.5;')
  })

  it('does rewrite a division by a literal zero', () => {
    expect(tidy('int c = a / 0;')).toBe('int c = JCoderMath.div(a , 0);')
  })
})

describe('operand boundaries', () => {
  it('binds tighter than addition', () => {
    expect(tidy('int c = a + b / d;')).toBe('int c = a + JCoderMath.div(b , d);')
    expect(tidy('int c = b / d + a;')).toBe('int c = JCoderMath.div(b , d) + a;')
  })

  it('takes the whole multiplicative chain as the dividend', () => {
    expect(tidy('int c = a * b / d;')).toBe('int c = JCoderMath.div(a * b , d);')
  })

  it('stops the divisor before an operator of equal precedence', () => {
    expect(tidy('int c = a / b * d;')).toBe('int c = JCoderMath.div(a , b) * d;')
  })

  it('nests left-associatively when divisions are chained', () => {
    expect(tidy('int c = a / b / d;')).toBe('int c = JCoderMath.div(JCoderMath.div(a , b) , d);')
  })

  it('keeps a cast with the dividend it belongs to', () => {
    // The classic average idiom: dropping the cast would make this an integer
    // division and quietly return the wrong answer.
    expect(tidy('double avg = (double) total / count;'))
      .toBe('double avg = JCoderMath.div((double) total , count);')
  })

  it('keeps a cast that follows return, where the average idiom usually is', () => {
    // Worked example 7 does exactly this, and printing 7.0 instead of 7.333
    // was the only sign that an earlier version of the scan had dropped it.
    expect(tidy('return (double) total / values.length;'))
      .toBe('return JCoderMath.div((double) total , values.length);')
  })

  it('keeps a cast in the other places a division tends to sit', () => {
    for (const context of ['x = %;', 'print(%);', 'return %;', 'if (% > 1) { }']) {
      const source = context.replace('%', '(double) total / count')
      expect(tidy(source)).toContain('JCoderMath.div((double) total , count)')
    }
  })

  it('takes a parenthesised expression whole', () => {
    expect(tidy('int c = (a + b) / d;')).toBe('int c = JCoderMath.div((a + b) , d);')
  })

  it('follows method calls and field chains on both sides', () => {
    expect(tidy('int c = list.size() / other.size();'))
      .toBe('int c = JCoderMath.div(list.size() , other.size());')
    expect(tidy('int c = this.total / this.count;'))
      .toBe('int c = JCoderMath.div(this.total , this.count);')
  })

  it('follows array indexing on both sides', () => {
    expect(tidy('int c = a[i] / b[j];')).toBe('int c = JCoderMath.div(a[i] , b[j]);')
  })

  it('keeps a prefix minus with the dividend it applies to', () => {
    expect(tidy('int c = -a / b;')).toBe('int c = -JCoderMath.div(a , b);')
    expect(tidy('int c = --a / b;')).toBe('int c = JCoderMath.div(--a , b);')
  })

  it('takes a prefix minus on the divisor', () => {
    expect(tidy('int c = a / -b;')).toBe('int c = JCoderMath.div(a , -b);')
  })

  it('works inside an argument list and a condition', () => {
    expect(tidy('System.out.println(a / b);'))
      .toBe('System.out.println(JCoderMath.div(a , b));')
    expect(tidy('if (a / b > c) { }')).toBe('if (JCoderMath.div(a , b) > c) { }')
  })

  it('works in the branches of a ternary', () => {
    expect(tidy('int c = flag ? a / b : d / e;'))
      .toBe('int c = flag ? JCoderMath.div(a , b) : JCoderMath.div(d , e);')
  })

  it('stops in front of the keyword that starts the statement', () => {
    expect(tidy('return a / b;')).toBe('return JCoderMath.div(a , b);')
    expect(tidy('throw a / b;')).toBe('throw JCoderMath.div(a , b);')
    expect(tidy('else x = a / b;')).toBe('else x = JCoderMath.div(a , b);')
  })

  it('keeps new with the object it constructs', () => {
    expect(tidy('int c = new Counter().total / n;'))
      .toBe('int c = JCoderMath.div(new Counter().total , n);')
  })

  it('does not mistake a control-flow condition for a cast', () => {
    // `while (n > 0) total / n;` is not valid Java, but a scan that read the
    // condition as a cast would silently produce something that was.
    expect(tidy('while (go) x = a / b;')).toBe('while (go) x = JCoderMath.div(a , b);')
    expect(tidy('for (int i = 0; i < n; i++) x = a / b;'))
      .toBe('for (int i = 0; i < n; i++) x = JCoderMath.div(a , b);')
  })
})

describe('what it refuses to touch', () => {
  const unchanged = (source: string) => expect(rewrite(source)).toBe(source)

  it('leaves divisions inside string and character literals alone', () => {
    unchanged('System.out.println("a / b = " + c);')
    unchanged("char slash = '/';")
    unchanged('String path = "one/two/three";')
  })

  it('leaves divisions inside comments alone', () => {
    unchanged('// divide a / b here\nint x = 1;')
    unchanged('/* a / b */\nint x = 1;')
  })

  it('leaves a divisor that begins with a cast alone', () => {
    unchanged('int c = a / (int) b;')
  })

  it('leaves a divisor built with new alone', () => {
    unchanged('int c = a / new Counter().value;')
  })

  it('leaves a dividend ending in a postfix operator alone', () => {
    unchanged('int c = a++ / b;')
  })

  it('leaves a character-literal dividend alone rather than guessing', () => {
    unchanged("int c = 'a' / b;")
  })

  it('does not rewrite its own output', () => {
    const once = rewrite('int c = a / b;')
    expect(rewriteDivision(once, blankLiteralsAndComments(once))).toBe(once)
  })

  it('leaves source with no division completely alone', () => {
    const source = 'public class Main {\n    public static void main(String[] a) {\n    }\n}\n'
    unchanged(source)
  })
})

describe('compound assignment', () => {
  it('checks the divisor in place, leaving the implicit cast alone', () => {
    expect(tidy('x /= y;')).toBe('x /= JCoderMath.divisor(x, y);')
    expect(tidy('x %= y;')).toBe('x %= JCoderMath.divisor(x, y);')
  })

  it('handles a field as the target', () => {
    expect(tidy('this.total /= count;')).toBe('this.total /= JCoderMath.divisor(this.total, count);')
  })

  it('skips a literal divisor, as elsewhere', () => {
    expect(tidy('x /= 2;')).toBe('x /= 2;')
  })

  it('works in the update clause of a for loop', () => {
    expect(tidy('for (int i = n; i > 0; i /= step) { }'))
      .toBe('for (int i = n; i > 0; i /= JCoderMath.divisor(i, step)) { }')
  })

  it('leaves a target that would be evaluated twice alone', () => {
    expect(rewrite('queue[next()] /= n;')).toBe('queue[next()] /= n;')
  })

  it('rewrites a division inside the divisor expression too', () => {
    expect(tidy('x /= a / b;')).toBe('x /= JCoderMath.divisor(x, JCoderMath.div(a , b));')
  })
})

describe('the shape of the output', () => {
  const programs = [
    'int c = a / b;',
    'double avg = (double) total / count;',
    'int c = a * b / d % e;',
    'System.out.println(a / b + " and " + c / d);',
    'for (int i = n; i > 0; i /= step) { total += i / count; }',
    'int[] r = { a / b, c / d };',
  ]

  it('keeps the number of lines, so diagnostics stay on their own line', () => {
    for (const program of programs) {
      const source = `class T {\n    void f() {\n        ${program}\n    }\n}\n`
      expect(rewrite(source).split('\n')).toHaveLength(source.split('\n').length)
    }
  })

  it('produces balanced brackets', () => {
    for (const program of programs) {
      const out = rewrite(program)
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        const count = (character: string) => out.split(character).length - 1
        expect(count(open)).toBe(count(close))
      }
    }
  })

  /** The two arguments of every call the rewrite produced. */
  function callArguments(rewritten: string): Array<[string, string]> {
    const calls: Array<[string, string]> = []
    const opening = /JCoderMath\.(?:div|rem|divisor)\(/g
    let match: RegExpExecArray | null
    while ((match = opening.exec(rewritten)) !== null) {
      const from = match.index + match[0].length
      let depth = 1
      let split = -1
      let i = from
      for (; i < rewritten.length && depth > 0; i++) {
        const character = rewritten[i]
        if (character === '(' || character === '[') depth++
        else if (character === ')' || character === ']') depth--
        else if (character === ',' && depth === 1 && split === -1) split = i
      }
      expect(split).toBeGreaterThan(-1)
      calls.push([rewritten.slice(from, split), rewritten.slice(split + 1, i - 1)])
    }
    return calls
  }

  /**
   * Both operands must look like expressions. This is the check that catches
   * the scan running too far: an argument beginning `return` or `else` is a
   * syntax error, and the only sign of it in the browser was a wrong number.
   */
  function expectPlausibleOperands(rewritten: string) {
    for (const [dividend, divisor] of callArguments(rewritten)) {
      for (const operand of [dividend, divisor]) {
        expect(operand.trim()).not.toBe('')
        expect(operand.trim()).not.toMatch(
          /^(?:return|else|do|case|throw|assert|yield|if|while|for|switch|catch)\b/)
        const count = (character: string) => operand.split(character).length - 1
        expect(count('(')).toBe(count(')'))
        expect(count('[')).toBe(count(']'))
      }
    }
  }

  it('produces operands that are expressions, in every worked example', () => {
    for (const example of EXAMPLES) expectPlausibleOperands(rewrite(example.source))
  })

  it('produces operands that are expressions, in the shapes divisions appear in', () => {
    const statements = [
      'return (double) total / values.length;',
      'return total / count;',
      'x = obj.count() / list.size();',
      'print("mean " + sum / n);',
      'if (total / n > 1) { }',
      'while (n / step > 0) { }',
      'for (int i = 0; i < len / step; i++) { }',
      'int[] parts = { a / b, c / d };',
      'return flag ? a / b : c / d;',
      'throw new Error("" + a / b);',
      'switch (a / b) { case 1: break; }',
      'total += subtotal / count;',
      'map.put(key, value / weight);',
      'double r = (double) (a + b) / (c - d);',
      'return new Counter().total / n;',
    ]
    for (const statement of statements) expectPlausibleOperands(rewrite(statement))
  })

  it('leaves every worked example with the same number of lines', () => {
    // The examples are the programs most likely to be run, and several of them
    // divide. A rewrite that broke one would only show up in the browser.
    for (const example of EXAMPLES) {
      const before = example.source.split('\n').length
      expect(rewrite(example.source).split('\n')).toHaveLength(before)
    }
  })
})

describe('the injected helper', () => {
  it('throws a real exception rather than relying on the machine', () => {
    expect(MATH_HELPER_SOURCE).toContain('throw new ArithmeticException("/ by zero")')
  })

  it('offers int, long, float and double overloads of each operation', () => {
    for (const method of ['div', 'rem', 'divisor']) {
      for (const type of ['int', 'long', 'float', 'double']) {
        expect(MATH_HELPER_SOURCE).toContain(`static ${type} ${method}(${type} a, ${type} b)`)
      }
    }
  })

  it('does not check the floating-point overloads, where zero is legal', () => {
    // 1.0 / 0 is Infinity in Java; throwing there would be a new bug, not a fix.
    for (const method of ['div', 'rem', 'divisor']) {
      for (const type of ['float', 'double']) {
        const from = MATH_HELPER_SOURCE.indexOf(`static ${type} ${method}(`)
        expect(from).toBeGreaterThan(-1)
        const body = MATH_HELPER_SOURCE.slice(from, MATH_HELPER_SOURCE.indexOf('}', from))
        expect(body).not.toContain('ArithmeticException')
      }
    }
  })

  it('checks both integer overloads of every operation', () => {
    for (const method of ['div', 'rem', 'divisor']) {
      for (const type of ['int', 'long']) {
        const from = MATH_HELPER_SOURCE.indexOf(`static ${type} ${method}(`)
        const body = MATH_HELPER_SOURCE.slice(from, MATH_HELPER_SOURCE.indexOf('\n    }', from))
        expect(body).toContain('ArithmeticException')
      }
    }
  })

  it('handles the overflowing division the machine also refuses', () => {
    // Integer.MIN_VALUE / -1 traps as "divide result unrepresentable"; the JLS
    // says the answer is Integer.MIN_VALUE, which negation gives.
    expect(MATH_HELPER_SOURCE).toContain('return -a;')
  })

  it('uses no annotation that takes arguments, which this javac cannot compile', () => {
    expect(MATH_HELPER_SOURCE).not.toMatch(/@[A-Za-z]+\s*\(/)
  })

  it('has no character literal running off the end of its line', () => {
    // The template-literal trap: '\n' written with one backslash becomes a real
    // newline and javac reports an error in a file the student cannot see.
    for (const line of MATH_HELPER_SOURCE.split('\n')) {
      const quotes = line.split("'").length - 1
      expect(quotes % 2).toBe(0)
    }
  })
})
