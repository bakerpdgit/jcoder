/** Splits a command-line style argument string, honouring double quotes. */
export function parseArgs(input: string): string[] {
  const matches = input.match(/"[^"]*"|\S+/g) ?? []
  return matches.map(token => (token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token))
}
