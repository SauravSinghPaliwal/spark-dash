"use client";
import { motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";

export const fmtBytes = (b: number, d = 1) => {
  const [n, u] = fmtParts(b, d);
  return `${n} ${u}`;
};

export function fmtParts(b: number, d = 1): [string, string] {
  if (!Number.isFinite(b)) return ["–", ""];
  const u = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return [b.toFixed(b >= 100 || i === 0 ? 0 : d), u[i]];
}

/** Number that springs smoothly to each new value. */
export function AnimatedNumber({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 110, damping: 22 });
  const text = useTransform(spring, (v) => `${v.toFixed(decimals)}${suffix}`);
  useEffect(() => { mv.set(value); }, [value, mv]);
  return <motion.span>{text}</motion.span>;
}

/** Thin progress meter whose fill springs to its width. */
export function Meter({ value, color }: { value: number; color: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="meter">
      <motion.span initial={{ width: 0 }} animate={{ width: `${v}%` }} transition={{ type: "spring", stiffness: 70, damping: 18 }} style={{ background: color }} />
    </div>
  );
}

/** Small KPI sparkline (values 0..100), same look as the reference design. */
export function Spark({ data, color }: { data: number[]; color: string }) {
  const w = 230, h = 32;
  // pin to the right edge so a growing series scrolls in from the right
  const pts = data.map((v, i) => `${(w * (60 - data.length + i)) / 59},${(h - (Math.max(0, Math.min(100, v)) / 100) * h).toFixed(1)}`);
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${w} 35`} preserveAspectRatio="none">
        {pts.length > 1 && <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" />}
      </svg>
    </div>
  );
}
