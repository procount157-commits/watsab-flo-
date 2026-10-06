import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation, useRoute, Link } from "wouter";
import {
  useListContacts,
  useCreateCampaign,
  useUpdateCampaign,
  useGetCampaign,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Plus, Trash2, Loader2, Upload,
  X, Image, Film, Users, ClipboardPaste, Braces,
  Phone, Link2, MessageSquare, Eye, Shuffle, ShieldAlert, ShieldCheck, ShieldX,
  BookOpen, Sparkles, ThumbsUp, ThumbsDown, BellOff,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────

type ButtonType  = "url" | "call" | "reply" | "interested" | "not_interested" | "stop";
type ButtonColor = "default" | "green" | "blue" | "red" | "orange" | "purple";
type Button = { text: string; type: ButtonType; url?: string; phone?: string; color?: ButtonColor };
type CarouselCard = {
  title: string;
  description: string;
  imagePath: string;
  imageFilename: string;
  imageUrl: string;
  buttonText: string;
  buttonUrl: string;
};
interface UploadedMedia {
  filename: string; path: string; url: string; size: number; mimetype: string;
}

// ── Helpers ────────────────────────────────────────────────────────

const inputCls =
  "w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-sm text-muted-foreground mb-1.5";

const MSG_TYPES = [
  { val: "text",     label: "نص فقط",   icon: "💬", desc: "رسالة نصية" },
  { val: "image",    label: "صورة",     icon: "🖼️", desc: "صورة + نص" },
  { val: "video",    label: "فيديو",    icon: "🎬", desc: "فيديو + نص" },
  { val: "carousel", label: "كاروسيل", icon: "🎠",  desc: "بطاقات متعددة" },
];

const BTN_TYPES: { val: ButtonType; label: string; icon: React.ReactNode }[] = [
  { val: "url",            label: "رابط",         icon: <Link2 className="w-3.5 h-3.5" /> },
  { val: "call",           label: "اتصال",        icon: <Phone className="w-3.5 h-3.5" /> },
  { val: "reply",          label: "رد سريع",      icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { val: "interested",     label: "مهتم",         icon: <ThumbsUp className="w-3.5 h-3.5" /> },
  { val: "not_interested", label: "غير مهتم",     icon: <ThumbsDown className="w-3.5 h-3.5" /> },
  { val: "stop",           label: "إيقاف الرسائل", icon: <BellOff className="w-3.5 h-3.5" /> },
];

const STOP_BUTTON: Button = { text: "إيقاف الرسائل", type: "stop", url: "", color: "red" };

/** Ready buttons: one tap adds one. Links and calls still need their address. */
const BTN_PRESETS: { icon: string; label: string; btn: Button }[] = [
  { icon: "👍", label: "مهتم",             btn: { text: "مهتم", type: "interested", url: "", color: "green" } },
  { icon: "👎", label: "غير مهتم",         btn: { text: "غير مهتم", type: "not_interested", url: "", color: "default" } },
  { icon: "🛑", label: "إيقاف الرسائل",    btn: STOP_BUTTON },
  { icon: "💰", label: "أريد عرض سعر",     btn: { text: "أريد عرض سعر", type: "reply", url: "", color: "purple" } },
  { icon: "❓", label: "عندي سؤال",        btn: { text: "عندي سؤال", type: "reply", url: "", color: "blue" } },
  { icon: "⏰", label: "كلمني لاحقاً",     btn: { text: "كلمني لاحقاً", type: "reply", url: "", color: "orange" } },
  { icon: "📞", label: "اتصل بنا",         btn: { text: "اتصل بنا", type: "call", url: "", phone: "", color: "default" } },
  { icon: "🌐", label: "زوروا موقعنا",     btn: { text: "زوروا موقعنا", type: "url", url: "", color: "blue" } },
  { icon: "📅", label: "احجز موعد",        btn: { text: "احجز موعد", type: "url", url: "", color: "green" } },
  { icon: "📍", label: "موقعنا",           btn: { text: "موقعنا على الخريطة", type: "url", url: "", color: "default" } },
];

/** The buttons as they will go: with the stop button added if asked and not already there. */
function withStopButton(btns: Button[], add: boolean): Button[] {
  const valid = btns.filter((b) => b.text.trim());
  return add && !valid.some((b) => b.type === "stop") ? [...valid, STOP_BUTTON] : valid;
}

/** The «أرسل: 0» line campaigns used to end with — the stop button replaced it. */
const stripZeroLine = (m: string) => m.replace(/\n*━+\n🔕 لإيقاف الرسائل أرسل: 0[ \t]*/g, "").trimEnd();

const BTN_COLORS: { val: ButtonColor; emoji: string; label: string; previewCls: string }[] = [
  { val: "default", emoji: "⬜", label: "افتراضي", previewCls: "bg-primary/15 border-primary/40 text-primary" },
  { val: "green",   emoji: "🟢", label: "أخضر",    previewCls: "bg-green-500/15 border-green-500/40 text-green-400" },
  { val: "blue",    emoji: "🔵", label: "أزرق",    previewCls: "bg-blue-500/15 border-blue-500/40 text-blue-400" },
  { val: "red",     emoji: "🔴", label: "أحمر",    previewCls: "bg-red-500/15 border-red-500/40 text-red-400" },
  { val: "orange",  emoji: "🟠", label: "برتقالي", previewCls: "bg-orange-500/15 border-orange-500/40 text-orange-400" },
  { val: "purple",  emoji: "🟣", label: "بنفسجي",  previewCls: "bg-purple-500/15 border-purple-500/40 text-purple-400" },
];

function btnColorEmoji(color: ButtonColor | undefined): string {
  const found = BTN_COLORS.find(c => c.val === color);
  return found && color !== "default" ? found.emoji + " " : "";
}

function btnPreviewCls(color: ButtonColor | undefined): string {
  return BTN_COLORS.find(c => c.val === color)?.previewCls ?? BTN_COLORS[0].previewCls;
}

const VARS = [
  { tag: "{اسم_الشركة|شركتكم}", desc: "شركة العميل — نظيفة ولغة الرسالة، و«شركتكم» إن لم يُحفظ اسم" },
  { tag: "{الاسم}",    desc: "الاسم المحفوظ للرقم (منظّفاً)" },
  { tag: "{الشركة}",   desc: "اسم شركتك أنت (المرسل)" },
  { tag: "{الوقت}",    desc: "الوقت الحالي" },
  { tag: "{التاريخ}",  desc: "تاريخ اليوم" },
];

const RANDOM_VARS = [
  { tag: "{تحية}",   desc: "تحية عشوائية لكل شخص",    preview: "مرحباً / هلا / أهلاً" },
  { tag: "{ختام}",   desc: "ختام عشوائي",              preview: "نتشرف بخدمتك / يسعدنا..." },
  { tag: "{cta}",    desc: "دعوة للتفاعل عشوائية",     preview: "تواصل معنا / راسلنا..." },
  { tag: "{فاصل}",   desc: "فاصل بصري عشوائي",         preview: "━━━ / ▪▪▪ / ───" },
];

const SPINTAX_EXAMPLES = [
  { label: "تحية مخصصة",   tag: "{مرحباً|هلا|أهلاً} فريق {اسم_الشركة|شركتكم}" },
  { label: "عرض متنوع",    tag: "{عرض حصري|تخفيض خاص|فرصة مميزة}" },
  { label: "ختام متنوع",   tag: "{تواصل معنا|راسلنا|كلمنا}" },
];

// ── Risk Score Calculator ──────────────────────────────────────────
function calcRiskScore(msg: string): { score: number; label: string; color: string; tips: string[] } {
  const tips: string[] = [];
  let score = 0;

  const hasSpintax  = /\{[^{}]*\|[^{}]*\}/.test(msg);
  const hasName     = /\{(الاسم|name|اسم)(\|[^{}]*)?\}|\{\s*(اسم_الشركة|اسم الشركة|شركة_العميل|client|company_name)(\|[^{}]*)?\}/i.test(msg);
  const hasRandom   = /\{تحية\}|\{ختام\}|\{cta\}|\{فاصل\}/.test(msg);
  const hasOtherVar = /\{الوقت\}|\{التاريخ\}|\{الشركة\}|\{الرقم\}/.test(msg);
  const isLong      = msg.length > 80;

  if (hasSpintax)  score += 40;
  if (hasName)     score += 25;
  if (hasRandom)   score += 20;
  if (hasOtherVar) score += 10;
  if (isLong)      score += 5;

  if (!hasName)     tips.push("أضف {اسم_الشركة|شركتكم} — اسم شركة كل عميل يجعل كل رسالة مختلفة، وهذا أقوى ما يقلّل الحظر");
  if (!hasSpintax)  tips.push("استخدم {خيار1|خيار2} لتنويع النص");
  if (!hasRandom)   tips.push("استخدم {تحية} أو {ختام} للتنوع");

  if (score >= 75) return { score, label: "ممتاز",      color: "text-green-400",  tips };
  if (score >= 45) return { score, label: "جيد",        color: "text-blue-400",   tips };
  if (score >= 20) return { score, label: "متوسط",      color: "text-yellow-400", tips };
  return               { score, label: "خطر الحظر",  color: "text-red-400",    tips };
}

function MessageRiskScore({ message }: { message: string }) {
  if (!message) return null;
  const { score, label, color, tips } = calcRiskScore(message);

  const Icon = score >= 75 ? ShieldCheck : score >= 20 ? ShieldAlert : ShieldX;
  const barColor = score >= 75 ? "bg-green-500" : score >= 45 ? "bg-blue-500" : score >= 20 ? "bg-yellow-500" : "bg-red-500";

  return (
    <div className="mt-2 p-3 bg-card border border-card-border rounded-xl space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className={cn("w-4 h-4", color)} />
          <span className="text-xs font-medium text-muted-foreground">مستوى الأمان:</span>
          <span className={cn("text-xs font-bold", color)}>{label}</span>
        </div>
        <span className={cn("text-xs font-mono font-bold", color)}>{score}/100</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-500", barColor)} style={{ width: `${score}%` }} />
      </div>
      {tips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {tips.map((tip, i) => (
            <span key={i} className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
              💡 {tip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── base64 helper ─────────────────────────────────────────────────
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = () => reject(new Error("فشل قراءة الملف"));
    reader.readAsDataURL(file);
  });
}

// ── MediaUploader (with drag-and-drop) ────────────────────────────

function MediaUploader({
  accept, isVideo, value, onChange, label,
}: {
  accept: string; isVideo: boolean;
  value: UploadedMedia | null; onChange: (m: UploadedMedia | null) => void;
  label?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/media/upload", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimetype: file.type, data: base64 }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "فشل الرفع"); }
      onChange(await res.json());
      toast.success("تم رفع الملف");
    } catch (e: any) { toast.error(e.message || "فشل الرفع"); }
    finally { setUploading(false); }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, []);

  if (value) {
    const isImg = value.mimetype?.startsWith("image/");
    return (
      <div className="rounded-xl overflow-hidden border border-primary/30 bg-input">
        {isImg && (
          <img src={value.url} alt={value.filename}
            className="w-full max-h-48 object-cover" />
        )}
        {!isImg && (
          <div className="h-20 flex items-center justify-center bg-black/20">
            <Film className="w-8 h-8 text-primary/60" />
          </div>
        )}
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{value.filename}</p>
            <p className="text-xs text-muted-foreground">{(value.size / 1024).toFixed(0)} KB</p>
          </div>
          <button type="button" onClick={() => onChange(null)} className="p-1 text-muted-foreground hover:text-red-400">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <input ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && ref.current?.click()}
        className={cn(
          "flex flex-col items-center justify-center gap-2 w-full px-4 py-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors",
          dragging
            ? "border-primary bg-primary/10 text-primary"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
          uploading && "opacity-50 cursor-not-allowed"
        )}
      >
        {uploading ? (
          <><Loader2 className="w-6 h-6 animate-spin" /><span className="text-sm">جاري الرفع...</span></>
        ) : (
          <>
            <Upload className="w-6 h-6" />
            <span className="text-sm font-medium">{label ?? (isVideo ? "ارفع أو اسحب فيديو" : "ارفع أو اسحب صورة")}</span>
            <span className="text-xs opacity-60">{isVideo ? "MP4، MOV — حتى 64MB" : "JPG، PNG، WebP — حتى 20MB"}</span>
          </>
        )}
      </div>
    </>
  );
}

// ── CardImageUploader ─────────────────────────────────────────────

function CardImageUploader({ value, onChange }: {
  value: { path: string; filename: string; url: string } | null;
  onChange: (v: { path: string; filename: string; url: string } | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/media/upload", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, mimetype: file.type, data: base64 }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "فشل الرفع"); }
      const data: UploadedMedia = await res.json();
      onChange({ path: data.path, filename: data.filename, url: data.url });
    } catch (e: any) { toast.error(e.message || "فشل الرفع"); }
    finally { setUploading(false); }
  };

  if (value) {
    return (
      <div className="rounded-lg overflow-hidden border border-primary/20">
        <img src={value.url} alt={value.filename} className="w-full h-24 object-cover" />
        <div className="flex items-center gap-2 px-2 py-1.5 bg-primary/5">
          <span className="text-xs text-foreground flex-1 truncate">{value.filename}</span>
          <button type="button" onClick={() => onChange(null)} className="text-muted-foreground hover:text-red-400">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
        onClick={() => ref.current?.click()}
        className={cn(
          "flex items-center justify-center gap-2 w-full px-3 py-3 border border-dashed rounded-lg text-xs cursor-pointer transition-colors",
          dragging ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary",
        )}
      >
        {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />رفع...</> : <><Upload className="w-3.5 h-3.5" />ارفع أو اسحب صورة البطاقة</>}
      </div>
    </>
  );
}

// ── WhatsApp Live Preview ──────────────────────────────────────────

function WAPreview({
  messageType, message, media, buttons, carousel,
}: {
  messageType: string;
  message: string;
  media: UploadedMedia | null;
  buttons: Button[];
  carousel: CarouselCard[];
}) {
  const now = new Date().toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
  const isEmpty = !message && !media && carousel.every(c => !c.title);

  return (
    <div className="sticky top-4 space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Eye className="w-4 h-4" />
        <span>معاينة واتساب</span>
      </div>

      {/* Phone frame */}
      <div className="rounded-3xl overflow-hidden border-2 border-border bg-[#111b21] shadow-2xl max-w-[320px] mx-auto">
        {/* Header */}
        <div className="bg-[#202c33] px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-primary-foreground">م</span>
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-white leading-none">حملتك</p>
            <p className="text-[10px] text-green-400 mt-0.5">متصل</p>
          </div>
          <div className="flex gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
          </div>
        </div>

        {/* Chat area */}
        <div
          className="min-h-64 px-3 py-4 flex flex-col items-start gap-2"
          style={{ background: "linear-gradient(#0b1e13 0%, #0d1f16 100%)" }}
        >
          {isEmpty ? (
            <div className="flex-1 flex items-center justify-center w-full py-8">
              <p className="text-xs text-white/20 text-center">ابدأ بكتابة رسالتك لترى المعاينة هنا</p>
            </div>
          ) : (
            <>
              {/* Carousel */}
              {messageType === "carousel" ? (
                <div className="w-full overflow-x-auto pb-1 -mx-1 px-1">
                  <div className="flex gap-2" style={{ width: "max-content" }}>
                    {carousel.filter(c => c.title).map((card, i) => (
                      <div key={i} className="w-44 rounded-xl overflow-hidden bg-[#1a3a25] border border-white/5 flex-shrink-0">
                        {card.imageUrl ? (
                          <img src={card.imageUrl} className="w-full h-24 object-cover" alt="" />
                        ) : (
                          <div className="w-full h-24 bg-white/5 flex items-center justify-center">
                            <Image className="w-7 h-7 text-white/15" />
                          </div>
                        )}
                        <div className="p-2.5 space-y-1">
                          <p className="text-xs font-semibold text-white leading-snug">{card.title}</p>
                          {card.description && <p className="text-[10px] text-white/50 leading-snug">{card.description}</p>}
                          {card.buttonText && (
                            <div className="mt-1.5 text-center text-[10px] text-primary bg-primary/10 py-1 rounded-lg font-medium">
                              {card.buttonText}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* Regular message bubble */
                <div className="w-full space-y-1">
                  <div className="max-w-[90%] rounded-xl rounded-tl-sm overflow-hidden shadow-md bg-[#1a3a25]">
                    {/* Media */}
                    {(messageType === "image" || messageType === "image_button") && (
                      media ? (
                        <img src={media.url} alt="" className="w-full max-h-40 object-cover" />
                      ) : (
                        <div className="w-full h-32 bg-white/5 flex items-center justify-center">
                          <Image className="w-8 h-8 text-white/15" />
                        </div>
                      )
                    )}
                    {(messageType === "video" || messageType === "video_button") && (
                      <div className="w-full h-32 bg-black/30 flex items-center justify-center">
                        <Film className="w-8 h-8 text-white/40" />
                        {media && <span className="absolute text-xs text-white/60 mt-16 font-mono">{media.filename}</span>}
                      </div>
                    )}

                    {/* Message text */}
                    {message && (
                      <div className="px-3 pt-2 pb-1">
                        <p className="text-xs text-white/90 whitespace-pre-wrap leading-relaxed text-right">
                          {message.length > 200 ? message.slice(0, 200) + "..." : message}
                        </p>
                      </div>
                    )}

                    {/* Timestamp */}
                    <div className="px-3 pb-2 flex justify-end items-center gap-1">
                      <span className="text-[9px] text-white/30">{now}</span>
                      <span className="text-[9px] text-primary">✓✓</span>
                    </div>
                  </div>
                  {/* Real WhatsApp buttons — under the bubble, one per row, as the phone shows them */}
                  {(messageType === "button" || messageType === "image_button" || messageType === "video_button") && buttons.filter(b => b.text).length > 0 && (
                    <div className="max-w-[90%] space-y-0.5">
                      {buttons.filter(b => b.text).map((btn, i) => (
                        <div key={i} className="rounded-lg bg-[#1a3a25] shadow-sm px-3 py-2 flex items-center justify-center gap-1.5">
                          <span className="text-[11px] leading-none text-[#53bdeb]">
                            {btn.type === "call" ? "📞" : btn.type === "url" ? "↗" : btn.type === "stop" ? "🛑" : "↩"}
                          </span>
                          <p className="text-[11px] font-medium text-[#53bdeb] leading-tight text-center">{btn.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Input bar mockup */}
        <div className="bg-[#1f2c34] px-3 py-2.5 flex items-center gap-2">
          <div className="flex-1 bg-[#2a3942] rounded-full h-8 flex items-center px-3">
            <span className="text-[10px] text-white/20">رسالة...</span>
          </div>
          <div className="w-7 h-7 bg-primary rounded-full flex items-center justify-center">
            <span className="text-[10px]">⬆</span>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-center text-muted-foreground/50">
        المعاينة تقريبية — قد يختلف الشكل الفعلي
      </p>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export default function CampaignNew() {
  const [, navigate] = useLocation();
  const [isEditRoute, editParams] = useRoute("/campaigns/:id/edit");
  const editId = isEditRoute && editParams?.id ? parseInt(editParams.id) : null;
  const isEdit = editId !== null;
  const queryClient = useQueryClient();
  const { data: groups } = useListContacts();
  const { data: existingCampaign, isLoading: loadingExisting } = useGetCampaign(editId ?? 0, {
    query: { enabled: isEdit } as any,
  });
  const [prefilled, setPrefilled] = useState(false);

  const [form, setForm] = useState({
    name: "",
    message: "",
    companyName: "",
    messageType: "text",
    pacingMode: "auto" as "auto" | "manual",
    delayMin: 15,
    delayMax: 45,
    scheduledAt: "",
    messageLimit: "" as string | number,
  });

  const [contactSource, setContactSource] = useState<"group" | "paste">("group");
  const [contactGroupId, setContactGroupId] = useState("");
  const [inlineNumbers, setInlineNumbers] = useState("");

  const [uploadedMedia, setUploadedMedia] = useState<UploadedMedia | null>(null);
  const [buttons, setButtons] = useState<Button[]>([{ text: "", type: "url", url: "", color: "default" }]);
  const [hasButtons, setHasButtons] = useState(false);
  // The way out is a button under every campaign message — fixed, not optional.
  // The server adds it too, so a campaign made before this carries it as well.
  const autoStop = true;
  const [carousel, setCarousel] = useState<CarouselCard[]>([
    { title: "", description: "", imagePath: "", imageFilename: "", imageUrl: "", buttonText: "", buttonUrl: "" },
  ]);

  const [showVarsGuide, setShowVarsGuide] = useState(false);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const [aiLoading, setAiLoading]   = useState(false);
  const [aiTone, setAiTone]         = useState<"friendly"|"professional"|"urgent"|"promotional">("friendly");

  const AI_TONES = [
    { val: "friendly",     label: "ودود" },
    { val: "professional", label: "رسمي" },
    { val: "urgent",       label: "عاجل" },
    { val: "promotional",  label: "ترويجي" },
  ] as const;

  const optimizeWithAI = async () => {
    if (!form.message.trim() || aiLoading) return;
    setAiLoading(true);
    try {
      const res = await fetch("/api/ai/optimize-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: form.message, tone: aiTone }),
      });
      if (!res.ok) throw new Error("فشل الطلب");
      const data = (await res.json()) as { result: string };
      setForm((f) => ({ ...f, message: data.result }));
      toast.success("✨ تم تحسين الرسالة بالذكاء الاصطناعي");
    } catch {
      toast.error("تعذّر تحسين الرسالة، حاول مرة أخرى");
    } finally {
      setAiLoading(false);
    }
  };


  const createMutation = useCreateCampaign({
    mutation: {
      onSuccess: (data) => {
        toast.success("تم إنشاء الحملة بنجاح");
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        navigate(`/campaigns/${(data as any).id}`);
      },
      onError: (err: any) => toast.error(err?.data?.error || "حدث خطأ أثناء الإنشاء"),
    },
  });

  const updateMutation = useUpdateCampaign({
    mutation: {
      onSuccess: () => {
        toast.success("تم حفظ التعديلات — يمكنك الآن تشغيل الحملة");
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        navigate(`/campaigns/${editId}`);
      },
      onError: (err: any) => toast.error(err?.data?.error || "حدث خطأ أثناء الحفظ"),
    },
  });

  // ── Prefill form when editing an existing campaign ─────────────────
  useEffect(() => {
    if (!isEdit || !existingCampaign || prefilled) return;
    const c: any = existingCampaign;
    setForm({
      name: c.name ?? "",
      message: stripZeroLine(c.message ?? ""),
      companyName: c.companyName ?? "",
      messageType: c.messageType === "image_button" ? "image" : c.messageType === "video_button" ? "video" : c.messageType === "button" ? "text" : (c.messageType ?? "text"),
      pacingMode: (c.pacingMode === "manual" ? "manual" : "auto") as "auto" | "manual",
      delayMin: c.delayMin ?? 15,
      delayMax: c.delayMax ?? 45,
      scheduledAt: c.scheduledAt ? new Date(c.scheduledAt).toISOString().slice(0, 16) : "",
      messageLimit: c.messageLimit ?? "",
    });
    if (c.mediaUrl) {
      setUploadedMedia({ filename: "", path: c.mediaUrl, url: c.mediaUrl, size: 0, mimetype: c.messageType === "video" ? "video/mp4" : "image/jpeg" });
    }
    if (c.buttons) {
      try {
        const parsed = JSON.parse(c.buttons);
        // The stop button is the toggle's; the editor shows only the others.
        const others = Array.isArray(parsed) ? parsed.filter((b: any) => b?.type !== "stop") : [];
        if (others.length > 0) {
          setHasButtons(true);
          setButtons(others.map((b: any) => ({
            text: b.text ?? "", type: (b.type as ButtonType) ?? "url",
            url: b.url ?? "", phone: b.phone ?? "", color: b.color ?? "default",
          })));
        }
      } catch {}
    }
    if (c.carousel) {
      try {
        const parsed = JSON.parse(c.carousel);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCarousel(parsed.map((card: any) => ({
            title: card.title ?? "", description: card.description ?? "",
            imagePath: card.imageUrl ?? "", imageFilename: "", imageUrl: card.imageUrl ?? "",
            buttonText: card.buttonText ?? "", buttonUrl: card.buttonUrl ?? "",
          })));
        }
      } catch {}
    }
    setPrefilled(true);
  }, [isEdit, existingCampaign, prefilled]);

  const isText     = form.messageType === "text";
  const isImage    = form.messageType === "image";
  const isVideo    = form.messageType === "video";
  const isCarousel = form.messageType === "carousel";

  const needsMedia   = isImage || isVideo;
  const needsButtons = hasButtons && !isCarousel;
  // What goes: the owner's buttons, and the stop button unless turned off.
  const sentButtons  = isCarousel ? [] : withStopButton(needsButtons ? buttons : [], autoStop);
  const sentType     = sentButtons.length ? (isImage ? "image_button" : isVideo ? "video_button" : "button") : form.messageType;

  const handleTypeChange = (val: string) => {
    setUploadedMedia(null);
    setForm((f) => ({ ...f, messageType: val }));
    if (val === "carousel") setHasButtons(false);
  };

  const updateCard = (i: number, key: keyof CarouselCard, val: string) => {
    setCarousel((prev) => prev.map((c, idx) => idx === i ? { ...c, [key]: val } : c));
  };

  const insertVar = (tag: string) => {
    const el = messageRef.current;
    if (!el) { setForm((f) => ({ ...f, message: f.message + tag })); return; }
    const start = el.selectionStart ?? el.value.length;
    const end   = el.selectionEnd ?? el.value.length;
    const newVal = el.value.slice(0, start) + tag + el.value.slice(end);
    setForm((f) => ({ ...f, message: newVal }));
    setTimeout(() => { el.focus(); el.setSelectionRange(start + tag.length, start + tag.length); }, 0);
  };

  const updateButton = (i: number, key: keyof Button, val: string) => {
    setButtons((prev) => prev.map((b, idx) => idx === i ? { ...b, [key]: val } : b));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name.trim())  { toast.error("يرجى كتابة اسم الحملة"); return; }
    if (!isCarousel && !form.message.trim()) { toast.error("يرجى كتابة نص الرسالة"); return; }
    if (!isEdit && contactSource === "group" && !contactGroupId) { toast.error("يرجى اختيار قائمة الأرقام"); return; }
    if (!isEdit && contactSource === "paste" && !inlineNumbers.trim()) { toast.error("يرجى لصق الأرقام أو اختيار قائمة"); return; }
    if (needsMedia && !uploadedMedia) { toast.error(isVideo ? "يرجى رفع فيديو" : "يرجى رفع صورة"); return; }

    if (needsButtons) {
      const valid = buttons.filter((b) => b.text.trim());
      if (!valid.length) { toast.error("أضف زراً واحداً على الأقل"); return; }
    }

    if (isCarousel) {
      const valid = carousel.filter((c) => c.title.trim());
      if (!valid.length) { toast.error("أضف بطاقة كاروسيل واحدة على الأقل"); return; }
    }

    const finalMessage = stripZeroLine(form.message);
    const finalMsgType = sentType;

    const payload: any = {
      name: form.name,
      message: finalMessage,
      messageType: finalMsgType,
      pacingMode: form.pacingMode,
      delayMin: form.delayMin,
      delayMax: form.delayMax,
      companyName: form.companyName || undefined,
      mediaUrl: uploadedMedia?.path ?? undefined,
    };

    if (!isEdit) {
      if (contactSource === "group") {
        payload.contactGroupId = parseInt(contactGroupId);
      } else {
        payload.inlineNumbers = inlineNumbers;
      }
    }

    payload.buttons = sentButtons.length ? JSON.stringify(sentButtons) : null;

    if (isCarousel) {
      payload.carousel = JSON.stringify(
        carousel.filter((c) => c.title.trim()).map((c) => ({
          title: c.title,
          description: c.description,
          imageUrl: c.imagePath,
          buttonText: c.buttonText,
          buttonUrl: c.buttonUrl,
        }))
      );
    } else if (isEdit) {
      payload.carousel = null;
    }

    if (form.scheduledAt) payload.scheduledAt = form.scheduledAt;
    const limit = typeof form.messageLimit === "string" ? parseInt(form.messageLimit) : form.messageLimit;
    if (limit && limit > 0) payload.messageLimit = limit;

    if (isEdit) {
      updateMutation.mutate({ id: editId!, data: payload });
    } else {
      createMutation.mutate({ data: payload });
    }
  };

  const inlineCount = inlineNumbers.split(/[\n,]+/).filter((l) => l.trim()).length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/campaigns" className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground">
          <ArrowRight className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{isEdit ? "تعديل الحملة" : "حملة جديدة"}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isEdit ? "عدّل الرسالة أو الأزرار ثم احفظ وأعد تشغيل الحملة" : "أنشئ حملة إرسال جماعي جديدة"}
          </p>
        </div>
      </div>

      {isEdit && loadingExisting && (
        <p className="text-sm text-muted-foreground mb-4">جارِ تحميل بيانات الحملة...</p>
      )}

      {/* 2-column layout: form + live preview */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-8 items-start max-w-5xl">
        {/* ── Form ── */}
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Campaign name */}
          <div>
            <label className={labelCls}>اسم الحملة *</label>
            <input type="text" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="مثال: حملة العروض الرمضانية" className={inputCls} />
          </div>

          {/* Company name */}
          <div>
            <label className={labelCls}>
              اسم الشركة
              <span className="text-xs text-muted-foreground/60 mr-2">(يُستخدم في متغير {"{الشركة}"})</span>
            </label>
            <input type="text" value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              placeholder="مثال: شركة النجم للتسويق" className={inputCls} />
          </div>

          {/* Contact source */}
          {isEdit ? (
            <div className="bg-card border border-card-border rounded-xl p-4">
              <p className="text-sm font-medium mb-1">قائمة الأرقام</p>
              <p className="text-xs text-muted-foreground">
                {(existingCampaign as any)?.contactGroupName || "الأرقام الملصقة عند الإنشاء"} — لا يمكن تغيير قائمة الأرقام عند التعديل
              </p>
            </div>
          ) : (
          <div className="bg-card border border-card-border rounded-xl overflow-hidden">
            <div className="flex border-b border-card-border">
              {[
                { id: "group", label: "قائمة موجودة", icon: <Users className="w-4 h-4" /> },
                { id: "paste", label: "لصق الأرقام مباشرة", icon: <ClipboardPaste className="w-4 h-4" /> },
              ].map(({ id, label, icon }) => (
                <button key={id} type="button"
                  onClick={() => setContactSource(id as "group" | "paste")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors",
                    contactSource === id
                      ? "bg-primary/10 text-primary border-b-2 border-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}>
                  {icon}{label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {contactSource === "group" ? (
                <select value={contactGroupId} onChange={(e) => setContactGroupId(e.target.value)} className={inputCls}>
                  <option value="">اختر قائمة الأرقام...</option>
                  {groups?.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} ({g.count} رقم)</option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">الصق الأرقام — رقم في كل سطر أو مفصولة بفواصل</p>
                  <div className="relative">
                    <textarea
                      value={inlineNumbers}
                      onChange={(e) => setInlineNumbers(e.target.value)}
                      placeholder={"971501234567\n971551234567\n971521234567"}
                      rows={4} dir="ltr"
                      className={inputCls + " resize-none font-mono text-xs pb-7"}
                    />
                    {inlineNumbers && (
                      <span className="absolute bottom-2 left-3 text-xs text-primary font-medium">
                        {inlineCount} رقم
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          )}

          {/* Message type selector */}
          <div>
            <label className={labelCls}>نوع الرسالة</label>
            <div className="grid grid-cols-3 gap-2">
              {MSG_TYPES.map(({ val, label, icon, desc }) => (
                <button key={val} type="button" onClick={() => handleTypeChange(val)}
                  className={cn(
                    "flex flex-col items-center gap-1 px-3 py-3 rounded-xl text-sm border transition-colors text-center",
                    form.messageType === val
                      ? "bg-primary/15 text-primary border-primary/40 font-medium"
                      : "bg-muted/40 text-muted-foreground border-border hover:border-primary/20 hover:text-foreground"
                  )}>
                  <span className="text-xl">{icon}</span>
                  <span className="font-medium text-xs">{label}</span>
                  <span className="text-[10px] opacity-70 leading-tight">{desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Message text + personalization vars */}
          {!isCarousel && (
            <div>
              <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
                <label className="text-sm text-muted-foreground">
                  {isText ? "نص الرسالة *" : "نص / تعليق *"}
                </label>
                <div className="flex items-center gap-1.5">
                  <Link href="/templates">
                    <a className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-primary/30 text-primary bg-primary/5 hover:bg-primary/10 transition-colors">
                      <BookOpen className="w-3.5 h-3.5" />
                      اختر من القوالب
                    </a>
                  </Link>
                  <button type="button" onClick={() => setShowVarsGuide((v) => !v)}
                    className={cn(
                      "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors",
                      showVarsGuide
                        ? "bg-primary/15 text-primary border-primary/30"
                        : "text-muted-foreground border-border hover:border-primary/30 hover:text-primary"
                    )}>
                    <Braces className="w-3.5 h-3.5" />
                    متغيرات التخصيص
                  </button>
                </div>
              </div>

              <RecipientPreview message={form.message} groupId={contactGroupId} companyName={form.companyName} />

              {showVarsGuide && (
                <div className="mb-2 p-3 bg-primary/5 border border-primary/20 rounded-xl space-y-4">

                  {/* Standard vars */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground">📌 متغيرات ثابتة</p>
                    <div className="grid grid-cols-2 gap-2">
                      {VARS.map(({ tag, desc }) => (
                        <button key={tag} type="button" onClick={() => insertVar(tag)}
                          className="flex items-center gap-2 px-2.5 py-2 bg-card border border-card-border rounded-lg hover:border-primary/40 hover:bg-primary/5 transition-colors text-right group">
                          <code className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">{tag}</code>
                          <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">{desc}</span>
                        </button>
                      ))}
                    </div>
                    {!form.companyName && (
                      <p className="text-xs text-yellow-500">⚠ لم تُدخل اسم الشركة — {"{الشركة}"} سيظهر فارغاً</p>
                    )}
                  </div>

                  {/* Random pool vars */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground">🎲 متغيرات عشوائية (مختلفة لكل شخص)</p>
                    <div className="grid grid-cols-1 gap-2">
                      {RANDOM_VARS.map(({ tag, desc, preview }) => (
                        <button key={tag} type="button" onClick={() => insertVar(tag)}
                          className="flex items-center gap-2 px-2.5 py-2 bg-card border border-card-border rounded-lg hover:border-primary/40 hover:bg-primary/5 transition-colors text-right group">
                          <code className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded flex-shrink-0">{tag}</code>
                          <div className="flex-1 min-w-0">
                            <span className="text-xs text-foreground">{desc}</span>
                            <span className="block text-[10px] text-muted-foreground/60 truncate">{preview}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Spintax */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Shuffle className="w-3.5 h-3.5 text-primary" />
                      <p className="text-xs font-semibold text-muted-foreground">Spintax — اكتب خياراتك بنفسك</p>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      صيغة: <code className="bg-primary/10 text-primary px-1 rounded">{"{خيار1|خيار2|خيار3}"}</code> — النظام يختار خياراً مختلفاً لكل شخص
                    </p>
                    <div className="grid grid-cols-1 gap-1.5">
                      {SPINTAX_EXAMPLES.map(({ label, tag }) => (
                        <button key={tag} type="button" onClick={() => insertVar(tag)}
                          className="flex items-center gap-2 px-2.5 py-1.5 bg-card border border-card-border rounded-lg hover:border-primary/40 hover:bg-primary/5 transition-colors text-right group">
                          <span className="text-[10px] text-muted-foreground w-16 flex-shrink-0">{label}:</span>
                          <code className="text-[10px] font-mono text-primary/80 truncate">{tag}</code>
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/60">
                      💡 يمكنك تداخل المتغيرات داخل الـ Spintax: {"{مرحباً|هلا} {الاسم}"}
                    </p>
                  </div>

                </div>
              )}

              <textarea ref={messageRef} value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder={`مثال: {تحية} {الاسم}، تفضل بزيارة {عرضنا الحصري|تخفيضاتنا المميزة|عروضنا الخاصة} من {الشركة} 🎁\n{فاصل}\n{ختام} 📲`}
                rows={6} className={inputCls + " resize-none"} />

              {/* ── AI Optimize Bar ── */}
              {form.message.trim().length > 5 && (
                <div className="mt-2 flex items-center gap-2 p-2.5 bg-primary/5 border border-primary/20 rounded-xl">
                  <Sparkles className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <span className="text-xs text-primary font-medium flex-shrink-0">حسّن بـ AI</span>
                  <div className="flex gap-1 flex-1 flex-wrap">
                    {AI_TONES.map(({ val, label }) => (
                      <button key={val} type="button"
                        onClick={() => setAiTone(val)}
                        className={cn(
                          "px-2 py-0.5 rounded-full text-[11px] font-medium transition-all",
                          aiTone === val
                            ? "bg-primary text-white"
                            : "bg-primary/10 text-primary hover:bg-primary/20"
                        )}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={optimizeWithAI} disabled={aiLoading}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex-shrink-0",
                      aiLoading
                        ? "bg-primary/20 text-primary cursor-not-allowed"
                        : "bg-primary text-white hover:bg-primary/90 active:scale-95 shadow-sm"
                    )}>
                    {aiLoading
                      ? <><Loader2 className="w-3 h-3 animate-spin" />جاري...</>
                      : <><Sparkles className="w-3 h-3" />تحسين</>}
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between mt-1">
                <p className="text-xs text-muted-foreground">{form.message.length} حرف</p>
                {form.message && (
                  <p className="text-[10px] text-muted-foreground/60">
                    {/\{[^{}]*\|[^{}]*\}/.test(form.message) && "✓ Spintax "}
                    {/\{تحية\}|\{ختام\}|\{cta\}|\{فاصل\}/.test(form.message) && "✓ عشوائي "}
                    {/\{الاسم\}/.test(form.message) && "✓ اسم"}
                  </p>
                )}
              </div>
              <MessageRiskScore message={form.message} />
            </div>
          )}

          {/* Media upload */}
          {needsMedia && (
            <div className="bg-card border border-card-border rounded-xl p-4">
              <label className={labelCls + " !mb-3"}>
                {isVideo ? "🎬 رفع الفيديو *" : "🖼️ رفع الصورة *"}
              </label>
              <MediaUploader
                accept={isVideo
                  ? "video/mp4,video/quicktime,video/x-msvideo,video/webm"
                  : "image/jpeg,image/png,image/gif,image/webp"}
                isVideo={isVideo}
                value={uploadedMedia}
                onChange={setUploadedMedia}
              />
            </div>
          )}

          {/* Buttons toggle — independent from message type */}
          {!isCarousel && (
            <div
              onClick={() => setHasButtons((v) => !v)}
              className={cn(
                "flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-colors select-none",
                hasButtons
                  ? "bg-primary/10 border-primary/30"
                  : "bg-card border-card-border hover:border-primary/20"
              )}
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">🔘</span>
                <div>
                  <p className={cn("text-sm font-semibold", hasButtons ? "text-primary" : "text-foreground")}>
                    إضافة أزرار تفاعلية
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    أزرار روابط أو اتصال تحت أي نوع رسالة — مستقلة عن الصورة
                  </p>
                </div>
              </div>
              <div className={cn(
                "w-10 h-5 rounded-full transition-colors relative flex-shrink-0",
                hasButtons ? "bg-primary" : "bg-muted"
              )}>
                <div className={cn(
                  "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                  hasButtons ? "right-0.5" : "left-0.5"
                )} />
              </div>
            </div>
          )}

          {/* Buttons editor — enhanced with types */}
          {needsButtons && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">🔘 الأزرار</p>
                  <p className="text-xs text-muted-foreground mt-0.5">أضف روابط أو أزرار اتصال أو ردود سريعة</p>
                </div>
                <button type="button" onClick={() => setButtons([...buttons, { text: "", type: "url", url: "", color: "default" }])}
                  className="flex items-center gap-1 text-xs text-primary border border-primary/30 px-2 py-1.5 rounded-lg hover:bg-primary/10 transition-colors">
                  <Plus className="w-3.5 h-3.5" /> إضافة زر
                </button>
              </div>

              {/* ── Quick presets ─────────────────────────────────── */}
              <div>
                <p className="text-xs text-muted-foreground mb-2">⚡ أزرار جاهزة — اضغط لإضافة زر:</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button"
                    onClick={() => setButtons([BTN_PRESETS[0]!.btn, BTN_PRESETS[1]!.btn, STOP_BUTTON].map((b) => ({ ...b })))}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-primary/15 border border-primary/40 text-primary font-medium hover:bg-primary/25 transition-colors">
                    ✨ الطقم الأساسي: مهتم · غير مهتم · إيقاف
                  </button>
                  {BTN_PRESETS.map(({ icon, label, btn }) => (

                    <button
                      key={label}
                      type="button"
                      onClick={() => setButtons((prev) => {
                        if (btn.type === "stop" && prev.some((b) => b.type === "stop")) return prev;
                        const newBtn: Button = { ...btn };
                        // Replace the first empty button if it exists, otherwise append
                        const firstEmpty = prev.findIndex((b) => !b.text.trim());
                        if (firstEmpty !== -1) {
                          const next = [...prev];
                          next[firstEmpty] = newBtn;
                          return next;
                        }
                        return [...prev, newBtn];
                      })}
                      className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-card border border-card-border hover:border-primary/40 hover:bg-primary/5 transition-colors text-foreground"
                    >
                      <span>{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                {buttons.map((btn, i) => (
                  <div key={i} className="bg-card border border-card-border rounded-xl p-3 space-y-2">
                    {/* Button type tabs */}
                    <div className="flex flex-wrap gap-1">
                      {BTN_TYPES.map(({ val, label, icon }) => (
                        <button key={val} type="button"
                          onClick={() => {
                            updateButton(i, "type", val);
                            if (!btn.text.trim()) {
                              if (val === "interested") updateButton(i, "text", "مهتم 👍");
                              if (val === "not_interested") updateButton(i, "text", "غير مهتم");
                              if (val === "stop") updateButton(i, "text", "إيقاف الرسائل");
                            }
                          }}
                          className={cn(
                            "flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors flex-1 justify-center",
                            btn.type === val
                              ? "bg-primary/15 text-primary border-primary/40 font-medium"
                              : "text-muted-foreground border-border hover:border-primary/20"
                          )}>
                          {icon}{label}
                        </button>
                      ))}
                      {buttons.length > 1 && (
                        <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}
                          className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {/* Button label */}
                    <input type="text" value={btn.text}
                      onChange={(e) => updateButton(i, "text", e.target.value)}
                      placeholder={btn.type === "call" ? "مثال: اتصل بنا الآن" : btn.type === "reply" ? "مثال: أرسل طلبك" : "مثال: اشتري الآن"}
                      className={inputCls} />

                    {/* Conditional field by type */}
                    {btn.type === "url" && (
                      <input type="url" value={btn.url ?? ""}
                        onChange={(e) => updateButton(i, "url", e.target.value)}
                        placeholder="الرابط (https://...)" className={inputCls} dir="ltr" />
                    )}
                    {btn.type === "call" && (
                      <input type="tel" value={btn.phone ?? ""}
                        onChange={(e) => updateButton(i, "phone", e.target.value)}
                        placeholder="رقم الهاتف (971XXXXXXXXX)" className={inputCls} dir="ltr" />
                    )}
                    {btn.type === "stop" && (
                      <p className="text-xs text-orange-400/90">🛑 من يضغطه لا تصله أي رسالة منك لمدة ٥ أشهر، ثم يعود تلقائياً لقوائمك.</p>
                    )}
                    {(btn.type === "interested" || btn.type === "not_interested") && (
                      <p className="text-xs text-muted-foreground">تُسجَّل الضغطة في تقرير الحملة ويصله رد شكر تلقائي.</p>
                    )}
                    {/* reply has no extra field */}

                    {/* Color picker */}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1.5">لون الزر</p>
                      <div className="flex gap-1.5 flex-wrap">
                        {BTN_COLORS.map((c) => (
                          <button key={c.val} type="button" title={c.label}
                            onClick={() => updateButton(i, "color", c.val)}
                            className={cn(
                              "w-7 h-7 rounded-lg border-2 flex items-center justify-center text-sm transition-all",
                              (btn.color ?? "default") === c.val
                                ? "border-primary scale-110 shadow-sm"
                                : "border-border hover:border-primary/50"
                            )}>
                            {c.emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Carousel editor */}
          {isCarousel && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">🎠 بطاقات الكاروسيل</p>
                  <p className="text-xs text-muted-foreground mt-0.5">كل بطاقة تُرسل كرسالة منفصلة بالترتيب</p>
                </div>
                <button type="button"
                  onClick={() => setCarousel([...carousel, { title: "", description: "", imagePath: "", imageFilename: "", imageUrl: "", buttonText: "", buttonUrl: "" }])}
                  className="flex items-center gap-1 text-xs text-primary border border-primary/30 px-2 py-1.5 rounded-lg hover:bg-primary/10 transition-colors">
                  <Plus className="w-3.5 h-3.5" /> بطاقة
                </button>
              </div>

              <div className="space-y-4">
                {carousel.map((card, i) => (
                  <div key={i} className="bg-card border border-card-border rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-primary">بطاقة {i + 1}</span>
                      {carousel.length > 1 && (
                        <button type="button" onClick={() => setCarousel(carousel.filter((_, j) => j !== i))}
                          className="p-1 text-muted-foreground hover:text-red-400 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <CardImageUploader
                      value={card.imagePath ? { path: card.imagePath, filename: card.imageFilename, url: card.imageUrl } : null}
                      onChange={(v) => {
                        updateCard(i, "imagePath",    v?.path     ?? "");
                        updateCard(i, "imageFilename", v?.filename ?? "");
                        updateCard(i, "imageUrl",      v?.url      ?? "");
                      }}
                    />

                    <input type="text" value={card.title}
                      onChange={(e) => updateCard(i, "title", e.target.value)}
                      placeholder="عنوان البطاقة *" className={inputCls} />

                    <textarea value={card.description}
                      onChange={(e) => updateCard(i, "description", e.target.value)}
                      placeholder="وصف البطاقة (اختياري)" rows={2}
                      className={inputCls + " resize-none"} />

                    <div className="grid grid-cols-2 gap-2">
                      <input type="text" value={card.buttonText}
                        onChange={(e) => updateCard(i, "buttonText", e.target.value)}
                        placeholder="نص الزر (اختياري)" className={inputCls} />
                      <input type="url" value={card.buttonUrl}
                        onChange={(e) => updateCard(i, "buttonUrl", e.target.value)}
                        placeholder="رابط الزر" className={inputCls} dir="ltr" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pacing */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-4">
            <p className="text-sm font-semibold">⏱ إيقاع الإرسال</p>

            {/* Auto / manual */}
            <div className="grid grid-cols-2 gap-2">
              {([
                { mode: "auto",   title: "تلقائي",  desc: "يوزّع الحصة اليومية على ساعات الإرسال" },
                { mode: "manual", title: "يدوي",    desc: "تحدّد المدة بين الرسائل بنفسك" },
              ] as const).map((o) => (
                <button
                  key={o.mode}
                  type="button"
                  onClick={() => setForm({ ...form, pacingMode: o.mode })}
                  className={`text-right p-3 rounded-lg border transition-colors ${
                    form.pacingMode === o.mode
                      ? "bg-primary/10 border-primary"
                      : "border-card-border hover:border-primary/50"
                  }`}
                >
                  <span className={`block text-sm font-semibold ${form.pacingMode === o.mode ? "text-primary" : ""}`}>
                    {o.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{o.desc}</span>
                </button>
              ))}
            </div>

            {form.pacingMode === "auto" && (
              <div className="rounded-lg bg-muted/40 border border-card-border p-3 space-y-1.5">
                <p className="text-xs text-foreground leading-relaxed">
                  يحسب النظام المدة قبل كل رسالة من عدد الرسائل المتبقية وحصتك اليومية
                  والوقت الباقي في نافذة الإرسال — ويعيد الحساب بعد كل رسالة.
                </p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  1500 رسالة على نافذة 12 ساعة ≈ فاصل 19 ثانية. إن توقّفت الحملة وعادت،
                  يعيد توزيع المتبقي على ما تبقّى من الوقت بدل أن ينتهي مبكراً أو يتجاوز النافذة.
                  ولا ينزل تحت 12 ثانية مهما ضاق الوقت.
                </p>
              </div>
            )}

            {form.pacingMode === "manual" && (
            <>
            {/* Presets */}
            <div className="flex flex-wrap gap-2">
              {[
                { label: "سريع", desc: "20–40 ث", min: 20, max: 40 },
                { label: "متوسط", desc: "45–90 ث", min: 45, max: 90 },
                { label: "بطيء", desc: "2–4 د", min: 120, max: 240 },
                { label: "عشوائي", desc: "30 ث – 5 د", min: 30, max: 300 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setForm({ ...form, delayMin: p.min, delayMax: p.max })}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                    form.delayMin === p.min && form.delayMax === p.max
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-card-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {p.label} <span className="opacity-60">({p.desc})</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {[
                { key: "delayMin", label: "الحد الأدنى" },
                { key: "delayMax", label: "الحد الأقصى" },
              ].map(({ key, label }) => {
                const val = form[key as keyof typeof form] as number;
                const display = val >= 60
                  ? `${Math.floor(val / 60)}:${String(val % 60).padStart(2, "0")} د`
                  : `${val} ث`;
                return (
                  <div key={key}>
                    <label className={labelCls}>{label}</label>
                    <div className="flex items-center gap-3">
                      <input type="range" min="5" max="300"
                        value={val}
                        onChange={(e) => setForm({ ...form, [key]: parseInt(e.target.value) })}
                        className="flex-1 accent-primary" />
                      <span className="text-xs font-mono w-16 text-center text-primary bg-muted rounded px-1 py-0.5">
                        {display}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              النظام يختار وقتاً عشوائياً بين الحدَّين. الوضع اليدوي لا يلاحق الحصة اليومية —
              إن أردت بلوغ 1500 رسالة استخدم الإيقاع التلقائي.
            </p>
            </>
            )}
          </div>

          {/* Message limit */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">🔢 حد الرسائل لكل تشغيل</p>
              <span className="text-xs text-muted-foreground">اختياري</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min="1"
                placeholder="مثال: 50 (اتركه فارغاً للإرسال للكل)"
                value={form.messageLimit}
                onChange={(e) => setForm({ ...form, messageLimit: e.target.value })}
                className={inputCls + " flex-1"}
              />
              {form.messageLimit && (
                <button
                  type="button"
                  onClick={() => setForm({ ...form, messageLimit: "" })}
                  className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
                >
                  مسح
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              عند الوصول للحد، تتوقف الحملة مؤقتاً — يمكن استئنافها لإرسال الدفعة التالية
            </p>
          </div>

          {/* Schedule */}
          <div>
            <label className={labelCls}>جدولة (اختياري)</label>
            <input type="datetime-local" value={form.scheduledAt}
              onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
              className={inputCls} />
          </div>

          {/* The stop button — fixed under every message, not a «send 0» line */}
          {!isCarousel && (
            <div className="flex items-center gap-3 p-4 rounded-xl border bg-orange-500/10 border-orange-500/30">
              <span className="text-xl">🛑</span>
              <div>
                <p className="text-sm font-semibold text-orange-400">زر «إيقاف الرسائل» ثابت تحت كل رسالة</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  من يضغطه يُحظر من الإرسال ٥ أشهر تلقائياً — يتخطّاه النظام في كل الحملات حتى لو جاء دوره، ثم يعود بعدها.
                  زر الخروج السهل يقلّل «الإبلاغ والحظر» على رقمك.
                </p>
              </div>
            </div>
          )}

          {/* Submit */}
          <button type="submit" disabled={createMutation.isPending || updateMutation.isPending}
            className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
            {isEdit
              ? (updateMutation.isPending
                  ? <><Loader2 className="w-4 h-4 animate-spin" />جاري الحفظ...</>
                  : "حفظ التعديلات ✓")
              : (createMutation.isPending
                  ? <><Loader2 className="w-4 h-4 animate-spin" />جاري الإنشاء...</>
                  : "إنشاء الحملة →")
            }
          </button>
        </form>

        {/* ── Live Preview ── */}
        <div className="hidden xl:block">
          <WAPreview
            messageType={sentType}
            message={form.message}
            media={uploadedMedia}
            buttons={sentButtons}
            carousel={carousel}
          />
        </div>
      </div>
    </div>
  );
}


// ── The message as three real numbers of the chosen list will receive it ──
function RecipientPreview({ message, groupId, companyName }: { message: string; groupId: string; companyName?: string }) {
  const [data, setData] = useState<{ samples: Array<{ name: string | null; phone: string; text: string }>; varies: boolean } | null>(null);
  useEffect(() => {
    if (!message.trim()) { setData(null); return; }
    const t = setTimeout(() => {
      fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/campaigns/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, groupId: groupId || null, companyName: companyName || null }) })
        .then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [message, groupId, companyName]);
  if (!data) return null;
  return (
    <div className="mb-2 p-3 rounded-xl border border-card-border bg-card/60 space-y-2">
      <p className="text-xs font-semibold text-muted-foreground">كما تصل إلى {groupId ? "أول ٣ أرقام في القائمة" : "٣ أمثلة"}</p>
      {!data.varies && <p className="text-xs text-red-400">⚠ الرسالة متطابقة لكل الناس — هذا أول ما يرصده واتساب كرسائل جماعية. أضف {"{اسم_الشركة|شركتكم}"} أو تنويعاً {"{خيار|خيار}"}.</p>}
      {data.samples.map((s) => (
        <div key={s.phone} className="rounded-lg bg-primary/5 border border-primary/15 p-2.5">
          <p className="text-[10px] text-muted-foreground mb-1" dir="ltr">{s.phone}{s.name ? ` · ${s.name}` : " · بلا اسم محفوظ"}</p>
          <p className="text-xs whitespace-pre-wrap leading-relaxed" dir="auto">{s.text}</p>
        </div>
      ))}
    </div>
  );
}
