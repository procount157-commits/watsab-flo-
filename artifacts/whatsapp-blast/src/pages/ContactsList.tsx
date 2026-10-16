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
import { FolderSidebar, FolderTiles, MoveToFolder, inFolder, type FolderSel } from "@/components/Folders";
import { CountryBar, CountryCodeSelect, CountryTag, inCountry, resolveCountry, useCountrySel, MARKETS } from "@/components/Countries";
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
  // The country picked above the lists: only its lists show, and a file
  // uploaded while it is picked reads numbers without a code as its numbers.
  const [countrySel, setCountrySel] = useCountrySel();
  const [country, setCountry] = useState(() => MARKETS.some((m) => m.iso === countrySel) ? countrySel : "AE");
  const pickCountry = (s: string) => { setCountrySel(s); setFolder("all"); if (MARKETS.some((m) => m.iso === s)) setCountry(s); };
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

  // Filter by country, then folder, then segment
  const [folder, setFolder] = useState<FolderSel>("all");
  const refreshLists = () => queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
  // Always one country: the one picked, or the one with the most lists.
  const shownCountry = resolveCountry(countrySel, (groups ?? []) as any[]);
  const inThisCountry = inCountry((groups ?? []) as any[], shownCountry);
  const inThisFolder = inFolder(inThisCountry, folder);
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
          <CountryCodeSelect value={country} onChange={setCountry} />
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

      {(groups?.length ?? 0) > 0 && <CountryBar lists={(groups ?? []) as any[]} value={shownCountry} onChange={pickCountry} />}

      {/* The segment chips («الكل», «عقارات»…) are gone: the folders are the sectors now,
          and a row of «all» is what the owner asked to have hidden. */}

      <div className="grid md:grid-cols-[14rem_1fr] gap-4 items-start">
      <div className="bg-card border border-card-border rounded-xl p-2 md:sticky md:top-4">
        <FolderSidebar kind="wa" value={folder} onChange={setFolder} total={inThisCountry.length} onChanged={refreshLists} lists={inThisCountry} noAll />
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
      ) : folder === "all" ? (
        <FolderTiles kind="wa" lists={inThisCountry} onPick={setFolder} unit="رقم" />
      ) : filteredGroups.length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl py-12 text-center">
          <p className="text-sm text-muted-foreground">المجلد فارغ في هذه الدولة — اسحب إليه قائمة، أو ارفع ملفاً</p>
          <button onClick={() => { setFilterSeg(""); setFolder("all"); }} className="text-xs text-primary mt-2 hover:underline">
            عودة إلى المجلدات
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
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <CountryTag list={group as any} sel={shownCountry} />
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
