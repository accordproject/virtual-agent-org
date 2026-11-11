// A small cron matcher for the schedules the gateway runs itself (decision 67): five
// fields (minute hour day-of-month month day-of-week) with numbers, *, lists, ranges and
// steps, read in the network's timezone. Sunday is 0 or 7.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether day-of-month and day-of-week were both restricted: then either may match, as in standard cron. */
  either: boolean;
}

const FIELDS: [keyof Omit<Cron, "either">, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 7],
];

/** Parses a five-field cron expression, or throws with the reason. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have 5 fields");
  const out = {} as Cron;
  parts.forEach((part, i) => {
    const [name, lo, hi] = FIELDS[i];
    const set = new Set<number>();
    for (const item of part.split(",")) {
      const m = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
      if (!m) throw new Error(`cron field "${part}" is not supported`);
      const from = m[1] === "*" ? lo : Number(m[2]);
      const to = m[1] === "*" ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from;
      const step = m[4] ? Number(m[4]) : 1;
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`cron field "${part}" is out of range ${lo}-${hi}`);
      for (let v = from; v <= to; v += step) set.add(name === "dow" && v === 7 ? 0 : v);
    }
    out[name] = set;
  });
  out.either = parts[2] !== "*" && parts[4] !== "*";
  return out;
}

export interface LocalTime {
  date: string;
  time: string;
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall-clock fields of `at` in `timezone`. */
export function localTime(timezone: string, at: Date): LocalTime {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minute: Number(p.minute),
    hour: Number(p.hour),
    dom: Number(p.day),
    month: Number(p.month),
    dow: DAYS.indexOf(p.weekday),
  };
}

export function cronMatches(c: Cron, t: LocalTime): boolean {
  if (!c.minute.has(t.minute) || !c.hour.has(t.hour) || !c.month.has(t.month)) return false;
  const dom = c.dom.has(t.dom);
  const dow = c.dow.has(t.dow);
  return c.either ? dom || dow : dom && dow;
}
