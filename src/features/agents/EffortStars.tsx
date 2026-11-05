/* Shooting-star field behind the max effort level, adapted from easyui
   "ShootingStars" (MIT, (c) 2026 Suraj Maurya): a twinkling starfield on
   canvas with periodic meteors that have gradient trails and glowing heads.
   Simplified to the slider's violet/white palette (rgba literals mirror the
   accent and violet tokens; canvas stops cannot read CSS vars). Static single
   frame under prefers-reduced-motion, and the loop pauses while offscreen. */
import { useEffect, useRef } from "react";
import styles from "./Composer.module.css";

type Star = {
  x: number;
  y: number;
  size: number;
  phase: number;
  speed: number;
  min: number;
  max: number;
  violet: boolean;
};

type Meteor = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  length: number;
  width: number;
};

const TRAIL = [202, 191, 253];
const HEAD = "255, 255, 255";

export default function EffortStars() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let raf = 0;
    let nextSpawn = 0;
    let visible = true;

    const seedStars = () => {
      const count = Math.round(Math.min(48, Math.max(14, (width * height) / 140)));
      stars = Array.from({ length: count }, () => {
        const max = 0.35 + Math.random() * 0.55;
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          size: 0.5 + Math.random() * 1.1,
          phase: Math.random() * Math.PI * 2,
          speed: 0.015 + Math.random() * 0.045,
          min: 0.08 + Math.random() * 0.12,
          max,
          violet: Math.random() < 0.4,
        };
      });
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      seedStars();
      meteors = [];
    };

    const spawnMeteor = (now: number) => {
      const length = 60 + Math.random() * 70;
      meteors.push({
        x: -length,
        y: Math.random() * height,
        vx: 5 + Math.random() * 5,
        vy: 0.6 + Math.random() * 1.6,
        life: 0,
        maxLife: Math.ceil((width + length * 2) / 5),
        length,
        width: 0.9 + Math.random() * 0.7,
      });
      nextSpawn = now + 1100 + Math.random() * 1100;
    };

    const drawStars = (now: number) => {
      for (const star of stars) {
        const glow = (Math.sin(star.phase + now * star.speed) + 1) / 2;
        const alpha = star.min + glow * (star.max - star.min);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = star.violet ? `rgba(${TRAIL[0]}, ${TRAIL[1]}, ${TRAIL[2]}, 1)` : `rgba(${HEAD}, 1)`;
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const drawMeteors = () => {
      meteors = meteors.filter((m) => {
        m.life += 1;
        m.x += m.vx;
        m.y += m.vy;
        if (m.life >= m.maxLife || m.x - m.length > width || m.y - m.length > height) return false;
        const fade = Math.sin((m.life / m.maxLife) * Math.PI);
        const tailX = m.x - m.vx * (m.length / 8);
        const tailY = m.y - m.vy * (m.length / 8);
        const trail = ctx.createLinearGradient(tailX, tailY, m.x, m.y);
        trail.addColorStop(0, "rgba(0, 0, 0, 0)");
        trail.addColorStop(0.55, `rgba(${TRAIL[0]}, ${TRAIL[1]}, ${TRAIL[2]}, ${0.75 * fade})`);
        trail.addColorStop(1, `rgba(${HEAD}, ${fade})`);
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, fade));
        ctx.strokeStyle = trail;
        ctx.lineWidth = m.width * 2.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(m.x, m.y);
        ctx.stroke();
        ctx.fillStyle = `rgba(${HEAD}, 1)`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.width, 0, Math.PI * 2);
        ctx.fill();
        const halo = ctx.createRadialGradient(m.x, m.y, 0.5, m.x, m.y, m.width * 5);
        halo.addColorStop(0, `rgba(${HEAD}, 0.9)`);
        halo.addColorStop(0.4, `rgba(${TRAIL[0]}, ${TRAIL[1]}, ${TRAIL[2]}, 0.5)`);
        halo.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.width * 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return true;
      });
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resize();
    if (reduced || typeof ResizeObserver === "undefined" || typeof IntersectionObserver === "undefined") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStars(1200);
      return;
    }

    const frame = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawStars(now);
      if (visible) {
        if (now >= nextSpawn && meteors.length < 2) spawnMeteor(now);
        drawMeteors();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const visibility = new IntersectionObserver(
      ([entry]) => {
        visible = entry ? entry.isIntersecting || entry.intersectionRatio > 0 : true;
      },
      { rootMargin: "50px 0px" },
    );
    visibility.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      visibility.disconnect();
    };
  }, []);

  return (
    <div className={styles.effortStars} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}
