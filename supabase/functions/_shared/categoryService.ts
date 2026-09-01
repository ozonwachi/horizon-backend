import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

// Admin-only CRUD for the categories table (migration_19) - the app reads
// active categories directly via RLS (see categoryService.ts on the Dart
// side), this is only for the admin screen that manages the list.

const TABLE = "categories";

export type Category = {
  id: string;
  name: string;
  iconName: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
};

// deno-lint-ignore no-explicit-any
function toCategory(row: any): Category {
  return {
    id: row.id,
    name: row.name,
    iconName: row.icon_name,
    sortOrder: row.sort_order,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function listAllCategories(supabase: SupabaseClient): Promise<Category[]> {
  const { data, error } = await supabase.from(TABLE).select("*").order("sort_order", { ascending: true });
  if (error) throw error;
  return (data || []).map(toCategory);
}

export async function createCategory(
  supabase: SupabaseClient,
  adminUid: string,
  { name, iconName, sortOrder }: { name: string; iconName?: string; sortOrder?: number }
): Promise<Category> {
  if (!name || !name.trim()) throw new Error("name is required");
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ name: name.trim(), icon_name: iconName || "category", sort_order: sortOrder ?? 0 })
    .select()
    .single();
  if (error) throw error;
  const category = toCategory(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "category_created",
    targetType: "category",
    targetId: category.id,
    newValue: category,
  }).catch((err) => console.error("recordAuditLog (category_created) failed:", err));

  return category;
}

export async function updateCategory(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  changes: { name?: string; iconName?: string; sortOrder?: number; active?: boolean }
): Promise<Category> {
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = {};
  if (changes.name !== undefined) patch.name = changes.name.trim();
  if (changes.iconName !== undefined) patch.icon_name = changes.iconName;
  if (changes.sortOrder !== undefined) patch.sort_order = changes.sortOrder;
  if (changes.active !== undefined) patch.active = changes.active;

  const { data, error } = await supabase.from(TABLE).update(patch).eq("id", id).select().single();
  if (error) throw error;
  const category = toCategory(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "category_updated",
    targetType: "category",
    targetId: id,
    newValue: changes,
  }).catch((err) => console.error("recordAuditLog (category_updated) failed:", err));

  return category;
}

export async function deleteCategory(supabase: SupabaseClient, adminUid: string, id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "category_deleted",
    targetType: "category",
    targetId: id,
  }).catch((err) => console.error("recordAuditLog (category_deleted) failed:", err));
}
