# Implementation Analysis Skill

## Purpose

Analyze an approved engineering task before implementation begins.

This skill is not responsible for product discovery or business prioritization.

Its purpose is to ensure the implementation scope is technically clear and minimal.

---

## Use When

Use this skill when:

- The approved implementation plan needs technical clarification.
- Multiple components may be affected.
- The requested change may conflict with existing code.
- The implementation scope is unclear.
- A task may require database, API, n8n, AI, or frontend changes.

---

## Responsibilities

- Identify the exact components affected by the approved task.
- Identify the minimum files that should be read.
- Detect implementation risks.
- Detect missing technical information.
- Confirm that the change can be implemented without redesigning the architecture.
- Keep the implementation scope as small as possible.

---

## Do Not

- Change product requirements.
- Redefine business goals.
- Expand feature scope.
- Redesign architecture.
- Inspect the entire repository.
- Make product decisions.

---

## Output

Return only:

- Affected components
- Required files
- Technical risks
- Missing information
- Recommended implementation scope