import { API } from "@/lib/api";

/**
 * An agent's face, served by the API as an image and cached for a day. At 32
 * px and under it is the simplified drawing - silhouette, colours and eyes -
 * since the full one's detail turns to noise that small. Decorative: the name
 * beside it says who it is.
 */
export function Portrait({ id, size, className = "" }: { id: string; size: number; className?: string }) {
  const small = size <= 32;
  return (
    // A plain img: an SVG from our own API, already sized; nothing for an optimiser to do.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${API}/agents/${id}/portrait.svg${small ? "?size=small" : ""}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      className={`shrink-0 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
