import { z } from "zod";

/**
 * The type profile — the SDLC schema, read as data rather than compiled in (conventions §6, ST-0006).
 *
 * This module is pure: it turns raw `TypeDefinition` frontmatter into resolved types and answers
 * questions about them. Reading `docs/profile/` off disk is `loadProfile` in `./load`, which is the
 * only module allowed to touch `node:fs`.
 */

const FieldDefSchema = z.object({
  kind: z.string(),
  required: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  pattern: z.string().optional(),
});

const LinkDefSchema = z.object({
  target: z.array(z.string()),
  min: z.number().optional(),
  max: z.number().optional(),
  cycles: z.literal("forbid").optional(),
});

/**
 * One declared move. `from` is a state, a list of states, or the wildcard `"*"` every type carries
 * for retirement; `to` is the single state it leads to.
 */
const TransitionSchema = z.object({
  from: z.union([z.string(), z.array(z.string())]),
  to: z.string(),
});

/**
 * `transitions` was stripped until RQ-0010: a *validator* sees one commit and cannot know what a
 * state was before it, so legality could not be checked there (RQ-0003). The application's own save
 * path reads the file before it writes it, so the previous state is in its hand — that is where
 * `legalNextStates` in `./transitions` reads this field from.
 */
const StatesDefSchema = z.object({
  vocabulary: z.array(z.string()),
  initial: z.string(),
  derived: z.boolean().optional(),
  transitions: z.array(TransitionSchema).optional(),
});

const SectionDefSchema = z.object({
  name: z.string(),
  required: z.boolean().optional(),
  items: z.string().optional(),
});

const TypeDefinitionSchema = z.object({
  defines: z.string().min(1),
  extends: z.string().optional(),
  abstract: z.boolean().optional(),
  prefix: z.string().optional(),
  dir: z.string().optional(),
  fields: z.record(z.string(), FieldDefSchema).optional(),
  links: z.record(z.string(), LinkDefSchema).optional(),
  states: StatesDefSchema.optional(),
  body: z.object({ sections: z.array(SectionDefSchema) }).optional(),
});

export type FieldDef = z.infer<typeof FieldDefSchema>;
export type LinkDef = z.infer<typeof LinkDefSchema>;
export type StatesDef = z.infer<typeof StatesDefSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type SectionDef = z.infer<typeof SectionDefSchema>;

/** A type definition with its whole `extends` chain already merged in. */
export interface TypeDef {
  readonly defines: string;
  readonly extends?: string;
  readonly abstract: boolean;
  readonly prefix?: string;
  readonly dir?: string;
  readonly fields: Readonly<Record<string, FieldDef>>;
  readonly links: Readonly<Record<string, LinkDef>>;
  readonly states?: StatesDef;
  readonly sections: readonly SectionDef[];
}

/** A profile document that would not parse. Reported, never thrown — the profile is consumed as
 * permissively as the bundle it describes. */
export interface ProfileIssue {
  readonly file: string;
  readonly message: string;
}

/** One `TypeDefinition` document as it came off disk. */
export interface RawTypeDefinition {
  readonly file: string;
  readonly frontmatter: Record<string, unknown>;
}

export class Profile {
  constructor(private readonly types: ReadonlyMap<string, TypeDef>) {}

  /** The fully resolved definition of a type, or `undefined` if the profile does not describe it. */
  get(type: string): TypeDef | undefined {
    return this.types.get(type);
  }

  /** Every type the profile defines. */
  names(): string[] {
    return [...this.types.keys()];
  }

  /**
   * Does `type` satisfy `target` — is it that type, or one that extends it (conventions §4)?
   *
   * A type the profile does not define is matched by name rather than rejected: `Architecture` is
   * ID-reserved and deliberately unprofiled, yet `Decision` really does declare
   * `constrains: { target: [..., Architecture] }`. Treating "unprofiled" as "does not match" would
   * fail the live bundle (RQ-0003#AC-9).
   */
  isA(type: string, target: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = type;
    while (current !== undefined && !seen.has(current)) {
      if (current === target) return true;
      seen.add(current);
      current = this.types.get(current)?.extends;
    }
    return false;
  }
}

/**
 * Resolve raw type definitions into a profile, merging each `extends` chain **by key, child wins**
 * (conventions §6). That is what lets `Story` inherit `depends_on` and `priority` from `WorkItem`
 * without restating them.
 */
export function resolveProfile(raw: readonly RawTypeDefinition[]): {
  profile: Profile;
  issues: ProfileIssue[];
} {
  const issues: ProfileIssue[] = [];
  const parsed = new Map<string, z.infer<typeof TypeDefinitionSchema>>();

  for (const { file, frontmatter } of raw) {
    const result = TypeDefinitionSchema.safeParse(frontmatter);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          file,
          message: `${issue.path.join(".") || "frontmatter"}: ${issue.message}`,
        });
      }
      continue;
    }
    const previous = parsed.get(result.data.defines);
    if (previous) {
      issues.push({ file, message: `${result.data.defines} is already defined` });
      continue;
    }
    parsed.set(result.data.defines, result.data);
  }

  const resolved = new Map<string, TypeDef>();
  for (const name of parsed.keys()) {
    resolve(name, parsed, resolved, issues, new Set());
  }

  return { profile: new Profile(resolved), issues };
}

function resolve(
  name: string,
  parsed: ReadonlyMap<string, z.infer<typeof TypeDefinitionSchema>>,
  resolved: Map<string, TypeDef>,
  issues: ProfileIssue[],
  seen: Set<string>,
): TypeDef | undefined {
  const existing = resolved.get(name);
  if (existing) return existing;

  const own = parsed.get(name);
  if (!own) return undefined;

  // A self-referential `extends` chain would otherwise recurse forever. Report it and treat the type
  // as if it had no parent, so the rest of the profile still resolves.
  if (seen.has(name)) {
    issues.push({ file: `${name}`, message: `extends chain is cyclic at ${name}` });
    return undefined;
  }
  seen.add(name);

  const parent = own.extends ? resolve(own.extends, parsed, resolved, issues, seen) : undefined;
  if (own.extends && !parent) {
    issues.push({ file: `${name}`, message: `extends unknown type ${own.extends}` });
  }

  const type: TypeDef = {
    defines: own.defines,
    // `abstract` is deliberately not inherited: a concrete type extending an abstract one is
    // concrete. Everything else merges by key with the child winning.
    abstract: own.abstract ?? false,
    fields: { ...parent?.fields, ...own.fields },
    links: { ...parent?.links, ...own.links },
    sections: own.body?.sections ?? parent?.sections ?? [],
    ...(own.extends === undefined ? {} : { extends: own.extends }),
    ...(own.prefix === undefined ? {} : { prefix: own.prefix }),
    ...(own.dir === undefined ? {} : { dir: own.dir }),
    ...(own.states || parent?.states
      ? { states: { ...parent?.states, ...own.states } as StatesDef }
      : {}),
  };

  resolved.set(name, type);
  return type;
}
