import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db/client.js";
import { latestSeq, liveCounters, matchesAfter, type LiveMatch } from "../db/feed.js";

/**
 * How long the site takes to play a match out, round by round. Matches resolve
 * the moment they are played; this is presentation, and the one number the
 * server and the page share so "in a match" means the same thing on both.
 */
export const PLAY_MS = 10_000;

export type LiveCounters = { matchesToday: number; totalStaked: number };

export type LiveOptions = {
  /** How often to look for new matches while anyone is listening. Default one second. */
  pollMs?: number;
  /** A comment line this often, so proxies do not close an idle stream. Default 20 s. */
  heartbeatMs?: number;
  /** Streams one address may hold open. Default 6: a few tabs, not a flood. */
  perAddress?: number;
  /** Streams in total. Default 2000. */
  maxStreams?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

type Stream = { res: ServerResponse; address: string };

/** The recent matches kept in memory, so a new listener sees what is still playing. */
const RECENT = 20;
/** At most this many missed matches are replayed to a listener that reconnects. */
const REPLAY = 50;
/** Counters older than this are read again before a new listener is sent them. */
const COUNTERS_TTL_MS = 60_000;

/**
 * New matches as server-sent events. One loop reads the matches table by seq
 * and fans each new row out to every open stream, so the database sees one
 * query a second however many people are watching, and none when nobody is.
 *
 *   event: hello  {counters, playMs}           once, on connecting
 *   event: match  {match, ageMs, counters?}    per match, id = its seq
 *
 * Every match is sent, exhibitions included: the page decides what to list.
 * Counters ride along with a staked match, the only kind that changes them.
 * A browser that reconnects sends Last-Event-ID, and the matches it missed are
 * replayed from there.
 */
export class LiveStream {
  private readonly streams = new Set<Stream>();
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly perAddress: number;
  private readonly maxStreams: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private last: number | null = null;
  private recent: LiveMatch[] = [];
  private counters: { value: LiveCounters; at: number } | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reading = false;
  private starting: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    options: LiveOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.perAddress = options.perAddress ?? 6;
    this.maxStreams = options.maxStreams ?? 2000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  get size(): number {
    return this.streams.size;
  }

  /** Answers GET /live. `headers` are the CORS headers every response carries. */
  async open(req: IncomingMessage, res: ServerResponse, address: string, after: number | null, headers: Record<string, string>) {
    const mine = [...this.streams].filter((s) => s.address === address).length;
    if (this.streams.size >= this.maxStreams || mine >= this.perAddress) {
      res.writeHead(429, { ...headers, "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: "too many live streams open" }));
      return;
    }
    res.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Some proxies buffer a response until it ends; this one never does.
      "x-accel-buffering": "no",
    });
    const stream: Stream = { res, address };
    // Added before anything is read, so no match lands between the catch-up and the tail.
    // A match can then arrive twice; the page keys rows by id.
    this.streams.add(stream);
    req.on("close", () => this.drop(stream));
    res.write(`retry: 3000\n\n`);

    try {
      await this.start();
      write(stream, "hello", { counters: await this.freshCounters(), playMs: PLAY_MS });
      const catchUp =
        after === null
          ? this.recent.filter((m) => this.ageOf(m) < PLAY_MS)
          : await matchesAfter(this.db, after, REPLAY);
      for (const m of catchUp) this.send(stream, m);
    } catch (error) {
      this.onError(error);
      this.drop(stream);
    }
  }

  /** Ends every stream and stops reading. */
  close(): void {
    for (const s of [...this.streams]) this.drop(s);
  }

  private drop(stream: Stream): void {
    if (!this.streams.delete(stream)) return;
    stream.res.end();
    if (this.streams.size === 0) this.stop();
  }

  private start(): Promise<void> {
    if (this.poll) return Promise.resolve();
    this.starting ??= (async () => {
      // A warm start: the last few matches, so the first listener still sees one mid-play.
      const latest = await latestSeq(this.db);
      this.recent = await matchesAfter(this.db, Math.max(0, latest - RECENT), RECENT);
      this.last = latest;
      if (this.streams.size === 0) return;
      this.poll = setInterval(() => void this.read(), this.pollMs);
      this.heartbeat = setInterval(() => {
        for (const s of this.streams) s.res.write(`: ping\n\n`);
      }, this.heartbeatMs);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private stop(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.poll = this.heartbeat = null;
    this.last = null;
  }

  /** One pass of the tail: whatever was recorded since the last pass, to everyone. */
  private async read(): Promise<void> {
    if (this.reading || this.last === null) return;
    this.reading = true;
    try {
      const fresh = await matchesAfter(this.db, this.last, REPLAY);
      if (fresh.length === 0 || this.last === null) return;
      this.last = fresh.at(-1)!.seq;
      this.recent = [...this.recent, ...fresh].slice(-RECENT);
      if (fresh.some((m) => !m.exhibition)) {
        this.counters = { value: await liveCounters(this.db, new Date(this.now())), at: this.now() };
      }
      const lastStaked = [...fresh].reverse().find((m) => !m.exhibition);
      for (const m of fresh) {
        const counters = m === lastStaked ? this.counters!.value : undefined;
        for (const s of this.streams) this.send(s, m, counters);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.reading = false;
    }
  }

  private async freshCounters(): Promise<LiveCounters> {
    if (!this.counters || this.now() - this.counters.at > COUNTERS_TTL_MS) {
      this.counters = { value: await liveCounters(this.db, new Date(this.now())), at: this.now() };
    }
    return this.counters.value;
  }

  private ageOf(m: LiveMatch): number {
    return Math.max(0, this.now() - new Date(m.createdAt).getTime());
  }

  private send(stream: Stream, m: LiveMatch, counters?: LiveCounters): void {
    write(stream, "match", { match: m, ageMs: this.ageOf(m), ...(counters ? { counters } : {}) }, m.seq);
  }
}

function write(stream: Stream, event: string, data: unknown, id?: number): void {
  stream.res.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Where a stream resumes from: Last-Event-ID on a browser's reconnect, or ?after=. */
export function resumeFrom(req: IncomingMessage, query: URLSearchParams): number | null {
  const raw = req.headers["last-event-id"] ?? query.get("after");
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return raw !== undefined && raw !== null && raw !== "" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}
