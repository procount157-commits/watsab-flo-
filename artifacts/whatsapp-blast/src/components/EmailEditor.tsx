// ── Writing an email the way it will be read ─────────────────────
// A visual editor in place of raw HTML: the owner writes and formats as in a
// document — bold, lists, links, a highlighted box, a call-to-action button,
// the company's name as a field — and sees the email beside it exactly as it
// will arrive, in the firm's branded layout, on a desktop or a phone. The
// HTML is still there, on its own tab, for whoever wants it.

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Bold, Code2, Eye, Italic, Link2, List, ListOrdered, Monitor, MousePointerClick, Heading2, Smartphone, SquareStack, Type, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const FIELDS: Array<[string, string]> = [
  ["{{company|your team}}", "Company / الشركة"],
  ["{{first_name|there}}", "First name / الاسم"],
  ["{{city}}", "City / المدينة"],
  ["{{sender}}", "Sender / المرسل"],
];
const WA = "https://wa.me/971542328336";

/** Keep what email can carry, drop what the browser's editing adds. */
function clean(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(?:on\w+|contenteditable|spellcheck|data-[\w-]+)="[^"]*"/gi, "")
    .replace(/<span(?![^>]*class=)[^>]*>([\s\S]*?)<\/span>/gi, "$1")
    .replace(/<div(?![^>]*class="note")[^>]*>([\s\S]*?)<\/div>/gi, "<p>$1</p>")
    .replace(/<p>\s*(<br\s*\/?>)?\s*<\/p>/gi, "")
    .replace(/\sstyle="[^"]*"/gi, "")
    .trim();
}

