// ── «ادرس موقعي» ──────────────────────────────────────────────────
// الرابط، ثم يقرأ الخادم حتى ٢٥ صفحة: المعرفة إلى «معرفة البوت»،
// والصور إلى «معرض الصور». تعمل في الخلفية، والنتيجة تظهر هنا حين تنتهي.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Globe, Loader2 } from "lucide-react";
import { Link } from "wouter";

const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(path, { credentials: "include", headers: init?.body ? { "Content-Type": "application/json" } : undefined, ...init });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "فشل الطلب");
  return d;
};

export function SiteStudy() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const { data } = useQuery<any>({ queryKey: ["study-site"], queryFn: () => api("/api/knowledge/study-site"), refetchInterval: (q) => (q.state.data?.running ? 5000 : false) });
  const start = useMutation({
    mutationFn: () => api("/api/knowledge/study-site", { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: (d) => { toast.success(d.note); qc.invalidateQueries({ queryKey: ["study-site"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const last = data?.last;
  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2"><Globe className="w-5 h-5 text-primary" /><p className="font-semibold">ادرس موقعي</p></div>
      <p className="text-xs text-muted-foreground">اكتب رابط موقعك: يقرأ حتى ٢٥ صفحة، فتصير خدماتك وعروضك معرفةً يردّ منها البوت ويكتب منها الحملات، وتنتقل صور الموقع إلى معرض الصور.</p>
      <div className="flex gap-2 flex-wrap">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="مثلاً: pro-count.ae" dir="ltr"
          className="flex-1 min-w-48 px-3 py-2 bg-input border border-border rounded-lg text-sm" />
        <button onClick={() => start.mutate()} disabled={!url.trim() || start.isPending || data?.running}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50">
          {data?.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
          {data?.running ? "يقرأ الموقع…" : "ادرس الموقع"}
        </button>
      </div>
      {last && !data?.running && (
        <p className={last.error ? "text-xs text-red-400" : "text-xs text-muted-foreground"}>
          {last.error ? `تعذّرت الدراسة: ${last.error}` : <>آخر دراسة لـ {last.site}: قُرئت {last.pages} صفحة، وكُتب {last.entries} مدخل معرفة، و{last.images} صورة في <Link href="/gallery" className="text-primary underline">المعرض</Link>.</>}
        </p>
      )}
    </div>
  );
}
