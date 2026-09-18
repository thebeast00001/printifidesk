"use client";

import { useEffect, useRef, useState } from "react";
import { Drawer } from "vaul";
import { Check, Crosshair, Loader2, MapPin } from "lucide-react";
import type { Map as LeafletMap, Marker, Circle } from "leaflet";

/**
 * Leaflet's stylesheet, served from /public and attached the first time a
 * map opens — not bundled, so no page carries it that never shows a map,
 * and not imported, so the feature checks that import the sheet's
 * components under tsx don't trip over a .css file. (A copy of
 * node_modules/leaflet/dist/leaflet.css; the marker and layers images it
 * names aren't used — the pin is a div.)
 */
function ensureLeafletCss(): Promise<void> {
  const id = "leaflet-css";
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "/leaflet.css";
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}
import type { Pin } from "@/lib/delivery";
import { cn } from "@/lib/utils";

/**
 * A pin on the map (0050).
 *
 * The phone says where it is; the pin lands there with a circle the size
 * of the phone's own doubt; the student drags it if it's off; "Deliver
 * here" hands the pin back. Leaflet with OpenStreetMap tiles — no account,
 * no key — loaded only when this opens, since most orders never will.
 * The default marker wants image files a bundler won't serve, so the pin
 * is a div; the tiles are the only thing fetched from outside.
 *
 * Honest about precision: the accuracy the browser reports is shown, not
 * hidden. Outdoors that's a few metres; inside a hostel it can be fifty.
 * The spot and detail lines still carry the floor and the room.
 */
export function SpotMap({
  open,
  onOpenChange,
  initial,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A pin already set, to start from; else the phone is asked. */
  initial: Pin | null;
  onPick: (pin: Pin) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const circleRef = useRef<Circle | null>(null);
  /** Puts (or moves) the pin and its circle; made once the map exists. */
  const placeRef = useRef<((p: Pin) => void) | null>(null);
  const [pin, setPin] = useState<Pin | null>(initial);
  const [state, setState] = useState<"idle" | "locating" | "on" | "denied" | "unsupported">("idle");
  const [error, setError] = useState<string | null>(null);

  // The map lives only while the sheet is open.
  useEffect(() => {
    if (!open) {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      return;
    }
    let cancelled = false;
    (async () => {
      const [{ default: L }] = await Promise.all([import("leaflet"), ensureLeafletCss()]);
      if (cancelled || !boxRef.current || mapRef.current) return;
      const start = initial ?? { lat: 20.5937, lng: 78.9629, acc: 0 };
      const map = L.map(boxRef.current, { zoomControl: false, attributionControl: true }).setView([start.lat, start.lng], initial ? 18 : 5);
      mapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      const place = (p: Pin) => {
        if (!markerRef.current) {
          markerRef.current = L.marker([p.lat, p.lng], {
            draggable: true,
            icon: L.divIcon({
              className: "",
              html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#111;border:3px solid #fff;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>',
              iconSize: [22, 22],
              iconAnchor: [11, 22],
            }),
          }).addTo(map);
          markerRef.current.on("dragend", () => {
            const at = markerRef.current!.getLatLng();
            // Dragged by hand: the phone's doubt no longer applies.
            setPin({ lat: round6(at.lat), lng: round6(at.lng), acc: 0 });
            circleRef.current?.setLatLng(at).setRadius(0);
          });
        } else {
          markerRef.current.setLatLng([p.lat, p.lng]);
        }
        if (!circleRef.current) {
          circleRef.current = L.circle([p.lat, p.lng], { radius: p.acc, color: "#111", weight: 1, fillOpacity: 0.08 }).addTo(map);
        } else {
          circleRef.current.setLatLng([p.lat, p.lng]).setRadius(p.acc);
        }
      };
      // A tap on the map puts the pin there — the way to set it by hand when
      // the phone won't say, or says wrong.
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        const p = { lat: round6(e.latlng.lat), lng: round6(e.latlng.lng), acc: 0 };
        place(p);
        setPin(p);
        setState("on");
        setError(null);
      });
      placeRef.current = place;
      if (initial) {
        place(initial);
        setState("on");
      } else {
        locate(place);
      }
      // Leaflet measures its box on creation; a drawer is still sliding then.
      setTimeout(() => map.invalidateSize(), 350);
    })();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `initial` is read once, when the sheet opens
  }, [open]);

  function locate(place?: (p: Pin) => void) {
    if (typeof navigator === "undefined" || !navigator.geolocation) return setState("unsupported");
    setState("locating");
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: round6(pos.coords.latitude), lng: round6(pos.coords.longitude), acc: Math.round(pos.coords.accuracy || 0) };
        setPin(p);
        setState("on");
        const map = mapRef.current;
        if (map) {
          map.setView([p.lat, p.lng], p.acc > 80 ? 17 : 18);
          (place ?? placeRef.current)?.(p);
        }
      },
      (e) => {
        setState(e.code === e.PERMISSION_DENIED ? "denied" : "on");
        setError(
          e.code === e.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it in your browser, or zoom in and tap the map where you are."
            : "Couldn't get a fix — zoom in and tap the map where you are.",
        );
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 },
    );
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[90] bg-[rgb(12_12_14/0.45)] backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-[100] mx-auto flex max-h-[92dvh] w-full max-w-[520px] flex-col rounded-t-[30px] bg-paper outline-none shadow-[0_-12px_48px_-12px_rgb(12_12_14/0.4)]">
          <div className="mx-auto mt-[11px] h-1 w-[38px] shrink-0 rounded-sm bg-line-strong" />
          <div className="px-[18px] pt-3.5 pb-[max(20px,env(safe-area-inset-bottom))]">
            <Drawer.Title className="font-figure m-0 mb-1 flex items-center gap-2 text-[23px] font-extrabold">
              <MapPin size={20} strokeWidth={2.2} />
              Pin where you&apos;ll be
            </Drawer.Title>
            <Drawer.Description className="m-0 mb-3 text-[13px] text-muted">
              Drag the pin, or tap the map, if it&apos;s off. The runner gets it with a route.
            </Drawer.Description>

            <div className="relative overflow-hidden rounded-[18px] border border-line">
              <div ref={boxRef} className="h-[46dvh] min-h-[280px] w-full bg-surface-sunk" />
              {state === "locating" && (
                <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
                  <span className="flex items-center gap-2 rounded-full bg-paper/90 px-3 py-1.5 text-[12px] font-semibold shadow-card">
                    <Loader2 size={13} className="animate-spin" />
                    Finding you…
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => locate()}
                aria-label="Use my location"
                className="absolute top-3 right-3 grid size-10 place-items-center rounded-xl bg-paper text-ink shadow-card"
              >
                <Crosshair size={17} strokeWidth={2.2} />
              </button>
            </div>

            <p className={cn("m-0 mt-2.5 text-[11.5px] leading-snug", error ? "text-clay-ink dark:text-clay" : "text-muted")}>
              {error
                ? error
                : state === "unsupported"
                  ? "This browser can't give a location — zoom in and tap the map where you are."
                  : pin
                    ? pin.acc > 0
                      ? `The phone puts you within about ${pin.acc} m of the pin${pin.acc > 60 ? " — indoors it's rough; the room and floor lines matter more" : ""}.`
                      : "Pin set by hand."
                    : "Waiting for the phone's location."}
            </p>

            <button
              disabled={!pin}
              onClick={() => pin && onPick(pin)}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-40"
            >
              <Check size={15} strokeWidth={2.6} />
              Deliver here
            </button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
