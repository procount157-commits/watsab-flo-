// ── The booking page a customer opens — no sign-in ────────────────
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function BookPage() {
  const [, params] = useRoute<{ token: string }>("/book/:token");
  const token = params?.token ?? "";
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState("");
  const [f, setF] = useState({ name: "", company: "", email: "", phone: "", topic: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const load = () => fetch(`${BASE}/api/book/${token}`).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setData(d); }).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, [token]);
  const submit = async () => {
    setBusy(true); setErr("");
    const r = await fetch(`${BASE}/api/book/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, at: pick }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error ?? "تعذّر الحجز"); void load(); return; }
    setDone(d);
  };
  const days = new Map<string, any[]>();
  for (const s of data?.slots ?? []) days.set(s.day, [...(days.get(s.day) ?? []), s]);
  const field = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:border-emerald-500";

  return (
    <div dir="rtl" className="min-h-screen bg-gray-50 text-gray-900 flex justify-center p-4" style={{ fontFamily: "Cairo, system-ui, sans-serif" }}>
      <div className="w-full max-w-xl space-y-4 py-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold">{data?.business || "احجز مكالمة"}</h1>
          <p className="text-sm text-gray-500">احجز مكالمة قصيرة ({data?.durationMin ?? 30} دقيقة) — Book a short call · توقيت الإمارات / UAE time</p>
        </div>
        {done ? (
          <div className="bg-white rounded-xl border border-emerald-200 p-6 text-center space-y-2">
            <p className="text-4xl">✅</p>
            <p className="font-bold">تم الحجز — Booked</p>
            <p className="text-sm">{done.ar}</p><p className="text-xs text-gray-500" dir="ltr">{done.en}</p>
            <p className="text-xs text-gray-500">سنتواصل معك لتأكيد الموعد. We'll be in touch to confirm.</p>
          </div>
        ) : !data ? <p className="text-center text-sm text-gray-500">{err || "…"}</p> : (
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-semibold">١. اختر الوقت — Pick a time</p>
              {!data.slots.length ? <p className="text-sm text-gray-500">لا أوقات متاحة حالياً — No times available right now.</p> : [...days.entries()].map(([day, list]) => (
                <div key={day}><p className="text-xs text-gray-500 mb-1">{list[0].dayAr} · <span dir="ltr">{list[0].dayEn}</span></p><div className="flex flex-wrap gap-1.5">{list.map((s) => (
                  <button key={s.at} onClick={() => setPick(s.at)} className={`px-3 py-1.5 rounded-lg border text-xs ${pick === s.at ? "bg-emerald-600 text-white border-emerald-600" : "border-gray-300 hover:border-emerald-500"}`}>{s.time}</button>
                ))}</div></div>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold">٢. بياناتك — Your details</p>
              <input className={field} placeholder="الاسم — Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <input className={field} placeholder="الشركة — Company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
              <input className={field} dir="ltr" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              <input className={field} dir="ltr" placeholder="Phone / WhatsApp" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              <textarea className={field} placeholder="عن ماذا تريد أن نتحدث؟ — What would you like to discuss?" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <button onClick={submit} disabled={busy || !pick || !f.name.trim() || (!f.email.trim() && !f.phone.trim())} className="w-full rounded-lg bg-emerald-600 text-white py-2.5 font-semibold disabled:opacity-40">{busy ? "…" : "احجز — Book"}</button>
          </div>
        )}
      </div>
    </div>
  );
}
