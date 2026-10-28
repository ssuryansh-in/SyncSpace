import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectColumns } from "./project-columns.js";
import { projects } from "./projects.js";
import { users } from "./users.js";

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => projectColumns.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    assigneeId: uuid("assignee_id").references(() => users.id),
    rankKey: text("rank_key").notNull(),
    version: integer("version").notNull().default(1),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_tasks_board").on(table.projectId, table.columnId, table.rankKey, table.id),
    index("idx_tasks_assignee").on(table.projectId, table.assigneeId),
    index("idx_tasks_search").using(
      "gin",
      sql`to_tsvector('english', ${table.title} || ' ' || ${table.description})`,
    ),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
