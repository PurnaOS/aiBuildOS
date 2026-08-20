---
type: TypeDefinition
defines: Playbook
abstract: false
prefix: PB
dir: playbooks
fields:
  harness: { kind: string, required: false }
states:
  vocabulary: [active, retired]
  initial: active
  transitions:
    - { from: "*", to: retired }
  derived: false
---

# Playbook

Named instructions a project carries for a coding agent, shown as a button in the workspace once
`state: active`. Lives in [`docs/playbooks/`](../playbooks/README.md).

The body **is** the instructions, plain Markdown any tool can read — there is no application-side
registry to keep in sync. `harness` names the button's preferred harness by *display name*; a button
whose name matches nothing configured runs with whatever harness the workspace already has attached.

No required body section and no declared links: a playbook has nothing to check itself against, only
words to send. Editing or retiring one — `state: retired`, the wildcard every type carries — is the
whole of changing what a button does.
