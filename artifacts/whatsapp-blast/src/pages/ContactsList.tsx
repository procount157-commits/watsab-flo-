import { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useListContacts,
  useCreateContactGroup,
  useDeleteContactGroup,
  getListContactsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Users, Trash2, ChevronLeft, Loader2, FileSpreadsheet, CopyX } from "lucide-react";
import { FolderSidebar, MoveToFolder, inFolder, type FolderSel } from "@/components/Folders";
import { api } from "@/components/AgentPanel";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Segment definitions ────────────────────────────────────────────
const SEGMENTS = [
  { value: "active",   label: "متفاعلون",               emoji: "🟢", color: "bg-green-500/15 text-green-400 border-green-500/30" },
  { value: "previous", label: "عملاء سابقون",            emoji: "🔵", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  { value: "vip",      label: "VIP",                    emoji: "👑", color: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  { value: "inactive", label: "غير نشطين",               emoji: "⚫", color: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
  { value: "offers",   label: "مهتمون بالعروض",          emoji: "🎁", color: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
];

function SegmentBadge({ segment }: { segment?: string | null }) {
  if (!segment) return null;
  const meta = SEGMENTS.find((s) => s.value === segment);
  if (!meta) return null;
  return (
    <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium", meta.color)}>
      {meta.emoji} {meta.label}
    </span>
  );
}

export default function ContactsList() {
  const queryClient = useQueryClient();
  const { data: groups, isLoading } = useListContacts();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName]       = useState("");
  const [desc, setDesc]       = useState("");
  const [segment, setSegment] = useState("");
  const [filterSeg, setFilterSeg] = useState("");

  // One step from a spreadsheet to a list: the file is read on the server —
  // every sheet, the mobile columns, the company names — saved as a new list
  // named after the file, and opened.
  const [, navigate] = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [country, setCountry] = useState("AE");
  const [uploading, setUploading] = useState(false);
  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("country", country);
      if (typeof folder === "number") fd.append("folderId", String(folder));
      const r = await fetch("/api/contacts/import", { method: "POST", body: fd, credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "تعذّر الاستيراد");
      // One upload fills both sections: the file's emails went to the email section too.
      const mail = d.email && !d.email.error ? `${d.email.inserted.toLocaleString("ar-SA")} إيميل في قسم البريد (قائمة «${d.email.list}»${d.email.folder ? ` · مجلد «${d.email.folder}»` : ""})` : "";
      if (d.email?.error) toast.error(`الإيميلات لم تُحفظ: ${d.email.error}`);
      if (d.emailOnly) { toast.success(`الملف بلا أرقام واتساب — حُفظ ${mail}`); queryClient.invalidateQueries({ queryKey: ["folders", "email"] }); return; }
      if (mail) toast.success(`وأيضاً: ${mail}`);
      toast.success(`حُفظ ${d.added.toLocaleString("ar-SA")} رقم واتساب${d.named ? " بأسماء الشركات" : ""}${d.addedTo ? ` في قائمتها السابقة «${d.addedTo}»` : ""}${d.folder ? ` · في مجلد «${d.folder}»` : ""}${d.inOtherLists ? ` · تُرك ${d.inOtherLists} موجود في قوائم أخرى` : ""}${d.verifying ? " — يجري التحقق على واتساب" : ""}`);
      queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["folders", "wa"] });
      if (d.groups?.[0]?.id) navigate(`/contacts/${d.groups[0].id}`);
      else if (d.inOtherLists) toast.info(`كل أرقام الملف موجودة مسبقاً في: ${(d.otherListNames ?? []).join("، ")}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploading(false);
    }
  };

  const createMutation = useCreateContactGroup({
    mutation: {
      onSuccess: () => {
        toast.success("تم إنشاء القائمة بنجاح");
        queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
        setShowCreate(false);
        setName(""); setDesc(""); setSegment("");
      },
      onError: () => toast.error("حدث خطأ أثناء الإنشاء"),
    },
  });

  const deleteMutation = useDeleteContactGroup({
    mutation: {
      onSuccess: () => {
        toast.success("تم حذف القائمة");
        queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["folders", "wa"] });
      },
      onError: () => toast.error("حدث خطأ أثناء الحذف"),
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({ data: { name: name.trim(), description: desc.trim(), segment: segment || undefined } as any });
  };

  // Filter by folder, then by segment
  const [folder, setFolder] = useState<FolderSel>("all");
  const refreshLists = () => queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
  const inThisFolder = inFolder((groups ?? []) as any[], folder);
  const filteredGroups = filterSeg
    ? inThisFolder.filter((g) => (g as any).segment === filterSeg)
    : inThisFolder;

  // Duplicates: counted first, removed on the owner's word.
  const [dupes, setDupes] = useState<any>(null);
  const [dedupeBusy, setDedupeBusy] = useState(false);
  const checkDupes = async () => {
    setDedupeBusy(true);
    try { setDupes(await api("/api/contacts/duplicates")); } catch (e: any) { toast.error(e.message); } finally { setDedupeBusy(false); }
  };
  const removeDupes = async (across: boolean) => {
    setDedupeBusy(true);
    try {
      const r = await api("/api/contacts/dedupe", { method: "POST", body: JSON.stringify({ across }) });
      toast.success(`حُذف ${r.removed} مكرر${r.fixed ? ` · صُحّح ${r.fixed} رقم للصيغة الدولية` : ""}${r.named ? ` · نُقل ${r.named} اسم` : ""}`);
      refreshLists();
      setDupes(await api("/api/contacts/duplicates"));
    } catch (e: any) { toast.error(e.message); } finally { setDedupeBusy(false); }
  };

  const inputCls = "w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">قوائم الأرقام</h1>
          <p className="text-sm text-muted-foreground mt-1">إدارة قوائم أرقام الهاتف وشرائح الجمهور</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={country} onChange={(e) => setCountry(e.target.value)} title="الدولة للأرقام المكتوبة بلا رمز دولة"
            className="px-2 py-2 bg-input border border-border rounded-lg text-xs">
            <option value="AE">+971</option><option value="SA">+966</option><option value="QA">+974</option>
            <option value="KW">+965</option><option value="BH">+973</option><option value="OM">+968</option><option value="EG">+20</option>
          </select>
          <button onClick={checkDupes} disabled={dedupeBusy}
            className="flex items-center gap-2 px-3 py-2 border border-border text-muted-foreground rounded-lg text-sm hover:text-foreground transition-colors disabled:opacity-50">
            {dedupeBusy && !dupes ? <Loader2 className="w-4 h-4 animate-spin" /> : <CopyX className="w-4 h-4" />} المكرر
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 border border-primary/40 text-primary rounded-lg text-sm font-medium hover:bg-primary/10 transition-colors disabled:opacity-50">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
            {uploading ? "يقرأ الملف…" : "ارفع ملف Excel"}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            قائمة جديدة
          </button>
        </div>
      </div>

      {/* Segment filter chips */}
      {(groups?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilterSeg("")}
            className={cn(
              "text-xs px-3 py-1 rounded-full border transition-colors",
              !filterSeg
                ? "bg-primary/15 text-primary border-primary/40 font-medium"
                : "text-muted-foreground border-border hover:border-primary/30"
            )}
          >
            الكل ({groups?.length ?? 0})
          </button>
          {SEGMENTS.map((seg) => {
            const cnt = (groups ?? []).filter((g) => (g as any).segment === seg.value).length;
            if (cnt === 0) return null;
            return (
              <button
                key={seg.value}
                onClick={() => setFilterSeg(filterSeg === seg.value ? "" : seg.value)}
                className={cn(
                  "text-xs px-3 py-1 rounded-full border transition-colors",
                  filterSeg === seg.value
                    ? `${seg.color} font-medium`
                    : "text-muted-foreground border-border hover:border-primary/30"
                )}
              >
                {seg.emoji} {seg.label} ({cnt})
              </button>
            );
          })}
        </div>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-card-border rounded-xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="font-semibold text-foreground mb-4">إنشاء قائمة جديدة</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">اسم القائمة *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: عملاء 2024"
                  className={inputCls}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">الوصف (اختياري)</label>
                <input
                  type="text"
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="وصف مختصر للقائمة"
                  className={inputCls}
                />
              </div>

              {/* Segment picker */}
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">
                  شريحة الجمهور (اختياري)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSegment("")}
                    className={cn(
                      "text-xs px-3 py-2 rounded-lg border transition-colors text-right",
                      !segment
                        ? "bg-primary/15 text-primary border-primary/40"
                        : "text-muted-foreground border-border hover:border-primary/30"
                    )}
                  >
                    بدون تصنيف
                  </button>
                  {SEGMENTS.map((seg) => (
                    <button
                      key={seg.value}
                      type="button"
                      onClick={() => setSegment(seg.value)}
                      className={cn(
                        "text-xs px-3 py-2 rounded-lg border transition-colors text-right",
                        segment === seg.value
                          ? seg.color
                          : "text-muted-foreground border-border hover:border-primary/30"
                      )}
                    >
                      {seg.emoji} {seg.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="submit"
                  disabled={createMutation.isPending || !name.trim()}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  إنشاء
                </button>
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setName(""); setDesc(""); setSegment(""); }}
                  className="flex-1 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors"
                >
                  إلغاء
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dupes && (
        <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2"><CopyX className="w-4 h-4 text-primary" /><p className="font-semibold text-sm">الأرقام المكررة</p>
            <button onClick={() => setDupes(null)} className="text-xs text-muted-foreground mr-auto">إغلاق</button></div>
          {dupes.withinLists + dupes.acrossLists + dupes.wrongFormat === 0 ? (
            <p className="text-sm text-muted-foreground">لا مكرر — كل رقم موجود مرة واحدة. الرفع القادم يتجاهل تلقائياً أي رقم موجود في أي قائمة (بأي صيغة كُتب).</p>
          ) : (<>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="rounded-lg bg-muted/40 p-2.5"><p className="text-xl font-bold">{dupes.withinLists}</p><p className="text-[11px] text-muted-foreground">مكرر داخل نفس القائمة</p></div>
              <div className="rounded-lg bg-muted/40 p-2.5"><p className="text-xl font-bold">{dupes.numbersInSeveralLists}</p><p className="text-[11px] text-muted-foreground">رقم موجود في أكثر من قائمة</p></div>
              <div className="rounded-lg bg-muted/40 p-2.5"><p className="text-xl font-bold">{dupes.wrongFormat}</p><p className="text-[11px] text-muted-foreground">بلا رمز الدولة (يُصحَّح)</p></div>
            </div>
            {dupes.samples?.length > 0 && <p className="text-[11px] text-muted-foreground">أمثلة: {dupes.samples.slice(0, 4).map((x: any) => `+${x.phone} في ${x.lists.join(" و")}`).join(" · ")}</p>}
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => removeDupes(false)} disabled={dedupeBusy} className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50">احذف المكرر داخل كل قائمة وصحّح الصيغة</button>
              {dupes.numbersInSeveralLists > 0 && <button onClick={() => confirm("سيبقى كل رقم في أقدم قائمة فيها فقط، ويُحذف من غيرها. متابعة؟") && removeDupes(true)} disabled={dedupeBusy} className="px-3 py-2 rounded-lg border border-red-500/40 text-red-400 text-xs disabled:opacity-50">احذفه أيضاً من القوائم الأخرى</button>}
            </div>
            <p className="text-[11px] text-muted-foreground">يُحفظ دائماً النسخة التي عليها اسم الشركة. الرقم نفسه بأي صيغة (050…، ‎+971…، 971…) يُعدّ رقماً واحداً.</p>
          </>)}
        </div>
      )}

      <div className="grid md:grid-cols-[14rem_1fr] gap-4 items-start">
      <div className="bg-card border border-card-border rounded-xl p-2 md:sticky md:top-4">
        <FolderSidebar kind="wa" value={folder} onChange={setFolder} total={groups?.length ?? 0} onChanged={refreshLists} lists={groups as any[] ?? []} />
      </div>
      <div>
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : !groups?.length ? (
        <div className="bg-card border border-card-border rounded-xl py-16 text-center">
          <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-foreground font-medium">لا توجد قوائم بعد</p>
          <p className="text-sm text-muted-foreground mt-1">أنشئ قائمة جديدة لإضافة أرقام الهاتف</p>
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl py-12 text-center">
          <p className="text-sm text-muted-foreground">{folder !== "all" && !inThisFolder.length ? "المجلد فارغ — اسحب إليه قائمة، أو ارفع ملفاً وهو مفتوح" : "لا توجد قوائم في هذه الشريحة"}</p>
          <button onClick={() => { setFilterSeg(""); setFolder("all"); }} className="text-xs text-primary mt-2 hover:underline">
            إظهار الكل
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredGroups.map((group) => (
            <div key={group.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/list-id", String(group.id))}
              className="bg-card border border-card-border rounded-xl p-5 hover:border-primary/30 transition-colors cursor-grab active:cursor-grabbing">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-foreground truncate">{group.name}</p>
                  {group.description && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{group.description}</p>
                  )}
                  <div className="mt-1.5">
                    <SegmentBadge segment={(group as any).segment} />
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (confirm(`حذف قائمة "${group.name}"؟`)) {
                      deleteMutation.mutate({ id: group.id });
                    }
                  }}
                  className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors flex-shrink-0 mr-2 mt-0.5"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-sm">
                  <Users className="w-4 h-4 text-primary" />
                  <span className="font-medium text-foreground">{group.count.toLocaleString("ar-SA")}</span>
                  <span className="text-muted-foreground">رقم</span>
                </div>
                <MoveToFolder kind="wa" listId={group.id} folderId={(group as any).folderId} onMoved={refreshLists} />
                <Link
                  href={`/contacts/${group.id}`}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  إدارة
                  <ChevronLeft className="w-3 h-3" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
