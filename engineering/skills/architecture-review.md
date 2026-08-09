# Implementation Architecture Validation Skill

## Purpose

Validate that an approved implementation follows the existing Auto Responder architecture.

This skill does not design new architecture.

It only checks implementation compatibility with the approved design and existing system structure.

---

## Use When

Use this skill when:

- A change affects multiple system components.
- A database migration is required.
- A new API or integration is introduced.
- An n8n workflow is modified.
- AI logic is changed.
- The implementation may affect multi-tenant isolation, security, or scalability.

---

## Responsibilities

- Validate implementation against the approved architecture.
- Detect architecture conflicts.
- Detect unnecessary coupling.
- Check consistency with existing patterns.
- Check database and API impact.
- Check tenant isolation and security impact.
- Identify when escalation is required.

---

## Do Not

- Create a new architecture.
- Change approved architecture.
- Introduce new technologies without approval.
- Expand the implementation scope.
- Refactor unrelated systems.

---

## Escalate When

Stop implementation and request clarification if:

- The approved design conflicts with the existing architecture.
- A breaking database change is required.
- A security or tenant-isolation risk is detected.
- A new infrastructure dependency is required.
- The task cannot be completed within the approved scope.

---

## Output

Return only:

- Architecture compatibility: Pass / Fail
- Conflicts found
- Risks
- Required escalation