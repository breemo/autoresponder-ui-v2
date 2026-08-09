# Engineering Standards

## Purpose

This document defines the engineering standards for the Auto Responder project.

Every AI agent and developer must follow these standards.

---

# Core Principles

- Simplicity over complexity.
- Documentation is part of the product.
- Every change must have a clear purpose.
- One source of truth.
- Keep the system maintainable.

---

# Development Rules

- Do not modify unrelated code.
- Read only the files required for the current task.
- Make the smallest safe change.
- Never expose secrets.
- Never deploy without approval.
- Avoid unnecessary refactoring.

---

# Architecture Rules

- Follow the existing architecture.
- Do not introduce new patterns without approval.
- Reuse existing components and services whenever possible.
- Keep features loosely coupled.

---

# Database Rules

- Every schema change requires a migration.
- Never modify production directly.
- Follow existing naming conventions.
- Respect Row Level Security (RLS).
- Never delete production data without approval.

---

# Frontend Rules

- Follow the existing folder structure.
- Reuse components whenever possible.
- Keep business logic outside UI components.
- Avoid duplicated code.

---

# Backend Rules

- Keep APIs consistent.
- Validate all inputs.
- Handle errors gracefully.
- Log meaningful events.

---

# AI Rules

- Minimize token usage.
- Read only the required documentation.
- Stay within the approved scope.
- Never inspect the entire repository unless explicitly requested.

---

# Documentation Rules

- Documentation must match implementation.
- Update documentation only when affected.
- Avoid duplicated documentation.

---

# Git Rules

- One logical change per commit.
- Write meaningful commit messages.
- Never commit secrets.
- Keep the repository clean.