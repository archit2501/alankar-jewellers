"use client";

/* eslint-disable @next/next/no-img-element --
 * Raw <img> is a DELIBERATE CHOICE here, not a forced one. That distinction
 * used to be the other way round and the comment this replaces was, by the end,
 * simply false.
 *
 * The original reason was real: there was no wrangler.jsonc, vite.config.ts
 * declared neither ASSETS nor IMAGES, and /_vinext/image threw on an undefined
 * binding. Then `vinext deploy` generated a wrangler.jsonc declaring both, it
 * was committed, and the optimizer started working -- verified by driving it
 * through the built Worker with both bindings supplied: 200 image/webp at every
 * allowed width.
 *
 * We keep build-time sizing anyway, for reasons that stand on their own:
 * scripts/build-images.mjs emits every derivative ahead of time and generates
 * app/_media/images.ts, so each <img> carries intrinsic width/height and a real
 * srcSet. Layout shift is structurally zero rather than merely usually zero,
 * and no request pays for a transform. Switching to next/image would trade that
 * for per-request work and a runtime dependency on a binding this project has
 * already watched appear and disappear once.
 */

import { useState } from "react";
import { images, type ImageKey } from "../_media/images";

/**
 * The Flip — this direction's signature interaction.
 *
 * In Jadau and Polki work the BACK of a piece is enamelled in opaque meenakari:
 * decoration the wearer knows about and the room never sees. Turning a piece
 * over is therefore not an embellishment, it is the product knowledge. That is
 * why this component carries information rather than ornament, and why it is
 * the one element on the site allowed to animate a transform.
 *
 * Behaviour:
 *   pointer  — hovering reveals the reverse, leaving restores the face
 *   keyboard — focus reveals it; Enter/Space pins it so it survives blur
 *   touch    — tap pins it (there is no hover to rely on)
 *
 * The field colour travels to meena green on the same curve as the crossfade, so
 * image and field read as one object turning rather than two things animating.
 *
 * The piece is cut to the multifoil arch. The mask lives on `.flip__stage`
 * rather than on the button, because a mask clips everything an element paints
 * including its focus outline — masking the control would have deleted the
 * keyboard ring. `framed` adds the gold arch ruled outside the mask; the
 * catalogue grid leaves it off because the teak niche already frames the piece.
 *
 * Reduced motion: the crossfade becomes instant and the 2% scale is dropped,
 * but the colour change is KEPT — the information survives, the movement does
 * not.
 */
export function Flip({
  front,
  back,
  alt,
  altBack,
  sizes = "(max-width: 780px) 90vw, 33vw",
  priority = false,
  caption,
  framed = false,
}: {
  front: ImageKey;
  /** Omit when a piece has no reverse photographed yet — the flip disables itself. */
  back?: ImageKey;
  alt: string;
  altBack?: string;
  sizes?: string;
  priority?: boolean;
  caption?: string;
  /** Rule a gold multifoil arch just outside the mask. Darbar sections only. */
  framed?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);

  const faceImage = images[front];
  const backImage = back ? images[back] : undefined;
  const showBack = Boolean(backImage) && (hovered || pinned);
  const root = `flip${framed ? " flip--framed" : ""}`;

  // Without a reverse there is nothing to turn over, so render a plain figure
  // rather than a control that lies about being interactive.
  if (!backImage) {
    return (
      <figure className={`${root} flip--static`}>
        <span className="flip__frame">
          <span className="flip__stage arch">
            <img
              className="flip__face"
              src={faceImage.src}
              srcSet={faceImage.srcSet}
              sizes={sizes}
              width={faceImage.width}
              height={faceImage.height}
              alt={alt}
              loading={priority ? undefined : "lazy"}
              fetchPriority={priority ? "high" : undefined}
              decoding={priority ? "sync" : "async"}
            />
          </span>
        </span>
        {caption ? <figcaption className="flip__caption">{caption}</figcaption> : null}
      </figure>
    );
  }

  return (
    <figure className={`${root}${showBack ? " flip--reversed" : ""}`}>
      <button
        type="button"
        className="flip__frame"
        aria-pressed={pinned}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => setPinned((value) => !value)}
      >
        <span className="flip__stage arch">
          <img
            className="flip__face"
            src={faceImage.src}
            srcSet={faceImage.srcSet}
            sizes={sizes}
            width={faceImage.width}
            height={faceImage.height}
            alt={alt}
            loading={priority ? undefined : "lazy"}
            fetchPriority={priority ? "high" : undefined}
            decoding={priority ? "sync" : "async"}
          />
          <img
            className="flip__back"
            src={backImage.src}
            srcSet={backImage.srcSet}
            sizes={sizes}
            width={backImage.width}
            height={backImage.height}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
          />
        </span>
        <span className="flip__hint" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
            <path
              d="M2 8a6 6 0 1 1 1.8 4.3M2 12.5V8.6h3.9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        {/* The only thing a screen reader needs: what turning it over reveals. */}
        <span className="visually-hidden">
          {showBack ? "Showing the enamelled reverse. " : ""}
          {altBack ?? "Turn over to see the enamelled meenakari reverse"}
        </span>
      </button>
      {caption ? <figcaption className="flip__caption">{caption}</figcaption> : null}
    </figure>
  );
}
