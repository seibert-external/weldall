-- PostgreSQL requires a newly added enum value to commit before a later
-- migration may use it in a check constraint.
ALTER TYPE "IacPrimitiveKind" ADD VALUE 'SKILL';
