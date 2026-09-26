"use client";

import Link from "next/link";
import { useMemo } from "react";

/** The centrepiece: the thing people screenshot. Shared by the app and /m/:id. */
export function Transcript({ text, matchId }: { text: string; matchId?: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  if (!text) return null;
  return (
    <section className="rounded-panel mt-3 border border-line bg-panel">
      <h2 className="flex items-center justify-between border-b border-line px-4 py-3 text-[12px] uppercase tracking-wider text-accent">
        Transcript
        <span className="flex gap-3 normal-case tracking-normal">
          {matchId ? (
            <>
              <Link href={`/m/${matchId}`} className="text-[11px] text-muted hover:text-accent">
                open
              </Link>
              <button
                onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/m/${matchId}`)}
                className="text-[11px] text-accent"
              >
                share link
              </button>
            </>
          ) : null}
          <button
            onClick={() => void navigator.clipboard?.writeText(text)}
            className="text-[11px] text-muted hover:text-accent"
          >
            copy text
          </button>
        </span>
      </h2>
      <div className="overflow-x-auto px-3 py-4 sm:px-5 sm:py-6">
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 sm:text-[14px] sm:leading-7">
          {lines.map((line, i) => (
            <span key={i} className={lineClass(line)}>
              {line || " "}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
    </section>
  );
}

const BEATS = [
  "A bluff that worked",
  "The bluff was called",
  "folded the better hand",
  "takes the match",
  "biggest pot",
];

function lineClass(line: string): string {
  if (BEATS.some((b) => line.includes(b))) return "text-text font-semibold";
  if (line.startsWith("  Running:")) return "text-muted";
  if (/^Round \d+\./.test(line)) return "text-text font-medium";
  if (line.startsWith("Final:") || / wins the match|ends level/.test(line)) return "text-text font-medium";
  return "text-muted";
}

