// The guides an AI reads before it works on a trip (model §13), served by the get_*_guide
// tools. Their text is src/mcp/guides/*.md, bundled with the Worker as text (wrangler.jsonc's
// Text rule), and check:guides holds what they say to what the tools do.

import itinerary from "./guides/itinerary.md";
import packing from "./guides/packing.md";
import pictures from "./guides/pictures.md";
import places from "./guides/places.md";
import split from "./guides/split.md";
import tripSetup from "./guides/trip-setup.md";

export const GUIDES = { "trip-setup": tripSetup, itinerary, places, packing, pictures, split };
