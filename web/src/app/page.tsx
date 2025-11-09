"use client";

import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";

type ComponentKind = "resistor" | "capacitor" | "ic" | "power" | "ground" | "led";

type Pin = {
  id: string;
  name: string;
  // pin position relative to component origin
  x: number;
  y: number;
};

type SchematicComponent = {
  id: string;
  kind: ComponentKind;
  x: number;
  y: number;
  rotation: number; // degrees
  label: string;
  pins: Pin[];
};

type Wire = {
  id: string;
  from: { componentId: string; pinId: string } | null;
  to: { componentId: string; pinId: string } | null;
};

type Mode = "schematic" | "layout";
type Tool = { type: "select" } | { type: "place"; kind: ComponentKind } | { type: "wire" };

type Design = {
  components: SchematicComponent[];
  wires: Wire[];
};

function snap(n: number, grid = 10) {
  return Math.round(n / grid) * grid;
}

function getDefaultPins(kind: ComponentKind): Pin[] {
  switch (kind) {
    case "resistor":
      return [
        { id: nanoid(), name: "1", x: -20, y: 0 },
        { id: nanoid(), name: "2", x: 20, y: 0 },
      ];
    case "capacitor":
      return [
        { id: nanoid(), name: "+", x: -20, y: 0 },
        { id: nanoid(), name: "-", x: 20, y: 0 },
      ];
    case "led":
      return [
        { id: nanoid(), name: "A", x: -20, y: 0 },
        { id: nanoid(), name: "K", x: 20, y: 0 },
      ];
    case "power":
      return [{ id: nanoid(), name: "+V", x: 0, y: -20 }];
    case "ground":
      return [{ id: nanoid(), name: "GND", x: 0, y: 20 }];
    case "ic":
      return [
        { id: nanoid(), name: "1", x: -30, y: -20 },
        { id: nanoid(), name: "2", x: -30, y: 0 },
        { id: nanoid(), name: "3", x: -30, y: 20 },
        { id: nanoid(), name: "4", x: 30, y: -20 },
        { id: nanoid(), name: "5", x: 30, y: 0 },
        { id: nanoid(), name: "6", x: 30, y: 20 },
      ];
  }
}

function rotatePoint(x: number, y: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function pinAbsPosition(c: SchematicComponent, p: Pin) {
  const rotated = rotatePoint(p.x, p.y, c.rotation);
  return { x: c.x + rotated.x, y: c.y + rotated.y };
}

function encodeDesign(design: Design): string {
  const json = JSON.stringify(design);
  return typeof window === "undefined"
    ? ""
    : btoa(unescape(encodeURIComponent(json)));
}

function decodeDesign(encoded: string): Design | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const parsed = JSON.parse(json) as Design;
    return parsed;
  } catch {
    return null;
  }
}

