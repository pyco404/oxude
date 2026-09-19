/**
 * Agent marks: one emoji per agent, its identity at a glance. The playstyle is
 * shown separately, as a text label; the mark says which agent, not how it plays.
 *
 * Curated by hand: animals (whole bodies, never faces), plants, the sky and
 * weather, objects, transport, sport and plain symbols. Left out on purpose:
 * flags, faces (including things drawn with one), hands and bodies, food, anything religious, national or tied to
 * a particular culture or festival, weapons, and anything that could be read as
 * offensive. Nothing newer than Unicode 12, so every mark renders on older
 * phones and Windows 10 instead of showing as a box. Symbols that default to text
 * carry U+FE0F so they draw as emoji.
 */
const V = "️";

const ANIMALS = [
  "🐕", "🐩", "🐈", "🐅", "🐆", "🐎", "🦓", "🦌", "🐂", "🐃", "🐄", "🐖", "🐗", "🐏", "🐑", "🐐", "🐪", "🐫",
  "🦙", "🦒", "🐘", "🦏", "🦛", "🐁", "🐀", "🐇", "🐿" + V, "🦔", "🦇", "🦥", "🦦", "🦨", "🦘", "🦡", "🐓",
  "🐦", "🐧", "🦅", "🦆", "🦢", "🦉", "🦩", "🦚", "🦜", "🐊", "🐢", "🦎", "🐍", "🦕", "🦖", "🐳", "🐋", "🐬",
  "🐟", "🐠", "🐡", "🦈", "🐙", "🐚", "🐌", "🦋", "🐛", "🐜", "🐝", "🐞", "🦗", "🕷" + V, "🕸" + V, "🦂", "🦀",
  "🦞", "🦑", "🦍", "🦧",
];

const PLANTS = [
  "💐", "🌸", "🏵" + V, "🌹", "🌺", "🌻", "🌼", "🌷", "🌱", "🌲", "🌳", "🌴", "🌵", "🌾", "🌿", "🍀", "🍂", "🍃",
];

const SKY = [
  "☀" + V, "🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘", "⭐", "🌟", "✨", "⚡", "☄" + V, "💫", "🔥", "💧",
  "🌊", "❄" + V, "☁" + V, "⛅", "🌤" + V, "🌦" + V, "🌪" + V, "🌫" + V, "🌋", "🏔" + V, "⛰" + V, "🏝" + V, "🏜" + V,
  "🌐", "🪐", "🌌", "🌠", "🌀",
];

const OBJECTS = [
  "⚓", "🔨", "⛏" + V, "🛠" + V, "🔧", "🔩", "⚙" + V, "🗜" + V, "⚖" + V, "🔗", "🧲", "🧰", "🧱", "🧪", "🧫",
  "🧬", "🔬", "🔭", "📡", "💡", "🔦", "🧯", "🛢" + V, "💎", "💍", "🔑", "🗝" + V, "🔒", "🔓", "🔔", "📯",
  "🎺", "🎷", "🎸", "🎻", "🥁", "🎹", "📻", "📱", "☎" + V, "📟", "📠", "🔋", "🔌", "💻", "🖥" + V, "🖨" + V,
  "⌨" + V, "🖱" + V, "🖲" + V, "💽", "💾", "💿", "📀", "🧮", "🎥", "🎞" + V, "📽" + V, "📺", "📷", "📸",
  "📹", "📼", "🔍", "🕰" + V, "⏰", "⏱" + V, "⏲" + V, "⌛", "⏳", "🧭", "🗺" + V, "🧳", "🌂", "☂" + V, "⛱" + V,
  "🎈", "🎀", "🎁", "🎊", "🎉", "🪀", "🪁", "🎯", "🎱", "🎮", "🕹" + V, "🎲", "🧩", "♟" + V,
  "🖼" + V, "🎨", "🧵", "🧶", "👓", "🕶" + V, "🥽", "🥼", "🦺", "👔", "👕", "👖", "🧣", "🧤", "🧥", "🧦",
  "👗", "👚", "👛", "👜", "👝", "🎒", "👞", "👟", "🥾", "🥿", "👠", "👡", "🩰", "👢", "👑", "👒", "🎩", "🎓",
  "🧢", "💄", "💼", "📁", "📂", "📅", "📆", "📇", "📈", "📉", "📊", "📋", "📌", "📍", "📎", "🖇" + V, "📏",
  "📐", "✂" + V, "🗃" + V, "🗄" + V, "🗑" + V, "✏" + V, "✒" + V, "🖋" + V, "🖊" + V, "🖌" + V, "🖍" + V, "📝",
  "📒", "📓", "📔", "📕", "📗", "📘", "📙", "📚", "📖", "🔖", "🏷" + V, "📜", "📃", "📄", "📑", "📰", "🗞" + V,
  "✉" + V, "📧", "📨", "📩", "📤", "📥", "📦", "📫", "📪", "📬", "📭", "📮", "💰", "💸", "💳", "🧾", "🏆",
  "🏅", "🥇", "🥈", "🥉", "🎫", "🎟" + V, "🎪", "🛎" + V, "🧹", "🧺", "🧼", "🧽", "🧴", "🚪", "🛋" + V, "🛏" + V,
  "🛁", "🚿", "🧷", "🏺", "🛡" + V, "🪑",
];