export function EmailEditor({ value, onChange, subject, minHeight = 320, compact }: { value: string; onChange: (html: string) => void; subject?: string; minHeight?: number; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"design" | "html">("design");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [preview, setPreview] = useState<{ subject: string; html: string; to?: { email: string; company: string | null } | null } | null>(null);
  const [showPreview, setShowPreview] = useState(!compact);
  const last = useRef(value);
  const rtl = (value.replace(/<[^>]+>/g, "").match(/[؀-ۿ]/g)?.length ?? 0) > (value.replace(/<[^>]+>/g, "").match(/[A-Za-z]/g)?.length ?? 0);

  // The editor's content follows the value when it changes from outside (a template picked, نورة's draft).
  useEffect(() => {
    if (mode === "design" && ref.current && value !== last.current) { ref.current.innerHTML = value; last.current = value; }
  }, [value, mode]);
  useEffect(() => { if (mode === "design" && ref.current) { ref.current.innerHTML = value; last.current = value; } }, [mode]);

  // The email as it will arrive, redrawn a moment after typing stops.
  useEffect(() => {
    if (!showPreview || !value.trim()) { setPreview(null); return undefined; }
    const t = setTimeout(() => { api("/api/email/preview", { method: "POST", body: JSON.stringify({ subject: subject ?? "", html: value }) }).then(setPreview).catch(() => {}); }, 500);
    return () => clearTimeout(t);
  }, [value, subject, showPreview]);

  const emit = () => { if (!ref.current) return; const h = clean(ref.current.innerHTML); last.current = h; onChange(h); };
  const cmd = (c: string, arg?: string) => { ref.current?.focus(); document.execCommand(c, false, arg); emit(); };
  const insertHtml = (html: string) => { ref.current?.focus(); document.execCommand("insertHTML", false, html); emit(); };

  const addLink = () => { const url = prompt("Link (https://…)", "https://www.pro-count.ae"); if (url) cmd("createLink", url); };
  const addButton = () => {
    const label = prompt(rtl ? "نص الزر" : "Button text", rtl ? "احجز استشارة مجانية" : "Book a free consultation");
    if (!label) return;
    const url = prompt(rtl ? "الرابط — واتساب افتراضياً" : "Link — WhatsApp by default", `${WA}?text=${encodeURIComponent(rtl ? `مرحباً بروكاونت، أرغب في ${label}` : `Hello Pro Count, I would like to ${label.charAt(0).toLowerCase()}${label.slice(1)}`)}`);
    if (!url) return;
    insertHtml(`<p class="cta"><a href="${url.replace(/"/g, "&quot;")}">${label}</a></p><p><br></p>`);
  };
  const addNote = () => insertHtml(`<div class="note">${rtl ? "نقطة مهمة…" : "Key point…"}</div><p><br></p>`);

  const tool = (on: boolean) => cn("p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors", on && "bg-muted text-foreground");
  const width = device === "phone" ? 380 : 640;

  return (
    <div className={cn("grid gap-3", showPreview && "xl:grid-cols-2")}>
      <div className="rounded-xl border border-card-border overflow-hidden bg-background/40">
        <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b border-card-border bg-muted/30">
          <button type="button" className={tool(mode === "design")} onClick={() => setMode("design")} title="Design"><Type className="w-3.5 h-3.5" /></button>
          <button type="button" className={tool(mode === "html")} onClick={() => setMode("html")} title="HTML"><Code2 className="w-3.5 h-3.5" /></button>
          <span className="w-px h-4 bg-card-border mx-1" />
          {mode === "design" && <>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("bold")} title="Bold"><Bold className="w-3.5 h-3.5" /></button>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("italic")} title="Italic"><Italic className="w-3.5 h-3.5" /></button>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("formatBlock", "h2")} title="Heading"><Heading2 className="w-3.5 h-3.5" /></button>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("insertUnorderedList")} title="Bullets"><List className="w-3.5 h-3.5" /></button>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("insertOrderedList")} title="Numbered"><ListOrdered className="w-3.5 h-3.5" /></button>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={addLink} title="Link"><Link2 className="w-3.5 h-3.5" /></button>
            <span className="w-px h-4 bg-card-border mx-1" />
            <button type="button" className={cn(tool(false), "flex items-center gap-1 text-[11px] px-2")} onMouseDown={(e) => e.preventDefault()} onClick={addButton} title="Call-to-action button"><MousePointerClick className="w-3.5 h-3.5" /> {rtl ? "زر" : "Button"}</button>
            <button type="button" className={cn(tool(false), "flex items-center gap-1 text-[11px] px-2")} onMouseDown={(e) => e.preventDefault()} onClick={addNote} title="Highlighted box"><SquareStack className="w-3.5 h-3.5" /> {rtl ? "صندوق" : "Box"}</button>
            <select className="bg-transparent text-[11px] text-muted-foreground border border-card-border rounded-md px-1.5 py-1 mx-1" value="" onMouseDown={(e) => e.stopPropagation()} onChange={(e) => { if (e.target.value) insertHtml(e.target.value); }}>
              <option value="">{rtl ? "+ حقل" : "+ Field"}</option>
              {FIELDS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}
            </select>
            <button type="button" className={tool(false)} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("undo")} title="Undo"><Undo2 className="w-3.5 h-3.5" /></button>
          </>}
          <button type="button" className={cn(tool(showPreview), "mr-auto ml-0 flex items-center gap-1 text-[11px] px-2")} onClick={() => setShowPreview(!showPreview)}><Eye className="w-3.5 h-3.5" /> {rtl ? "المعاينة" : "Preview"}</button>
        </div>
        {mode === "design" ? (
          <div ref={ref} contentEditable suppressContentEditableWarning onInput={emit} onBlur={emit} dir={rtl ? "rtl" : "ltr"}
            onPaste={(e) => { e.preventDefault(); const t = e.clipboardData.getData("text/plain"); document.execCommand("insertText", false, t); emit(); }}
            className="email-editor px-5 py-4 text-[14px] leading-7 text-foreground outline-none overflow-y-auto" style={{ minHeight, maxHeight: 640 }} />
        ) : (
          <textarea className={cn(input, "rounded-none border-0 font-mono text-[11px] leading-relaxed")} style={{ minHeight }} dir="ltr" value={value} onChange={(e) => { last.current = e.target.value; onChange(e.target.value); }} />
        )}
      </div>

      {showPreview && (
        <div className="rounded-xl border border-card-border overflow-hidden bg-[#eef2f6] flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 bg-white border-b text-black">
            <div className="min-w-0 flex-1" dir={rtl ? "rtl" : "ltr"}>
              <p className="text-[10px] text-gray-500 truncate" dir="rtl">{preview?.to ? `كما تصل إلى ${preview.to.company || preview.to.email} — كل مستلم يرى اسمه وشركته` : "كما تصل — باسم مثال"}</p>
              <p className="text-xs font-semibold truncate">{preview?.subject || subject || "—"}</p>
            </div>
            <button type="button" onClick={() => setDevice("desktop")} className={cn("p-1.5 rounded", device === "desktop" ? "bg-gray-200 text-black" : "text-gray-400")}><Monitor className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={() => setDevice("phone")} className={cn("p-1.5 rounded", device === "phone" ? "bg-gray-200 text-black" : "text-gray-400")}><Smartphone className="w-3.5 h-3.5" /></button>
          </div>
          <div className="flex-1 overflow-auto flex justify-center p-2">
            {preview ? <iframe title="preview" srcDoc={preview.html} style={{ width, minHeight: Math.max(minHeight + 120, 520) }} className="bg-white rounded border-0 transition-all" />
              : <p className="text-xs text-gray-400 self-center">{rtl ? "اكتب لترى المعاينة" : "Start writing to see the preview"}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A full-size look at a finished email, from the server's own rendering. */
export function EmailPreviewModal({ html, subject, onClose }: { html: string; subject: string; onClose: () => void }) {
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  if (!html) { toast.error("لا معاينة"); return null; }
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#eef2f6] rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-2.5 bg-white border-b text-black">
          <p className="text-sm font-semibold truncate flex-1">{subject}</p>
          <button onClick={() => setDevice("desktop")} className={cn("p-1.5 rounded", device === "desktop" ? "bg-gray-200" : "text-gray-400")}><Monitor className="w-4 h-4" /></button>
          <button onClick={() => setDevice("phone")} className={cn("p-1.5 rounded", device === "phone" ? "bg-gray-200" : "text-gray-400")}><Smartphone className="w-4 h-4" /></button>
          <button onClick={onClose} className="text-gray-500 text-sm px-2">✕</button>
        </div>
        <div className="flex-1 overflow-auto flex justify-center p-3"><iframe title="email" srcDoc={html} style={{ width: device === "phone" ? 390 : 680, height: "78vh" }} className="bg-white rounded border-0" /></div>
      </div>
    </div>
  );
}
