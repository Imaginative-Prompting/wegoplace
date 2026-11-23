// What the delete dialog of a trip's people page says goes (js/trip-people.js), from the
// numbers the server answers for that trip (`goes`, docs/API.md). No DOM, so the trips check
// holds these words for one and for several without a browser (checks/trips/run.mjs).

import { formatBytes } from "./shared/bytes.js";

const listWords = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
// "1 photo goes"; "2 photos go", "1 photo and 1 video go".
const verb = (n) => (n === 1 ? "goes" : "go");

/** [icon name, words] for each line: who loses it, what files go, the boards, the money. */
export function goesLines(goes) {
  const lines = [];
  const others = goes.members - 1;
  lines.push(["people", others > 0 ? `${others === 1 ? "1 other person loses" : `${others} other people lose`} it, as you do.` : "Nobody else is on it."]);
  const media = [];
  if (goes.photos) media.push(count(goes.photos, "photo", "photos"));
  if (goes.videos) media.push(count(goes.videos, "video", "videos"));
  // Pictures on its places, events and cover, and receipts (older answers have neither: 0).
  if (goes.pictures) media.push(count(goes.pictures, "picture", "pictures"));
  if (goes.receipts) media.push(count(goes.receipts, "receipt", "receipts"));
  const files = goes.photos + goes.videos + (goes.pictures || 0) + (goes.receipts || 0);
  lines.push(["storage", media.length ? `${listWords(media)} ${verb(files)}, ${formatBytes(goes.bytes)} in all.` : "It holds no photos, videos or pictures."]);
  if (goes.boards) lines.push(["link", goes.boards === 1 ? "1 shared board stops working for whoever has its link." : `${goes.boards} shared boards stop working for whoever has their links.`]);
  const money = [];
  if (goes.purchases) money.push(count(goes.purchases, "purchase", "purchases"));
  if (goes.payments) money.push(count(goes.payments, "payment", "payments"));
  if (money.length) lines.push(["bin", `${listWords(money)} ${verb(goes.purchases + goes.payments)}, with who owes whom.`]);
  if (goes.someone_owes) lines.push(["warn", "Someone still owes money on it. Settle up first if that matters: afterwards nobody can see it."]);
  return lines;
}
