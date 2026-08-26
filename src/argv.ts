// A tiny flag parser for the plugin's command-line surface.
//
// BB hands the plugin a raw argv array and leaves parsing to the plugin, so
// this stays deliberately small: long flags, an optional "=" form, repeated
// bare words as positionals.
export interface ParsedArgv {
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { positionals, flags };
}

export function flagText(parsed: ParsedArgv, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagPresent(parsed: ParsedArgv, name: string): boolean {
  return parsed.flags.has(name);
}

export function flagNumber(
  parsed: ParsedArgv,
  name: string,
  fallback: number,
): number {
  const parsedNumber = Number.parseInt(flagText(parsed, name) ?? "", 10);
  return Number.isFinite(parsedNumber) ? parsedNumber : fallback;
}
