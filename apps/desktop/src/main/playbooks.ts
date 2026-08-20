/**
 * The standard playbooks, written into a project that has none (RQ-0013#AC-4).
 *
 * DC-0019: a playbook is a record artifact, so "seeding" is writing the same files the scaffold
 * template ships — with the same identity rules minting has, because these artifacts need an
 * `owner` and it cannot be baked into a static template.
 */
export function seedPlaybooks(_projectPath: string): string | null {
  return "Seeding playbooks is not built yet.";
}
