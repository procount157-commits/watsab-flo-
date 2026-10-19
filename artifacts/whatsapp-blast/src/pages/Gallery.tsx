// ── معرض الصور ────────────────────────────────────────────────────
// صاحب العمل: «أريد مكاناً أرفع فيه الصور، مثل معرض، والكاتب يكتب
// الحملات منها». كل صورةٍ هنا بوصفها ووسومها: الوصف يقول ما فيها
// («طقم الكلوفر على مانيكان»)، والوسوم تقول لأي حملة تصلح («أطقم»،
// «زفاف»، «عقارات»). كاتب الحملات يختار منها بالوسم والوصف، وما رُفع في
// أي حملة يظهر هنا أيضاً.

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Images, Upload, Trash2, Loader2, Tag, Globe } from "lucide-react";
import { api } from "@/components/AgentPanel";
import { cn } from "@/lib/utils";

type Asset = { id: number; url: string; caption: string | null; tags: string[]; source: string; sourceUrl: string | null; createdAt: string };

const toBase64 = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(f); });

export default function Gallery() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [filter, setFilter] = useState("");
  const [tagsForUpload, setTagsForUpload] = useState("");
  const { data, isLoading } = useQuery<{ assets: Asset[] }>({ queryKey: ["media-library"], queryFn: () => api("/api/media/library") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["media-library"] });

  const save = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<Asset> }) => api(`/api/media/library/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { refresh(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/media/library/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast.success("حُذفت من المعرض"); },
  });

  const upload = async (files: FileList) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) { toast.error("اختر صوراً (jpg/png/webp)"); return; }
    const tags = tagsForUpload.split(/[،,]/).map((t) => t.trim()).filter(Boolean);
    setUploading(list.length);
    let ok = 0;
    for (const f of list) {
      try {
        await api("/api/media/upload", { method: "POST", body: JSON.stringify({ filename: f.name, mimetype: f.type, data: await toBase64(f), tags }) });
        ok++;
      } catch (e: any) { toast.error(`${f.name}: ${e.message}`); }
      setUploading((n) => n - 1);
    }
    toast.success(`رُفعت ${ok} صورة إلى المعرض`);
    refresh();
  };

  const assets = (data?.assets ?? []).filter((a) => !filter || (a.caption ?? "").includes(filter) || a.tags.some((t) => t.includes(filter)));
  const allTags = [...new Set((data?.assets ?? []).flatMap((a) => a.tags))].slice(0, 30);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Images className="w-6 h-6 text-primary" /> معرض الصور</h1>
          <p className="text-sm text-muted-foreground mt-1">ارفع صور منشوراتك ومنتجاتك هنا مرة واحدة. اكتب لكل صورة وصفاً ووسوماً، وكاتب الحملات يختار منها.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={tagsForUpload} onChange={(e) => setTagsForUpload(e.target.value)} placeholder="وسوم للصور المرفوعة — مثلاً: أطقم، زفاف"
            className="px-3 py-2 bg-input border border-border rounded-lg text-sm w-64" />
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading > 0}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50">
            {uploading > 0 ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading > 0 ? `يرفع… (${uploading})` : "ارفع صوراً"}
          </button>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <Tag className="w-4 h-4 text-muted-foreground" />
          <button onClick={() => setFilter("")} className={cn("text-xs px-3 py-1 rounded-full border", !filter ? "bg-primary/15 text-primary border-primary/40" : "border-border text-muted-foreground")}>كل الصور ({data?.assets.length ?? 0})</button>
          {allTags.map((t) => (
            <button key={t} onClick={() => setFilter(filter === t ? "" : t)} className={cn("text-xs px-3 py-1 rounded-full border", filter === t ? "bg-primary/15 text-primary border-primary/40" : "border-border text-muted-foreground")}>{t}</button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
      ) : !assets.length ? (
        <div className="bg-card border border-card-border rounded-xl py-16 text-center">
          <Images className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium">المعرض فارغ</p>
          <p className="text-sm text-muted-foreground mt-1">ارفع صور منشوراتك أو منتجاتك، أو ادرس موقعك من صفحة «معرفة البوت» فتُجلب صوره إلى هنا.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
          {assets.map((a) => <AssetCard key={a.id} a={a} onSave={(body) => save.mutate({ id: a.id, body })} onDelete={() => confirm("حذف الصورة من المعرض؟") && del.mutate(a.id)} />)}
        </div>
      )}
    </div>
  );
}

function AssetCard({ a, onSave, onDelete }: { a: Asset; onSave: (b: Partial<Asset>) => void; onDelete: () => void }) {
  const [caption, setCaption] = useState(a.caption ?? "");
  const [tags, setTags] = useState(a.tags.join("، "));
  const dirty = caption !== (a.caption ?? "") || tags !== a.tags.join("، ");
  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden flex flex-col">
      <div className="relative aspect-square bg-muted">
        <img src={a.url} alt={a.caption ?? ""} className="w-full h-full object-cover" loading="lazy" />
        {a.source === "website" && <span className="absolute top-2 right-2 text-[10px] px-2 py-0.5 rounded-full bg-black/60 text-white flex items-center gap-1"><Globe className="w-3 h-3" /> من الموقع</span>}
      </div>
      <div className="p-3 space-y-2 flex-1">
        <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} placeholder="ماذا في الصورة؟"
          className="w-full px-2 py-1.5 bg-input border border-border rounded-lg text-xs resize-none" />
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="وسوم: أطقم، زفاف"
          className="w-full px-2 py-1.5 bg-input border border-border rounded-lg text-xs" />
        <div className="flex items-center justify-between">
          <button disabled={!dirty} onClick={() => onSave({ caption, tags: tags.split(/[،,]/).map((t) => t.trim()).filter(Boolean) })}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40">حفظ</button>
          <button onClick={onDelete} className="p-1.5 text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}
