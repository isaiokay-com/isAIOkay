/**
 * Schema-generation-only Better Auth config.
 *
 * Production auth is created per Worker request from the D1 binding. The CLI
 * cannot import a live Worker binding, so it uses Node's in-memory SQLite API
 * solely to emit Better Auth's canonical SQLite schema for review.
 */
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";

export const auth = betterAuth({
  appName: "IsAIokay.com",
  database: new DatabaseSync(":memory:"),
  secret: "schema-generation-only-secret-at-least-32-characters",
  baseURL: "http://localhost:4321",
  advanced: {
    database: { generateId: () => crypto.randomUUID() }
  },
  user: {
    additionalFields: {
      githubUsername: { type: "string", required: false },
      githubAccountCreatedAt: { type: "number", required: false }
    }
  }
});
