import { useState, useRef, useCallback } from "react";
import { useParams, Link, useLocation } from "wouter";
import {
  useGetContactGroup,
  getGetContactGroupQueryKey,
  getListContactsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Upload, ClipboardPaste, Users, Copy,
  Loader2, CheckCircle2, Layers, ArrowLeft, UserCheck, PhoneOff,
  FileSpreadsheet, AlertTriangle, Download,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface ImportExtra {
  verifying?: boolean;
  named?: number;
  byCountry?: Record<string, number>;
  sheets?: Array<{ sheet: string; rows: number; columns: Record<string, string> }>;
  sample?: Array<{ phone: string; name: string | null }>;
  inOtherLists?: number;
  otherListNames?: string[];
}
interface ImportResult {
  added: number;
  duplicates: number;
  invalid: number;
  skippedLandline?: number;
  total: number;
  autoSplit: boolean;
  groups: { id: number; name: string; count: number }[];
}

// ── Main Page ─────────────────────────────────────────────────────

export default function ContactDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: group, isLoading } = useGetContactGroup(id, { query: { enabled: !!id } as any });

  const [pasteText, setPasteText]       = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [tab, setTab]                   = useState<"paste" | "excel">("paste");
  const [mobileOnly, setMobileOnly]     = useState(true);
  const [dragging, setDragging]         = useState(false);

  // The country a number without its code belongs to. Rows whose city or
  // country column says otherwise follow the file.
  const [country, setCountry]           = useState("AE");
  const [allMobiles, setAllMobiles]     = useState(false);
  const [allowOther, setAllowOther]     = useState(false);
  const [importing, setImporting]       = useState(false);
  const [extra, setExtra]               = useState<ImportExtra | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Import: straight to the server, saved on arrival ──────────
  // The server reads every sheet, finds the number columns and the company
  // name, and saves. No preview: the report says what was kept.
  const runImport = async (payload: { file?: File; text?: string }) => {
    setImporting(true);
    setImportResult(null);
    setExtra(null);
    try {
      const fd = new FormData();
      if (payload.file) fd.append("file", payload.file);
      if (payload.text) fd.append("text", payload.text);
      fd.append("groupId", String(id));
      fd.append("country", country);
      fd.append("mobileOnly", String(mobileOnly));
      fd.append("allMobiles", String(allMobiles));
      fd.append("allowOtherLists", String(allowOther));
      const r = await fetch("/api/contacts/import", { method: "POST", body: fd, credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "تعذّر الاستيراد");
      setImportResult({
        added: d.added, duplicates: (d.duplicates ?? 0) + (d.alreadyInList ?? 0) + (d.inOtherLists ?? 0), invalid: d.noNumber ?? 0,
        skippedLandline: d.skippedLandline ?? 0, total: d.total, autoSplit: d.autoSplit, groups: d.groups,
      });
      setExtra({ verifying: d.verifying, named: d.named, byCountry: d.byCountry, sheets: d.sheets, sample: d.sample, inOtherLists: d.inOtherLists, otherListNames: d.otherListNames });
      setPasteText("");
      toast.success(d.autoSplit
        ? `حُفظ ${d.added.toLocaleString("ar-SA")} رقم في ${d.groups.length} قائمة`
        : `حُفظ ${d.added.toLocaleString("ar-SA")} رقم${d.named ? " باسم الشركة" : ""}`);
      queryClient.invalidateQueries({ queryKey: getGetContactGroupQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImporting(false);
    }
  };

  const handlePastePreview = () => { if (pasteText.trim()) void runImport({ text: pasteText }); };
  const processExcelFile = useCallback((file: File) => { void runImport({ file }); }, [country, mobileOnly, allMobiles, id]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processExcelFile(file);
  }, [processExcelFile]);

  // ── Paste live stats ──────────────────────────────────────────

  // A count of lines holding a number. Which are mobiles, and in which
  // country, is the server's call — it knows the chosen country and reads
  // any city written beside the number.
  const pasteLines   = pasteText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const pasteMobiles = pasteLines.filter((l) => /\d[\d\s\-().]{5,}\d/.test(l)).length;
  const pasteSkipped = pasteLines.length - pasteMobiles;

  const inputCls =
    "w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!group) {
    return <div className="p-6 text-center text-muted-foreground">القائمة غير موجودة</div>;
  }

  const hasNames = group.contacts?.some((c: any) => c.name);

  // ── Excel Export (server-side) ─────────────────────────────────
  // We hit /api/contacts/:id/export which fetches from DB and streams
  // the Excel file — no dependency on client-side cache state.
  const exportToExcel = () => {
    if (!group.count) { toast.error("لا توجد أرقام للتصدير"); return; }
    window.open(`/api/contacts/${id}/export`, "_blank");
  };

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/contacts" className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground">
          <ArrowRight className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{group.name}</h1>
          {group.description && <p className="text-sm text-muted-foreground mt-0.5">{group.description}</p>}
        </div>
        <div className="mr-auto flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary rounded-lg text-sm">
          <Users className="w-4 h-4" />
          <span className="font-medium">{group.count.toLocaleString("ar-SA")} رقم</span>
        </div>
      </div>

      {/* Import Section */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        {/* Tabs */}
        <div className="flex border-b border-card-border">
          {(["paste", "excel"] as const).map((t) => (
            <button key={t} onClick={() => { setTab(t); setImportResult(null); setExtra(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors",
                tab === t ? "bg-primary/10 text-primary border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
              )}>
              {t === "paste" ? <><ClipboardPaste className="w-4 h-4" /> لصق وكتابة</> : <><FileSpreadsheet className="w-4 h-4" /> Excel / CSV</>}
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* Mobile-only toggle */}
          <button onClick={() => setMobileOnly((v) => !v)}
            className={cn(
              "mb-4 w-full flex items-center justify-between px-3 py-2 rounded-lg border text-sm transition-colors",
              mobileOnly ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted/30 border-border text-muted-foreground"
            )}>
            <div className="flex items-center gap-2">
              {mobileOnly ? <UserCheck className="w-4 h-4" /> : <PhoneOff className="w-4 h-4" />}
              <span className="font-medium">
                {mobileOnly ? "تجاهل الأرقام الأرضية (موصى به)" : "استيراد الكل (موبايل + أرضي)"}
              </span>
            </div>
            <div className={cn("w-9 h-5 rounded-full transition-colors relative", mobileOnly ? "bg-primary" : "bg-muted")}>
              <div className={cn("absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all", mobileOnly ? "right-0.5" : "left-0.5")} />
            </div>
          </button>

          <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">الدولة للأرقام المحلية</span>
              <select value={country} onChange={(e) => setCountry(e.target.value)} className="px-2 py-1.5 bg-input border border-border rounded-lg">
                <option value="AE">الإمارات +971</option>
                <option value="SA">السعودية +966</option>
                <option value="QA">قطر +974</option>
                <option value="KW">الكويت +965</option>
                <option value="BH">البحرين +973</option>
                <option value="OM">عُمان +968</option>
                <option value="EG">مصر +20</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={allMobiles} onChange={(e) => setAllMobiles(e.target.checked)} />
              <span>كل أرقام الجوال للشركة (لا الأول فقط)</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" title="بدونها: الرقم الموجود في أي قائمة أخرى لا يُضاف مرة ثانية">
              <input type="checkbox" checked={allowOther} onChange={(e) => setAllowOther(e.target.checked)} />
              <span>اسمح بالرقم الموجود في قائمة أخرى</span>
            </label>
            <span className="text-muted-foreground/70">الصف الذي فيه مدينة أو دولة يتبعها — رقم من الرياض يُحفظ +966 ولو اخترت الإمارات.</span>
          </div>

          {tab === "paste" ? (
            /* ── Paste tab ── */
            <div className="space-y-3">
              <div className="px-3 py-2 bg-muted/30 rounded-lg text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">تنسيقات مدعومة:</p>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {[
                    { label: "رقم فقط",      ex: "971588123456" },
                    { label: "محلي (يُحوّل)", ex: "0588123456" },
                    { label: "اسم + رقم",    ex: "أحمد،971588123456" },
                    { label: "CSV",          ex: "Ahmed,0588123456" },
                  ].map(({ label, ex }) => (
                    <div key={label} className="bg-card border border-card-border rounded-lg px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                      <p dir="ltr" className="font-mono text-[10px] text-foreground mt-0.5">{ex}</p>
                    </div>
                  ))}
                </div>
              </div>

              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder={"971501234567\nأحمد,0551234567\nSarah,0521234567"}
                rows={7} dir="ltr" className={inputCls + " resize-none font-mono"} />

              {/* Live stats */}
              {pasteText.trim() && (
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-green-400 font-medium">✓ {pasteMobiles.toLocaleString("ar-SA")} سطر فيه رقم</span>
                  {pasteSkipped > 0 && (
                    <span className="text-orange-400 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      {pasteSkipped} سطر بلا رقم
                    </span>
                  )}
                </div>
              )}

              <button onClick={handlePastePreview} disabled={!pasteText.trim() || importing}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
                احفظ الأرقام
              </button>
            </div>
          ) : (
            /* ── Excel tab ── */
            <div className="space-y-3">
              {/* Format hint */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/30 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-muted-foreground font-medium">عمود واحد</p>
                  <p dir="ltr" className="font-mono text-foreground/80">971501234567</p>
                  <p dir="ltr" className="font-mono text-foreground/80">0551234567 ← يُحوّل تلقائياً</p>
                </div>
                <div className="bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5 space-y-1">
                  <p className="text-primary font-medium">عمودين (اسم + رقم) ✓</p>
                  <p dir="ltr" className="font-mono text-foreground/80">Ahmed | 971501234567</p>
                  <p dir="ltr" className="font-mono text-foreground/80">Sara  | 0551234567</p>
                </div>
              </div>

              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) processExcelFile(f); e.target.value = ""; }}
                className="hidden" />

              {/* Drag-and-drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  "flex flex-col items-center justify-center gap-3 w-full px-4 py-12 border-2 border-dashed rounded-xl cursor-pointer transition-all",
                  dragging
                    ? "border-primary bg-primary/10 scale-[1.01]"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
                )}
              >
                {importing ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <span className="text-sm text-primary font-medium">يقرأ الملف ويحفظ الأرقام…</span>
                  </div>
                ) : dragging ? (
                  <div className="flex flex-col items-center gap-2 text-primary">
                    <FileSpreadsheet className="w-10 h-10" />
                    <span className="text-sm font-semibold">أفلت الملف هنا</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <FileSpreadsheet className="w-10 h-10" />
                    <span className="text-sm font-medium">اضغط أو اسحب ملف Excel / CSV</span>
                    <span className="text-xs opacity-60">xlsx · xls · csv — كل الأوراق، بلا حد للصفوف (حتى 60MB)</span>
                    <span className="text-xs opacity-40">يجد أعمدة الجوال واسم الشركة وحده، ويحفظ فور الرفع</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Import Result ── */}
          {importResult && !importing && (
            <div className="mt-5 space-y-4">
              {extra && (
                <div className="rounded-xl border border-card-border p-3 text-xs space-y-1.5">
                  {(extra.sheets ?? []).map((sh) => (
                    <p key={sh.sheet} className="text-muted-foreground">
                      <span className="text-foreground font-medium">{sh.sheet}</span> — {sh.rows.toLocaleString("ar-SA")} صف ·
                      {sh.columns.company ? ` الشركة: «${sh.columns.company}»` : " لم أجد عمود الشركة"} ·
                      {sh.columns.phones ? ` الأرقام من: «${sh.columns.phones}»` : " لا أعمدة أرقام"}
                    </p>
                  ))}
                  <p className="text-muted-foreground">
                    {extra.named ? `${extra.named.toLocaleString("ar-SA")} رقم محفوظ باسم الشركة. ` : ""}
                    {extra.inOtherLists ? `${extra.inOtherLists.toLocaleString("ar-SA")} رقم لم يُضف لأنه موجود في: ${(extra.otherListNames ?? []).join("، ")}. ` : ""}
                    {extra.byCountry && Object.keys(extra.byCountry).length > 1 ? `الدول: ${Object.entries(extra.byCountry).map(([k, v]) => `${k} ${v}`).join("، ")}. ` : ""}
                    {extra.verifying ? "يجري الآن التحقق من الأرقام على واتساب — غير المسجّلة تُعلَّم «غير صالح» خلال دقائق." : "واتساب غير متصل — استخدم «فحص الأرقام» بعد الربط."}
                  </p>
                </div>
              )}
              <div className={cn("grid gap-3", importResult.skippedLandline ? "grid-cols-5" : "grid-cols-4")}>
                {[
                  { label: "مُضاف",        value: importResult.added,             color: "text-green-400" },
                  { label: "مكرر",         value: importResult.duplicates,        color: "text-yellow-400" },
                  { label: "غير صالح",     value: importResult.invalid,           color: "text-red-400" },
                  ...(importResult.skippedLandline
                    ? [{ label: "أرضي متجاهل", value: importResult.skippedLandline, color: "text-orange-400" }]
                    : []),
                  { label: "الإجمالي",     value: importResult.total,             color: "text-foreground" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-muted/50 rounded-xl p-3 text-center">
                    <p className={cn("text-xl font-bold", color)}>{value.toLocaleString("ar-SA")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                  </div>
                ))}
              </div>

              {importResult.autoSplit && importResult.groups.length > 1 && (
                <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold">تم التقسيم التلقائي إلى {importResult.groups.length} قائمة</span>
                    <CheckCircle2 className="w-4 h-4 text-green-400 mr-auto" />
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 max-h-52 overflow-y-auto">
                    {importResult.groups.map((g, i) => (
                      <button key={g.id} onClick={() => navigate(`/contacts/${g.id}`)}
                        className="flex items-center justify-between px-3 py-2 bg-card border border-card-border rounded-lg hover:border-primary/30 transition-colors group">
                        <div className="flex items-center gap-2">
                          <span className="w-5 h-5 flex items-center justify-center rounded-full bg-primary/15 text-primary text-xs font-bold">{i + 1}</span>
                          <span className="text-sm">{g.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-primary font-medium">{g.count.toLocaleString("ar-SA")} رقم</span>
                          <ArrowLeft className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Contacts Table */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-card-border flex items-center justify-between">
          <h2 className="font-semibold text-sm">الأرقام ({group.count.toLocaleString("ar-SA")})</h2>
          <div className="flex items-center gap-3">
            {group.count > 100 && <span className="text-xs text-muted-foreground">يُعرض أول 100</span>}
            {group.count > 0 && (
              <button
                onClick={exportToExcel}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/10 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                تصدير Excel
              </button>
            )}
          </div>
        </div>

        {!group.contacts?.length ? (
          <div className="py-12 text-center text-muted-foreground text-sm">لا توجد أرقام في هذه القائمة بعد</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-card-border bg-muted/20">
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium w-12">#</th>
                  {hasNames && <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">الاسم</th>}
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">رقم الهاتف</th>
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {group.contacts.slice(0, 100).map((contact: any, i: number) => (
                  <tr key={contact.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-2.5 text-xs text-muted-foreground">{i + 1}</td>
                    {hasNames && (
                      <td className="px-5 py-2.5 text-sm">
                        {contact.name || <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                    )}
                    <td className="px-5 py-2.5 text-sm font-mono text-foreground" dir="ltr">{contact.phone}</td>
                    <td className="px-5 py-2.5">
                      {contact.status === "invalid"
                        ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400">ليس على واتساب</span>
                        : contact.status === "active"
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400">واتساب ✓</span>
                          : <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{contact.status}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
