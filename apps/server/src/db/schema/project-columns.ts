import { integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";

export const projectColumns = pgTable(
  "project_columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    unique("project_columns_project_position_unique").on(table.projectId, table.position),
    unique("project_columns_project_name_unique").on(table.projectId, table.name),
  ],
);

export type ProjectColumn = typeof projectColumns.$inferSelect;
export type NewProjectColumn = typeof projectColumns.$inferInsert;
