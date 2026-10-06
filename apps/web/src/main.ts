import "@fontsource-variable/inter";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/noto-serif-devanagari/500.css";

/**
 * Chrome Web Store listing. Empty until the listing is published; every "Get the extension" button
 * (`[data-store]`) falls back to the GitHub quick start in the meantime.
 */
const STORE_URL = "";
if (STORE_URL)
  for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-store]")) a.href = STORE_URL;

/** Landing-page demo: a scripted EN→HI exchange typed out with realistic timing, plus a level meter. */

const SCRIPT: ReadonlyArray<readonly [string, string, number]> = [
  ["Hi everyone, thanks for joining.", "नमस्ते सभी, जुड़ने के लिए धन्यवाद।", 740],
  ["I'll send you the report tomorrow morning.", "मैं आपको रिपोर्ट कल सुबह भेज दूँगा।", 810],
  ["Does that work for you?", "क्या यह आपके लिए ठीक है?", 690],
  ["Let's move on to the roadmap.", "चलिए रोडमैप पर चलते हैं।", 760],
];

const src = document.getElementById("src");
const dst = document.getElementById("dst");
const lat = document.getElementById("lat");
const speaker = document.querySelector<HTMLElement>(".tile.t1");
const mic = speaker?.querySelector<HTMLElement>(".mic");
const canvas = document.getElementById("wave") as HTMLCanvasElement | null;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let level = 0; // 0..1 drives the meter

async function type(el: HTMLElement, text: string, msPerChar: number): Promise<void> {
  el.textContent = "";
  el.classList.add("caret");
  for (const word of text.split(" ")) {
    el.textContent += (el.textContent ? " " : "") + word;
    await sleep(reduced ? 0 : msPerChar * word.length);
  }
  el.classList.remove("caret");
}

async function run(): Promise<void> {
  if (!src || !dst || !lat) return;
  for (;;) {
    for (const [en, hi, ms] of SCRIPT) {
      speaker?.classList.add("speaking");
      mic?.classList.add("on");
      dst.parentElement?.classList.add("stale");
      level = 1;
      const typing = type(src, en, 55);
      await sleep(Math.max(0, en.length * 55 - 300));
      level = 0.35;
      await typing;
      speaker?.classList.remove("speaking");
      mic?.classList.remove("on");
      level = 0;
      await sleep(ms - 300);
      lat.textContent = `${(ms / 1000).toFixed(2)} s`;
      level = 0.8;
      dst.parentElement?.classList.remove("stale");
      await type(dst, hi, 40);
      level = 0;
      await sleep(1500);
    }
  }
}

function meter(): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
  };
  resize();
  addEventListener("resize", resize);
  const bars = 72;
  const phase = Float32Array.from({ length: bars }, () => Math.random() * Math.PI * 2);
  let amp = 0;
  let t = 0;
  const draw = () => {
    t += 0.05;
    amp += (level - amp) * 0.1;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const gap = w / bars;
    for (let i = 0; i < bars; i++) {
      const env = 0.35 + 0.65 * Math.sin((i / bars) * Math.PI);
      const n = 0.5 + 0.5 * Math.sin(t * 2.3 + (phase[i] ?? 0)) * Math.sin(t * 0.8 + i * 0.35);
      const bh = Math.max(2 * dpr, (h - 4 * dpr) * env * (0.08 + amp * n * 0.92));
      ctx.fillStyle = amp > 0.05 ? "#e2552b" : "#c9c1b4";
      ctx.beginPath();
      ctx.roundRect(i * gap + gap * 0.3, (h - bh) / 2, gap * 0.4, bh, 1.5 * dpr);
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(draw);
  };
  draw();
}

function reveal(): void {
  if (!("IntersectionObserver" in window)) return;
  const els = document.querySelectorAll(
    ".sec-head, .steps li, .lang-list li, .rm li, .numbers > div, .hops, .craft > *, .final > *",
  );
  for (const el of els) el.classList.add("reveal");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
    },
    { rootMargin: "0px 0px -40px 0px" },
  );
  for (const el of els) io.observe(el);
}

meter();
reveal();
void run();