export default function Home() {
  const [design, setDesign] = useState<Design>({ components: [], wires: [] });
  const [mode, setMode] = useState<Mode>("schematic");
  const [tool, setTool] = useState<Tool>({ type: "select" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [message, setMessage] = useState<string>("");

  // Load from URL hash or localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const decoded = decodeDesign(hash);
      if (decoded) {
        setDesign(decoded);
        return;
      }
    }
    const saved = localStorage.getItem("fluxlite-design");
    if (saved) {
      try {
        setDesign(JSON.parse(saved));
      } catch {}
    }
  }, []);

  // Persist to localStorage (debounced-ish)
  useEffect(() => {
    const id = setTimeout(() => {
      if (typeof window !== "undefined") {
        localStorage.setItem("fluxlite-design", JSON.stringify(design));
      }
    }, 300);
    return () => clearTimeout(id);
  }, [design]);

  const addComponent = (kind: ComponentKind, x: number, y: number) => {
    const component: SchematicComponent = {
      id: nanoid(),
      kind,
      x: snap(x),
      y: snap(y),
      rotation: 0,
      label: kind.toUpperCase(),
      pins: getDefaultPins(kind),
    };
    setDesign((d) => ({ ...d, components: [...d.components, component] }));
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setDesign((d) => ({
      components: d.components.filter((c) => c.id !== selectedId),
      wires: d.wires.filter(
        (w) => w.from?.componentId !== selectedId && w.to?.componentId !== selectedId
      ),
    }));
    setSelectedId(null);
  };

  const startWireFromPin = (componentId: string, pinId: string) => {
    setTool({ type: "wire" });
    setDesign((d) => ({
      ...d,
      wires: [...d.wires, { id: nanoid(), from: { componentId, pinId }, to: null }],
    }));
  };

  const completeWireToPin = (componentId: string, pinId: string) => {
    setDesign((d) => {
      const wires = [...d.wires];
      for (let i = wires.length - 1; i >= 0; i--) {
        const w = wires[i];
        if (w.to === null && w.from) {
          if (w.from.componentId === componentId && w.from.pinId === pinId) {
            // same pin - cancel
            wires.pop();
            setTool({ type: "select" });
            return { ...d, wires };
          }
          wires[i] = { ...w, to: { componentId, pinId } };
          break;
        }
      }
      setTool({ type: "select" });
      return { ...d, wires };
    });
  };

  const currentOpenWire = useMemo(() => design.wires.find((w) => w.to === null), [design.wires]);

  const getPinAbs = (componentId: string, pinId: string) => {
    const c = design.components.find((c) => c.id === componentId);
    const p = c?.pins.find((p) => p.id === pinId);
    if (!c || !p) return null;
    return pinAbsPosition(c, p);
  };

  const netlist = useMemo(() => {
    // Nets are groups of pins connected by wires
    const adj = new Map<string, Set<string>>(); // pinKey -> set of pinKey
    const pinKey = (cid: string, pid: string) => `${cid}:${pid}`;
    for (const w of design.wires) {
      if (!w.from || !w.to) continue;
      const a = pinKey(w.from.componentId, w.from.pinId);
      const b = pinKey(w.to.componentId, w.to.pinId);
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
    const visited = new Set<string>();
    const nets: string[][] = [];
    const keys = Array.from(adj.keys());
    for (const k of keys) {
      if (visited.has(k)) continue;
      const queue = [k];
      const group: string[] = [];
      visited.add(k);
      while (queue.length) {
        const cur = queue.shift()!;
        group.push(cur);
        for (const nxt of adj.get(cur) || []) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      nets.push(group);
    }
    return nets.map((g, i) => ({ name: `N${i + 1}`, pins: g }));
  }, [design.wires]);

  const bom = useMemo(() => {
    const counts = new Map<ComponentKind, number>();
    for (const c of design.components) {
      counts.set(c.kind, (counts.get(c.kind) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([kind, qty]) => ({ kind, qty }));
  }, [design.components]);

  const onWheel: React.WheelEventHandler<SVGSVGElement> = (e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    const newZoom = Math.min(4, Math.max(0.2, zoom * factor));
    setZoom(newZoom);
  };

  const onMouseDown: React.MouseEventHandler<SVGSVGElement> = (e) => {
    const target = e.target as Element;
    if ((e.button === 1) || e.shiftKey) {
      setIsPanning(true);
      panStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
      return;
    }
    if (e.button !== 0) return;
    const pt = clientToWorld(e);
    if (tool.type === "place") {
      addComponent(tool.kind, pt.x, pt.y);
      return;
    }
    // selection begins
    if (target.closest('[data-component-id]')) {
      const compEl = target.closest('[data-component-id]') as HTMLElement;
      const cid = compEl.getAttribute('data-component-id');
      if (cid) setSelectedId(cid);
    } else {
      setSelectedId(null);
    }
  };

  const onMouseMove: React.MouseEventHandler<SVGSVGElement> = (e) => {
    if (isPanning) {
      const start = panStart.current!;
      setPan({ x: e.clientX - start.x, y: e.clientY - start.y });
    }
  };

  const onMouseUp: React.MouseEventHandler<SVGSVGElement> = () => {
    setIsPanning(false);
  };

  const clientToWorld = (e: React.MouseEvent) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left - pan.x) / zoom;
    const y = (e.clientY - rect.top - pan.y) / zoom;
    return { x: snap(x), y: snap(y) };
  };

  const rotateSelected = () => {
    if (!selectedId) return;
    setDesign((d) => ({
      ...d,
      components: d.components.map((c) =>
        c.id === selectedId ? { ...c, rotation: (c.rotation + 90) % 360 } : c
      ),
    }));
  };

  const moveSelected = (dx: number, dy: number) => {
    if (!selectedId) return;
    setDesign((d) => ({
      ...d,
      components: d.components.map((c) =>
        c.id === selectedId ? { ...c, x: snap(c.x + dx), y: snap(c.y + dy) } : c
      ),
    }));
  };

  const shareLink = () => {
    const encoded = encodeDesign(design);
    const url = `${window.location.origin}${window.location.pathname}#${encoded}`;
    navigator.clipboard.writeText(url);
    setMessage("Share link copied");
    setTimeout(() => setMessage(""), 2000);
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(design, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "design.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJSON: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result)) as Design;
        setDesign(data);
        setMessage("Design imported");
        setTimeout(() => setMessage(""), 1500);
      } catch {
        setMessage("Invalid file");
        setTimeout(() => setMessage(""), 1500);
      }
    };
    reader.readAsText(file);
    // reset input
    e.currentTarget.value = "";
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
      }
      if (e.key.toLowerCase() === "r") {
        rotateSelected();
      }
      const step = 10;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "ArrowUp") moveSelected(0, -step);
        if (e.key === "ArrowDown") moveSelected(0, step);
        if (e.key === "ArrowLeft") moveSelected(-step, 0);
        if (e.key === "ArrowRight") moveSelected(step, 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const ComponentSymbol: React.FC<{ c: SchematicComponent }> = ({ c }) => {
    const w = 40;
    const h = 20;
    const isSelected = c.id === selectedId;
    return (
      <g
        transform={`translate(${c.x},${c.y}) rotate(${c.rotation})`}
        data-component-id={c.id}
        className="cursor-move"
        onMouseDown={(e) => {
          // start drag
          if (tool.type !== "select") return;
          e.stopPropagation();
          setSelectedId(c.id);
          const start = { x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
          const onMove = (ev: MouseEvent) => {
            const dx = (ev.clientX - start.x) / zoom;
            const dy = (ev.clientY - start.y) / zoom;
            setDesign((d) => ({
              ...d,
              components: d.components.map((cc) =>
                cc.id === c.id ? { ...cc, x: snap(start.cx + dx), y: snap(start.cy + dy) } : cc
              ),
            }));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      >
        {/* Body */}
        {c.kind === "resistor" && (
          <>
            <line x1={-30} y1={0} x2={-20} y2={0} stroke="#111" strokeWidth={2} />
            <rect x={-20} y={-8} width={40} height={16} fill="#f9d57a" stroke="#111" />
            <line x1={20} y1={0} x2={30} y2={0} stroke="#111" strokeWidth={2} />
          </>
        )}
        {c.kind === "capacitor" && (
          <>
            <line x1={-20} y1={-10} x2={-20} y2={10} stroke="#111" strokeWidth={2} />
            <line x1={20} y1={-10} x2={20} y2={10} stroke="#111" strokeWidth={2} />
            <line x1={-30} y1={0} x2={-20} y2={0} stroke="#111" strokeWidth={2} />
            <line x1={20} y1={0} x2={30} y2={0} stroke="#111" strokeWidth={2} />
          </>
        )}
        {c.kind === "led" && (
          <>
            <circle r={10} fill="#ff6b6b" stroke="#111" />
            <line x1={-30} y1={0} x2={-10} y2={0} stroke="#111" strokeWidth={2} />
            <line x1={10} y1={0} x2={30} y2={0} stroke="#111" strokeWidth={2} />
          </>
        )}
        {c.kind === "power" && (
          <>
            <polygon points="0,-20 -8,0 8,0" fill="#4ade80" stroke="#111" />
          </>
        )}
        {c.kind === "ground" && (
          <>
            <line x1={-10} y1={0} x2={10} y2={0} stroke="#111" />
            <line x1={-6} y1={4} x2={6} y2={4} stroke="#111" />
            <line x1={-2} y1={8} x2={2} y2={8} stroke="#111" />
          </>
        )}
        {c.kind === "ic" && (
          <rect x={-30} y={-30} width={60} height={60} rx={6} fill="#e5e7eb" stroke="#111" />
        )}

        {/* Label */}
        <text x={0} y={-18} textAnchor="middle" fontSize={10} fill="#111">
          {c.label}
        </text>

        {/* Pins */}
        {c.pins.map((p) => (
          <g key={p.id}>
            {(() => {
              const pos = pinAbsPosition({ ...c, x: 0, y: 0 }, p);
              return (
                <>
                  <circle
                    cx={pos.x}
                    cy={pos.y}
                    r={4}
                    fill="#fff"
                    stroke="#111"
                    className="cursor-crosshair"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      if (tool.type === "wire") {
                        completeWireToPin(c.id, p.id);
                      } else {
                        startWireFromPin(c.id, p.id);
                      }
                    }}
                  />
                  <text x={pos.x} y={pos.y - 8} fontSize={8} textAnchor="middle" fill="#111">
                    {p.name}
                  </text>
                </>
              );
            })()}
          </g>
        ))}

        {/* Selection highlight */}
        {isSelected && (
          <rect x={-40} y={-40} width={80} height={80} fill="none" stroke="#16a34a" strokeDasharray={4} />
        )}
      </g>
    );
  };

  const WireView: React.FC<{ w: Wire }> = ({ w }) => {
    if (!w.from || !w.to) return null;
    const a = getPinAbs(w.from.componentId, w.from.pinId);
    const b = getPinAbs(w.to.componentId, w.to.pinId);
    if (!a || !b) return null;
    return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2563eb" strokeWidth={2} />;
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar Palette */}
      <aside className="w-56 border-r border-black/10 p-3 space-y-3 bg-white">
        <div className="text-xs font-semibold uppercase text-zinc-500">Palette</div>
        <div className="grid grid-cols-2 gap-2">
          {(["resistor", "capacitor", "led", "ic", "power", "ground"] as ComponentKind[]).map(
            (k) => (
              <button
                key={k}
                className={`rounded border px-2 py-1 text-sm hover:bg-zinc-100 ${
                  tool.type === "place" && tool.kind === k ? "border-blue-500" : "border-zinc-200"
                }`}
                onClick={() => setTool({ type: "place", kind: k })}
              >
                {k}
              </button>
            )
          )}
        </div>
        <div className="pt-4 space-y-2">
          <button
            className={`w-full rounded border px-2 py-1 text-sm ${
              tool.type === "select" ? "border-blue-500" : "border-zinc-200"
            }`}
            onClick={() => setTool({ type: "select" })}
          >
            Select/Move
          </button>
          <button
            className={`w-full rounded border px-2 py-1 text-sm ${
              tool.type === "wire" ? "border-blue-500" : "border-zinc-200"
            }`}
            onClick={() => setTool({ type: "wire" })}
          >
            Wire
          </button>
        </div>
        <div className="pt-4">
          <div className="text-xs font-semibold uppercase text-zinc-500 mb-2">Actions</div>
          <div className="flex flex-col gap-2">
            <button className="rounded border border-zinc-200 px-2 py-1 text-sm" onClick={rotateSelected}>
              Rotate (R)
            </button>
            <button className="rounded border border-zinc-200 px-2 py-1 text-sm" onClick={deleteSelected}>
              Delete (Del)
            </button>
            <button className="rounded border border-zinc-200 px-2 py-1 text-sm" onClick={shareLink}>
              Share Link
            </button>
            <button className="rounded border border-zinc-200 px-2 py-1 text-sm" onClick={exportJSON}>
              Export JSON
            </button>
            <label className="rounded border border-zinc-200 px-2 py-1 text-sm text-center cursor-pointer">
              Import JSON
              <input type="file" accept="application/json" className="hidden" onChange={importJSON} />
            </label>
          </div>
        </div>
        <div className="pt-4 border-t mt-4">
          <div className="text-xs font-semibold uppercase text-zinc-500 mb-2">Mode</div>
          <div className="flex gap-2">
            <button
              className={`flex-1 rounded border px-2 py-1 text-sm ${mode === "schematic" ? "border-blue-500" : "border-zinc-200"}`}
              onClick={() => setMode("schematic")}
            >
              Schematic
            </button>
            <button
              className={`flex-1 rounded border px-2 py-1 text-sm ${mode === "layout" ? "border-blue-500" : "border-zinc-200"}`}
              onClick={() => setMode("layout")}
            >
              Layout
            </button>
          </div>
        </div>
        {message && <div className="text-xs text-emerald-600 pt-2">{message}</div>}
      </aside>

      {/* Main Canvas */}
      <main className="flex-1 relative bg-zinc-50">
        <div className="absolute left-3 top-3 z-10 rounded bg-white/90 shadow border border-zinc-200 px-2 py-1 text-xs">
          Tool: {tool.type}
          {tool.type === "place" ? ` (${tool.kind})` : ""} ? Mode: {mode}
        </div>
        <svg
          ref={svgRef}
          className="h-full w-full"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
        >
          {/* Grid */}
          <defs>
            <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e5e7eb" strokeWidth="1" />
            </pattern>
          </defs>
          <rect x={0} y={0} width="100%" height="100%" fill="url(#grid)" />
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {mode === "schematic" && (
              <>
                {design.wires.map((w) => (
                  <WireView key={w.id} w={w} />
                ))}
                {currentOpenWire && currentOpenWire.from && (
                  (() => {
                    const a = getPinAbs(
                      currentOpenWire.from.componentId,
                      currentOpenWire.from.pinId
                    );
                    if (!a) return null;
                    return (
                      <circle cx={a.x} cy={a.y} r={3} fill="#2563eb" />
                    );
                  })()
                )}
                {design.components.map((c) => (
                  <ComponentSymbol key={c.id} c={c} />
                ))}
              </>
            )}

            {mode === "layout" && (
              <>
                {/* Board outline */}
                <rect x={-400} y={-300} width={800} height={600} fill="#0f172a" rx={12} />
                {/* Components footprints */}
                {design.components.map((c) => (
                  <g key={c.id} transform={`translate(${c.x},${c.y}) rotate(${c.rotation})`}>
                    <rect x={-20} y={-10} width={40} height={20} fill="#94a3b8" rx={4} />
                    <text x={0} y={-14} textAnchor="middle" fontSize={8} fill="#fff">
                      {c.label}
                    </text>
                  </g>
                ))}
                {/* Tracks (reuse schematic wires) */}
                {design.wires.map((w) => (
                  (() => {
                    if (!w.from || !w.to) return null;
                    const a = getPinAbs(w.from.componentId, w.from.pinId);
                    const b = getPinAbs(w.to.componentId, w.to.pinId);
                    if (!a || !b) return null;
                    return <line key={w.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#22d3ee" strokeWidth={3} />;
                  })()
                ))}
              </>
            )}
          </g>
        </svg>
      </main>

      {/* Right Panel */}
      <aside className="w-72 border-l border-black/10 p-3 space-y-4 bg-white">
        <div>
          <div className="text-xs font-semibold uppercase text-zinc-500 mb-2">Properties</div>
          {selectedId ? (
            (() => {
              const c = design.components.find((c) => c.id === selectedId)!;
              return (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <div>ID</div>
                    <div className="font-mono text-xs">{c.id.slice(0, 6)}</div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>Kind</div>
                    <div className="font-mono">{c.kind}</div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>Position</div>
                    <div className="font-mono text-xs">({c.x}, {c.y})</div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>Rotation</div>
                    <div className="font-mono">{c.rotation}?</div>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm" htmlFor="label">Label</label>
                    <input
                      id="label"
                      className="ml-3 flex-1 rounded border border-zinc-200 px-2 py-1 text-sm"
                      value={c.label}
                      onChange={(e) =>
                        setDesign((d) => ({
                          ...d,
                          components: d.components.map((cc) =>
                            cc.id === c.id ? { ...cc, label: e.target.value } : cc
                          ),
                        }))
                      }
                    />
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="text-sm text-zinc-500">Select a component to edit</div>
          )}
        </div>

        <div>
          <div className="text-xs font-semibold uppercase text-zinc-500 mb-2">Netlist</div>
          <div className="max-h-48 overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="text-left px-2 py-1 border-b">Net</th>
                  <th className="text-left px-2 py-1 border-b">Pins</th>
                </tr>
              </thead>
              <tbody>
                {netlist.length === 0 && (
                  <tr>
                    <td className="px-2 py-1 text-zinc-500" colSpan={2}>No nets</td>
                  </tr>
                )}
                {netlist.map((n) => (
                  <tr key={n.name}>
                    <td className="px-2 py-1 border-b font-mono">{n.name}</td>
                    <td className="px-2 py-1 border-b">
                      {n.pins
                        .map((p) => {
                          const [cid, pid] = p.split(":");
                          const c = design.components.find((c) => c.id === cid);
                          const pin = c?.pins.find((pp) => pp.id === pid);
                          return `${c?.label}.${pin?.name}`;
                        })
                        .join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase text-zinc-500 mb-2">BOM</div>
          <div className="max-h-48 overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-50">
                  <th className="text-left px-2 py-1 border-b">Part</th>
                  <th className="text-right px-2 py-1 border-b">Qty</th>
                </tr>
              </thead>
              <tbody>
                {bom.length === 0 && (
                  <tr>
                    <td className="px-2 py-1 text-zinc-500" colSpan={2}>No parts</td>
                  </tr>
                )}
                {bom.map((b) => (
                  <tr key={b.kind}>
                    <td className="px-2 py-1 border-b">{b.kind}</td>
                    <td className="px-2 py-1 border-b text-right">{b.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </aside>
    </div>
  );
}
