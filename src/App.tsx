import { useEffect, useMemo, useRef, useState } from "react";

/* =======================
   Types
======================= */

type Track = {
  id: string;
  name: string;      // display name (leaf file name without extension)
  fileName: string;  // full IA path (may include folders)
  url: string;       // stream URL
  tags: string[];
  weight: number;
};

type Station = {
  name: string;
  description: string;
  tagWeights: Record<string, number>;
  crossfadeDefaultSec: number;
};

/* =======================
   Utilities
======================= */

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Preserve folder slashes, encode each segment
function encodePathPreserveSlashes(path: string) {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function normalizeTag(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\- _]/g, "");
}

function dedupe<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

// Simple weighted pick
function weightedPick<T>(items: T[], weights: number[]) {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Infer tags from FULL PATH (folders + filename)
 * This is key for your archive because “Montana 2000/Comp 1/...” carries meaning.
 */
function inferTagsFromPath(fullPath: string) {
  const s = normalizeTag(fullPath.replace(/[_]+/g, " "));

  const likely = [
    // vibe
    "campfire",
    "kitchen",
    "rain",
    "river",
    "wind",
    "birds",
    "drum",
    "chant",
    "crowd",
    "night",
    "dawn",
    "morning",
    "evening",
    "crickets",
    "frog",
    "guitar",
    "fiddle",
    "flute",
    "harp",
    "voice",
    "story",
    "interview",
    "silence",
    // geography / gatherings you might have
    "montana",
    "new mexico",
    "california",
    "new hampshire",
    "brazil",
    "mexico",
    "panama",
    "new zealand",
    // archive-ish
    "comp",
    "seed camp",
    "main circle",
    "welcome home",
  ];

  const tags: string[] = [];

  // include known keywords if present
  for (const k of likely) {
    if (s.includes(k)) tags.push(normalizeTag(k));
  }

  // Year detection: 19xx or 20xx anywhere in the path
  const yearMatches = fullPath.match(/\b(19|20)\d{2}\b/g) ?? [];
  for (const y of yearMatches) tags.push(`year:${y}`);

  // Folder-based tags: top two path segments
  const parts = fullPath.split("/").map((p) => normalizeTag(p)).filter(Boolean);
  if (parts[0]) tags.push(`folder:${parts[0]}`);
  if (parts[1]) tags.push(`folder:${parts[1]}`);

  // A few extra heuristics from filename words
  const leaf = (fullPath.split("/").pop() || fullPath).toLowerCase();
  if (/chant|aum|om\b/i.test(leaf)) tags.push("chant");
  if (/drum|boogie|beat/i.test(leaf)) tags.push("drum");
  if (/kitchen|cook|breakfast|lunch|dinner/i.test(leaf)) tags.push("kitchen");
  if (/cricket|night/i.test(leaf)) tags.push("night");
  if (/dawn|morning|sunrise/i.test(leaf)) tags.push("dawn");
  if (/bird|blackbird|crow|hawk/i.test(leaf)) tags.push("birds");
  if (/rain|storm|thunder/i.test(leaf)) tags.push("rain");
  if (/river|creek|stream/i.test(leaf)) tags.push("river");
  if (/wind/i.test(leaf)) tags.push("wind");
  if (/interview|talk|story/i.test(leaf)) tags.push("interview");

  return dedupe(tags).filter(Boolean);
}

/* =======================
   Stations
======================= */

const STATIONS: Station[] = [
  {
    name: "All Field",
    description: "A broad shuffle across the whole archive.",
    tagWeights: {},
    crossfadeDefaultSec: 6,
  },
  {
    name: "Campfire Drift",
    description: "Crackle-forward, night-songs, drum edges, human warmth.",
    tagWeights: {
      campfire: 4,
      night: 3,
      crickets: 2,
      drum: 2,
      guitar: 2,
      fiddle: 2,
      flute: 1,
      crowd: 1,
      chant: 1,
    },
    crossfadeDefaultSec: 7,
  },
  {
    name: "Kitchen Radio",
    description: "Work-as-rhythm: voices, clatter, logistics, mutual-aid energy.",
    tagWeights: {
      kitchen: 5,
      voice: 3,
      interview: 3,
      story: 2,
      crowd: 2,
      evening: 1,
    },
    crossfadeDefaultSec: 5,
  },
  {
    name: "Dawn Sound-Trail",
    description: "Birds, wind, river—gentle waking woods.",
    tagWeights: {
      dawn: 5,
      birds: 4,
      wind: 3,
      river: 3,
      rain: 2,
      silence: 1,
      morning: 2,
    },
    crossfadeDefaultSec: 9,
  },
  {
    name: "Night Trail",
    description: "Dark woods, distant drums, crickets—slow luminous drift.",
    tagWeights: {
      night: 5,
      crickets: 4,
      campfire: 2,
      drum: 2,
      chant: 2,
      wind: 1,
      crowd: 1,
      silence: 1,
    },
    crossfadeDefaultSec: 8,
  },
];

/* =======================
   Crossfade Engine
======================= */

type Deck = {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  track: Track | null;
};

function createDeck(ctx: AudioContext) {
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  const source = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(ctx.destination);
  return { audio, source, gain, track: null } as Deck;
}

function rampGain(ctx: AudioContext, gain: GainNode, to: number, seconds: number) {
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(to, now + Math.max(0.01, seconds));
}

/* =======================
   App
======================= */

export default function App() {
  const IA_IDENTIFIER = "soundsfromtherainbow2000-2025";

  // Library
  const [tracks, setTracks] = useState<Track[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");

  // Debug
  const [debug, setDebug] = useState<{
    totalFiles: number;
    audioByExt: number;
    sampleNames: string[];
  } | null>(null);

  // Station
  const [stationName, setStationName] = useState<string>(STATIONS[0].name);
  const station = useMemo(
    () => STATIONS.find((s) => s.name === stationName) ?? STATIONS[0],
    [stationName]
  );

  // Radio state
  const [nowPlaying, setNowPlaying] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [radioMode, setRadioMode] = useState(true);

  // Audio controls
  const [volume, setVolume] = useState(0.9);
  const [crossfadeSec, setCrossfadeSec] = useState(station.crossfadeDefaultSec);

  // Web Audio engine refs
  const ctxRef = useRef<AudioContext | null>(null);
  const deckARef = useRef<Deck | null>(null);
  const deckBRef = useRef<Deck | null>(null);
  const activeRef = useRef<"A" | "B">("A");
  const tickRef = useRef<number | null>(null);
  const pendingFadeRef = useRef(false);

  const activeDeck = () => (activeRef.current === "A" ? deckARef.current : deckBRef.current);
  const inactiveDeck = () => (activeRef.current === "A" ? deckBRef.current : deckARef.current);

  async function ensureCtx() {
    if (!ctxRef.current) {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      deckARef.current = createDeck(ctx);
      deckBRef.current = createDeck(ctx);
      deckARef.current.audio.volume = volume;
      deckBRef.current.audio.volume = volume;
    }
    const ctx = ctxRef.current!;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {}
    }
  }

  // Apply volume
  useEffect(() => {
    if (deckARef.current) deckARef.current.audio.volume = volume;
    if (deckBRef.current) deckBRef.current.audio.volume = volume;
  }, [volume]);

  // Update crossfade default when station changes (but don’t override if user is mid-tweak heavily)
  useEffect(() => {
    setCrossfadeSec((v) => {
      // if close to previous station default, snap to new default; else keep user choice
      const prev = v;
      const newDef = station.crossfadeDefaultSec;
      if (Math.abs(prev - newDef) <= 2) return newDef;
      return prev;
    });
  }, [station.crossfadeDefaultSec]);

  // Cleanup
  useEffect(() => {
    return () => {
      try {
        if (tickRef.current) window.clearInterval(tickRef.current);
        deckARef.current?.audio.pause();
        deckBRef.current?.audio.pause();
        ctxRef.current?.close();
      } catch {}
    };
  }, []);

  /* =======================
     Load from Internet Archive
  ======================= */

  async function loadFromIA() {
    setStatus("loading");
    setError("");

    try {
      const res = await fetch(`https://archive.org/metadata/${IA_IDENTIFIER}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Metadata fetch failed: HTTP ${res.status}`);

      const data = await res.json();
      const files: any[] = data.files || [];

      const audioExt = /\.(mp3|ogg|opus|wav|flac|m4a|aac)$/i;

      const audio = files
        .map((f) => ({
          name: String(f?.name ?? ""),
          format: String(f?.format ?? ""),
        }))
        .filter((f) => audioExt.test(f.name));

      setDebug({
        totalFiles: files.length,
        audioByExt: audio.length,
        sampleNames: audio.slice(0, 25).map((f) => `${f.name} (${f.format || "no format"})`),
      });

      if (!audio.length) throw new Error("No audio files found by extension.");

      const base = `https://archive.org/download/${IA_IDENTIFIER}/`;

      const mapped: Track[] = audio.map((f) => {
        const full = f.name;
        const leaf = full.split("/").pop() || full;
        return {
          id: uid(),
          name: leaf.replace(/\.[a-z0-9]+$/i, ""),
          fileName: full,
          url: base + encodePathPreserveSlashes(full),
          tags: inferTagsFromPath(full),
          weight: 1,
        };
      });

      setTracks(mapped);
      setStatus("ready");
    } catch (e: any) {
      setStatus("error");
      setError(e?.message || String(e));
    }
  }

  useEffect(() => {
    loadFromIA();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =======================
     Station-weighted selection
  ======================= */

  function scoreTrack(t: Track) {
    let w = t.weight ?? 1;

    const tw = station.tagWeights;
    const hasWeights = tw && Object.keys(tw).length > 0;

    if (hasWeights) {
      // add weights for matching tags
      for (const tag of t.tags) {
        const key = normalizeTag(tag);
        if (tw[key] != null) w += tw[key];
        // allow weights on year/folder tags too if you ever add them later
      }
      // small reward for having *some* tags
      w += Math.min(2, (t.tags?.length ?? 0) * 0.15);
    } else {
      // All Field: mild variety bias
      w += Math.min(2, (t.tags?.length ?? 0) * 0.25);
    }

    // Avoid immediate repeats
    if (nowPlaying?.id && t.id === nowPlaying.id) w *= 0.05;

    return Math.max(0, w);
  }

  function pickNextTrack() {
    if (!tracks.length) return null;
    if (tracks.length === 1) return tracks[0];

    const pool = tracks;
    const weights = pool.map(scoreTrack);
    return weightedPick(pool, weights);
  }

  /* =======================
     Playback + Crossfade
  ======================= */

  function stopTick() {
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function startTick() {
    if (tickRef.current) return;

    tickRef.current = window.setInterval(() => {
      const deck = activeDeck();
      if (!deck) return;
      if (!radioMode || !isPlaying) return;

      const a = deck.audio;
      if (!isFinite(a.duration) || a.duration <= 0) return;

      const remaining = a.duration - a.currentTime;

      if (remaining <= crossfadeSec + 0.25) {
        if (pendingFadeRef.current) return;
        pendingFadeRef.current = true;
        next(true).finally(() => {
          setTimeout(() => (pendingFadeRef.current = false), 500);
        });
      }
    }, 250);
  }

  async function playTrack(track: Track, opts?: { crossfade?: boolean }) {
    await ensureCtx();
    const ctx = ctxRef.current!;
    const xfade = !!opts?.crossfade && isPlaying;

    const cur = activeDeck();
    const nxt = inactiveDeck();
    if (!nxt) return;

    nxt.track = track;
    nxt.audio.src = track.url;
    nxt.audio.currentTime = 0;
    nxt.audio.load();

    nxt.gain.gain.value = 0;
    await nxt.audio.play();

    if (xfade && cur) {
      rampGain(ctx, nxt.gain, 1, crossfadeSec);
      rampGain(ctx, cur.gain, 0, crossfadeSec);

      window.setTimeout(() => {
        try {
          cur.audio.pause();
        } catch {}
      }, Math.max(250, crossfadeSec * 1000 + 100));
    } else {
      if (cur) {
        cur.gain.gain.value = 0;
        try {
          cur.audio.pause();
        } catch {}
      }
      nxt.gain.gain.value = 1;
    }

    activeRef.current = activeRef.current === "A" ? "B" : "A";
    setNowPlaying(track);
    setIsPlaying(true);

    const active = activeDeck();
    if (active) {
      active.audio.onended = () => {
        if (radioMode) next(false);
        else setIsPlaying(false);
      };
    }

    startTick();
  }

  async function play() {
    if (!tracks.length) return;
    await ensureCtx();

    const cur = activeDeck();
    if (cur?.track && cur.audio.paused) {
      try {
        await cur.audio.play();
        setIsPlaying(true);
        startTick();
        return;
      } catch {}
    }

    const first = pickNextTrack();
    if (!first) return;
    await playTrack(first, { crossfade: false });
  }

  function pause() {
    const cur = activeDeck();
    if (!cur) return;
    try {
      cur.audio.pause();
      setIsPlaying(false);
      stopTick();
    } catch {}
  }

  async function next(useCrossfade: boolean) {
    if (!tracks.length) return;
    const nxt = pickNextTrack();
    if (!nxt) return;
    await playTrack(nxt, { crossfade: useCrossfade });
  }

  function stop() {
    const a = deckARef.current;
    const b = deckBRef.current;
    try {
      a?.audio.pause();
      b?.audio.pause();
      if (a) a.gain.gain.value = 0;
      if (b) b.gain.gain.value = 0;
    } catch {}
    setIsPlaying(false);
    stopTick();
  }

  /* =======================
     Render
  ======================= */

  const canPlay = tracks.length > 0 && status === "ready";

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 1040 }}>
      <h1>🎧 Sounds from the Rainbow — Radio</h1>

      <p>
        Internet Archive item: <b>{IA_IDENTIFIER}</b>
      </p>

      {status === "loading" && <p>Loading archive…</p>}
      {status === "error" && <p style={{ color: "red" }}>{error}</p>}
      {status === "ready" && (
        <p>
          <b>{tracks.length}</b> recordings loaded
        </p>
      )}

      {/* Station Buttons */}
      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <div style={{ fontWeight: 600 }}>Station:</div>
        {STATIONS.map((s) => (
          <button
            key={s.name}
            onClick={() => setStationName(s.name)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid #ccc",
              background: s.name === stationName ? "#111" : "#fff",
              color: s.name === stationName ? "#fff" : "#111",
              cursor: "pointer",
            }}
            title={s.description}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>{station.description}</div>

      {/* Controls */}
      <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button onClick={() => (isPlaying ? pause() : play())} disabled={!canPlay}>
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>

        <button onClick={() => next(true)} disabled={!canPlay}>
          ⏭ Next (crossfade)
        </button>

        <button onClick={() => next(false)} disabled={!canPlay}>
          ⏭ Next (hard cut)
        </button>

        <button onClick={stop} disabled={!canPlay}>
          ⏹ Stop
        </button>

        <button onClick={loadFromIA}>↻ Reload from IA</button>
      </div>

      {/* Sliders */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "#fafafa", padding: 12, borderRadius: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Crossfade</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="range"
              min={0}
              max={15}
              step={1}
              value={crossfadeSec}
              onChange={(e) => setCrossfadeSec(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ minWidth: 48, textAlign: "right" }}>{crossfadeSec}s</div>
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            Tip: 5–9 seconds feels very “radio”. 0 = hard cuts.
          </div>
        </div>

        <div style={{ background: "#fafafa", padding: 12, borderRadius: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Volume & Mode</div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: 12, opacity: 0.75 }}>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ minWidth: 48, textAlign: "right" }}>{Math.round(volume * 100)}%</div>
          </div>

          <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
            <input
              type="checkbox"
              checked={radioMode}
              onChange={(e) => setRadioMode(e.target.checked)}
            />
            <span style={{ fontSize: 13 }}>Radio mode (auto-advance continuously)</span>
          </label>
        </div>
      </div>

      {/* Now Playing */}
      {nowPlaying && (
        <div style={{ marginTop: 16 }}>
          <div><strong>Now Playing:</strong></div>
          <div style={{ fontSize: 18, marginTop: 4 }}>{nowPlaying.name}</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            {nowPlaying.tags.slice(0, 12).join(" · ") || "(no inferred tags)"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
            Path: {nowPlaying.fileName}
          </div>
        </div>
      )}

      {/* Debug */}
      {debug && (
        <div style={{ background: "#f6f6f6", padding: 12, borderRadius: 8, marginTop: 18 }}>
          <div><b>Debug</b></div>
          <div>Total files from IA: {debug.totalFiles}</div>
          <div>Audio by extension: {debug.audioByExt}</div>
          <div style={{ marginTop: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>
            {debug.sampleNames.join("\n")}
          </div>
        </div>
      )}

      <hr style={{ margin: "24px 0" }} />

      <h3>Track List (first 50)</h3>
      <ul style={{ paddingLeft: 18 }}>
        {tracks.slice(0, 50).map((t) => (
          <li key={t.id} style={{ marginBottom: 6 }}>
            <button onClick={() => playTrack(t, { crossfade: true })} style={{ marginRight: 8 }}>
              Play (xfade)
            </button>
            {t.name}
          </li>
        ))}
      </ul>

      {tracks.length > 50 && (
        <p style={{ fontSize: 12, opacity: 0.6 }}>
          Showing first 50 tracks for performance. (Next: search + “recently played” memory.)
        </p>
      )}
    </div>
  );
}
