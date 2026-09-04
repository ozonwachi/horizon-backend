import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { recordAuditLog } from "./auditLogService.ts";

// Admin-only CRUD for the faqs table (migration_28) - the app reads FAQs
// directly via RLS from HelpCenterScreen (same "admin writes, everyone
// reads" split as categories/regions), this is only for the admin screen
// that manages the list.

const TABLE = "faqs";

export type Faq = {
  id: string;
  question: string;
  answer: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// deno-lint-ignore no-explicit-any
function toFaq(row: any): Faq {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAllFaqs(supabase: SupabaseClient): Promise<Faq[]> {
  const { data, error } = await supabase.from(TABLE).select("*").order("sort_order", { ascending: true });
  if (error) throw error;
  return (data || []).map(toFaq);
}

export async function createFaq(
  supabase: SupabaseClient,
  adminUid: string,
  { question, answer, sortOrder }: { question: string; answer: string; sortOrder?: number }
): Promise<Faq> {
  if (!question || !question.trim()) throw new Error("question is required");
  if (!answer || !answer.trim()) throw new Error("answer is required");
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ question: question.trim(), answer: answer.trim(), sort_order: sortOrder ?? 0 })
    .select()
    .single();
  if (error) throw error;
  const faq = toFaq(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "faq_created",
    targetType: "faq",
    targetId: faq.id,
    newValue: faq,
  }).catch((err) => console.error("recordAuditLog (faq_created) failed:", err));

  return faq;
}

export async function updateFaq(
  supabase: SupabaseClient,
  adminUid: string,
  id: string,
  changes: { question?: string; answer?: string; sortOrder?: number }
): Promise<Faq> {
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (changes.question !== undefined) patch.question = changes.question.trim();
  if (changes.answer !== undefined) patch.answer = changes.answer.trim();
  if (changes.sortOrder !== undefined) patch.sort_order = changes.sortOrder;

  const { data, error } = await supabase.from(TABLE).update(patch).eq("id", id).select().single();
  if (error) throw error;
  const faq = toFaq(data);

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "faq_updated",
    targetType: "faq",
    targetId: id,
    newValue: changes,
  }).catch((err) => console.error("recordAuditLog (faq_updated) failed:", err));

  return faq;
}

export async function deleteFaq(supabase: SupabaseClient, adminUid: string, id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;

  await recordAuditLog(supabase, {
    userId: adminUid,
    action: "faq_deleted",
    targetType: "faq",
    targetId: id,
  }).catch((err) => console.error("recordAuditLog (faq_deleted) failed:", err));
}
