import { ID_PREFIXES } from "@aibuildos/shared";
import { z } from "zod";

export const ARTIFACT_ID_PATTERN = new RegExp(`^(${ID_PREFIXES.join("|")})-\\d{4,}$`);

/** Accepts a whole-artifact reference or a criterion reference (`RQ-0007#AC-2`). */
export const LINK_TARGET_PATTERN = new RegExp(`^(${ID_PREFIXES.join("|")})-\\d{4,}(#AC-\\d+)?$`);

export const ArtifactIdSchema = z.string().regex(ARTIFACT_ID_PATTERN, "not a valid artifact ID");
export const LinkTargetSchema = z.string().regex(LINK_TARGET_PATTERN, "not a valid link target");
export const ProvenanceSchema = z.enum(["human", "agent", "imported", "backfilled"]);

/** Relationship name -> list of targets. Always arrays, even for a single entry. */
export const LinksSchema = z.record(z.string(), z.array(LinkTargetSchema));

export const GeneratedSchema = z.object({ by: z.string(), at: z.string() });

/** The keys every artifact carries, whatever its type. See okf-conventions §2. */
export const CommonFrontmatterSchema = z.object({
  type: z.string().min(1),
  id: ArtifactIdSchema,
  title: z.string().min(1),
  state: z.string().min(1),
  owner: z.string().min(1),
  provenance: ProvenanceSchema,
  created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO-8601 date"),
  links: LinksSchema.optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  generated: GeneratedSchema.optional(),
});

export type CommonFrontmatter = z.infer<typeof CommonFrontmatterSchema>;

/** Strip a criterion suffix: `RQ-0007#AC-2` -> `RQ-0007`. */
export function baseArtifactId(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}