const TRANSPORT = [
  "🚗", "🚕", "🚙", "🚌", "🚎", "🏎" + V, "🚑", "🚒", "🚐", "🚚", "🚛", "🚜", "🛴", "🚲", "🛵", "🏍" + V, "🛹",
  "🚂", "🚆", "🚇", "🚊", "🚝", "🚄", "🚁", "🛩" + V, "✈" + V, "🛫", "🛬", "🪂", "💺", "🚀", "🛸", "🛰" + V,
  "🚢", "⛴" + V, "🛥" + V, "🚤", "⛵", "🛶", "🚡", "🚠", "🚟", "🎠", "🎡", "🎢", "🚏", "⛽", "🚥", "🚦", "🛑",
  "🚧", "⛲", "⛺", "🏕" + V, "🏠", "🏡", "🏗" + V, "🏭", "🏰", "🏟" + V, "🌉", "🎆", "🎇",
];

const SPORT = [
  "⚽", "⚾", "🥎", "🏀", "🏐", "🏈", "🏉", "🎾", "🥏", "🎳", "🏏", "🏑", "🏒", "🥍", "🏓", "🏸", "🥊", "🥅",
  "⛸" + V, "🎣", "🤿", "🎿", "🛷", "🥌",
];

const SYMBOLS = [
  "♠" + V, "♥" + V, "♦" + V, "♣" + V, "🔶", "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘", "🔳", "🔲", "⬛", "⬜",
  "🟥", "🟧", "🟨", "🟩", "🟦", "🟪", "🟫", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "💢", "💥",
  "💨", "💤", "♾" + V, "⭕", "✅", "➰", "➿", "✳" + V, "✴" + V, "❇" + V, "❓", "❗", "🔅", "🔆", "📶", "♻" + V,
  "⚛" + V, "⚠" + V, "🔊", "📣", "📢", "🎵", "🎶", "🎼", "🔀", "🔁", "🔄", "🧡", "💛", "💚", "💙", "💜", "🤎",
  "🖤", "🤍",
];

function curate(groups: string[][]): readonly string[] {
  const all = groups.flat();
  const seen = new Set<string>();
  for (const m of all) {
    if (seen.has(m)) throw new Error(`mark listed twice: ${m}`);
    seen.add(m);
  }
  return Object.freeze(all);
}

/** Every mark an agent can have, in a fixed order: never reorder, only append. */
export const MARKS = curate([ANIMALS, PLANTS, SKY, OBJECTS, TRANSPORT, SPORT, SYMBOLS]);

/** FNV-1a over the agent id: where in the list its search for a free mark starts. */
function startFor(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    h ^= agentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The marks an agent would take, in order of preference: single marks from the
 * one its id hashes to onwards, then (only once every single mark is taken)
 * pairs. Deterministic for an id; which one it gets depends only on which are
 * already taken.
 */
export function* candidateMarks(agentId: string): Generator<string> {
  const n = MARKS.length;
  const start = startFor(agentId) % n;
  for (let i = 0; i < n; i++) yield MARKS[(start + i) % n]!;
  const second = Math.floor(startFor(agentId) / n) % n;
  for (let i = 0; i < n * n; i++) {
    const a = MARKS[(start + Math.floor(i / n)) % n]!;
    const b = MARKS[(second + i) % n]!;
    if (a !== b) yield a + b;
  }
}

/** The first candidate for this agent that nobody has yet. */
export function firstFreeMark(agentId: string, taken: ReadonlySet<string>): string {
  for (const mark of candidateMarks(agentId)) if (!taken.has(mark)) return mark;
  throw new Error("every mark and pair of marks is taken");
}
