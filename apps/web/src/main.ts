/** Landing-page demo: a scripted EN→HI exchange typed out with realistic timing, plus a waveform. */

const SCRIPT: ReadonlyArray<readonly [string, string, number]> = [
  ["Hi everyone, thanks for joining.", "नमस्ते सभी, जुड़ने के लिए धन्यवाद।", 980],
  ["I'll send you the report tomorrow morning.", "मैं आपको रिपोर्ट कल सुबह भेज दूँगा।", 1040],
  ["Does that work for you?", "क्या यह आपके लिए ठीक है?", 910],
  ["Let's move on to the roadmap.", "चलिए रोडमैप पर चलते हैं।", 1010],
];

const src = document.getElementById("src");
const dst = document.getElementById("dst");
const lat = document.getElementById("lat");
const canvas = document.getElementById("wave") as HTMLCanvasElement | null;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let speaking = 0; // 0..1 drives waveform amplitude

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
      speaking = 1;
      const typing = type(src, en, 55);
      // translation starts before the English finishes (speculative), Hindi lands ~ms after the phrase end
      await sleep(Math.max(0, en.length * 55 - 300));
      speaking = 0.35;
      await typing;
      speaking = 0;
      await sleep(ms - 300);
      lat.textContent = `${(ms / 1000).toFixed(2)} s`;
      speaking = 0.8;
      await type(dst, hi, 40);
      speaking = 0;
      await sleep(1400);
    }
  }
}

function wave(): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const bars = 96;
  const phase = new Float32Array(bars).map(() => Math.random() * Math.PI * 2);
  let amp = 0;
  let t = 0;
  const draw = () => {
    t += 0.045;
    amp += (speaking - amp) * 0.08;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const gap = w / bars;
    for (let i = 0; i < bars; i++) {
      const env = Math.sin((i / bars) * Math.PI); // taller in the middle
      const n = 0.5 + 0.5 * Math.sin(t * 2.1 + (phase[i] ?? 0)) * Math.sin(t * 0.7 + i * 0.3);
      const bh = 4 + (h - 8) * env * (0.06 + amp * n * 0.94);
      const x = i * gap + gap * 0.3;
      const g = ctx.createLinearGradient(0, (h - bh) / 2, 0, (h + bh) / 2);
      g.addColorStop(0, "rgba(108,140,255,0.95)");
      g.addColorStop(1, "rgba(138,92,242,0.95)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, (h - bh) / 2, gap * 0.4, bh, 3);
      ctx.fill();
    }
    if (!reduced) requestAnimationFrame(draw);
  };
  draw();
}

function reveal(): void {
  const els = document.querySelectorAll("section > *, .pipeline li, .lang-grid li, .rm > div");
  if (!("IntersectionObserver" in window)) return;
  for (const el of els) el.classList.add("reveal");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of els) io.observe(el);
}

wave();
reveal();
void run();
