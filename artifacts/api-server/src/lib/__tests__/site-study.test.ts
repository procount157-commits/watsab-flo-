export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { readPage, rankLinks } = await import("../site-study");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(50)} ${d}`); };
const html = `<html><head><title>خدماتنا — برو كاونت</title><meta name="description" content="محاسبة وضرائب"><meta property="og:image" content="/img/hero.jpg"></head>
<body><nav><a href="/login">دخول</a></nav><h1>خدمات المحاسبة</h1><p>مسك الدفاتر والضريبة</p><script>var x=1</script>
<a href="/services/aml">AML</a><a href="https://other.com/x">خارج</a><a href="/cart">سلة</a><a href="/file.pdf">ملف</a>
<img src="/img/team.jpg" alt="فريق المحاسبين"><img src="/logo.png" alt="logo"><img src="/x.jpg"></body></html>`;
const p = readPage(html, "https://pro-count.ae/services");
check("العنوان والوصف", p.title === "خدماتنا — برو كاونت" && p.description === "محاسبة وضرائب");
check("النص بلا سكربت ولا قائمة تنقل", p.text.includes("مسك الدفاتر") && !p.text.includes("var x") && !p.text.includes("دخول"));
check("روابط النطاق نفسه فقط، بلا سلة ولا ملفات", p.links.length === 1 && p.links[0] === "https://pro-count.ae/services/aml", p.links.join(" "));
check("الصور: og وصورة لها وصف، بلا شعار", p.images.length === 2 && p.images[1]!.alt === "فريق المحاسبين", p.images.map((i) => i.src).join(" "));
const r = rankLinks(["https://a.ae/blog/2024/10/post", "https://a.ae/services", "https://a.ae/x/y/z"]);
check("صفحات الخدمات أولاً", r[0] === "https://a.ae/services");
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
