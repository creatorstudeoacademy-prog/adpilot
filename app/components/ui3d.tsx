import type { ReactNode } from "react";
import { Text } from "@shopify/polaris";

/** 3D tilt card — lifts on hover. */
export function TiltCard({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div className="ap-tilt ap-enter" style={{ animationDelay: `${delay}s` }}>
      {children}
    </div>
  );
}

/** Glassmorphism card with depth. */
export function GlassCard({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <div className="ap-glass ap-enter" style={{ padding: 20, animationDelay: `${delay}s` }}>
      {children}
    </div>
  );
}

/** Hero banner with 3D depth + orbs. */
export function Hero3D({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="ap-hero-3d ap-enter" style={{ padding: "28px 24px", color: "#fff" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div
          style={{
            fontSize: 40,
            width: 72,
            height: 72,
            borderRadius: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(145deg, rgba(255,255,255,0.25), rgba(255,255,255,0.08))",
            boxShadow: "0 8px 24px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.4)",
            transform: "rotateX(8deg)",
          }}
        >
          {icon}
        </div>
        <div>
          <Text as="h2" variant="headingLg">
            <span style={{ color: "#fff" }}>{title}</span>
          </Text>
          <Text as="p" variant="bodyMd">
            <span style={{ color: "rgba(255,255,255,0.75)" }}>{subtitle}</span>
          </Text>
        </div>
      </div>
      {children && <div style={{ marginTop: 16 }}>{children}</div>}
    </div>
  );
}

/** 3D stat card with icon bubble. */
export function Stat3D({
  icon,
  iconTone = "violet",
  label,
  value,
  sub,
  delay = 0,
}: {
  icon: string;
  iconTone?: "violet" | "pink" | "amber" | "green" | "blue";
  label: string;
  value: string;
  sub?: string;
  delay?: number;
}) {
  return (
    <div className="ap-stat-3d ap-enter" style={{ padding: 16, flex: 1, animationDelay: `${delay}s` }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div className={`ap-icon-3d ${iconTone}`}>{icon}</div>
        <div>
          <Text as="p" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="p" variant="headingMd">
            {value}
          </Text>
          {sub && (
            <Text as="p" variant="bodySm" tone="subdued">
              {sub}
            </Text>
          )}
        </div>
      </div>
    </div>
  );
}

/** 3D progress bar. */
export function Progress3D({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="ap-progress-3d">
      <div style={{ width: `${clamped}%` }} />
    </div>
  );
}

/** Gradient headline. */
export function GradTitle({ children }: { children: ReactNode }) {
  return (
    <span className="ap-grad-text" style={{ fontWeight: 700 }}>
      {children}
    </span>
  );
}
