import { bigint, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { users } from "./users.js";

export const projectEvents = pgTable(
  "project_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("project_events_project_seq_unique").on(table.projectId, table.seq),
  ],
);

export type ProjectEvent = typeof projectEvents.$inferSelect;
export type NewProjectEvent = typeof projectEvents.$inferInsert;
